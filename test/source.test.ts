import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSourceState, SourceState, DEFAULT_TIMINGS as T, Go2rtcHealth, SourceSelector, sourceText, cameraDirectText } from "../src/source";
import { Logger, setLogLevel } from "../src/logger";

setLogLevel("error");
const up = (at: number, startedAt: number | null = 0): Go2rtcHealth => ({ supervisor: "running", apiOk: true, rtspOk: true, at, error: null, startedAt });
const down = (at: number): Go2rtcHealth => ({ supervisor: "backoff", apiOk: false, rtspOk: false, at, error: "go2rtc isn't running (backoff: exited with code 1)", startedAt: null });
const boot: SourceState = { mode: "go2rtc", since: 0, reason: null, downSince: null, healthySince: null, unhealthySince: 0, returnAt: null };
const run = (s: SourceState, steps: Go2rtcHealth[]) => steps.reduce((acc, h) => nextSourceState(acc, h, T), s);
const every5s = (from: number, to: number, f: (t: number) => Go2rtcHealth) => { const o = []; for (let t = from; t <= to; t += 5000) o.push(f(t)); return o; };

test("a short go2rtc blip (a reload) doesn't switch", () => {
  const s = run(boot, [up(5000), down(10_000), down(15_000), up(20_000)]);
  assert.equal(s.mode, "go2rtc");
});

test("down for 15 s switches to direct, with the reason and when it went down", () => {
  const s = run(boot, [up(5000), ...every5s(10_000, 25_000, down)]);
  assert.equal(s.mode, "direct");
  assert.equal(s.downSince, 10_000);
  assert.match(s.reason!, /backoff/);
});

test("comes back only after 60 s healthy AND 2 min in direct", () => {
  let s = run(boot, [up(5000), ...every5s(10_000, 25_000, down)]);            // direct since 25 s
  s = run(s, every5s(30_000, 100_000, up));                                     // healthy since 30 s
  assert.equal(s.mode, "direct", "healthy 70 s but only 75 s in direct");
  assert.equal(s.returnAt, 145_000);
  s = run(s, every5s(105_000, 145_000, up));
  assert.equal(s.mode, "go2rtc");
});

test("a crash-looping go2rtc (up 30 s, down 5 s) stays direct", () => {
  let s = run(boot, [up(5000), ...every5s(10_000, 25_000, down)]);
  for (let t = 30_000; t < 600_000; t += 35_000) s = run(s, [...every5s(t, t + 25_000, up), down(t + 30_000)]);
  assert.equal(s.mode, "direct");
});

test("never healthy after boot: direct 15 s in", () => {
  assert.equal(run(boot, every5s(5000, 15_000, down)).mode, "direct");
});

test("off mode never changes, and the selector always picks the camera", () => {
  const sel = new SourceSelector({ rtspPort: null, offReason: "go2rtc is switched off in this instance (UNSCRYPTED_GO2RTC=off)", log: new Logger("t"), now: () => 0 });
  sel.update(up(1));
  assert.equal(sel.state().mode, "off");
  sel.setCameras([{ name: "Cam", rtspSub: undefined }]);
  assert.deepEqual(sel.picker({ name: "Cam", rtspMain: "rtsp://u:p@h/11" })("main"), { url: "rtsp://u:p@h/11", via: "camera" });
  assert.match(sourceText(sel.state(), String), /^HomeKit reads the cameras directly: go2rtc is switched off/);
});

test("picker: restream in go2rtc mode, camera in direct mode, null for a missing sub; listeners hear switches", () => {
  let now = 0;
  const sel = new SourceSelector({ rtspPort: 8554, log: new Logger("t"), now: () => now });
  sel.setCameras([{ name: "Garage Cam", rtspSub: "rtsp://u:p@h/12" }, { name: "NoSub" }]);
  const pick = sel.picker({ name: "Garage Cam", rtspMain: "rtsp://u:p@h/11", rtspSub: "rtsp://u:p@h/12" });
  assert.deepEqual(pick("main"), { url: "rtsp://127.0.0.1:8554/garage_cam", via: "go2rtc" });
  assert.deepEqual(pick("sub"), { url: "rtsp://127.0.0.1:8554/garage_cam_sub", via: "go2rtc" });
  assert.equal(sel.picker({ name: "NoSub", rtspMain: "rtsp://x/1" })("sub"), null);
  let heard = 0; sel.onChange(() => heard++);
  for (now = 5000; now <= 20_000; now += 5000) sel.update(down(now));
  assert.equal(heard, 1);
  assert.deepEqual(pick("main"), { url: "rtsp://u:p@h/11", via: "camera" });
});

