// #47: the HKSV clip generator, driven with a fake recording buffer (no ffmpeg, no HomeKit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CameraRecordingConfiguration, RecordingPacket } from "hap-nodejs";
import { RecordingDelegate, describeCloseReason } from "../src/recordingDelegate";
import { Prebuffer, PrebufferSession } from "../src/prebuffer";
import { Logger, setLogLevel } from "../src/logger";
import { captureLogs, fakeCamera } from "./helpers/fakes";

setLogLevel("error");

const INIT = Buffer.from("ftyp+moov");
const frag = (n: number) => Buffer.from(`moof+mdat #${n}`);

/** A stand-in for Prebuffer: what openSession returns, and the live subscribers it hands fragments to. */
class FakePrebuffer {
  started = 0;
  stopped = 0;
  init: Buffer | null = INIT;
  prebuffered: Buffer[] = [frag(1), frag(2)];
  readonly subs = new Set<(f: Buffer) => void>();
  async start(): Promise<void> { this.started++; }
  stop(): void { this.stopped++; }
  async waitForInit(): Promise<boolean> { return this.init !== null; }
  openSession(): PrebufferSession | null {
    if (!this.init) return null;
    return {
      initSegment: this.init,
      prebufferedFragments: this.prebuffered,
      subscribeLive: (cb) => { this.subs.add(cb); return () => { this.subs.delete(cb); }; },
    };
  }
  /** Send a live fragment to every open clip. */
  live(f: Buffer): void { for (const s of this.subs) s(f); }
}

const config = (fragmentLength = 4000) => ({
  videoCodec: { resolution: [1920, 1080, 15] },
  mediaContainerConfiguration: { fragmentLength },
  prebufferLength: 4000,
} as unknown as CameraRecordingConfiguration);

function delegate(over: Parameters<typeof fakeCamera>[0] = {}): { rd: RecordingDelegate; pb: FakePrebuffer } {
  const pb = new FakePrebuffer();
  const rd = new RecordingDelegate(fakeCamera(over), pb as unknown as Prebuffer, new Logger("test"));
  rd.updateRecordingConfiguration(config());
  return { rd, pb };
}

const text = (p: RecordingPacket) => p.data.toString();

test("HomeKit switching recording on starts the buffer; off stops it", () => {
  const { rd, pb } = delegate();
  rd.updateRecordingActive(true);
  assert.equal(pb.started, 1);
  assert.equal(rd.isRecordingActive(), true);
  rd.updateRecordingActive(false);
  assert.equal(pb.stopped, 1);
  assert.equal(rd.isRecordingActive(), false);
});

test("a clip is the init segment first, then the pre-roll, then live fragments; the clip counts as active", async () => {
  const { rd, pb } = delegate();
  rd.updateRecordingActive(true);
  const gen = rd.handleRecordingStreamRequest(7, new AbortController().signal);
  const got: RecordingPacket[] = [];
  for (let i = 0; i < 3; i++) got.push((await gen.next()).value as RecordingPacket);
  assert.deepEqual(got.map(text), ["ftyp+moov", "moof+mdat #1", "moof+mdat #2"]);
  assert.ok(got.every((p) => p.isLast === false));
  assert.equal(rd.activeClips(), 1);
  assert.equal(pb.subs.size, 1, "the clip subscribed to live fragments");
  const next = gen.next();
  pb.live(frag(3));
  assert.equal(text((await next).value as RecordingPacket), "moof+mdat #3");
  await gen.return(undefined);
  assert.equal(rd.activeClips(), 0);
  assert.equal(pb.subs.size, 0, "the live subscription was dropped");
});

test("the fragment cap marks the last fragment isLast and ends the clip", async () => {
  // 1 s max at 4 s fragments: ceil(1000/4000) + 4 = 5 fragments at most.
  const { rd, pb } = delegate({ maxRecordingSeconds: 1 });
  rd.updateRecordingActive(true);
  const gen = rd.handleRecordingStreamRequest(8);
  const got: RecordingPacket[] = [];
  for (let i = 0; i < 3; i++) got.push((await gen.next()).value as RecordingPacket);
  for (let n = 3; n <= 6; n++) {
    const p = gen.next();
    pb.live(frag(n));
    const r = await p;
    if (r.done) break;
    got.push(r.value as RecordingPacket);
    if ((r.value as RecordingPacket).isLast) break;
  }
  const last = got[got.length - 1];
  assert.equal(last.isLast, true, "the last fragment is marked isLast");
  assert.equal(got.length, 6, "init + 2 pre-roll + 3 live = the 5-fragment cap");
  assert.equal((await gen.next()).done, true, "nothing after isLast");
  assert.equal(rd.activeClips(), 0);
});

