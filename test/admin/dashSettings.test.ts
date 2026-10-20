import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { AddressInfo } from "net";
import { tempDir } from "../helpers/tmp";
import { createAdminServer } from "../../src/admin/server";
import { setLogLevel } from "../../src/logger";

setLogLevel("error");

const dir = tempDir("unscr-dashset-");
const dashDir = path.join(dir, "dash");
const settingsFile = path.join(dashDir, "settings.json");
let base = "";
let srv: http.Server;

before(async () => {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    bridge: { name: "U", username: "CC:22:3D:E3:CE:F6", pin: "031-45-154" },
    cameras: [
      { name: "DogCamTest", rtspMain: "rtsp://admin:s3cret@10.0.0.3:554/11", rtspSub: "rtsp://admin:s3cret@10.0.0.3:554/12" },
      { name: "GarageCamTest", host: "10.0.0.5", rtspUser: "admin", rtspPassword: "pw2" },
      { name: "BackyardCamTest", rtspMain: "rtsp://a:b@10.0.0.6/1" },
      { name: "OnvifCamTest", rtspMain: "rtsp://a:b@10.0.0.7/1" },
      { name: "Couch Cam", rtspMain: "rtsp://a:b@10.0.0.8/1" },
    ] }, null, 2));
  fs.writeFileSync(path.join(dir, "pw"), "letmein\n");
  fs.mkdirSync(path.join(dashDir, "fonts"), { recursive: true });
  fs.writeFileSync(path.join(dashDir, "fonts", "rMrRHh34w5nN.otf"), "OTTO");
  fs.writeFileSync(path.join(dashDir, "fonts", "names.json"), JSON.stringify({ "rMrRHh34w5nN.otf": "AlbertusMT" }));
  srv = createAdminServer({
    configPath: path.join(dir, "config.json"), passwordFile: path.join(dir, "pw"), go2rtcApi: "",
    sessionKeyFile: path.join(dir, "admin-session.key"), webRoot: path.join(__dirname, "../../web/admin"), title: "unscrypted admin - TEST",
    dash: { dir: dashDir, port: 8181, url: null },
    bridge: { status: () => null, request: async () => null },
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(() => srv.close());

async function login() {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "letmein" }) });
  const j = await r.json();
  return { cookie: r.headers.get("set-cookie")!.split(";")[0], csrf: j.csrf as string };
}
const put = (body: unknown, s?: { cookie: string; csrf?: string }) => fetch(base + "/api/dash/settings", {
  method: "PUT", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...(s ? { cookie: s.cookie } : {}), ...(s?.csrf ? { "x-csrf-token": s.csrf } : {}) },
});
const four = (j: any) => ["attempted", "happened", "changed", "next"].every((k) => typeof j.error?.[k] === "string" && j.error[k].length > 0);

