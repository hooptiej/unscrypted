// #47: the live-view session lifecycle (prepare -> start -> reconfigure/stop, ffmpeg exits) against a
// fake ffmpeg: the node binary running a one-line script, so exit codes and signals are real.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as dgram from "dgram";
import {
  AudioStreamingCodecType, PrepareStreamRequest, PrepareStreamResponse, StreamingRequest, StreamRequestTypes,
} from "hap-nodejs";
import { StreamingDelegate } from "../src/streamingDelegate";
import { Logger, setLogLevel } from "../src/logger";
import { captureLogs, fakeCamera, fakeFfmpeg, FFMPEG, FakeFfmpeg, until } from "./helpers/fakes";

setLogLevel("error");

let n = 0;
function prepareRequest(): PrepareStreamRequest {
  const key = Buffer.alloc(16, 1);
  const salt = Buffer.alloc(14, 2);
  return {
    sessionID: `session-${++n}-0000-0000`,
    sourceAddress: "127.0.0.1",
    targetAddress: "127.0.0.1",
    addressVersion: "ipv4",
    video: { port: 40000, srtpCryptoSuite: 0, srtp_key: key, srtp_salt: salt },
    audio: { port: 40002, srtpCryptoSuite: 0, srtp_key: key, srtp_salt: salt },
  } as PrepareStreamRequest;
}

const startRequest = (sessionID: string) => ({
  sessionID,
  type: StreamRequestTypes.START,
  video: { codec: 0, profile: 1, level: 2, packetizationMode: 0, width: 1280, height: 720, fps: 15, pt: 99, ssrc: 1, max_bit_rate: 800, rtcp_interval: 0.5, mtu: 1378 },
  audio: { codec: AudioStreamingCodecType.OPUS, channel: 1, bit_rate: 0, sample_rate: 16, packet_time: 20, pt: 110, ssrc: 2, max_bit_rate: 24, rtcp_interval: 5, comfort_pt: 13, comfortNoiseEnabled: false },
} as unknown as StreamingRequest);

type Sockets = { videoReturnSocket: dgram.Socket; audioReturnSocket: dgram.Socket };
/** The session's two RTCP return sockets (private state, read only to watch them close). */
function sockets(sd: StreamingDelegate, sessionID: string): Sockets {
  const inner = sd as unknown as { pendingSessions: Map<string, Sockets>; activeSessions: Map<string, { info: Sockets }> };
  return inner.pendingSessions.get(sessionID) ?? inner.activeSessions.get(sessionID)!.info;
}
function watchClose(s: Sockets): { closed: () => number } {
  let c = 0;
  s.videoReturnSocket.once("close", () => c++);
  s.audioReturnSocket.once("close", () => c++);
  return { closed: () => c };
}

function prepare(sd: StreamingDelegate, req = prepareRequest()): Promise<PrepareStreamResponse> {
  return new Promise((resolve, reject) => {
    void sd.prepareStream(req, (err, res) => (err ? reject(err) : resolve(res!)));
  });
}
function request(sd: StreamingDelegate, req: StreamingRequest): Promise<Error | undefined> {
  return new Promise((resolve) => sd.handleStreamRequest(req, (err) => resolve(err)));
}

function delegate(ff: FakeFfmpeg): StreamingDelegate {
  return new StreamingDelegate(fakeCamera(), "fake-ffmpeg", new Logger("test"), undefined, undefined, ff);
}

async function started(ff: FakeFfmpeg): Promise<{ sd: StreamingDelegate; id: string; s: Sockets }> {
  const sd = delegate(ff);
  const req = prepareRequest();
  const res = await prepare(sd, req);
  assert.ok(res.video && "port" in res.video && res.video.port > 0, "prepare answered with a return port");
  const s = sockets(sd, req.sessionID);
  assert.equal(await request(sd, startRequest(req.sessionID)), undefined, "START succeeded");
  return { sd, id: req.sessionID, s };
}

