// #113: don't blink. A camera isn't called offline on one missed check (a grace period first), and a tile
// that has shown a picture keeps its last frame: plain through a blip, dimmed under the banner once the
// grace has run out. The wall's tile rules are in web/dash/app.js (tileView, a pure function read out of
// the file here, the way glow.test.ts reads glowFor).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { CamGrace, DEFAULT_OFFLINE_GRACE_SECONDS } from "../../src/dash/camGrace";
import { DashRuntime } from "../../src/dash/runtime";
import { DEFAULTS, applySettingsEdit, loadSettings, saveSettings } from "../../src/dash/settings";
import { tempDir } from "../helpers/tmp";
import { Logger, setLogLevel } from "../../src/logger";

setLogLevel("error");
const log = new Logger("test");
const T0 = 1_000_000;
const MISS = "Camera not answering at its RTSP port (no answer within 1.5 s)";

// ---- the grace itself ----

test("a blip shorter than the grace changes nothing: still up, same 'since'", () => {
  const g = new CamGrace(() => 20_000);
  assert.deepEqual(g.observe("garage", null, T0), { state: "up", reason: null, since: T0, failingSince: null });
  const miss = g.observe("garage", MISS, T0 + 4_000);
  assert.equal(miss.state, "up", "one missed check is a hiccup, not an outage");
  assert.equal(miss.since, T0, "the camera's 'since' hasn't moved");
  assert.equal(g.observe("garage", MISS, T0 + 15_000).state, "up", "15 s of misses is still inside the 20 s grace");
  const back = g.observe("garage", null, T0 + 16_000);
  assert.deepEqual(back, { state: "up", reason: null, since: T0, failingSince: null }, "a blip that ends inside the grace never happened");
});

test("past the grace it flips to offline, 'since' being when it first stopped answering", () => {
  const g = new CamGrace(() => 20_000);
  g.observe("garage", null, T0);
  g.observe("garage", MISS, T0 + 4_000);
  assert.equal(g.observe("garage", MISS, T0 + 23_000).state, "up", "19 s after the first miss: not yet");
  const down = g.observe("garage", MISS, T0 + 24_000);
  assert.equal(down.state, "down");
  assert.equal(down.since, T0 + 4_000, "since = the first missed check, not the moment the grace ran out");
  assert.equal(down.reason, MISS);
});

test("recovery clears it, and the camera is up since it came back", () => {
  const g = new CamGrace(() => 20_000);
  g.observe("garage", null, T0);
  for (let t = 4_000; t <= 40_000; t += 4_000) g.observe("garage", MISS, T0 + t);
  assert.equal(g.observe("garage", MISS, T0 + 44_000).state, "down");
  const back = g.observe("garage", null, T0 + 48_000);
  assert.deepEqual(back, { state: "up", reason: null, since: T0 + 48_000, failingSince: null });
});

test("a camera never seen answering is 'checking' until the grace runs out, then offline", () => {
  const g = new CamGrace(() => 20_000);
  assert.equal(g.observe("garage", MISS, T0).state, "checking");
  assert.equal(g.observe("garage", MISS, T0 + 10_000).state, "checking");
  const down = g.observe("garage", MISS, T0 + 21_000);
  assert.equal(down.state, "down");
  assert.equal(down.since, T0);
});

test("the grace is read on every check, so a changed setting applies at once; removed cameras are forgotten", () => {
  let grace = 60_000;
  const g = new CamGrace(() => grace);
  g.observe("a", null, T0);
  assert.equal(g.observe("a", MISS, T0 + 1_000).state, "up");
  assert.equal(g.observe("a", MISS, T0 + 30_000).state, "up", "inside 60 s");
  grace = 10_000;
  assert.equal(g.observe("a", MISS, T0 + 31_000).state, "down", "the shorter grace applies to the miss already being waited out");
  g.keepOnly(new Set());
  assert.equal(g.observe("a", MISS, T0 + 32_000).state, "checking", "a forgotten camera starts over");
});