test("the settings page needs sign-in: a redirect to sign-in that comes back here", async () => {
  const r = await fetch(base + "/dash-settings?from=dash", { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/?next=%2Fdash-settings%3Ffrom%3Ddash#/login");
  assert.ok(four(await r.json()));
  const s = await login();
  const ok = await fetch(base + "/dash-settings?from=dash", { headers: { cookie: s.cookie } });
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /<title>Homedash settings - TEST<\/title>/);
  assert.doesNotMatch(html, /<style|\sstyle=|<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+=/i, "nothing the CSP would block");
  for (const f of ["/dash-settings.js", "/dash-settings.css"]) assert.equal((await fetch(base + f)).status, 200, f);
});

test("both API routes refuse without sign-in; saving refuses without the CSRF token", async () => {
  assert.equal((await fetch(base + "/api/dash/settings")).status, 401);
  const r = await put({ idleSeconds: 40 });
  assert.equal(r.status, 401);
  assert.ok(four(await r.json()));
  const s = await login();
  const n = await put({ idleSeconds: 40 }, { cookie: s.cookie });
  assert.equal(n.status, 403);
  assert.match((await n.json()).error.happened, /security token/);
  assert.equal(fs.existsSync(settingsFile), false, "nothing written");
});

test("GET lists every config.json camera, which have a sub stream, and the fonts, with no secrets", async () => {
  const s = await login();
  const r = await fetch(base + "/api/dash/settings", { headers: { cookie: s.cookie } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.cameras.map((c: any) => [c.camera, c.shown, c.hasSub]), [
    ["DogCamTest", false, true], ["GarageCamTest", false, true], ["BackyardCamTest", false, false], ["OnvifCamTest", false, false], ["Couch Cam", false, false],
  ]);
  assert.equal(j.gridMax, 4);
  assert.deepEqual(j.fonts, [{ file: "rMrRHh34w5nN.otf", name: "AlbertusMT" }]);
  assert.equal(j.dashUrl, "http://127.0.0.1:8181/");
  const text = JSON.stringify(j);
  assert.doesNotMatch(text, /s3cret|pw2|rtsp:|10\.0\.0\./);
});

test("a valid save writes the file (keeping a .bak) and returns the new settings", async () => {
  const s = await login();
  const cams = [
    { camera: "DogCamTest", label: "DogCam", shown: true, stream: "sub" },
    { camera: "BackyardCamTest", label: "BackyardCam", shown: true, stream: "main" },
  ];
  const r = await put({ cameras: cams, idleSeconds: 45, fonts: { ui: { kind: "file", file: "rMrRHh34w5nN.otf" } } }, s);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.saved, true);
  assert.equal(j.settings.idleSeconds, 45);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")).cameras, cams);
  const r2 = await put({ idleSeconds: 50 }, s);
  assert.equal(r2.status, 200);
  assert.ok((await r2.json()).backupPath.endsWith("settings.json.bak"));
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).cameras.length, 2, "a partial edit keeps the rest");
});

test("a fifth tile is refused with a clear message, and the file is unchanged", async () => {
  const s = await login();
  const before = fs.readFileSync(settingsFile, "utf8");
  const five = ["DogCamTest", "GarageCamTest", "BackyardCamTest", "OnvifCamTest", "Couch Cam"].map((camera) => ({ camera, label: camera, shown: true, stream: "main" }));
  const r = await put({ cameras: five }, s);
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.ok(four(j));
  assert.match(j.error.happened, /the grid shows at most 4; 5 are switched on/);
  assert.match(j.error.changed, /Nothing was saved/);
  assert.equal(fs.readFileSync(settingsFile, "utf8"), before);
});

test("an unknown camera or a sub stream the camera doesn't have is refused by name", async () => {
  const s = await login();
  const a = await put({ cameras: [{ camera: "Nope", label: "x", shown: true, stream: "main" }] }, s);
  assert.equal(a.status, 400);
  assert.match((await a.json()).error.happened, /"Nope" isn't in config\.json/);
  // host-style cameras get a derived sub stream; a bare rtspMain one has none
  const b = await put({ cameras: [{ camera: "BackyardCamTest", label: "x", shown: true, stream: "sub" }] }, s);
  assert.equal(b.status, 400);
  assert.match((await b.json()).error.happened, /BackyardCamTest.*no sub stream/);
});

test("the session says where the dashboard is and its idle time, for the kiosk's sign-in page", async () => {
  const j = await (await fetch(base + "/api/session")).json();
  assert.equal(j.dash.url, "http://127.0.0.1:8181/");
  assert.equal(typeof j.dash.idleSeconds, "number");
});

test("the preview fonts are served from the fonts folder, nothing else", async () => {
  const r = await fetch(base + "/dash-fonts/rMrRHh34w5nN.otf");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "font/otf");
  assert.equal((await fetch(base + "/dash-fonts/names.json")).status, 404);
  assert.equal((await fetch(base + "/dash-fonts/..%2fsettings.json")).status, 404);
});
