// #90: the motion hold ("Hold motion for") is 5 to 180 seconds, per camera with an install-wide default,
// refused outside that range with the range in the message, and applied live (no restart).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { AddressInfo } from "net";
import { resolveConfig, loadConfig, ConfigError, DEFAULT_MOTION_COOLDOWN_MS, MIN_MOTION_COOLDOWN_MS, MAX_MOTION_COOLDOWN_MS } from "../../src/config";
import { applyCameraEdit, applyMotionDefault, redactConfig } from "../../src/admin/configStore";
import { createAdminServer } from "../../src/admin/server";
import { BridgeRuntime } from "../../src/bridgeRuntime";
import { UnscryptedCamera } from "../../src/camera";
import { ToAdmin } from "../../src/admin/ipc";
import { UserError } from "../../src/shared/errors";
import { Logger, setLogLevel } from "../../src/logger";
import { tempDir } from "../helpers/tmp";

setLogLevel("error");

const onvif = (extra: object = {}) => ({ host: "10.0.0.5", port: 8080, username: "u", password: "p", ...extra });
const cfg = (top: object = {}, own: object = {}): any => ({
  bridge: { name: "U", username: "CC:22:3D:E3:CE:F6", pin: "031-45-154" },
  ...top,
  cameras: [
    { name: "Garage", rtspMain: "rtsp://u:p@10.0.0.3:554/11", onvif: onvif() },
    { name: "Yard", rtspMain: "rtsp://u:p@10.0.0.4:554/11", foscam: { cgiBase: "http://10.0.0.4:88", username: "u", password: "p" } },
    { name: "Hall", rtspMain: "rtsp://u:p@10.0.0.6:554/11", onvif: onvif({ motionCooldownMs: 20000, ...own }) },
    { name: "Plain", rtspMain: "rtsp://u:p@10.0.0.7:554/11" },
  ],
});
const holdOf = (r: ReturnType<typeof resolveConfig>, name: string) => {
  const c = r.cameras.find((x) => x.name === name)!;
  return (c.onvif ?? c.foscam)?.motionCooldownMs;
};

test("the range is 5 to 180 seconds, and the built-in default is 60", () => {
  assert.equal(MIN_MOTION_COOLDOWN_MS, 5000);
  assert.equal(MAX_MOTION_COOLDOWN_MS, 180000);
  assert.equal(DEFAULT_MOTION_COOLDOWN_MS, 60000);
});

test("no setting anywhere: every camera holds for the built-in 60 s", () => {
  const r = resolveConfig(cfg(), "/");
  assert.equal(r.motionCooldownMs, 60000);
  assert.equal(holdOf(r, "Garage"), 60000);
  assert.equal(holdOf(r, "Yard"), 60000);
});

test("the install-wide default applies to cameras without their own value; a camera's own value wins", () => {
  const r = resolveConfig(cfg({ motionCooldownMs: 30000 }), "/");
  assert.equal(r.motionCooldownMs, 30000);
  assert.equal(holdOf(r, "Garage"), 30000, "onvif camera without its own value");
  assert.equal(holdOf(r, "Yard"), 30000, "foscam camera without its own value");
  assert.equal(holdOf(r, "Hall"), 20000, "the camera's own value overrides the default");
});

test("the limits themselves are allowed: 5000 and 180000", () => {
  assert.equal(holdOf(resolveConfig(cfg({ motionCooldownMs: 5000 }), "/"), "Garage"), 5000);
  assert.equal(holdOf(resolveConfig(cfg({ motionCooldownMs: 180000 }), "/"), "Garage"), 180000);
  assert.equal(holdOf(resolveConfig(cfg({}, { motionCooldownMs: 5000 }), "/"), "Hall"), 5000);
  assert.equal(holdOf(resolveConfig(cfg({}, { motionCooldownMs: 180000 }), "/"), "Hall"), 180000);
});