test("prepare -> start -> stop: ffmpeg runs for the session, then STOP kills it and closes both return sockets", async () => {
  const ff = fakeFfmpeg(FFMPEG.runs);
  const { sd, id, s } = await started(ff);
  assert.equal(sd.liveSessionCount(), 1);
  assert.equal(ff.calls.length, 1);
  const args = ff.calls[0].join(" ");
  assert.match(args, /-i rtsp:\/\/u:p@127\.0\.0\.1:8554\/main/, "reads the camera's main stream");
  assert.match(args, /srtp:\/\/127\.0\.0\.1:40000/, "sends video to the controller's port");
  const sock = watchClose(s);
  assert.equal(await request(sd, { sessionID: id, type: StreamRequestTypes.STOP } as StreamingRequest), undefined);
  assert.equal(sd.liveSessionCount(), 0);
  await until(() => sock.closed() === 2, "both return sockets closed");
});

test("prepare then STOP without a START still closes both return sockets", async () => {
  const sd = delegate(fakeFfmpeg(FFMPEG.runs));
  const req = prepareRequest();
  await prepare(sd, req);
  const sock = watchClose(sockets(sd, req.sessionID));
  await request(sd, { sessionID: req.sessionID, type: StreamRequestTypes.STOP } as StreamingRequest);
  await until(() => sock.closed() === 2, "both return sockets closed");
});

test("START with no prepared session is refused", async () => {
  const sd = delegate(fakeFfmpeg(FFMPEG.runs));
  const err = await request(sd, startRequest("never-prepared"));
  assert.match(String(err?.message), /no pending session/);
  assert.equal(sd.liveSessionCount(), 0);
});

test("ffmpeg failing (non-zero exit) tears the session down and says why", async () => {
  const logs = captureLogs();
  try {
    const { sd, s } = await started(fakeFfmpeg(FFMPEG.fails));
    const sock = watchClose(s);
    await until(() => sd.liveSessionCount() === 0, "the session torn down");
    await until(() => sock.closed() === 2, "both return sockets closed");
    assert.ok(logs.lines.some((l) => /live stream stopped for Test Cam after .* its ffmpeg exited \(code 1\).*Connection refused/.test(l)), logs.lines.join("\n"));
  } finally {
    logs.restore();
  }
});

test("#78: the fast probe missing the video stream is retried once with full probing on the same session", async () => {
  const miss = "process.stderr.write('Output file #0 does not contain any stream\\n'); process.exit(1)";
  const ff = fakeFfmpeg(miss, FFMPEG.runs);
  const { sd, id } = await started(ff);
  await until(() => ff.calls.length === 2, "the full-probing retry");
  assert.ok(ff.calls[0].includes("-probesize"), "the first try used the fast probe");
  assert.ok(!ff.calls[1].includes("-probesize"), "the retry dropped the fast-probe flags");
  assert.equal(sd.liveSessionCount(), 1, "the session survived the miss");
  await request(sd, { sessionID: id, type: StreamRequestTypes.STOP } as StreamingRequest);
  assert.equal(sd.liveSessionCount(), 0);
});

test("RECONFIGURE re-spawns ffmpeg at the new size; the retired ffmpeg's exit doesn't end the session", async () => {
  const ff = fakeFfmpeg(FFMPEG.runs);
  const { sd, id } = await started(ff);
  const reconf = { sessionID: id, type: StreamRequestTypes.RECONFIGURE, video: { width: 640, height: 360, fps: 15, max_bit_rate: 300, rtcp_interval: 0.5 } } as unknown as StreamingRequest;
  assert.equal(await request(sd, reconf), undefined);
  assert.equal(ff.calls.length, 2);
  assert.match(ff.calls[1].join(" "), /min\(640,iw\)/, "the new ffmpeg scales to the new size");
  await new Promise((r) => setTimeout(r, 300));   // the old ffmpeg has been killed and has exited by now
  assert.equal(sd.liveSessionCount(), 1);
  sd.shutdown();
  assert.equal(sd.liveSessionCount(), 0);
});

test("shutdown stops every live session and closes every pending one", async () => {
  const ff = fakeFfmpeg(FFMPEG.runs);
  const { sd, s } = await started(ff);
  const live = watchClose(s);
  const req = prepareRequest();
  await prepare(sd, req);
  const pending = watchClose(sockets(sd, req.sessionID));
  sd.shutdown();
  assert.equal(sd.liveSessionCount(), 0);
  await until(() => live.closed() === 2 && pending.closed() === 2, "all four return sockets closed");
});
