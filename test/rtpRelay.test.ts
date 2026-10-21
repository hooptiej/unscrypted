// #55 experiment: the relay re-sends everything ffmpeg sends (RTP and RTCP, from different source ports) from ONE
// port, unchanged, the way go2rtc does.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as dgram from "dgram";
import { RtpRelay, rtpRelayEnabled } from "../src/rtpRelay";
import { Logger, setLogLevel } from "../src/logger";

setLogLevel("error");

const bindLoopback = (): Promise<dgram.Socket> =>
  new Promise((resolve) => { const s = dgram.createSocket("udp4"); s.bind(0, "127.0.0.1", () => resolve(s)); });
const closeAll = (...s: dgram.Socket[]) => s.forEach((x) => { try { x.close(); } catch { /* ignore */ } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("everything ffmpeg sends reaches the controller from ONE source port, bytes unchanged, in order", async () => {
  const controller = await bindLoopback();   // stands in for the phone
  const out = await bindLoopback();          // the socket whose port was announced to the phone
  const ffRtp = await bindLoopback();        // ffmpeg's RTP source port
  const ffRtcp = await bindLoopback();       // ffmpeg's RTCP source port (a different one)
  const relay = await RtpRelay.create({ out, targetAddress: "127.0.0.1", targetPort: controller.address().port, label: "t", log: new Logger("t") });
  const seen: { msg: Buffer; port: number }[] = [];
  controller.on("message", (msg, rinfo) => seen.push({ msg, port: rinfo.port }));

  ffRtp.send(Buffer.from([0x80, 0x63, 0, 1, 1, 2, 3, 4]), relay.ingestPort, "127.0.0.1");
  await wait(20);
  ffRtcp.send(Buffer.from([0x80, 0xc8, 0, 6, 9, 9, 9, 9]), relay.ingestPort, "127.0.0.1");
  await wait(20);
  ffRtp.send(Buffer.from([0x80, 0x63, 0, 2, 5, 6, 7, 8]), relay.ingestPort, "127.0.0.1");
  await wait(50);

  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((x) => x.msg[3]), [1, 6, 2], "order is preserved");
  assert.ok(seen.every((x) => x.port === out.address().port), "RTP and RTCP leave from the announced port");
  assert.notEqual(ffRtp.address().port, ffRtcp.address().port, "ffmpeg itself uses two different source ports");
  assert.deepEqual([...seen[0].msg], [0x80, 0x63, 0, 1, 1, 2, 3, 4], "payload untouched");
  assert.equal(relay.stats().toController, 3);
  assert.equal(relay.stats().bytesToController, 24);
  relay.close();
  closeAll(controller, out, ffRtp, ffRtcp);
});

test("the controller's replies to the announced port are counted, never crash the relay", async () => {
  const controller = await bindLoopback();
  const out = await bindLoopback();
  const relay = await RtpRelay.create({ out, targetAddress: "127.0.0.1", targetPort: controller.address().port, label: "t", log: new Logger("t") });
  controller.send(Buffer.from([0x81, 0xc9, 0, 7]), out.address().port, "127.0.0.1");
  controller.send(Buffer.from([0x81, 0xc9, 0, 7]), out.address().port, "127.0.0.1");
  await wait(50);
  assert.equal(relay.stats().fromController, 2);
  relay.close();
  closeAll(controller, out);
});

test("close() stops relaying, is safe to repeat, and leaves the outbound socket to its owner", async () => {
  const controller = await bindLoopback();
  const out = await bindLoopback();
  const ff = await bindLoopback();
  const relay = await RtpRelay.create({ out, targetAddress: "127.0.0.1", targetPort: controller.address().port, label: "t", log: new Logger("t") });
  const got: Buffer[] = [];
  controller.on("message", (m) => got.push(m));
  relay.close();
  relay.close();
  assert.equal(relay.closed, true);
  ff.send(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), relay.ingestPort, "127.0.0.1");
  await wait(50);
  assert.equal(got.length, 0);
  assert.doesNotThrow(() => out.address(), "the outbound socket is still open");
  closeAll(controller, out, ff);
});

test("a failed send is counted and logged once, not thrown", async () => {
  const out = await bindLoopback();
  const ff = await bindLoopback();
  const warnings: string[] = [];
  const log = new Logger("t");
  (log as any).warn = (m: string) => warnings.push(m);
  const relay = await RtpRelay.create({ out, targetAddress: "256.256.256.256", targetPort: 9, label: "t", log });
  ff.send(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), relay.ingestPort, "127.0.0.1");
  ff.send(Buffer.from([1, 2, 3, 4, 5, 6, 7, 9]), relay.ingestPort, "127.0.0.1");
  await wait(100);
  assert.ok(relay.stats().sendErrors >= 1);
  assert.equal(warnings.filter((w) => w.includes("relay couldn't send")).length, 1, "logged once");
  relay.close();
  closeAll(out, ff);
});

test("the relay is off unless UNSCRYPTED_RTP_PROXY=on", () => {
  assert.equal(rtpRelayEnabled({}), false);
  assert.equal(rtpRelayEnabled({ UNSCRYPTED_RTP_PROXY: "off" }), false);
  assert.equal(rtpRelayEnabled({ UNSCRYPTED_RTP_PROXY: "on" }), true);
});