test("out of range, fractional or not a number is refused, naming the field and the allowed range", () => {
  for (const bad of [4999, 0, -1, 180001, 3_600_000, 60.5, "60000", true, NaN]) {
    for (const make of [() => cfg({ motionCooldownMs: bad }), () => cfg({}, { motionCooldownMs: bad })]) {
      assert.throws(() => resolveConfig(make(), "/"), (e: unknown) => {
        assert.ok(e instanceof ConfigError, String(bad));
        assert.match(e.message, /motionCooldownMs/);
        assert.match(e.message, /5000 to 180000/);
        assert.match(e.message, /5 to 180 seconds/);
        return true;
      }, String(bad));
    }
  }
});

test("applyMotionDefault sets, replaces and removes the default, and refuses out-of-range with the range in the words", () => {
  const raw = cfg();
  const set = applyMotionDefault(raw, 45000);
  assert.equal(set.motionCooldownMs, 45000);
  assert.equal(raw.motionCooldownMs, undefined, "the input is not mutated");
  assert.equal(applyMotionDefault(set, null).motionCooldownMs, undefined, "null goes back to the built-in default");
  assert.equal(redactConfig(set).motionCooldownMs, 45000);
  assert.equal(redactConfig(raw).motionCooldownMs, null);
  for (const bad of [4999, 180001, "x", undefined]) {
    assert.throws(() => applyMotionDefault(raw, bad), (e: unknown) => {
      assert.ok(e instanceof UserError, String(bad));
      assert.match(e.body.happened, /5000 to 180000/);
      assert.match(e.body.changed, /Nothing was saved/);
      assert.match(e.body.next, /5 to 180 seconds/);
      return true;
    });
  }
});

test("a camera's own hold: set by an edit, refused out of range, and taken off (null) to follow the default again", () => {
  const raw = cfg({ motionCooldownMs: 30000 });
  const set = applyCameraEdit(raw, "Garage", { onvif: { motionCooldownMs: 15000 } });
  assert.equal(set.cameras[0].onvif!.motionCooldownMs, 15000);
  assert.throws(() => applyCameraEdit(raw, "Garage", { onvif: { motionCooldownMs: 4000 } }),
    (e: unknown) => e instanceof UserError && /5000 to 180000/.test(e.body.happened) && /Garage/.test(e.body.happened));
  const cleared = applyCameraEdit(set, "Garage", { onvif: { motionCooldownMs: null } as any });
  assert.ok(!("motionCooldownMs" in cleared.cameras[0].onvif!), "the key is gone, not null");
  assert.equal(holdOf(resolveConfig(cleared, "/"), "Garage"), 30000, "back to the install-wide default");
});

// ---------- the admin pane's route ----------

