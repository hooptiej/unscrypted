import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { tempDir } from "../helpers/tmp";
import { DashRuntime } from "../../src/dash/runtime";
import { saveSettings, DEFAULTS } from "../../src/dash/settings";
import { Logger, setLogLevel } from "../../src/logger";

setLogLevel("error");
const log = new Logger("test");

function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

function runtime() {
  const dir = tempDir("unscr-dashrt-");
  saveSettings(path.join(dir, "settings.json"), { ...DEFAULTS, cameras: [
    { camera: "DogCamTest", label: "DogCam", shown: true, stream: "main" },
    { camera: "GarageCamTest", label: "Garagecam", shown: true, stream: "sub" },
    { camera: "Couch Cam", label: "Couch", shown: false, stream: "main" },
  ] });
  return new DashRuntime({ dir, title: "Homedash - TEST", env: "test", adminPort: 8191, log });
}

test("config says which stream each tile actually plays, for the 'live · main/sub' tag (#22)", () => {
  const rt = runtime();
  rt.cameras = [
    { name: "DogCamTest", main: "dogcamtest", sub: "dogcamtest_sub", probe: null },
    { name: "GarageCamTest", main: "garagecamtest", sub: "garagecamtest_sub", probe: null },
  ];
  const cams = (rt.publicConfig() as any).cameras;
  assert.deepEqual(cams.map((c: any) => [c.label, c.which, c.stream]), [
    ["DogCam", "main", "dogcamtest"],
    ["Garagecam", "sub", "garagecamtest_sub"],
  ]);
  // Set to sub, but the camera has no sub stream: it plays main, and says so.
  rt.cameras = [{ name: "GarageCamTest", main: "garagecamtest", sub: null, probe: null }];
  assert.deepEqual((rt.publicConfig() as any).cameras.map((c: any) => [c.which, c.stream]), [["main", "garagecamtest"]]);
});

test("probes shown cameras: up, and down with a plain reason but no address", async () => {
  const live = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => live.listen(0, "127.0.0.1", () => r()));
  const upPort = (live.address() as net.AddressInfo).port;
  const downPort = await closedPort();
  try {
    const rt = runtime();
    rt.cameras = [
      { name: "DogCamTest", main: "dogcamtest", sub: null, probe: { host: "127.0.0.1", port: upPort } },
      { name: "GarageCamTest", main: "garagecamtest", sub: "garagecamtest_sub", probe: { host: "127.0.0.1", port: downPort } },
      { name: "Couch Cam", main: "couch_cam", sub: null, probe: null },
    ];
    await rt.probeCameras();
    const st = rt.state() as any;
    assert.deepEqual({ up: st.cameras.dogcamtest.up, reason: st.cameras.dogcamtest.reason }, { up: true, reason: null });
    assert.equal(st.cameras.garagecamtest.up, false);
    assert.match(st.cameras.garagecamtest.reason, /not answering at its RTSP port \(connection refused/);
    assert.equal(typeof st.cameras.garagecamtest.since, "number");
    assert.equal(st.cameras.couch_cam, undefined, "a hidden camera isn't probed");

    // since only moves when up/down flips
    const since = st.cameras.garagecamtest.since;
    await new Promise((r) => setTimeout(r, 5));
    await rt.probeCameras();
    assert.equal((rt.state() as any).cameras.garagecamtest.since, since);

    const cfg = rt.publicConfig();
    assert.deepEqual(cfg.cameras, [
      { id: "dogcamtest", label: "DogCam", stream: "dogcamtest", which: "main" },
      { id: "garagecamtest", label: "Garagecam", stream: "garagecamtest_sub", which: "sub" },
    ]);
    const all = JSON.stringify(cfg) + JSON.stringify(rt.state());
    assert.doesNotMatch(all, /rtsp:/);
    assert.doesNotMatch(all, /\b\d+\.\d+\.\d+\.\d+\b/);
    assert.doesNotMatch(all, /password/i);
  } finally { live.close(); }
});

