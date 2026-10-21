import { test } from "node:test";
import assert from "node:assert/strict";
import { UnscryptedCamera } from "../src/camera";
import { SourceSelector } from "../src/source";
import { Logger, setLogLevel } from "../src/logger";

setLogLevel("error");
const cam = () => ({ name: "Garage", rtspMain: "rtsp://u:p@10.0.1.3:554/11", rtspSub: "rtsp://u:p@10.0.1.3:554/12", hksv: true,
  prebufferSeconds: 4, maxRecordingSeconds: 60, copyVideo: true, audio: false, manufacturer: "x", model: "y", serialNumber: "z" }) as any;
const down = (at: number) => ({ supervisor: "backoff", apiOk: false, rtspOk: false, at, error: "down", startedAt: null });

test("a running prebuffer re-points when the source mode flips, but waits for an active clip", () => {
  let now = 0;
  const sel = new SourceSelector({ rtspPort: 8554, log: new Logger("t"), now: () => now });
  const c = cam(); sel.setCameras([c]);
  const ucam = new UnscryptedCamera(c, "ffmpeg-not-run", new Logger("t"), sel);
  const pb = (ucam as any).prebuffer;
  let restarts = 0;
  pb.isRunning = () => true; pb.currentVia = () => "go2rtc"; pb.restart = () => { restarts++; };
  const rec = (ucam as any).recordingDelegate; let clips = 1; rec.activeClips = () => clips;
  for (now = 5000; now <= 20_000; now += 5000) sel.update(down(now));
  assert.equal(restarts, 0, "a clip is recording: wait");
  assert.equal(ucam.snapshotStatus().via, "camera");
  clips = 0;
  (ucam as any).syncPrebufferSource();
  assert.equal(restarts, 1);
  ucam.shutdown();
});

test("a per-camera switch re-points only that camera's buffer", () => {
  let now = 100_000;
  const sel = new SourceSelector({ rtspPort: 8554, log: new Logger("t"), now: () => now });
  const a = cam(); const b = { ...cam(), name: "Dog", rtspMain: "rtsp://u:p@10.0.1.99:554/11" };
  sel.setCameras([a, b]);
  sel.update({ supervisor: "running", apiOk: true, rtspOk: true, at: now, error: null, startedAt: 0 });
  const ca = new UnscryptedCamera(a, "ffmpeg-not-run", new Logger("t"), sel);
  const cb = new UnscryptedCamera(b, "ffmpeg-not-run", new Logger("t"), sel);
  const counts = { a: 0, b: 0 };
  for (const [u, k] of [[ca, "a"], [cb, "b"]] as const) {
    const pb = (u as any).prebuffer;
    pb.isRunning = () => true; pb.currentVia = () => "go2rtc"; pb.restart = () => { counts[k]++; };
  }
  for (const t of [110_000, 130_000, 150_000]) { now = t; sel.reportFailure("Garage", "EOF"); }
  assert.deepEqual(counts, { a: 1, b: 0 });
  assert.equal(ca.snapshotStatus().via, "camera");
  assert.equal(cb.snapshotStatus().via, "go2rtc");
  ca.shutdown(); cb.shutdown();
});
