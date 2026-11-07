// #87: a per-camera main-or-sub choice for each consumer: snapshot, live view and recording here (the wall
// tile's choice is the dashboard's own setting, tested with the dashboard). The default for all of them is
// how it worked before: snapshots automatic (the cheapest still), live view and recording on main.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrepareStreamRequest, StreamingRequest, StreamRequestTypes, AudioStreamingCodecType } from "hap-nodejs";
import { resolveConfig, ConfigError, DEFAULT_STREAMS, ResolvedCamera, Config } from "../src/config";
import { directPicker, FeedChoice, FeedWant, Go2rtcHealth, SourceSelector, streamChangeNotes } from "../src/source";
import { StreamingDelegate } from "../src/streamingDelegate";
import { Prebuffer } from "../src/prebuffer";
import { UnscryptedCamera } from "../src/camera";
import { Logger, setLogLevel } from "../src/logger";
import { captureLogs, fakeCamera, fakeFfmpeg, FFMPEG, until } from "./helpers/fakes";

setLogLevel("error");
const MAIN = "rtsp://u:p@127.0.0.1:8554/main";
const SUB = "rtsp://u:p@127.0.0.1:8554/sub";
/** The same two streams as go2rtc's loopback restream serves them. */
const G_MAIN = "rtsp://127.0.0.1:8554/garage_cam";
const G_SUB = "rtsp://127.0.0.1:8554/garage_cam_sub";

// ---- config validation ----

const cfg = (cam: Record<string, unknown>): Config => ({ cameras: [{ name: "Garage", rtspMain: MAIN, rtspSub: SUB, ...cam }] } as Config);
const streamsOf = (c: Config) => resolveConfig(c, "/").cameras[0].streams;
const refused = (c: Config, ...parts: RegExp[]) => assert.throws(() => resolveConfig(c, "/"), (e: unknown) => {
  assert.ok(e instanceof ConfigError, "a ConfigError");
  for (const p of parts) assert.match((e as Error).message, p);
  return true;
});

test("a camera with no streams setting gets today's behaviour: snapshots automatic, live view and recording on main", () => {
  assert.deepEqual(streamsOf(cfg({})), { snapshot: "auto", live: "main", recording: "main" });
  assert.deepEqual(DEFAULT_STREAMS, { snapshot: "auto", live: "main", recording: "main" });
  assert.deepEqual(streamsOf(cfg({ streams: {} })), DEFAULT_STREAMS);
  assert.deepEqual(streamsOf(cfg({ streams: null })), DEFAULT_STREAMS);
});

test("valid choices are kept, key by key; the others stay at their default", () => {
  assert.deepEqual(streamsOf(cfg({ streams: { live: "sub" } })), { snapshot: "auto", live: "sub", recording: "main" });
  assert.deepEqual(streamsOf(cfg({ streams: { snapshot: "main", recording: "sub" } })), { snapshot: "main", live: "main", recording: "sub" });
  assert.deepEqual(streamsOf(cfg({ streams: { snapshot: "auto", live: "main", recording: "main" } })), DEFAULT_STREAMS);
});

test("a bad choice is refused by name, saying what's allowed", () => {
  refused(cfg({ streams: { live: "auto" } }), /cameras\[0\] "Garage"/, /streams\.live/, /"main" or "sub"/, /"auto"/);
  refused(cfg({ streams: { snapshot: "huge" } }), /streams\.snapshot/, /"auto" or "main" or "sub"/);
  refused(cfg({ streams: { recording: 2 } }), /streams\.recording/);
  refused(cfg({ streams: { liev: "sub" } }), /unknown streams key "liev"/, /snapshot, live, recording/);
  refused(cfg({ streams: "sub" }), /streams must be an object/);
  refused(cfg({ streams: ["sub"] }), /streams must be an object/);
});

test("Sub needs a sub stream: refused by name with the fix, for each consumer", () => {
  for (const k of ["snapshot", "live", "recording"]) {
    refused(cfg({ rtspSub: undefined, streams: { [k]: "sub" } }), new RegExp(`streams\\.${k} is "sub" but this camera has no sub stream configured`), /rtspSub/, /choose "main"/);
  }
  // main is always fine without a sub, and a camera set up by address + paths always has a sub path to use
  assert.deepEqual(streamsOf(cfg({ rtspSub: undefined, streams: { snapshot: "main", live: "main", recording: "main" } })), { snapshot: "main", live: "main", recording: "main" });
  assert.equal(streamsOf({ cameras: [{ name: "Cam", host: "10.0.0.5", streams: { live: "sub" } }] } as Config).live, "sub");
});