test("HomeKit aborting the clip (AbortSignal) ends the generator and frees the clip", async () => {
  const { rd, pb } = delegate();
  rd.updateRecordingActive(true);
  const ac = new AbortController();
  const gen = rd.handleRecordingStreamRequest(9, ac.signal);
  for (let i = 0; i < 3; i++) await gen.next();
  const waiting = gen.next();
  ac.abort();
  assert.equal((await waiting).done, true);
  assert.equal(rd.activeClips(), 0);
  assert.equal(pb.subs.size, 0);
});

test("closeRecordingStream ends the clip that is waiting for live fragments", async () => {
  const { rd, pb } = delegate();
  rd.updateRecordingActive(true);
  const gen = rd.handleRecordingStreamRequest(10);
  for (let i = 0; i < 3; i++) await gen.next();
  const waiting = gen.next();
  rd.closeRecordingStream(10, 0 as never);
  assert.equal((await waiting).done, true);
  assert.equal(rd.activeClips(), 0);
  assert.equal(pb.subs.size, 0);
});

test("#10: describeCloseReason names HAP's close reasons in plain words", () => {
  assert.equal(describeCloseReason(6), "TIMEOUT (6): HomeKit timed out waiting for video");
  assert.equal(describeCloseReason(0), "NORMAL (0): the clip ended normally");
  assert.match(describeCloseReason(7), /^BAD_DATA \(7\)/);
  assert.equal(describeCloseReason(undefined), "the HomeKit data connection closed");
  assert.equal(describeCloseReason(42), "unknown reason 42");
});

test("#10: a clip closed with a non-zero reason is a WARN naming it; a normal close stays INFO", () => {
  const { rd } = delegate();
  const logs = captureLogs();
  try {
    rd.closeRecordingStream(20, 6 as never);
    rd.closeRecordingStream(21, 0 as never);
    rd.closeRecordingStream(22, undefined);
    const warns = logs.warns();
    assert.equal(warns.length, 1, warns.join("\n"));
    assert.match(warns[0], /recording stream 20 closed with TIMEOUT \(6\): HomeKit timed out waiting for video/);
    assert.ok(logs.lines.some((l) => l.includes("[INFO]") && l.includes("recording stream 21 closed (NORMAL (0)")), logs.lines.join("\n"));
    assert.ok(logs.lines.some((l) => l.includes("[INFO]") && l.includes("recording stream 22 closed (the HomeKit data connection closed)")), logs.lines.join("\n"));
  } finally {
    logs.restore();
  }
});

test("no init segment after the warm-up: the clip is aborted with an ERROR, nothing is sent", async () => {
  const { rd, pb } = delegate();
  pb.init = null;
  rd.updateRecordingActive(true);
  const logs = captureLogs();
  try {
    const gen = rd.handleRecordingStreamRequest(11);
    assert.equal((await gen.next()).done, true);
    assert.ok(logs.lines.some((l) => l.includes("[ERROR]") && l.includes("recording stream 11") && l.includes("Aborting clip")), logs.lines.join("\n"));
    assert.equal(rd.activeClips(), 0);
  } finally {
    logs.restore();
  }
});

test("a clip requested while HomeKit has recording off still runs, with a WARN saying so", async () => {
  const { rd } = delegate();
  const logs = captureLogs();
  try {
    const gen = rd.handleRecordingStreamRequest(12);
    assert.equal(text((await gen.next()).value as RecordingPacket), "ftyp+moov");
    assert.ok(logs.warns().some((l) => l.includes("recording stream 12 requested but recording is not active")), logs.lines.join("\n"));
    await gen.return(undefined);
  } finally {
    logs.restore();
  }
});