// ---- the dashboard's runtime ----

function runtime(clock: { t: number }, probeResults: Record<string, string | null>) {
  const dir = tempDir("unscr-hold-");
  saveSettings(path.join(dir, "settings.json"), { ...DEFAULTS, cameras: [
    { camera: "Garage", label: "Garage", shown: true, stream: "main" },
    { camera: "Shed", label: "Shed", shown: false, stream: "main" },
  ] });
  const rt = new DashRuntime({ dir, title: "t", env: "test", adminPort: 8191, log, now: () => clock.t,
    probe: async (host) => (host in probeResults ? probeResults[host] : null) });
  rt.cameras = [
    { name: "Garage", main: "garage", sub: null, probe: { host: "garage", port: 554 } },
    { name: "Shed", main: "shed", sub: null, probe: { host: "shed", port: 554 } },
  ];
  return rt;
}

test("the tile's state follows the grace: a blip shows nothing, offline only after it, recovery clears", async () => {
  const clock = { t: T0 };
  const results: Record<string, string | null> = {};
  const rt = runtime(clock, results);
  await rt.probeCameras();
  const cam = () => (rt.state() as any).cameras.garage;
  assert.equal(cam().up, true);

  results.garage = "no answer within 1.5 s";
  clock.t += 4_000; await rt.probeCameras();
  assert.deepEqual({ up: cam().up, reason: cam().reason, since: cam().since }, { up: true, reason: null, since: T0 }, "a blip: the tile is told nothing");

  clock.t += 12_000; await rt.probeCameras();   // 16 s since the first miss
  assert.equal(cam().up, true);

  clock.t += 9_000; await rt.probeCameras();    // 21 s
  assert.equal(cam().up, false);
  assert.match(cam().reason, /not answering at its RTSP port \(no answer within 1\.5 s\)/);
  assert.equal(cam().since, T0 + 4_000, "since = the first missed check");

  results.garage = null;
  clock.t += 4_000; await rt.probeCameras();
  assert.equal(cam().up, true);
  assert.equal(cam().reason, null);
});

test("the grace is the dashboard setting, applied live", async () => {
  const clock = { t: T0 };
  const results: Record<string, string | null> = {};
  const rt = runtime(clock, results);
  await rt.probeCameras();
  results.garage = "no answer within 1.5 s";
  clock.t += 1_000; await rt.probeCameras();
  clock.t += 8_000; await rt.probeCameras();   // 8 s after the first miss
  assert.equal((rt.state() as any).cameras.garage.up, true, "8 s < the 20 s default");
  rt.settings = { ...rt.settings, offlineGraceSeconds: 5 };
  await rt.probeCameras();
  assert.equal((rt.state() as any).cameras.garage.up, false, "8 s > a 5 s grace");
});

test("cameras switched off on the wall are still checked for Home's fault flag, but not shown in the open API", async () => {
  const clock = { t: T0 };
  const results: Record<string, string | null> = {};
  const rt = runtime(clock, results);
  await rt.probeCameras();
  results.shed = "connection refused (nothing listening)";
  clock.t += 1_000; await rt.probeCameras();
  clock.t += 25_000; await rt.probeCameras();
  assert.deepEqual(rt.reachReport(), { Shed: { since: T0 + 1_000, reason: "Camera not answering at its RTSP port (connection refused (nothing listening))" } });
  assert.equal((rt.state() as any).cameras.shed, undefined, "the open API lists only the cameras on the wall");
  assert.doesNotMatch(JSON.stringify(rt.state()), /shed/i);
  results.shed = null;
  clock.t += 4_000; await rt.probeCameras();
  assert.deepEqual(rt.reachReport(), {}, "back: the all-clear");
});

test("the public config carries the grace for the page", () => {
  const rt = runtime({ t: T0 }, {});
  assert.equal((rt.publicConfig() as any).offlineGraceSeconds, DEFAULT_OFFLINE_GRACE_SECONDS);
});

