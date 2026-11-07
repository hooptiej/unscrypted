// #87: the admin pane's side of the per-camera stream choice: what config.json stores, what the pane is
// told (including the wall tile's choice, which is the dashboard's own setting), and what a refused save says.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { AddressInfo } from "net";
import { applyCameraEdit, redactCamera } from "../../src/admin/configStore";
import { createAdminServer } from "../../src/admin/server";
import { loadSettings, saveSettings, DEFAULTS } from "../../src/dash/settings";
import { UserError } from "../../src/shared/errors";
import { setLogLevel } from "../../src/logger";
import { tempDir } from "../helpers/tmp";

setLogLevel("error");

const cfg = () => ({
  bridge: { name: "U", username: "CC:22:3D:E3:CE:F6", pin: "031-45-154" },
  cameras: [
    { name: "Dog", rtspMain: "rtsp://admin:s3cret@10.0.0.3:554/11", rtspSub: "rtsp://admin:s3cret@10.0.0.3:554/12" },
    { name: "Garage", rtspMain: "rtsp://admin:s3cret@10.0.0.4:554/11" },
  ],
});
const streamsOf = (raw: any, name: string) => raw.cameras.find((c: any) => c.name === name).streams;
const four = (e: UserError) => ["attempted", "happened", "changed", "next"].every((k) => typeof (e.body as any)[k] === "string" && (e.body as any)[k].length > 0);

test("a choice is stored per camera, key by key; a key sent as null goes back to its default and leaves the others", () => {
  let raw: any = applyCameraEdit(cfg() as any, "Dog", { streams: { live: "sub" } });
  assert.deepEqual(streamsOf(raw, "Dog"), { live: "sub" });
  assert.equal(streamsOf(raw, "Garage"), undefined, "other cameras are untouched");
  raw = applyCameraEdit(raw, "Dog", { streams: { recording: "sub", snapshot: "main" } });
  assert.deepEqual(streamsOf(raw, "Dog"), { live: "sub", recording: "sub", snapshot: "main" });
  raw = applyCameraEdit(raw, "Dog", { streams: { live: null } });
  assert.deepEqual(streamsOf(raw, "Dog"), { recording: "sub", snapshot: "main" });
  raw = applyCameraEdit(raw, "Dog", { streams: { recording: null, snapshot: null } });
  assert.equal(streamsOf(raw, "Dog"), undefined, "all back to default: no streams block left in config.json");
});

test("a form that sends only default choices (as null) writes nothing to config.json", () => {
  const raw = applyCameraEdit(cfg() as any, "Dog", { streams: { snapshot: null, live: null, recording: null } });
  assert.deepEqual(raw, cfg());
});

test("an edit that leaves streams out keeps what is saved; null for the whole block clears all three", () => {
  let raw: any = applyCameraEdit(cfg() as any, "Dog", { streams: { live: "sub", recording: "sub" } });
  raw = applyCameraEdit(raw, "Dog", { audio: false });
  assert.deepEqual(streamsOf(raw, "Dog"), { live: "sub", recording: "sub" });
  raw = applyCameraEdit(raw, "Dog", { streams: null });
  assert.equal(streamsOf(raw, "Dog"), undefined);
});

test("the pane gets the saved choices back (redaction keeps them)", () => {
  const raw: any = applyCameraEdit(cfg() as any, "Dog", { streams: { live: "sub" } });
  assert.deepEqual((redactCamera(raw.cameras[0]) as any).streams, { live: "sub" });
});