async function withServer(fn: (h: { base: string; session: () => Promise<{ cookie: string; csrf: string }>; file: string; asked: any[]; reply: { v: (m: any) => any } }) => Promise<void>, top: object = {}) {
  const dir = tempDir("unscr-hold-");
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg(top)));
  fs.writeFileSync(path.join(dir, "pw"), "letmein\n");
  fs.mkdirSync(path.join(dir, "web"));
  fs.writeFileSync(path.join(dir, "web", "index.html"), "<title>__TITLE__</title>");
  const asked: any[] = [];
  const reply = { v: (m: any): any => ({ type: "applied", reqId: "x", ok: true, mode: "live", message: `applied ${m.type}` }) };
  const srv = createAdminServer({
    configPath: file, passwordFile: path.join(dir, "pw"), go2rtcApi: "", sessionKeyFile: path.join(dir, "data", "key"),
    webRoot: path.join(dir, "web"), title: "t",
    bridge: { status: () => null, request: async (m: any) => { asked.push(m); return reply.v(m); } },
  });
  const base = await new Promise<string>((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`)));
  const session = async () => {
    const r = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "letmein" }) });
    const j = (await r.json()) as any;
    return { cookie: r.headers.get("set-cookie")!.split(";")[0], csrf: j.csrf as string };
  };
  try { await fn({ base, session, file, asked, reply }); } finally { srv.close(); }
}
const put = (base: string, s: { cookie: string; csrf: string } | null, body: unknown) =>
  fetch(base + "/api/settings/motion", { method: "PUT", headers: { "content-type": "application/json", ...(s ? { cookie: s.cookie, "x-csrf-token": s.csrf } : {}) }, body: JSON.stringify(body) });

test("PUT /api/settings/motion saves the default and tells the bridge to apply it live (no restart)", async () => {
  await withServer(async ({ base, session, file, asked }) => {
    const s = await session();
    for (const ms of [5000, 90000, 180000]) {
      const r = await put(base, s, { motionCooldownMs: ms });
      assert.equal(r.status, 200, String(ms));
      const j = (await r.json()) as any;
      assert.equal(j.mode, "live");
      assert.equal(j.saved, true);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).motionCooldownMs, ms);
    }
    assert.deepEqual(asked.map((m) => m.type), ["apply-defaults", "apply-defaults", "apply-defaults"]);
    assert.ok(!asked.some((m) => m.type === "restart-bridge"), "never a restart");
    const list = (await (await fetch(base + "/api/cameras", { headers: { cookie: s.cookie } })).json()) as any;
    assert.equal(list.motionCooldownMs, 180000);
    assert.deepEqual(list.limits.motionCooldownMs, { min: 5000, max: 180000 });
    assert.equal(list.defaults.motionCooldownMs, 60000);
    const off = await put(base, s, { motionCooldownMs: null });
    assert.equal(off.status, 200);
    assert.ok(!("motionCooldownMs" in JSON.parse(fs.readFileSync(file, "utf8"))), "null removes the default");
  });
});

test("PUT /api/settings/motion refuses out-of-range with the range in words; nothing written, bridge not asked", async () => {
  await withServer(async ({ base, session, file, asked }) => {
    const s = await session();
    const before = fs.readFileSync(file, "utf8");
    for (const bad of [4999, 180001, 0, -5, 12.5, "60", true]) {
      const r = await put(base, s, { motionCooldownMs: bad });
      assert.equal(r.status, 400, String(bad));
      const e = ((await r.json()) as any).error;
      assert.match(e.attempted, /default motion hold/i);
      assert.match(e.happened, /5000 to 180000/);
      assert.match(e.changed, /Nothing was saved/);
      assert.match(e.next, /5 to 180 seconds/);
    }
    const missing = await put(base, s, {});
    assert.equal(missing.status, 400);
    assert.equal(fs.readFileSync(file, "utf8"), before, "config.json untouched");
    assert.equal(asked.length, 0);
  });
});

test("PUT /api/settings/motion needs the admin sign-in and the CSRF token", async () => {
  await withServer(async ({ base, session, file }) => {
    const before = fs.readFileSync(file, "utf8");
    assert.equal((await put(base, null, { motionCooldownMs: 30000 })).status, 401);
    const s = await session();
    assert.equal((await put(base, { cookie: s.cookie, csrf: "wrong" }, { motionCooldownMs: 30000 })).status, 403);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("PUT /api/settings/motion says plainly when the bridge didn't confirm, or refused", async () => {
  await withServer(async ({ base, session, reply }) => {
    const s = await session();
    reply.v = () => null;
    const slow = await put(base, s, { motionCooldownMs: 30000 });
    assert.equal(slow.status, 202);
    assert.match(((await slow.json()) as any).message, /NOT live yet/);
    reply.v = () => ({ type: "applied", reqId: "x", ok: false, error: { attempted: "Apply the default motion hold", happened: "boom", changed: "The running bridge kept its previous settings.", next: "Restart." } });
    const refused = await put(base, s, { motionCooldownMs: 31000 });
    assert.equal(refused.status, 500);
    const e = ((await refused.json()) as any).error;
    assert.match(e.changed, /config\.json WAS saved/);
  });
});

// ---------- the running bridge: live, no restart ----------

function runtime(top: object = {}, own: object = {}) {
  const dir = tempDir("unscr-hold-rt-");
  const file = path.join(dir, "config.json");
  const raw = cfg(top, own);
  fs.writeFileSync(file, JSON.stringify(raw));
  const log = new Logger("test");
  const config = loadConfig(file);
  const cameras = config.cameras.map((c) => new UnscryptedCamera(c, "ffmpeg", log));
  let restarts = 0;
  const rt = new BridgeRuntime({
    config, configPath: file, bridge: null, cameras, log, ffmpegPath: "ffmpeg", version: "test",
    admin: { port: 0, enabled: false }, go2rtc: { binary: "go2rtc", apiPort: 0, webrtcPort: null, rtspPort: null, runtimeDir: dir, enabled: false },
    dash: { host: "127.0.0.1", port: 0, enabled: false, dir: path.join(dir, "dash"), title: "t" },
    requestRestart: () => { restarts++; },
  });
  const sent: ToAdmin[] = [];
  (rt as any).send = (m: ToAdmin) => sent.push(m);
  const save = (mutate: (r: any) => void) => { mutate(raw); fs.writeFileSync(file, JSON.stringify(raw)); };
  const ask = (m: unknown) => (rt as any).onMessage(m) as Promise<void>;
  const last = () => sent.filter((m) => m.type === "applied").pop() as any;
  const hold = (name: string) => {
    const c = cameras.find((x) => x.name === name)!.resolved;
    return (c.onvif ?? c.foscam)?.motionCooldownMs;
  };
  return { rt, save, ask, last, hold, restarts: () => restarts, sent };
}

test("changing the default applies live to the cameras that use it, leaves the ones with their own value, and never restarts", async () => {
  const { save, ask, last, hold, restarts } = runtime();
  assert.deepEqual(["Garage", "Yard", "Hall"].map(hold), [60000, 60000, 20000]);
  save((r) => { r.motionCooldownMs = 10000; });
  await ask({ type: "apply-defaults", reqId: "1" });
  assert.equal(last().ok, true);
  assert.equal(last().mode, "live");
  assert.match(last().message, /10 s/);
  assert.match(last().message, /"Garage"/);
  assert.match(last().message, /"Yard"/);
  assert.doesNotMatch(last().message, /"Hall"/, "Hall has its own hold");
  assert.deepEqual(["Garage", "Yard", "Hall"].map(hold), [10000, 10000, 20000], "applied to the running cameras");
  save((r) => { r.motionCooldownMs = 180000; });
  await ask({ type: "apply-defaults", reqId: "2" });
  assert.deepEqual(["Garage", "Yard", "Hall"].map(hold), [180000, 180000, 20000]);
  save((r) => { delete r.motionCooldownMs; });
  await ask({ type: "apply-defaults", reqId: "3" });
  assert.deepEqual(["Garage", "Yard", "Hall"].map(hold), [60000, 60000, 20000], "taking the default off goes back to 60 s");
  assert.equal(restarts(), 0, "no restart was requested");
});

test("applying a default nothing uses says so, and a camera with no motion source is left alone", async () => {
  const { save, ask, last, hold } = runtime({}, {});
  save((r) => { r.cameras = r.cameras.filter((c: any) => c.name === "Hall"); r.motionCooldownMs = 10000; });
  await ask({ type: "apply-defaults", reqId: "1" });
  assert.equal(last().ok, true);
  assert.match(last().message, /nothing needed to change/);
  assert.equal(hold("Hall"), 20000);
  assert.equal(hold("Plain"), undefined);
});

test("a hand-edited, out-of-range default is refused when applied: the bridge keeps what it had and says why", async () => {
  const { save, ask, last, hold } = runtime();
  save((r) => { r.motionCooldownMs = 1000; });
  await ask({ type: "apply-defaults", reqId: "1" });
  assert.equal(last().ok, false);
  assert.match(last().error.happened, /5000 to 180000/);
  assert.match(last().error.changed, /kept its previous settings/);
  assert.equal(hold("Garage"), 60000);
});

test("the pane's slider and the form are wired: 5-180 s, a use-the-default box, the live motion state (#90)", () => {
  const js = fs.readFileSync(path.join(__dirname, "..", "..", "web", "admin", "app.js"), "utf8");
  assert.match(js, /\/api\/settings\/motion/);
  assert.match(js, /type: "range"/);
  assert.match(js, /longer = fewer flickers in wind/i);
  assert.match(js, /limits/);
  assert.doesNotMatch(js, /Hold motion for \(ms\)/, "the number-in-ms box is replaced by the slider");
});