test("a camera whose address can't be read says so", async () => {
  const rt = runtime();
  rt.cameras = [{ name: "DogCamTest", main: "dogcamtest", sub: null, probe: null }];
  await rt.probeCameras();
  assert.match((rt.state() as any).cameras.dogcamtest.reason, /address in config\.json can't be read/);
});

test("a camera dropped from config.json is dropped from the probe state", async () => {
  const rt = runtime();
  rt.cameras = [{ name: "DogCamTest", main: "dogcamtest", sub: null, probe: null }];
  await rt.probeCameras();
  rt.cameras = [];
  await rt.probeCameras();
  assert.deepEqual((rt.state() as any).cameras, {});
  assert.ok(fs.existsSync(rt.settingsFile));
});

test("service lights reach /api/state with their reasons and a timestamp", async () => {
  const rt = runtime();
  assert.deepEqual({ s: (rt.state() as any).services, at: (rt.state() as any).servicesAt }, { s: [], at: null });
  rt.bridge = { hapEnabled: false, paired: false, go2rtc: { state: "running", lastError: null, nextRetryAt: null } };
  await rt.pollServices();
  await rt.pollServices();   // the second miss turns a light red (debounce)
  const st = rt.state() as any;
  assert.equal(typeof st.servicesAt, "number");
  const server = st.services[0];
  assert.equal(server.name, "NAS", "the old 'Server' rollup is named for what it checks");
  if (server.state !== "ok") assert.ok(server.short && server.reason, "a non-green NAS light says why");
  const kids = Object.fromEntries(server.children.map((k: any) => [k.id, k]));
  assert.equal(kids.homekit.name, "HomeKit bridge");
  assert.equal(kids.homekit.state, "down");
  assert.match(kids.homekit.reason, /HomeKit is off on this instance/);
  assert.equal(kids.homekit.short, "HomeKit off (test)");
  assert.equal(kids.constructicon.state, "down");
  assert.match(kids.constructicon.reason, /can't be checked from the NAS's own network yet/);
  assert.equal(kids.constructicon.short, "can't check yet");
  assert.equal(kids.scrypted, undefined, "the Scrypted light is gone (owner Q2 = a)");
  const reasons = JSON.stringify(st.services, (k, v) => (k === "link" ? undefined : v));
  assert.doesNotMatch(reasons, /\b\d+\.\d+\.\d+\.\d+\b/, "no addresses in the reasons");
});

test("weather: no place says so; a failure keeps the last forecast and says why; a place change re-geocodes", async () => {
  const rt = runtime();
  assert.equal(await rt.refreshWeather(async () => { throw new Error("should not be called"); }), 60);
  assert.match((rt.state() as any).weatherError, /No weather place is set/);

  const fc = { current: { temperature_2m: 50, weather_code: 0 }, daily: { temperature_2m_max: [60], temperature_2m_min: [30], sunrise: ["x T07:00"], sunset: ["x T18:00"] } };
  const calls: string[] = [];
  let fail = false;
  const fj = async (u: string) => {
    calls.push(u.split("?")[0]);
    if (fail) throw new Error("Open-Meteo answered 503");
    return u.includes("geocoding") ? { results: [{ latitude: 1, longitude: 2, name: "Sterling" }] } : fc;
  };
  rt.settings.weather.place = "Sterling, CO";
  assert.equal(await rt.refreshWeather(fj), 600);
  let st = rt.state() as any;
  assert.deepEqual({ t: st.weather.temp, place: st.weather.place, err: st.weatherError }, { t: 50, place: "Sterling", err: null });

  fail = true;
  assert.equal(await rt.refreshWeather(fj), 60);
  st = rt.state() as any;
  assert.equal(st.weather.temp, 50, "the last forecast stays up");
  assert.match(st.weatherError, /Open-Meteo answered 503\. Retrying every minute\./);
  assert.equal(typeof st.weatherErrorSince, "number");

  fail = false;
  await rt.refreshWeather(fj);
  assert.equal(calls.filter((c) => c.includes("geocoding")).length, 1, "geocoded once");
  rt.settings.weather.place = "Denver";
  await rt.refreshWeather(fj);
  assert.equal(calls.filter((c) => c.includes("geocoding")).length, 2, "a new place geocodes again");
  assert.equal((rt.state() as any).weatherError, null);
});

test("fonts: publicConfig serves the chosen file; a gone file falls back and the page is told why", () => {
  const rt = runtime();
  const fdir = path.join(path.dirname(rt.settingsFile), "fonts");
  fs.mkdirSync(fdir, { recursive: true });
  fs.writeFileSync(path.join(fdir, "rMrRHh34w5nN.otf"), "OTTO");
  fs.writeFileSync(path.join(fdir, "names.json"), JSON.stringify({ "rMrRHh34w5nN.otf": "AlbertusMT" }));
  rt.settings.fonts = { ui: { kind: "file", file: "rMrRHh34w5nN.otf" }, clock: { kind: "system", family: "inherit" } };
  assert.deepEqual(rt.publicConfig().fonts, { ui: { file: "/fonts/rMrRHh34w5nN.otf", name: "AlbertusMT" }, clock: { inherit: true } });
  assert.deepEqual((rt.state() as any).notices, []);
  rt.settings.fonts.clock = { kind: "file", file: "Gone.otf" };
  assert.equal((rt.publicConfig().fonts.clock as any).family.includes("sans-serif"), true);
  assert.match((rt.state() as any).notices.join(" "), /clock font "Gone\.otf" isn't in the fonts folder/);
});

test("a saved settings change reaches the open page; a garbage file falls back to defaults and says so", async () => {
  const rt = runtime();
  rt.cameras = [{ name: "DogCamTest", main: "dogcamtest", sub: null, probe: null }];
  const v0 = (rt.state() as any).settingsVersion;
  await new Promise((r) => setTimeout(r, 20));   // a distinct mtime
  saveSettings(rt.settingsFile, { ...rt.settings, cameras: [{ camera: "DogCamTest", label: "The Dogs", shown: true, stream: "main" }] });
  assert.equal(rt.reloadSettingsIfChanged(fs.statSync(rt.settingsFile).mtimeMs), true);
  assert.equal(rt.publicConfig().cameras[0].label, "The Dogs");
  assert.notEqual((rt.state() as any).settingsVersion, v0);
  assert.equal(rt.reloadSettingsIfChanged(fs.statSync(rt.settingsFile).mtimeMs), false, "unchanged file: no reload");

  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(rt.settingsFile, "{garbage");
  assert.equal(rt.reloadSettingsIfChanged(fs.statSync(rt.settingsFile).mtimeMs), true);
  assert.deepEqual(rt.publicConfig().cameras, [], "defaults: nothing shown");
  assert.match((rt.state() as any).settingsWarning, /couldn't be read .*default dashboard settings/);
});

test("the Settings button's target comes from config, and a bad UNSCRYPTED_ADMIN_URL is said on the page", () => {
  const dir = tempDir("unscr-dashrt-");
  const plain = new DashRuntime({ dir, title: "T", env: "test", adminPort: 8191, log });
  assert.equal(plain.publicConfig().settingsUrl, null, "unset: the page uses this host and the admin port");
  const set = new DashRuntime({ dir, title: "T", env: "prod", adminPort: 8190, log, adminUrl: "http://10.0.1.78:8190" });
  assert.equal(set.publicConfig().settingsUrl, "http://10.0.1.78:8190/dash-settings?from=dash");
  const bad = new DashRuntime({ dir, title: "T", env: "prod", adminPort: 8190, log, adminUrl: null, adminUrlError: "UNSCRYPTED_ADMIN_URL (\"x\") isn't a web address" });
  assert.match((bad.state() as any).notices.join(" "), /UNSCRYPTED_ADMIN_URL/);
});

test("glow knobs (#25) reach the open page: 0% by default, the saved percents after a save", async () => {
  const rt = runtime();
  assert.deepEqual(rt.publicConfig().glow, { intensity: 0, size: 0 });
  await new Promise((r) => setTimeout(r, 20));   // a distinct mtime
  saveSettings(rt.settingsFile, { ...rt.settings, glow: { intensity: 40, size: -25 } });
  assert.equal(rt.reloadSettingsIfChanged(fs.statSync(rt.settingsFile).mtimeMs), true);
  assert.deepEqual(rt.publicConfig().glow, { intensity: 40, size: -25 });
});
