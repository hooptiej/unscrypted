import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BridgeRuntime, probeRtsp } from "../../src/bridgeRuntime";
import { loadConfig } from "../../src/config";
import { UnscryptedCamera } from "../../src/camera";
import { Logger, setLogLevel } from "../../src/logger";
import { ToAdmin } from "../../src/admin/ipc";

setLogLevel("error");
const log = new Logger("test");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unscr-rt-"));
  const file = path.join(dir, "config.json");
  const raw: any = {
    bridge: { name: "Test", username: "CC:22:3D:E3:CE:F6", pin: "031-45-154" },
    cameras: [{ name: "Garage", rtspMain: "rtsp://u:p@127.0.0.1:1/11", hksv: true }],
  };
  fs.writeFileSync(file, JSON.stringify(raw));
  const config = loadConfig(file);
  const cameras = config.cameras.map((c) => new UnscryptedCamera(c, "ffmpeg", log));
  let restarts = 0;
  const rt = new BridgeRuntime({
    config, configPath: file, bridge: null, cameras, log, ffmpegPath: "ffmpeg", version: "test",
    admin: { port: 0, enabled: false }, go2rtc: { binary: "go2rtc", apiPort: 0, webrtcPort: null, runtimeDir: dir, enabled: false },
    requestRestart: () => { restarts++; },
  });
  const sent: ToAdmin[] = [];
  (rt as any).send = (m: ToAdmin) => sent.push(m);
  const save = (mutate: (r: any) => void) => { mutate(raw); fs.writeFileSync(file, JSON.stringify(raw)); };
  const ask = (m: unknown) => (rt as any).onMessage(m) as Promise<void>;
  const lastApplied = () => sent.filter((m) => m.type === "applied").pop() as any;
  return { rt, cameras, save, ask, lastApplied, restarts: () => restarts };
}

test("live change is applied to the running camera object", async () => {
  const { cameras, save, ask, lastApplied, rt } = setup();
  save((r) => { r.cameras[0].rtspMain = "rtsp://u:new@127.0.0.1:1/11"; });
  await ask({ type: "apply", reqId: "1", name: "Garage", isNew: false });
  assert.equal(lastApplied().ok, true);
  assert.equal(lastApplied().mode, "live");
  assert.equal(cameras[0].resolved.rtspMain, "rtsp://u:new@127.0.0.1:1/11");
  assert.equal(rt.status().cameras[0].pendingRestart, false);
});

test("HKSV change waits for restart, and a later live edit still says restart", async () => {
  const { cameras, save, ask, lastApplied, rt } = setup();
  save((r) => { r.cameras[0].hksv = false; });
  await ask({ type: "apply", reqId: "1", name: "Garage", isNew: false });
  assert.equal(lastApplied().mode, "restart-needed");
  assert.equal(cameras[0].resolved.hksv, true, "running camera untouched");
  save((r) => { r.cameras[0].maxRecordingSeconds = 100; });
  await ask({ type: "apply", reqId: "2", name: "Garage", isNew: false });
  assert.equal(lastApplied().mode, "restart-needed");
  assert.equal(rt.status().cameras[0].pendingRestart, true);
});

test("new camera is added (HAP off: says it won't appear in Home)", async () => {
  const { save, ask, lastApplied, rt } = setup();
  save((r) => { r.cameras.push({ name: "Side", rtspMain: "rtsp://127.0.0.1:1/1" }); });
  await ask({ type: "apply", reqId: "1", name: "Side", isNew: true });
  assert.equal(lastApplied().mode, "added");
  assert.match(lastApplied().message, /won't appear in Home/);
  assert.deepEqual(rt.status().cameras.map((c) => c.name), ["Garage", "Side"]);
  assert.equal(rt.status().cameras[1].pendingRestart, false);
});

test("bridge identity is never adopted from a hand-edited config", async () => {
  const { save, ask, rt } = setup();
  save((r) => { r.bridge.pin = "111-22-333"; r.cameras[0].audio = false; });
  await ask({ type: "apply", reqId: "1", name: "Garage", isNew: false });
  assert.equal(rt.status().pin, "031-45-154");
});

test("broken config.json comes back as a plain-words error, bridge unchanged", async () => {
  const { rt, ask, lastApplied, cameras } = setup();
  fs.writeFileSync((rt as any).o.configPath, "{ nope");
  await ask({ type: "apply", reqId: "9", name: "Garage", isNew: false });
  const err = lastApplied();
  assert.equal(err.ok, false);
  assert.match(err.error.happened, /no longer loads/);
  assert.match(err.error.changed, /kept its previous settings/);
  assert.equal(cameras[0].resolved.rtspMain, "rtsp://u:p@127.0.0.1:1/11");
});

test("malformed or unknown messages are refused with a reason", async () => {
  const { ask, lastApplied } = setup();
  await ask({ type: "explode", reqId: "x" });
  assert.equal(lastApplied().ok, false);
  assert.match(lastApplied().error.happened, /unknown message type/);
  await ask(null);   // no reqId: logged only, must not throw
});

test("restart-bridge acks, then asks index.ts to shut down", async () => {
  const { ask, lastApplied, restarts } = setup();
  await ask({ type: "restart-bridge", reqId: "r" });
  assert.equal(lastApplied().ok, true);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(restarts(), 1);
});

test("reload-go2rtc without go2rtc says why", async () => {
  const { rt, ask, lastApplied } = setup();
  rt.start();
  await ask({ type: "reload-go2rtc", reqId: "g" });
  await rt.stop();
  assert.equal(lastApplied().ok, false);
  assert.match(lastApplied().error.happened, /isn't running/);
  assert.equal(rt.status().go2rtc.state, "stopped");
});

test("probeRtsp reports an unparseable URL and a closed port", async () => {
  assert.match((await probeRtsp("not a url")).err ?? "", /can't be parsed/);
  const r = await probeRtsp("rtsp://127.0.0.1:1/x", 1000);
  assert.equal(r.ok, false);
  assert.ok(r.err);
});
