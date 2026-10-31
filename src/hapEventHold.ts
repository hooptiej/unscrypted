/**
 * Hold HAP event notifications until a whole HTTP response has gone out (#97, #96).
 *
 * hap-nodejs (0.14.3, and upstream master as of v2.2.3) calls
 * HAPConnection.handleHttpServerResponse once per chunk its internal HTTP server writes, and
 * clears `handlingRequest` after the FIRST chunk. A snapshot (/resource) JPEG goes out chunked in
 * 64 KB pieces, so a motion event queued during the snapshot is written between two chunks of the
 * reply. The controller's HTTP stream is then corrupt and it drops the connection, taking any live
 * view on it along. Measured on prod: 27 of 27 events written mid-reply were followed by the
 * phone hanging up within 0.5 s; 0 of 41 events written between replies were.
 *
 * The fix keeps `handlingRequest` true until the response's framing (Content-Length or chunked)
 * says it is complete. A response it can't frame falls back to hap-nodejs's own behaviour, loudly.
 */

import { Logger } from "./logger";

const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

type Mode = "idle" | "headers" | "length" | "chunk-size" | "chunk-data" | "chunk-data-crlf" | "trailers";

/**
 * Follows one HTTP/1.1 response stream, fed in arbitrary pieces, and says when each response is
 * complete. Handles Content-Length bodies and chunked bodies (sizes, data, trailers) split anywhere.
 */
export class ResponseFraming {
  private mode: Mode = "idle";
  private pending = Buffer.alloc(0); // bytes of a header/size/trailer line not yet terminated
  private remaining = 0; // body or chunk bytes still to come
  /** Why the last response couldn't be framed (the caller logs it); cleared on read. */
  unframed?: string;

  /** True when no response is part-way through. */
  get idle(): boolean {
    return this.mode === "idle";
  }

  /** Feed the next piece of the response stream. Returns true if the stream ends on a complete response. */
  push(data: Buffer): boolean {
    let i = 0;
    while (i < data.length) {
      switch (this.mode) {
        case "idle":
          this.mode = "headers";
          this.pending = Buffer.alloc(0);
          break;
        case "headers": {
          const buf = Buffer.concat([this.pending, data.subarray(i)]);
          const end = buf.indexOf(HEADER_END);
          if (end < 0) {
            this.pending = buf;
            return false;
          }
          const consumed = end + HEADER_END.length - this.pending.length;
          this.startBody(buf.subarray(0, end).toString("latin1"));
          if (this.unframed) return true; // the rest of this piece is a body it can't measure
          this.pending = Buffer.alloc(0);
          i += consumed;
          break;
        }
        case "length": {
          const take = Math.min(this.remaining, data.length - i);
          this.remaining -= take;
          i += take;
          if (this.remaining === 0) this.mode = "idle";
          break;
        }
        case "chunk-size":
        case "chunk-data-crlf":
        case "trailers": {
          const buf = Buffer.concat([this.pending, data.subarray(i)]);
          const eol = buf.indexOf(CRLF);
          if (eol < 0) {
            this.pending = buf;
            return false;
          }
          const line = buf.subarray(0, eol).toString("latin1");
          i += eol + CRLF.length - this.pending.length;
          this.pending = Buffer.alloc(0);
          if (this.mode === "chunk-data-crlf") {
            this.mode = "chunk-size";
          } else if (this.mode === "trailers") {
            if (line === "") this.mode = "idle";
          } else {
            const size = parseInt(line.split(";")[0].trim(), 16);
            if (!Number.isFinite(size) || size < 0) {
              return this.giveUp(`unreadable chunk size "${line.slice(0, 20)}"`);
            }
            if (size === 0) this.mode = "trailers";
            else {
              this.remaining = size;
              this.mode = "chunk-data";
            }
          }
          break;
        }
        case "chunk-data": {
          const take = Math.min(this.remaining, data.length - i);
          this.remaining -= take;
          i += take;
          if (this.remaining === 0) this.mode = "chunk-data-crlf";
          break;
        }
      }
    }
    return this.mode === "idle";
  }