// ---- who reads what ----

const cam = (streams: Partial<ResolvedCamera["streams"]> = {}, over: Partial<ResolvedCamera> = {}): ResolvedCamera =>
  fakeCamera({ name: "Garage Cam", rtspMain: MAIN, rtspSub: SUB, streams: { ...DEFAULT_STREAMS, ...streams }, ...over });
const up: Go2rtcHealth = { supervisor: "running", apiOk: true, rtspOk: true, at: 1, error: null, startedAt: 0 };
function selector(c: ResolvedCamera, live: "go2rtc" | "camera" = "go2rtc"): SourceSelector {
  const sel = new SourceSelector({ rtspPort: 8554, log: new Logger("test"), live, now: () => 100_000 });
  sel.setCameras([c]);
  sel.update(up);
  return sel;
}
const WANTS: FeedWant[] = ["snapshot", "live", "recording"];
const streamOf = (f: FeedChoice | null) => f?.stream ?? null;

test("default unchanged, through go2rtc: snapshot -> the cheapest (sub), live view and recording -> main", () => {
  const p = selector(cam()).picker(cam());
  assert.deepEqual(WANTS.map((w) => streamOf(p(w))), ["sub", "main", "main"]);
  assert.equal(p("recording")!.url, G_MAIN);
  assert.equal(p("snapshot")!.url, G_SUB);
});

test("default unchanged, reading the camera itself: snapshot -> sub, live view and recording -> main", () => {
  const c = cam();
  const restreamOff = new SourceSelector({ rtspPort: null, log: new Logger("test") });
  restreamOff.setCameras([c]);
  for (const p of [directPicker(c), restreamOff.picker(c)]) {
    assert.deepEqual(WANTS.map((w) => p(w)!.url), [SUB, MAIN, MAIN]);
  }
  // no sub stream at all: the snapshot falls back to main, as before
  assert.equal(directPicker(cam({}, { rtspSub: undefined }))("snapshot")!.url, MAIN);
});

test("each consumer follows its own choice, and only its own", () => {
  const c = cam();
  const p = selector(c).picker(c);
  const direct = directPicker(c);
  // live view -> sub (via go2rtc and via the camera): snapshots and recording don't move
  c.streams = { ...DEFAULT_STREAMS, live: "sub" };
  assert.deepEqual(WANTS.map((w) => streamOf(p(w))), ["sub", "sub", "main"]);
  assert.equal(p("live")!.url, G_SUB);
  assert.equal(direct("live")!.url, SUB);
  assert.equal(selector(c, "camera").picker(c)("live")!.url, SUB, "the camera-per-viewer live policy reads the chosen stream too");
  // recording -> sub: only the recording moves
  c.streams = { ...DEFAULT_STREAMS, recording: "sub" };
  assert.deepEqual(WANTS.map((w) => streamOf(p(w))), ["sub", "main", "sub"]);
  assert.equal(p("recording")!.url, G_SUB);
  assert.equal(direct("recording")!.url, SUB);
  // snapshot -> main (a fixed choice, no longer "the cheapest"), then -> sub
  c.streams = { ...DEFAULT_STREAMS, snapshot: "main" };
  assert.deepEqual(WANTS.map((w) => streamOf(p(w))), ["main", "main", "main"]);
  assert.equal(direct("snapshot")!.url, MAIN);
  c.streams = { ...DEFAULT_STREAMS, snapshot: "sub", live: "sub", recording: "sub" };
  assert.deepEqual(WANTS.map((w) => streamOf(p(w))), ["sub", "sub", "sub"]);
});

test("automatic snapshots still prefer a stream go2rtc already holds; a fixed choice ignores that", () => {
  const c = cam();
  const sel = selector(c);
  sel.update({ ...up, at: 2, streams: { garage_cam: { state: "streaming", errorAt: null, error: null }, garage_cam_sub: { state: "idle", errorAt: null, error: null } } });
  assert.equal(streamOf(sel.picker(c)("snapshot")), "main", "main is the one go2rtc is already holding");
  c.streams = { ...DEFAULT_STREAMS, snapshot: "sub" };
  assert.equal(streamOf(sel.picker(c)("snapshot")), "sub", "a fixed 'sub' opens the sub stream regardless");
});