test("refusals say what, why and what to do, and write nothing", () => {
  const before = JSON.stringify(cfg());
  const refuse = (edit: object, name: string, ...parts: RegExp[]) => assert.throws(() => applyCameraEdit(JSON.parse(before), name, edit as any), (e: unknown) => {
    assert.ok(e instanceof UserError && four(e), "a four-part error");
    for (const p of parts) assert.match(JSON.stringify((e as UserError).body), p);
    assert.match((e as UserError).body.changed, /Nothing was saved/);
    return true;
  });
  refuse({ streams: { live: "sub" } }, "Garage", /Garage/, /streams\.live is \\"sub\\" but this camera has no sub stream configured/);
  refuse({ streams: { recording: "sub" } }, "Garage", /streams\.recording/);
  refuse({ streams: { live: "auto" } }, "Dog", /streams\.live/, /main\\" or \\"sub/);
  refuse({ streams: { liev: "sub" } }, "Dog", /Unknown field in the streams block: liev/);
  refuse({ streams: "sub" }, "Dog", /streams choice wasn't an object/);
});

// ---- over HTTP, with the dashboard's settings beside ----

const dir = tempDir("unscr-streams-");
const dashDir = path.join(dir, "dash");
let base = "";
let srv: http.Server;
const applied: any[] = [];

before(async () => {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg(), null, 2));
  fs.writeFileSync(path.join(dir, "pw"), "letmein\n");
  fs.mkdirSync(dashDir, { recursive: true });
  saveSettings(path.join(dashDir, "settings.json"), { ...DEFAULTS, cameras: [
    { camera: "Dog", label: "Dog", shown: true, stream: "sub" },
    { camera: "Garage", label: "Garage", shown: true, stream: "main" },
  ] });
  srv = createAdminServer({
    configPath: path.join(dir, "config.json"), passwordFile: path.join(dir, "pw"), go2rtcApi: "",
    sessionKeyFile: path.join(dir, "admin-session.key"), webRoot: path.join(__dirname, "../../web/admin"), title: "t",
    dash: { dir: dashDir, port: 8181, url: null },
    bridge: { status: () => null, request: async (m: any) => { applied.push(m); return { type: "applied", reqId: "x", ok: true, mode: "live", message: "applied" }; } },
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(() => srv.close());

async function login() {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "letmein" }) });
  const j: any = await r.json();
  return { cookie: r.headers.get("set-cookie")!.split(";")[0], csrf: j.csrf as string };
}
const send = (method: string, p: string, body: unknown, s: { cookie: string; csrf: string }) =>
  fetch(base + p, { method, headers: { "content-type": "application/json", cookie: s.cookie, "x-csrf-token": s.csrf }, body: JSON.stringify(body) });
const readCfg = () => JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));

test("the camera list tells the pane each camera's wall-tile stream, from the dashboard's settings, and the recording-switch warning", async () => {
  const s = await login();
  const j: any = await (await fetch(base + "/api/cameras", { headers: { cookie: s.cookie } })).json();
  assert.deepEqual(j.dashStreams, { Dog: "sub", Garage: "main" });
  assert.match(j.notices.recordingStreamSwitch, /restarts this camera's recording buffer/);
  assert.match(j.notices.recordingStreamSwitch, /clip being recorded right now finishes first/);
});

test("saving a choice writes config.json and tells the bridge to apply it live", async () => {
  const s = await login();
  const r = await send("PUT", "/api/cameras/Dog", { streams: { live: "sub", recording: "sub", snapshot: null } }, s);
  assert.equal(r.status, 200);
  assert.deepEqual(readCfg().cameras[0].streams, { live: "sub", recording: "sub" });
  assert.deepEqual(applied.pop(), { type: "apply", name: "Dog", isNew: false });
  const j: any = await (await fetch(base + "/api/cameras", { headers: { cookie: s.cookie } })).json();
  assert.deepEqual(j.cameras[0].streams, { live: "sub", recording: "sub" });
});

test("a refused save says why and leaves config.json exactly as it was", async () => {
  const s = await login();
  const before = fs.readFileSync(path.join(dir, "config.json"), "utf8");
  const r = await send("PUT", "/api/cameras/Garage", { streams: { live: "sub" } }, s);
  assert.equal(r.status, 400);
  const j: any = await r.json();
  assert.match(j.error.happened, /Garage.*streams\.live is "sub" but this camera has no sub stream configured/);
  assert.match(j.error.changed, /Nothing was saved; config\.json is untouched/);
  assert.equal(fs.readFileSync(path.join(dir, "config.json"), "utf8"), before);
});

test("the wall tile's choice is saved through the dashboard settings, which still refuses sub for a camera without one", async () => {
  const s = await login();
  const cams = (over: Record<string, string>) => ["Dog", "Garage"].map((c) => ({ camera: c, label: c, shown: true, stream: over[c] ?? "main" }));
  const ok = await send("PUT", "/api/dash/settings", { cameras: cams({ Dog: "main" }) }, s);
  assert.equal(ok.status, 200);
  assert.equal(loadSettings(path.join(dashDir, "settings.json")).settings.cameras.find((c) => c.camera === "Dog")!.stream, "main");
  const bad = await send("PUT", "/api/dash/settings", { cameras: cams({ Garage: "sub" }) }, s);
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as any).error.happened, /Stream for Garage: this camera has no sub stream/);
  const j: any = await (await fetch(base + "/api/cameras", { headers: { cookie: s.cookie } })).json();
  assert.equal(j.dashStreams.Dog, "main", "the camera list shows the new wall choice");
});