  private startBody(head: string): void {
    const lines = head.split("\r\n");
    const status = parseInt(lines[0].split(" ")[1] ?? "", 10);
    const header = (name: string): string | undefined => {
      const l = lines.find((x) => x.toLowerCase().startsWith(name + ":"));
      return l?.slice(name.length + 1).trim();
    };
    if (!lines[0].startsWith("HTTP/")) {
      this.giveUp(`not an HTTP response ("${lines[0].slice(0, 20)}")`);
    } else if ((header("transfer-encoding") ?? "").toLowerCase().includes("chunked")) {
      this.mode = "chunk-size";
    } else if (header("content-length") !== undefined) {
      this.remaining = parseInt(header("content-length")!, 10) || 0;
      this.mode = this.remaining > 0 ? "length" : "idle";
    } else if (status === 204 || status === 304 || (status >= 100 && status < 200)) {
      this.mode = "idle"; // no body by definition
    } else {
      this.giveUp(`no Content-Length or chunked framing (status ${status})`);
    }
  }

  private giveUp(why: string): boolean {
    this.unframed = why;
    this.mode = "idle";
    this.pending = Buffer.alloc(0);
    this.remaining = 0;
    return true;
  }
}

// hap-nodejs's private HAPConnection internals this relies on (checked against 0.14.3).
interface HapConnectionInternals {
  state: number;
  handlingRequest: boolean;
  eventsTimer?: NodeJS.Timeout;
  eventsQueuedForImmediateDelivery: boolean;
  remoteAddress: string;
  tcpSocket: { write(data: Buffer, cb: () => void): void };
  encrypt(data: Buffer): Buffer;
  close(): void;
  writeQueuedEventNotifications(): void;
  handleTCPSocketWriteFulfilled(): void;
  handleHttpServerResponse(data: Buffer): void;
  __unscryptedFraming?: ResponseFraming;
}

const TO_BE_TEARED_DOWN = 3; // hap-nodejs HAPConnectionState.TO_BE_TEARED_DOWN

// hap-nodejs's own debug channel (its `debug` dependency); a no-op if that ever goes away.
const debugCon: (fmt: string, ...args: unknown[]) => void = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("debug")("HAP-NodeJS:EventedHTTPServer:Connection");
  } catch {
    return () => undefined;
  }
})();

/**
 * Replace hap-nodejs's per-chunk response handler with one that holds events until the response
 * is complete. Returns false (and says why) if this hap-nodejs doesn't look like the one it was
 * written against; the bridge then runs with hap-nodejs's own behaviour.
 */
export function installEventHold(log: Logger, proto?: object): boolean {
  let target = proto as HapConnectionInternals | undefined;
  if (!target) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      target = require("hap-nodejs/dist/lib/util/eventedhttp").HAPConnection?.prototype;
    } catch (err) {
      log.warn(`event hold (#97) not installed: couldn't load hap-nodejs's HAPConnection (${(err as Error).message}). ` +
        "A motion event during a snapshot can still drop a Home app live view.");
      return false;
    }
  }
  const expected = ["handleHttpServerResponse", "writeQueuedEventNotifications", "encrypt", "handleTCPSocketWriteFulfilled", "close"] as const;
  const missing = expected.filter((m) => typeof (target as unknown as Record<string, unknown>)?.[m] !== "function");
  if (!target || missing.length > 0) {
    log.warn(`event hold (#97) not installed: hap-nodejs's HAPConnection has changed (missing ${missing.join(", ") || "prototype"}). ` +
      "A motion event during a snapshot can still drop a Home app live view.");
    return false;
  }

  target.handleHttpServerResponse = function (this: HapConnectionInternals, data: Buffer): void {
    const framing = (this.__unscryptedFraming ??= new ResponseFraming());
    const complete = framing.push(data);
    if (framing.unframed) {
      log.warn(`[${this.remoteAddress}] couldn't follow a HAP response (${framing.unframed}); ` +
        "sending queued events after this piece, as hap-nodejs does on its own");
      framing.unframed = undefined;
    }
    this.tcpSocket.write(this.encrypt(data), this.handleTCPSocketWriteFulfilled.bind(this));
    // Same debug line hap-nodejs logs, once per piece, so the #96 log analysis keeps working.
    debugCon("[%s] HTTP Response is finished", this.remoteAddress);
    if (!complete) return; // more of this response to come: events keep waiting

    this.handlingRequest = false;
    if (this.state === TO_BE_TEARED_DOWN) {
      setTimeout(() => this.close(), 10);
    } else if (this.state < TO_BE_TEARED_DOWN) {
      if (!this.eventsTimer || this.eventsQueuedForImmediateDelivery) {
        this.writeQueuedEventNotifications();
      }
    }
  };
  log.info("HAP event hold installed: event notifications wait for a whole response (#97)");
  return true;
}
