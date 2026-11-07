/**
 * HTTP plumbing the admin pane and the open dashboard both use (#46). It lives here, not in
 * src/admin/, so the dashboard process (open to the LAN, no sign-in) imports nothing from the admin
 * pane's modules (auth, config store, session keys). Keep this file free of admin and dash imports.
 */

import * as http from "http";
import * as net from "net";
import { Duplex } from "stream";
import * as fs from "fs";
import * as path from "path";
import { UserError } from "./errors";
import { Logger } from "../logger";

/** CSP / no framing / nosniff / no-store on every response of both servers. */
export function securityHeaders(req: http.IncomingMessage): Record<string, string> {
  const host = /^[A-Za-z0-9.\-:[\]]+$/.test(req.headers.host ?? "") ? req.headers.host! : "";
  const ws = host ? ` ws://${host} wss://${host}` : "";
  return {
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
      `connect-src 'self'${ws}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

/** A stream name go2rtc may be asked for: lower-case letters, digits, underscore. */
export const STREAM_NAME = /^[a-z0-9_]{1,64}$/;

/**
 * Read one font file the caller already validated the name of. A missing file is a 404 in the
 * caller's words (`notThere`); any other read failure (EACCES, EISDIR, ...) is logged and answered
 * as a 500 that says what the read actually hit, never "isn't in the folder" when it is (#12).
 */
export function readFontFile(dir: string, name: string, o: {
  attempted: string; log: Logger; notThere: () => UserError; changed: string; unreadableNext: string;
}): Buffer {
  try {
    return fs.readFileSync(path.join(dir, name));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    if (code === "ENOENT") throw o.notThere();
    o.log.warn(`font "${name}" is in the fonts folder but couldn't be read (${code})`);
    throw new UserError({ attempted: o.attempted, happened: `The font file "${name}" is in the dashboard's fonts folder but couldn't be read (${code}).`,
      changed: o.changed, next: o.unreadableNext }, 500);
  }
}

/**
 * Stream one GET from go2rtc's loopback API to the browser (its player files, a frame). 20 s
 * timeout. A failure before the first byte is answered as `down(attempted)` (the caller's 503 in its
 * own words) with the reason appended; after the first byte the connection is just cut.
 */
export function proxyGo2rtcFile(o: {
  go2rtcApi: string; target: string; res: http.ServerResponse; attempted: string; log: Logger;
  /** What the log line calls the thing being streamed, e.g. "player file". */
  label: string; down: (attempted: string) => UserError;
}): Promise<void> {
  const { res, log } = o;
  return new Promise<void>((resolve) => {
    const upstream = http.request(o.go2rtcApi + o.target, { method: "GET", timeout: 20_000 }, (up) => {
      res.writeHead(up.statusCode ?? 502, { "content-type": up.headers["content-type"] ?? "application/octet-stream" });
      up.pipe(res);
      up.on("end", resolve);
      up.on("error", (err) => { log.warn(`go2rtc ${o.label} broke off: ${err.message}`); res.destroy(); resolve(); });
    });
    upstream.on("timeout", () => upstream.destroy(new Error("go2rtc didn't answer within 20 s")));
    upstream.on("error", (err) => {
      if (!res.headersSent) {
        const down = o.down(o.attempted);
        sendJson(res, 503, { error: { ...down.body, happened: `${down.body.happened} (${err.message})` } });
      } else {
        res.destroy();
      }
      resolve();
    });
    upstream.end();
  });
}

/** What a browser->go2rtc frame filter looks like (the dashboard's ClientFrameFilter fits). */
export interface FrameFilter { push(chunk: Buffer): { forward: Buffer } | { reject: string } }

/**
 * Proxy go2rtc's signalling WebSocket (/api/ws?src=...) for an upgrade request the caller has
 * already vetted (auth, stream allow-list). The browser's cookie, origin and authorization never
 * reach go2rtc. With a `filter`, compression is also refused and every browser frame is checked
 * before it is forwarded (the dashboard's WebRTC-only rule); without one the sockets are plain pipes.
 * `onGone` runs once the connection is over, whichever side ended it.
 */
export function proxyGo2rtcSocket(o: {
  req: http.IncomingMessage; socket: Duplex; head: Buffer; go2rtcApi: string; src: string; log: Logger;
  /** What the log lines call this connection, e.g. "dashboard video" / "live preview". */
  label: string; filter?: FrameFilter; onGone?: () => void;
}): void {
  const { req, socket, head, src, log } = o;
  const target = new URL(o.go2rtcApi);
  const strip = o.filter ? /^(host|cookie|origin|authorization|sec-websocket-extensions)$/i : /^(host|cookie|origin|authorization)$/i;
  let gone = false;
  const done = () => { if (!gone) { gone = true; o.onGone?.(); } };
  let upgraded = false;
  const up = net.connect(Number(target.port), target.hostname, () => {
    const lines = [`GET /api/ws?src=${encodeURIComponent(src)} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (strip.test(req.rawHeaders[i])) continue;
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push(`Host: ${target.host}`, "", "");
    up.write(lines.join("\r\n"));
    if (o.filter) {
      const filter = o.filter;
      const feed = (chunk: Buffer) => {
        const r = filter.push(chunk);
        if ("reject" in r) { log.warn(`closed a ${o.label} connection for "${src}": the browser sent ${r.reject}`); socket.destroy(); up.destroy(); return; }
        if (r.forward.length) up.write(r.forward);
      };
      if (head.length) feed(head);
      socket.on("data", feed);
    } else {
      if (head.length) up.write(head);
      socket.pipe(up);
    }
    up.once("data", () => { upgraded = true; });
    up.pipe(socket);
  });
  up.on("error", (err) => {
    log.warn(`${o.label}: couldn't reach go2rtc at ${target.host} for "${src}": ${err.message}`);
    if (!upgraded && socket.writable) socket.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nthe video server (go2rtc) didn't answer: ${err.message}\n`);
    else socket.destroy();
    done();
  });
  // http.Server sockets are half-open: a browser hanging up sends "end", and "close" only follows
  // once our side ends too. Without this the live-view slot (and go2rtc's session) would leak.
  socket.on("end", () => { up.destroy(); socket.destroy(); done(); });
  socket.on("error", () => { up.destroy(); socket.destroy(); });   // a browser that vanished mid-handshake
  socket.on("close", () => { up.destroy(); done(); });
  up.on("close", () => { socket.destroy(); done(); });
}
