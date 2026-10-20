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
      { id: "dogcamtest", label: "DogCam", stream: "dogcamtest" },
      { id: "garagecamtest", label: "Garagecam", stream: "garagecamtest_sub" },
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
  assert.equal(server.name, "Server");
  const kids = Object.fromEntries(server.children.map((k: any) => [k.id, k]));
  assert.equal(kids.homekit.name, "HomeKit bridge");
  assert.equal(kids.homekit.state, "down");
  assert.match(kids.homekit.reason, /HomeKit is off on this instance/);
  assert.equal(kids.constructicon.state, "down");
  assert.match(kids.constructicon.reason, /can't be checked from the NAS's own network yet/);
  assert.equal(kids.scrypted, undefined, "the Scrypted light is gone (owner Q2 = a)");
  const reasons = JSON.stringify(st.services, (k, v) => (k === "link" ? undefined : v));
  assert.doesNotMatch(reasons, /\b\d+\.\d+\.\d+\.\d+\b/, "no addresses in the reasons");
});
