// #113: Home shows a fault (StatusFault) on a camera that has been offline for the whole grace, and the
// fault clears the moment the camera answers. Checked on the real HAP MotionSensor service, on a real
// UnscryptedCamera, and through the bridge's handling of the dashboard's camera-reach message.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { Characteristic, Service } from "hap-nodejs";
import { CameraFault, FaultService } from "../src/homekitFault";
import { UnscryptedCamera } from "../src/camera";
import { BridgeRuntime, REACH_STALE_MS } from "../src/bridgeRuntime";
import { loadConfig } from "../src/config";
import { checkCameraReach } from "../src/dash/ipc";
import { Logger, setLogLevel } from "../src/logger";
import { captureLogs, fakeCamera } from "./helpers/fakes";
import { tempDir } from "./helpers/tmp";

setLogLevel("error");
const log = new Logger("test");
const fault = (svc: Service) => svc.getCharacteristic(Characteristic.StatusFault).value;
const OFF = { since: Date.UTC(2026, 10, 7, 15, 38), reason: "Camera not answering at its RTSP port (no answer within 1.5 s)" };

test("StatusFault is set when the camera goes offline and cleared when it answers (fake HAP service)", () => {
  const calls: number[] = [];
  const svc: FaultService = { updateCharacteristic: (_c, v) => { calls.push(v); return svc; } };
  const f = new CameraFault(svc, "Garage", log);
  assert.deepEqual(calls, [Characteristic.StatusFault.NO_FAULT], "starts clear, so Home never shows a stale fault after a restart");
  f.set(OFF);
  assert.deepEqual(calls.slice(1), [Characteristic.StatusFault.GENERAL_FAULT]);
  assert.deepEqual(f.current(), OFF);
  f.set(null);
  assert.deepEqual(calls.slice(2), [Characteristic.StatusFault.NO_FAULT]);
  assert.equal(f.current(), null);
});