test("status text says direct, why and since when, in plain words", () => {
  const s = run(boot, [up(5000), ...every5s(10_000, 25_000, down)]);
  const txt = sourceText(s, (ms) => `<${ms}>`);
  assert.match(txt, /^HomeKit is reading the cameras directly because go2rtc is down \(since <10000>\)/);
  assert.match(txt, /switches back on its own/);
  assert.match(sourceText({ ...boot, unhealthySince: null }, String), /through go2rtc/);
});

// Per-camera fallback (owner Q3 = yes): 3 failures in 2 min -> that camera alone direct for 10 min.
function perCam() {
  let now = 100_000;
  const sel = new SourceSelector({ rtspPort: 8554, log: new Logger("t"), now: () => now });
  sel.setCameras([{ name: "Garage", rtspSub: undefined }, { name: "Dog", rtspSub: undefined }]);
  sel.update(up(now, 0));                     // go2rtc healthy, started long ago
  const garage = sel.picker({ name: "Garage", rtspMain: "rtsp://u:p@10.0.0.3/11" });
  const dog = sel.picker({ name: "Dog", rtspMain: "rtsp://u:p@10.0.0.99/11" });
  return { sel, garage, dog, at: (t: number) => { now = t; }, get now() { return now; } };
}

test("per camera: 3 go2rtc failures within 2 min send that camera alone direct, with the reason", () => {
  const p = perCam();
  let heard = 0; p.sel.onChange(() => heard++);
  const fail = p.sel.failureReporter({ name: "Garage" });
  p.at(110_000); fail(p.garage("main")!, "ffmpeg exited (code 1)");
  p.at(130_000); fail(p.garage("main")!, "ffmpeg exited (code 1)");
  assert.equal(p.garage("main")!.via, "go2rtc", "2 failures: still through go2rtc");
  p.at(150_000); fail(p.garage("main")!, "no video for 10 s");
  assert.equal(p.garage("main")!.via, "camera");
  assert.equal(p.dog("main")!.via, "go2rtc", "other cameras keep reading through go2rtc");
  assert.equal(p.sel.state().mode, "go2rtc", "the global mode doesn't change");
  assert.equal(heard, 1);
  const d = p.sel.cameraDirect("Garage")!;
  assert.equal(d.until, 150_000 + 600_000);
  assert.match(d.reason, /3 times within 2m0s \(last: no video for 10 s\)/);
  assert.match(cameraDirectText("Garage", d, (ms) => `<${ms}>`), /^HomeKit is reading "Garage" directly \(since <150000>\).*tries go2rtc again for it at <750000>/);
  // 10 minutes later the next health check sends it back through go2rtc.
  p.at(749_000); p.sel.update(up(749_000, 0));
  assert.equal(p.garage("main")!.via, "camera");
  p.at(750_000); p.sel.update(up(750_000, 0));
  assert.equal(p.garage("main")!.via, "go2rtc");
  assert.equal(p.sel.cameraDirect("Garage"), null);
  assert.equal(heard, 2);
});

test("per camera: failures spread over more than 2 min, or direct reads, don't count", () => {
  const p = perCam();
  const fail = p.sel.failureReporter({ name: "Garage" });
  for (const t of [110_000, 180_000, 250_000, 320_000]) { p.at(t); fail(p.garage("main")!, "EOF"); }
  assert.equal(p.garage("main")!.via, "go2rtc");
  for (const t of [330_000, 340_000, 350_000]) { p.at(t); fail({ url: "rtsp://u:p@10.0.0.3/11", via: "camera" }, "EOF"); }
  assert.equal(p.garage("main")!.via, "go2rtc", "a direct read failing is the camera, not go2rtc");
});

test("per camera: failures while go2rtc is unhealthy or just restarted are go2rtc's, not the camera's", () => {
  const p = perCam();
  const fail = p.sel.failureReporter({ name: "Garage" });
  p.at(110_000); fail(p.garage("main")!, "EOF");
  p.at(112_000); fail(p.garage("main")!, "EOF");    // under 3 s after the first: same incident
  p.at(115_000); p.sel.update(down(115_000));        // go2rtc died: the counted failure was its fault
  p.at(118_000); fail(p.garage("main")!, "EOF");     // ignored while unhealthy
  p.at(120_000); p.sel.update(up(120_000, 119_000)); // back, restarted at 119 s
  p.at(125_000); fail(p.garage("main")!, "connection refused"); // inside the 20 s restart grace
  p.at(145_000); fail(p.garage("main")!, "EOF");
  p.at(160_000); fail(p.garage("main")!, "EOF");
  assert.equal(p.garage("main")!.via, "go2rtc", "only 2 failures counted since the restart");
  p.at(170_000); fail(p.garage("main")!, "EOF");
  assert.equal(p.garage("main")!.via, "camera");
});
