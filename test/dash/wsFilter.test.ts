import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientFrameFilter } from "../../src/dash/wsFilter";

function frame(op: number, payload: string | Buffer, fin = true, masked = true): Buffer {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = Buffer.from([1, 2, 3, 4]);
  const len = p.length < 126 ? Buffer.from([(masked ? 0x80 : 0) | p.length])
    : p.length < 65536 ? Buffer.from([(masked ? 0x80 : 0) | 126, p.length >> 8, p.length & 255])
    : Buffer.concat([Buffer.from([(masked ? 0x80 : 0) | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(p.length)); return b; })()]);
  const body = masked ? Buffer.from(p.map((b, i) => b ^ mask[i & 3])) : p;
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op]), len, masked ? mask : Buffer.alloc(0), body]);
}
const offer = JSON.stringify({ type: "webrtc/offer", value: "v=0..." });

test("passes a WebRTC offer and candidate through byte-for-byte", () => {
  const f = new ClientFrameFilter();
  const a = frame(1, offer), b = frame(1, JSON.stringify({ type: "webrtc/candidate", value: "candidate:1" }));
  const r = f.push(Buffer.concat([a, b]));
  assert.ok("forward" in r);
  assert.deepEqual((r as any).forward, Buffer.concat([a, b]));
});

test("a real-size offer (over 125 bytes) passes", () => {
  const big = JSON.stringify({ type: "webrtc/offer", value: "a=".repeat(1500) });
  const a = frame(1, big);
  assert.deepEqual((new ClientFrameFilter().push(a) as any).forward, a);
});

test("holds a frame split across chunks until it's complete", () => {
  const f = new ClientFrameFilter();
  const a = frame(1, offer);
  assert.deepEqual((f.push(a.subarray(0, 5)) as any).forward.length, 0);
  assert.deepEqual((f.push(a.subarray(5)) as any).forward, a);
});

test("checks a fragmented message as a whole", () => {
  const f = new ClientFrameFilter();
  const p1 = frame(1, offer.slice(0, 10), false), p2 = frame(0, offer.slice(10), true);
  assert.equal((f.push(p1) as any).forward.length, 0);
  assert.deepEqual((f.push(p2) as any).forward, Buffer.concat([p1, p2]));
});

test("a ping in the middle of a fragmented message is passed on, the message still checked", () => {
  const f = new ClientFrameFilter();
  const p1 = frame(1, offer.slice(0, 10), false), ping = frame(9, ""), p2 = frame(0, offer.slice(10), true);
  assert.deepEqual((f.push(Buffer.concat([p1, ping])) as any).forward, ping);
  assert.deepEqual((f.push(p2) as any).forward, Buffer.concat([p1, p2]));
});

test("refuses MSE, binary, non-JSON, unmasked and oversized messages", () => {
  assert.match((new ClientFrameFilter().push(frame(1, JSON.stringify({ type: "mse", value: "" }))) as any).reject, /only WebRTC/);
  assert.match((new ClientFrameFilter().push(frame(2, Buffer.from([1, 2]))) as any).reject, /binary/);
  assert.match((new ClientFrameFilter().push(frame(1, "hello")) as any).reject, /isn't JSON/);
  assert.match((new ClientFrameFilter().push(frame(1, offer, true, false)) as any).reject, /unmasked/);
  assert.match((new ClientFrameFilter().push(frame(1, "x".repeat(70_000))) as any).reject, /64 KB/);
});

test("a fragmented MSE request is refused and none of it is forwarded", () => {
  const f = new ClientFrameFilter();
  const mse = JSON.stringify({ type: "mse", value: "avc1" });
  assert.equal((f.push(frame(1, mse.slice(0, 5), false)) as any).forward.length, 0);
  assert.match((f.push(frame(0, mse.slice(5))) as any).reject, /only WebRTC/);
});

test("ping, pong and close pass through", () => {
  const f = new ClientFrameFilter();
  const c = Buffer.concat([frame(9, ""), frame(10, ""), frame(8, Buffer.from([3, 232]))]);
  assert.deepEqual((f.push(c) as any).forward, c);
});