test("saying the same thing twice changes nothing and logs nothing more", () => {
  const logs = captureLogs();
  try {
    const calls: number[] = [];
    const svc: FaultService = { updateCharacteristic: (_c, v) => { calls.push(v); return svc; } };
    const f = new CameraFault(svc, "Garage", new Logger("test"));
    f.set(null);
    f.set(OFF); f.set({ ...OFF, reason: "other words" }); f.set(OFF);
    f.set(null); f.set(null);
    assert.deepEqual(calls, [0, 1, 0], "one set, one clear");
    const said = logs.lines.filter((l) => /offline since|answering again/.test(l));
    assert.equal(said.length, 2, "one line when it goes offline (WARN), one when it's back");
    assert.equal(logs.warns().length, 1, "going offline is a WARN with the reason");
    assert.match(logs.warns()[0], /camera offline since 2026-11-07T15:38:00\.000Z \(Camera not answering at its RTSP port/);
  } finally { logs.restore(); }
});

test("a camera with no motion sensor says once that Home can't show the fault, and never throws", () => {
  const logs = captureLogs();
  try {
    const f = new CameraFault(undefined, "Shed", new Logger("test"));
    f.set(OFF);
    f.set(null);
    assert.ok(logs.lines.some((l) => /"Shed" has no motion sensor in Home/.test(l)), "said at startup");
    assert.ok(logs.lines.some((l) => /Home has no motion sensor for it, so it can't show a fault/.test(l)), "and when it goes offline");
  } finally { logs.restore(); }
});

test("on a real camera the fault lands on its MotionSensor's StatusFault", () => {
  const cam = new UnscryptedCamera(fakeCamera({ name: "Garage", hksv: true }), "ffmpeg", log);
  const motion = cam.accessory.getServiceById(Service.MotionSensor.UUID, "") ?? cam.accessory.services.find((s) => s.UUID === Service.MotionSensor.UUID);
  assert.ok(motion, "an HKSV camera has a motion sensor service");
  assert.equal(fault(motion!), Characteristic.StatusFault.NO_FAULT);
  cam.setOffline(OFF);
  assert.equal(fault(motion!), Characteristic.StatusFault.GENERAL_FAULT);
  assert.deepEqual(cam.snapshotStatus().offline, OFF);
  cam.setOffline(null);
  assert.equal(fault(motion!), Characteristic.StatusFault.NO_FAULT);
  assert.equal(cam.snapshotStatus().offline, null);
});

// ---- the dashboard's message to the bridge ----

test("camera-reach messages are shape-checked", () => {
  assert.deepEqual(checkCameraReach({ type: "camera-reach", offline: {} }), { offline: {} });
  assert.deepEqual(checkCameraReach({ type: "camera-reach", offline: { Garage: { since: 5, reason: "x" } } }), { offline: { Garage: { since: 5, reason: "x" } } });
  for (const bad of [null, {}, { type: "camera-reach" }, { type: "camera-reach", offline: [] }, { type: "camera-reach", offline: { G: { since: "x", reason: "y" } } }, { type: "camera-reach", offline: { G: { since: 1 } } }]) {
    assert.equal(typeof checkCameraReach(bad), "string", JSON.stringify(bad));
  }
});

// ---- the bridge turning the dashboard's report into faults ----

function bridge() {
  const dir = tempDir("unscr-fault-");
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({
    bridge: { name: "Test", username: "CC:22:3D:E3:CE:F6", pin: "031-45-154" },
    cameras: [{ name: "Garage", rtspMain: "rtsp://u:p@127.0.0.1:1/11", hksv: true }, { name: "Shed", rtspMain: "rtsp://u:p@127.0.0.1:1/12", hksv: true }],
  }));
  const config = loadConfig(file);
  const cameras = config.cameras.map((c) => new UnscryptedCamera(c, "ffmpeg", log));
  const rt = new BridgeRuntime({
    config, configPath: file, bridge: null, cameras, log, ffmpegPath: "ffmpeg", version: "test",
    admin: { port: 0, enabled: false }, go2rtc: { binary: "go2rtc", apiPort: 0, webrtcPort: null, rtspPort: null, runtimeDir: dir, enabled: false },
    dash: { host: "127.0.0.1", port: 0, enabled: false, dir: path.join(dir, "dash") }, requestRestart: () => {},
  });
  const offline = () => rt.status().cameras.map((c) => [c.name, c.offline ? c.offline.reason : null]);
  return { rt, cameras, offline, report: (offline: Record<string, { since: number; reason: string }>) => (rt as any).onDashMessage({ type: "camera-reach", offline }) };
}

test("the dashboard's report flags the offline cameras and clears the rest, and the admin status shows it", () => {
  const { report, offline, cameras } = bridge();
  assert.deepEqual(offline(), [["Garage", null], ["Shed", null]]);
  report({ Garage: OFF });
  assert.deepEqual(offline(), [["Garage", OFF.reason], ["Shed", null]]);
  assert.equal(cameras[0].snapshotStatus().offline?.since, OFF.since);
  report({});
  assert.deepEqual(offline(), [["Garage", null], ["Shed", null]], "an all-clear report clears it");
});

test("a malformed report is ignored with a warning and leaves the flags alone", () => {
  const logs = captureLogs();
  try {
    const { report, offline, rt } = bridge();
    report({ Garage: OFF });
    (rt as any).onDashMessage({ type: "camera-reach", offline: "yes" });
    assert.deepEqual(offline(), [["Garage", OFF.reason], ["Shed", null]]);
    assert.ok(logs.warns().some((l) => /ignored a malformed camera-status message from the dashboard/.test(l)));
  } finally { logs.restore(); }
});

test("if the dashboard goes quiet for a minute the flags are cleared, loudly, so they can't stick", () => {
  const logs = captureLogs();
  try {
    const { report, offline, rt } = bridge();
    report({ Garage: OFF });
    const now = Date.now();
    (rt as any).expireStaleReach(now + REACH_STALE_MS - 1_000);
    assert.equal(offline()[0][1], OFF.reason, "30 s of silence is fine");
    (rt as any).expireStaleReach(now + REACH_STALE_MS + 1_000);
    assert.deepEqual(offline(), [["Garage", null], ["Shed", null]]);
    assert.ok(logs.warns().some((l) => /hasn't reported camera status for \d+ s, so Home's offline fault flags on "Garage" are cleared/.test(l)));
    (rt as any).expireStaleReach(now + REACH_STALE_MS + 9_000);
    assert.equal(logs.warns().filter((l) => /hasn't reported camera status/.test(l)).length, 1, "said once");
  } finally { logs.restore(); }
});