test("the setup is read at each spawn: a saved change reaches the next pipeline without a restart of anything", () => {
  const c = cam();
  const p = selector(c).picker(c);
  assert.equal(streamOf(p("live")), "main");
  Object.assign(c, { streams: { ...DEFAULT_STREAMS, live: "sub" } });   // what UnscryptedCamera.reconfigure() does
  assert.equal(streamOf(p("live")), "sub");
});

test("what a saved change says it will do, in words, one sentence per consumer that changed", () => {
  assert.deepEqual(streamChangeNotes(DEFAULT_STREAMS, DEFAULT_STREAMS), []);
  const notes = streamChangeNotes(DEFAULT_STREAMS, { snapshot: "sub", live: "sub", recording: "sub" });
  assert.equal(notes.length, 3);
  assert.match(notes[0], /^Snapshots now use the sub stream/);
  assert.match(notes[1], /^Live view now uses the sub stream; a live view that's already open keeps its current stream/);
  assert.match(notes[2], /^The recording buffer now reads the sub stream: it switches over now .*finishes first/);
});

// ---- the consumers ----

let n = 0;
const prep = (): PrepareStreamRequest => {
  const key = Buffer.alloc(16, 1), salt = Buffer.alloc(14, 2);
  return { sessionID: `s-${++n}-0000-0000`, sourceAddress: "127.0.0.1", targetAddress: "127.0.0.1", addressVersion: "ipv4",
    video: { port: 40000, srtpCryptoSuite: 0, srtp_key: key, srtp_salt: salt }, audio: { port: 40002, srtpCryptoSuite: 0, srtp_key: key, srtp_salt: salt } } as PrepareStreamRequest;
};
const start = (id: string) => ({ sessionID: id, type: StreamRequestTypes.START,
  video: { codec: 0, profile: 1, level: 2, packetizationMode: 0, width: 1280, height: 720, fps: 15, pt: 99, ssrc: 1, max_bit_rate: 800, rtcp_interval: 0.5, mtu: 1378 },
  audio: { codec: AudioStreamingCodecType.OPUS, channel: 1, bit_rate: 0, sample_rate: 16, packet_time: 20, pt: 110, ssrc: 2, max_bit_rate: 24, rtcp_interval: 5, comfort_pt: 13, comfortNoiseEnabled: false } } as unknown as StreamingRequest);

async function liveInput(c: ResolvedCamera): Promise<string> {
  const ff = fakeFfmpeg(FFMPEG.runs);
  const sd = new StreamingDelegate(c, "fake-ffmpeg", new Logger("test"), selector(c, "camera").picker(c), undefined, ff);
  const req = prep();
  await new Promise<void>((res, rej) => { void sd.prepareStream(req, (err) => (err ? rej(err) : res())); });
  const err = await new Promise<Error | undefined>((res) => sd.handleStreamRequest(start(req.sessionID), (e) => res(e)));
  assert.equal(err, undefined);
  const args = ff.calls[0];
  await new Promise<void>((res) => { sd.handleStreamRequest({ sessionID: req.sessionID, type: StreamRequestTypes.STOP } as StreamingRequest, () => res()); });
  sd.shutdown();
  return args[args.indexOf("-i") + 1];
}

test("live view reads the stream it's set to: main by default, sub when chosen", async () => {
  assert.equal(await liveInput(cam()), MAIN);
  assert.equal(await liveInput(cam({ live: "sub" })), SUB);
  assert.equal(await liveInput(cam({ recording: "sub", snapshot: "sub" })), MAIN, "the other choices don't move live view");
});

test("snapshots ask for the snapshot stream: the choice reaches the feed that is read (and reported if it fails)", async () => {
  for (const [choice, want] of [[undefined, "sub"], ["main", "main"], ["sub", "sub"]] as const) {
    const c = cam(choice ? { snapshot: choice } : {});
    const reported: FeedChoice[] = [];
    const sd = new StreamingDelegate(c, "fake-ffmpeg", new Logger("test"), selector(c).picker(c), (f) => reported.push(f),
      { resolve: async () => process.execPath });   // "ffmpeg" is node here: it can't make a picture, which is fine: we want the feed it was given
    await (sd as unknown as { captureSnapshot(w: number, h: number): Promise<unknown> }).captureSnapshot(640, 360).catch(() => undefined);
    sd.shutdown();
    assert.equal(reported[0]?.stream, want, `snapshot ${choice ?? "(default)"} read the ${want} stream`);
  }
});

test("the recording buffer reads the recording stream: main by default, sub when chosen, and says which", async () => {
  const logs = captureLogs();
  try {
    for (const [choice, url, word] of [[undefined, G_MAIN, "main"], ["sub", G_SUB, "sub"]] as const) {
      const c = cam(choice ? { recording: choice } : {});
      const ff = fakeFfmpeg(FFMPEG.runs);
      const pb = new Prebuffer(c, "fake-ffmpeg", new Logger("test"), selector(c).picker(c), undefined, { ffmpeg: ff });
      await pb.start();
      assert.equal(ff.calls[0][ff.calls[0].indexOf("-i") + 1], url);
      assert.equal(pb.currentStream(), word);
      assert.equal(pb.status().stream, word);
      assert.ok(logs.lines.some((l) => new RegExp(`prebuffer running \\(.*${word} stream, reading through go2rtc\\)`).test(l)), logs.lines.join("\n"));
      pb.stop();
    }
  } finally { logs.restore(); }
});

/** A camera object wired the way production is, but with its recording buffer reading from a fake ffmpeg. */
function liveCamera(streams: Partial<ResolvedCamera["streams"]> = {}) {
  const c = cam(streams);
  const sel = selector(c);
  const ucam = new UnscryptedCamera(c, "ffmpeg", new Logger("test"), sel);
  const ff = fakeFfmpeg(FFMPEG.runs);
  const inner = ucam as unknown as { prebuffer: Prebuffer; recordingDelegate: { activeClips(): number } | undefined; pick: ReturnType<SourceSelector["picker"]>; camera: ResolvedCamera };
  const pb = new Prebuffer(inner.camera, "fake-ffmpeg", new Logger("test"), inner.pick, undefined, { ffmpeg: ff });
  inner.prebuffer = pb;
  return { ucam, pb, ff, inner, c };
}
const inputOf = (args: string[]) => args[args.indexOf("-i") + 1];

test("changing the recording stream restarts the buffer on the new stream, says so (camera and stream), and never cuts a clip", async () => {
  const logs = captureLogs();
  try {
    const { ucam, pb, ff, c } = liveCamera();
    await pb.start();
    assert.equal(inputOf(ff.calls[0]), G_MAIN);
    ucam.reconfigure({ ...c, streams: { ...DEFAULT_STREAMS, recording: "sub" } });
    await until(() => ff.calls.length === 2 && pb.currentStream() === "sub", "the buffer restarted on the sub stream");
    assert.equal(inputOf(ff.calls[1]), G_SUB, "the new ffmpeg reads the sub stream");
    assert.ok(logs.lines.some((l) => /"Garage Cam": recording buffer switching to reading the sub stream through go2rtc \(it was reading the main stream\) \(the next few seconds of pre-roll are lost\)/.test(l)), logs.lines.join("\n"));
    assert.equal(logs.warns().filter((l) => /clip/.test(l)).length, 0, "no clip was cut");
    // and back again
    ucam.reconfigure({ ...c, streams: { ...DEFAULT_STREAMS } });
    await until(() => ff.calls.length === 3 && pb.currentStream() === "main", "back on main");
    pb.stop();
  } finally { logs.restore(); }
});

test("a clip being recorded finishes on the old stream first; the switch follows once it has ended", async () => {
  const logs = captureLogs();
  try {
    const { ucam, pb, ff, inner, c } = liveCamera();
    let clips = 1;
    inner.recordingDelegate = { activeClips: () => clips };
    await pb.start();
    ucam.reconfigure({ ...c, streams: { ...DEFAULT_STREAMS, recording: "sub" } });
    assert.equal(ff.calls.length, 1, "not restarted while the clip is being recorded");
    assert.equal(pb.currentStream(), "main");
    assert.ok(logs.lines.some((l) => /"Garage Cam": recording buffer will switch to reading the sub stream through go2rtc \(it was reading the main stream\) as soon as the clip being recorded ends/.test(l)));
    clips = 0;
    await until(() => ff.calls.length === 2 && pb.currentStream() === "sub", "the switch after the clip ended", 6000);
    assert.equal(inputOf(ff.calls[1]), G_SUB);
    pb.stop();
  } finally { logs.restore(); }
});

test("changing only the live or snapshot choice leaves a running recording buffer alone", async () => {
  const { ucam, pb, ff, c } = liveCamera();
  await pb.start();
  ucam.reconfigure({ ...c, streams: { ...DEFAULT_STREAMS, live: "sub", snapshot: "main" } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ff.calls.length, 1, "the buffer wasn't restarted");
  assert.equal(pb.currentStream(), "main");
  pb.stop();
});