// ---- the setting ----

const ctx = { cameras: [], fontFiles: [] };

test("the grace defaults to 20 s and is validated 5 to 120 on save", () => {
  assert.equal(DEFAULTS.offlineGraceSeconds, 20);
  assert.equal(applySettingsEdit(DEFAULTS, { offlineGraceSeconds: "30" }, ctx).offlineGraceSeconds, 30);
  for (const bad of [4, 121, 1.5, "soon"]) {
    assert.throws(() => applySettingsEdit(DEFAULTS, { offlineGraceSeconds: bad }, ctx), (e: unknown) =>
      /Call a camera offline after/.test(JSON.stringify((e as { body?: unknown }).body)), `${bad} is refused by name`);
  }
});

test("a hand-edited grace is clamped or defaulted, and the warning says so", () => {
  const dir = tempDir("unscr-grace-");
  const f = path.join(dir, "settings.json");
  fs.writeFileSync(f, JSON.stringify({ offlineGraceSeconds: 900 }));
  let l = loadSettings(f);
  assert.equal(l.settings.offlineGraceSeconds, 120);
  assert.match(l.warning ?? "", /offlineGraceSeconds is 900, so it's 120/);
  fs.writeFileSync(f, JSON.stringify({ offlineGraceSeconds: "soon" }));
  l = loadSettings(f);
  assert.equal(l.settings.offlineGraceSeconds, 20);
  assert.match(l.warning ?? "", /isn't a number/);
  fs.writeFileSync(f, JSON.stringify({ idleSeconds: 45 }));
  l = loadSettings(f);
  assert.equal(l.settings.offlineGraceSeconds, 20, "an old file with no grace gets the default");
  assert.equal(l.warning, null);
});

// ---- what a tile shows (tileView, read out of web/dash/app.js) ----

const app = fs.readFileSync(path.join(__dirname, "..", "..", "web", "dash", "app.js"), "utf8");
const grab = (name: string) => {
  const m = new RegExp(`function ${name}\\([^]*?\\r?\\n}\\r?\\n`).exec(app);
  assert.ok(m, `app.js defines ${name}`);
  return m![0];
};
interface View { stream: string; why: string | null; badge: string; held: string; trouble: { kind: string; since: number } | null; recreate: boolean }
// eslint-disable-next-line no-new-func
const tileView = new Function(`${grab("tileView")}\nreturn tileView;`)() as (i: Record<string, unknown>) => View;

const NOW = 5_000_000;
const GRACE = 20_000;
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  st: { up: true, reason: null, since: NOW - 60_000 }, playerReady: true, go2rtc: { state: "running" }, playing: true, everPlayed: true,
  madeAt: NOW - 60_000, lastPlayingAt: NOW, hasFrame: true, frameAt: NOW - 1_000, which: "main", now: NOW, graceMs: GRACE, recreateMs: 60_000,
  prev: null, clock: (ms: number) => `clock(${ms})`, whenOf: (ms: number) => `when(${ms})`, ...over,
});

test("a tile that's playing shows live: no banner, no kept frame on top", () => {
  const v = tileView(base());
  assert.deepEqual({ why: v.why, badge: v.badge, held: v.held, stream: v.stream }, { why: null, badge: "live · main", held: "none", stream: "start" });
});

test("a blip: the video stalls but the server still says up -> only the kept frame, no banner, no state change", () => {
  // stalled for 6 s of a 20 s grace
  const v = tileView(base({ playing: false, lastPlayingAt: NOW - 6_000 }));
  assert.equal(v.why, null, "no banner");
  assert.equal(v.badge, "live · main", "no state change");
  assert.equal(v.held, "plain", "the last frame, undimmed");
  assert.equal(v.stream, "start", "the stream element is kept so its player reconnects on its own");
});

