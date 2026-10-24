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

// Owner decision 1 (2026-10-20): camera outages never count toward per-camera fallback.
function outageRig() {
  let now = 100_000;
  const lines: string[] = [];
  const log = new Logger("t");
  log.info = (...a: unknown[]) => { lines.push(a.join(" ")); };
  log.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
  const sel = new SourceSelector({ rtspPort: 8554, log, now: () => now });
  sel.setCameras([{ name: "Garage", rtspSub: "rtsp://u:p@10.0.0.3/12" }, { name: "Dog", rtspSub: undefined }]);
  const garage = sel.picker({ name: "Garage", rtspMain: "rtsp://u:p@10.0.0.3/11", rtspSub: "rtsp://u:p@10.0.0.3/12" });
  const fail = sel.failureReporter({ name: "Garage" });
  const health = (at: number, garageState: string, errorAt: number | null = null): Go2rtcHealth => ({
    ...up(at, 0), streams: {
      garage: { state: garageState, errorAt, error: errorAt === null ? null : "The camera didn't answer at that address." },
      garage_sub: { state: "idle", errorAt: null, error: null },
      dog: { state: "streaming", errorAt: null, error: null },
    } });
  return { sel, garage, fail, lines, health, at: (t: number) => { now = t; } };
}

test("camera outage: go2rtc can't reach the camera either, so failures don't count and it never goes direct", () => {
  for (const st of ["down", "starting", "stalled"]) {
    const r = outageRig();
    r.sel.update(r.health(100_000, st));
    for (const t of [110_000, 130_000, 150_000, 170_000, 190_000]) { r.at(t); r.fail(r.garage("main")!, "ffmpeg exited (code 1)"); }
    assert.equal(r.garage("main")!.via, "go2rtc", `${st}: a rebooting camera reconnects through go2rtc`);
    assert.equal(r.sel.cameraDirect("Garage"), null);
    const ignored = r.lines.filter((l) => /doesn't count toward reading this camera directly/.test(l));
    assert.equal(ignored.length, 1, `${st}: logged once per outage, not per failure`);
    assert.match(ignored[0], /^"Garage": reading through go2rtc failed \(ffmpeg exited \(code 1\)\), but go2rtc/);
  }
});

test("camera outage: a producer error go2rtc logged in the window counts as an outage even when the feed reads idle", () => {
  const r = outageRig();
  r.sel.update(r.health(100_000, "idle", 109_000));   // HomeKit was the only viewer; go2rtc logged its own failure
  for (const t of [110_000, 130_000, 150_000]) { r.at(t); r.fail(r.garage("main")!, "EOF"); }
  assert.equal(r.garage("main")!.via, "go2rtc");
  assert.match(r.lines.join("\n"), /go2rtc's own connection to it also failed at .*didn't answer/);
});

test("camera outage: an old producer error (outside the 2 min window) doesn't hide a go2rtc fault", () => {
  const r = outageRig();
  r.sel.update(r.health(300_000, "streaming", 100_000));
  for (const t of [310_000, 330_000, 350_000]) { r.at(t); r.fail(r.garage("main")!, "EOF"); }
  assert.equal(r.garage("main")!.via, "camera", "go2rtc has video, yet HomeKit's reads through it fail: go2rtc's fault");
});

test("camera outage: earlier counted failures are dropped, the end of the outage is logged, and a later go2rtc fault counts afresh", () => {
  const r = outageRig();
  r.sel.update(r.health(100_000, "streaming"));
  r.at(110_000); r.fail(r.garage("main")!, "EOF");                // counted: go2rtc still showed video
  r.at(115_000); r.sel.update(r.health(115_000, "down", 111_000));  // the camera went away for go2rtc too
  r.at(120_000); r.fail(r.garage("main")!, "EOF");                // ignored, and the first one is dropped
  r.at(200_000); r.sel.update(r.health(200_000, "streaming", 111_000));
  assert.match(r.lines.at(-1)!, /^"Garage": go2rtc has video from the camera again .*HomeKit kept reading it through go2rtc/);
  // Back, and go2rtc has video, but HomeKit's reads keep failing: that's go2rtc's fault and counts.
  // (The producer error at 111 s is still inside the 2 min window until 231 s.)
  r.at(232_000); r.fail(r.garage("main")!, "EOF");
  r.at(252_000); r.fail(r.garage("main")!, "EOF");
  assert.equal(r.garage("main")!.via, "go2rtc", "only 2 counted");
  r.at(272_000); r.fail(r.garage("main")!, "EOF");
  assert.equal(r.garage("main")!.via, "camera");
});

test("camera outage: only the stream that failed is judged (a down sub doesn't excuse a failing main)", () => {
  const r = outageRig();
  const h = r.health(100_000, "streaming");
  h.streams!.garage_sub = { state: "down", errorAt: null, error: null };
  r.sel.update(h);
  for (const t of [110_000, 130_000, 150_000]) { r.at(t); r.fail(r.garage("main")!, "EOF"); }
  assert.equal(r.garage("main")!.via, "camera");
});

// 0.1.7: snapshots never read main while a sub exists (#55), and prefer a stream go2rtc already holds.
test("snapshot picks a held stream, else sub, never main while a sub exists; live follows the policy", () => {
  const log = new Logger("t");
  const cams = [{ name: "Garage", rtspSub: "rtsp://u:p@h/12" }, { name: "NoSub", rtspSub: undefined }];
  const garage = { name: "Garage", rtspMain: "rtsp://u:p@h/11", rtspSub: "rtsp://u:p@h/12" };
  const nosub = { name: "NoSub", rtspMain: "rtsp://u:p@h/1" };
  const sel = new SourceSelector({ rtspPort: 8554, log, now: () => 0 });
  sel.setCameras(cams);
  const view = (state: string) => ({ state, errorAt: null, error: null });
  // Nobody holds anything: sub.
  sel.update({ ...up(1), streams: { garage: view("idle"), garage_sub: view("idle"), nosub: view("idle") } });
  assert.equal(sel.picker(garage)("snapshot")!.url, "rtsp://127.0.0.1:8554/garage_sub");
  assert.equal(sel.picker(nosub)("snapshot")!.url, "rtsp://127.0.0.1:8554/nosub");
  // The recording buffer holds main: a snapshot rides along, no new camera session.
  sel.update({ ...up(2), streams: { garage: view("streaming"), garage_sub: view("idle") } });
  assert.equal(sel.picker(garage)("snapshot")!.url, "rtsp://127.0.0.1:8554/garage");
  // Both held (dash on sub): sub wins, it's cheaper to decode.
  sel.update({ ...up(3), streams: { garage: view("streaming"), garage_sub: view("streaming") } });
  assert.equal(sel.picker(garage)("snapshot")!.url, "rtsp://127.0.0.1:8554/garage_sub");
  // Live view: policy "camera" (default) reads the camera even while go2rtc is healthy; "go2rtc" reads the restream.
  assert.deepEqual(sel.picker(garage)("live"), { url: "rtsp://u:p@h/11", via: "camera" });
  const all = new SourceSelector({ rtspPort: 8554, live: "go2rtc", log, now: () => 0 });
  all.setCameras(cams);
  assert.deepEqual(all.picker(garage)("live"), { url: "rtsp://127.0.0.1:8554/garage", via: "go2rtc" });
  // Direct picker (no go2rtc at all): sub for snapshots, main for live.
  const d = sel.picker(garage); for (let t = 5000; t <= 20_000; t += 5000) sel.update(down(t));
  assert.deepEqual(d("snapshot"), { url: "rtsp://u:p@h/12", via: "camera" });
  assert.deepEqual(d("live"), { url: "rtsp://u:p@h/11", via: "camera" });
});
