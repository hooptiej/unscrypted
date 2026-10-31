import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as net from "net";
import { ResponseFraming, installEventHold } from "../src/hapEventHold";
import { Logger } from "../src/logger";

const quiet = (warnings: string[] = []): Logger =>
  ({ info: () => undefined, debug: () => undefined, error: () => undefined, warn: (m: string) => warnings.push(m) }) as unknown as Logger;

/** Every way to cut `buf` into two pieces, fed to a fresh framing: completion must only show after the last byte. */
function assertCompleteOnlyAtEnd(buf: Buffer): void {
  for (let cut = 1; cut < buf.length; cut++) {
    const f = new ResponseFraming();
    assert.equal(f.push(buf.subarray(0, cut)), false, `complete too early at cut ${cut}`);
    assert.equal(f.push(buf.subarray(cut)), true, `not complete at end, cut ${cut}`);
    assert.equal(f.unframed, undefined);
  }
}

test("#97: a Content-Length reply is complete only after its last body byte, wherever it is split", () => {
  assertCompleteOnlyAtEnd(Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: application/hap+json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}"));
});

test("#97: a chunked reply (sizes, extensions, trailers) is complete only at its terminator, wherever it is split", () => {
  assertCompleteOnlyAtEnd(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;x=y\r\nhello\r\n0\r\n\r\n"));
  assertCompleteOnlyAtEnd(Buffer.from("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\na\r\n0\r\n\r\n0\r\n\r\n\r\n0\r\nX-T: 1\r\n\r\n"));
});

test("#97: body bytes that look like a terminator don't end a chunked reply early", () => {
  const f = new ResponseFraming();
  assert.equal(f.push(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\na\r\n0\r\n\r\n")), false);
  assert.equal(f.push(Buffer.from("0\r\n\r\n")), false); // still inside the 10-byte chunk
  assert.equal(f.push(Buffer.from("\r\n0\r\n\r\n")), true);
});

test("#97: back-to-back replies, and replies with no body, frame correctly", () => {
  const f = new ResponseFraming();
  assert.equal(f.push(Buffer.from("HTTP/1.1 204 No Content\r\n\r\n")), true);
  assert.equal(f.push(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")), true);
  assert.equal(f.push(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokHTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n")), false);
  assert.equal(f.push(Buffer.from("x")), true);
  assert.ok(f.idle);
});

test("#97: a reply it can't frame falls back to 'complete now' and says why", () => {
  const f = new ResponseFraming();
  assert.equal(f.push(Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nwho knows")), true);
  assert.match(f.unframed ?? "", /no Content-Length or chunked framing/);
  const g = new ResponseFraming();
  assert.equal(g.push(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n")), true);
  assert.match(g.unframed ?? "", /unreadable chunk size/);
});

/** The real bytes, in the real pieces, that Node's HTTP server writes for hap-nodejs's /resource reply. */
async function realSnapshotReplyPieces(size: number): Promise<Buffer[]> {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "image/jpeg" }); // exactly what hap-nodejs's HAPServer does
    res.end(Buffer.alloc(size, 0xff));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as net.AddressInfo;
  const pieces: Buffer[] = [];
  await new Promise<void>((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write("POST /resource HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n"));
    s.on("data", (d: Buffer) => {
      pieces.push(d);
      if (Buffer.concat(pieces).subarray(-5).toString() === "0\r\n\r\n") { s.destroy(); resolve(); }
    });
  });
  srv.close();
  return pieces;
}

/** Feed `pieces` to a fake connection built on `proto`; returns the order of writes and event flushes. */
function replay(proto: object, pieces: Buffer[]): { timeline: string[]; conn: { handlingRequest: boolean } } {
  const timeline: string[] = [];
  const conn = Object.assign(Object.create(proto), {
    state: 2, // AUTHENTICATED
    handlingRequest: true,
    eventsTimer: undefined,
    eventsQueuedForImmediateDelivery: false,
    remoteAddress: "10.0.1.219",
    tcpSocket: { write: () => timeline.push("piece") },
    encrypt: (d: Buffer) => d,
    writeQueuedEventNotifications: () => timeline.push("events"),
  });
  for (const p of pieces) conn.handleHttpServerResponse(p);
  return { timeline, conn };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realProto = () => require("hap-nodejs/dist/lib/util/eventedhttp").HAPConnection.prototype;

test("#97 control: unpatched hap-nodejs flushes a queued event after the FIRST piece of a snapshot reply (the bug)", async () => {
  const pieces = await realSnapshotReplyPieces(200_000);
  assert.ok(pieces.length > 1, "the reply should arrive in several pieces, as on prod");
  const { timeline } = replay(realProto(), pieces);
  assert.deepEqual(timeline.slice(0, 2), ["piece", "events"]);
});

test("#97: hap-nodejs's real handler, patched, holds a queued event until the whole snapshot reply is written", async () => {
  const proto = Object.create(realProto()); // a private copy: the real prototype stays untouched
  assert.equal(installEventHold(quiet(), proto), true);
  const pieces = await realSnapshotReplyPieces(200_000);
  const { timeline, conn } = replay(proto, pieces);
  assert.deepEqual(timeline, [...pieces.map(() => "piece"), "events"], "events must go out after the last piece, never between pieces");
  assert.equal(conn.handlingRequest, false);
});

test("#97: an unrecognisable hap-nodejs is left alone, with a warning", () => {
  const warnings: string[] = [];
  assert.equal(installEventHold(quiet(warnings), { handleHttpServerResponse() {} }), false);
  assert.match(warnings[0], /not installed.*missing writeQueuedEventNotifications/);
});