test("a stall that outlasts the grace gets a banner over the dimmed last frame", () => {
  const v = tileView(base({ playing: false, lastPlayingAt: NOW - 25_000 }));
  assert.match(v.why!, /^Video stopped: no new picture for 25 s\. Reconnecting\./);
  assert.match(v.why!, /Showing the last picture, from when\(\d+\)\./);
  assert.equal(v.held, "dim");
  assert.equal(v.badge, "reconnecting…");
  assert.equal(v.recreate, false);
  assert.equal(tileView(base({ playing: false, lastPlayingAt: NOW - 61_000 })).recreate, true, "after a minute the stream is made fresh");
});

test("the server's offline verdict (already past its grace) is a banner over the dimmed last frame, 'since' the camera stopped answering", () => {
  const v = tileView(base({ playing: false, st: { up: false, reason: MISS, since: NOW - 40_000 } }));
  assert.equal(v.stream, "stop");
  assert.equal(v.badge, "offline");
  assert.equal(v.held, "dim", "never a black void when there is a picture to show");
  assert.ok(v.why!.startsWith(`${MISS} since clock(${NOW - 40_000}).`), v.why!);
  assert.match(v.why!, /Showing the last picture, from when\(\d+\)\.$/);
});

test("offline with no picture ever kept falls back to the plain message on the dark tile", () => {
  const v = tileView(base({ playing: false, hasFrame: false, st: { up: false, reason: MISS, since: NOW - 40_000 } }));
  assert.equal(v.held, "none");
  assert.equal(v.why, `${MISS} since clock(${NOW - 40_000}).`);
});

test("recovery: playing again drops the kept frame and the banner", () => {
  const down = tileView(base({ playing: false, st: { up: false, reason: MISS, since: NOW - 40_000 } }));
  assert.equal(down.held, "dim");
  const back = tileView(base({ everPlayed: false, playing: false, madeAt: NOW - 2_000 }));
  assert.equal(back.why, null, "reconnecting in the first seconds is quiet");
  assert.equal(back.held, "plain", "and shows the kept frame meanwhile");
  const live = tileView(base());
  assert.deepEqual({ why: live.why, held: live.held }, { why: null, held: "none" });
});

test("not known yet: a kept frame (even one restored after a reload) shows instead of 'checking' words", () => {
  const withFrame = tileView(base({ st: null, playing: false }));
  assert.deepEqual({ why: withFrame.why, held: withFrame.held, badge: withFrame.badge }, { why: null, held: "plain", badge: "checking…" });
  const noFrame = tileView(base({ st: null, playing: false, hasFrame: false }));
  assert.equal(noFrame.why, "Checking the camera…");
});

test("a video server restart only gets a banner after the grace; its age survives between calls", () => {
  const go2rtc = { state: "restarting", lastError: "exited" };
  const first = tileView(base({ go2rtc, playing: false }));
  assert.equal(first.why, null, "just noticed: nothing but the kept frame");
  assert.deepEqual(first.trouble, { kind: "server", since: NOW });
  const later = tileView(base({ go2rtc, playing: false, now: NOW + 25_000, prev: first.trouble }));
  assert.match(later.why!, /^Video server restarting: exited\./);
  assert.equal(later.held, "dim");
  // a different trouble starts a new clock
  const other = tileView(base({ go2rtc: { state: "running" }, playerReady: false, playing: false, now: NOW + 25_000, prev: first.trouble }));
  assert.deepEqual(other.trouble, { kind: "player", since: NOW + 25_000 });
});

test("no picture on a fresh stream: quiet through the grace, then the old message, with 'retrying'", () => {
  const quiet = tileView(base({ everPlayed: false, playing: false, madeAt: NOW - 10_000, hasFrame: false }));
  assert.equal(quiet.why, null);
  const loud = tileView(base({ everPlayed: false, playing: false, madeAt: NOW - 30_000, hasFrame: false }));
  assert.match(loud.why!, /^Video didn't start: no picture from the camera within 30 s\. Retrying\./);
  assert.equal(loud.badge, "no picture");
  assert.equal(loud.held, "none");
});
