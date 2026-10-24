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

test("GET also carries the dashboard's own status lights, with full reasons, for the settings page", async () => {
  const lights = [{ id: "server", name: "NAS", state: "warn", short: "4 can't be checked yet", reason: "Below this: Constructicon: can't check yet.", children: [] }];
  const fake = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/api/state" ? { services: lights, servicesAt: 1234, cameras: { secret: "nope" } } : {}));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const dead = http.createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
  const deadPort = (dead.address() as AddressInfo).port;
  await new Promise((r) => dead.close(r));
  const mk = (port: number) => createAdminServer({
    configPath: path.join(dir, "config.json"), passwordFile: path.join(dir, "pw"), go2rtcApi: "",
    sessionKeyFile: path.join(dir, "admin-session.key"), webRoot: path.join(__dirname, "../../web/admin"), title: "unscrypted admin - TEST",
    dash: { dir: dashDir, port, url: null, host: "0.0.0.0" },
    bridge: { status: () => null, request: async () => null },
  });
  for (const [port, check] of [
    [(fake.address() as AddressInfo).port, (j: any) => {
      assert.deepEqual(j.lights, { services: lights, at: 1234, error: null });
    }],
    [deadPort, (j: any) => {
      assert.equal(j.lights.services, null);
      assert.match(j.lights.error, /couldn't read the status lights from the dashboard/i);
      assert.match(j.lights.error, /refused|ECONNREFUSED/);
    }],
  ] as const) {
    const a = mk(port);
    await new Promise<void>((r) => a.listen(0, "127.0.0.1", () => r()));
    try {
      const b = `http://127.0.0.1:${(a.address() as AddressInfo).port}`;
      const r = await fetch(b + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "letmein" }) });
      const cookie = r.headers.get("set-cookie")!.split(";")[0];
      const g = await fetch(b + "/api/dash/settings", { headers: { cookie } });
      assert.equal(g.status, 200);
      check(await g.json());
    } finally { a.closeAllConnections(); a.close(); }
  }
  fake.closeAllConnections();
  fake.close();
});

test("owner eye-check: live clock preview, 'Dashboard stream' with its hint, a status-lights list, labels that fit", () => {
  const web = path.join(__dirname, "../../web/admin");
  const html = fs.readFileSync(path.join(web, "dash-settings.html"), "utf8");
  const js = fs.readFileSync(path.join(web, "dash-settings.js"), "utf8");
  const css = fs.readFileSync(path.join(web, "dash-settings.css"), "utf8");
  // A fixed sample time read like a broken clock: the preview shows the live time, ticking.
  assert.doesNotMatch(html, /\d{1,2}:\d{2}\s*[AP]M/, "no fixed sample time in the preview");
  assert.match(html, /id="previewTime"/);
  assert.match(js, /\$\("previewTime"\)\.textContent = new Date\(\)\.toLocaleTimeString/);
  assert.match(js, /setInterval\(tickPreview/);
  // The stream column only picks the tile's go2rtc stream: say so.
  assert.match(html, /<span>Dashboard stream<\/span>/);
  assert.match(html, /what the dashboard tile plays; HomeKit isn't affected/);
  // The settings page shows each light's full reason.
  assert.match(html, /id="lights"/);
  assert.match(js, /function renderLights\(/);
  // The label column fits "ONVIF Camera" at the label font size: at least 300 design px.
  const cols = /\.camhead,\.cam\{display:grid;grid-template-columns:([^;]+);/.exec(css)![1];
  const fixed = [...cols.matchAll(/calc\((\d+)\*var\(--u\)\)/g)].reduce((n, m) => n + Number(m[1]), 0);
  const grid = /grid-template-columns:([\d.]+)fr ([\d.]+)fr ([\d.]+)fr;/.exec(css)!;
  const fr = (2560 - 40 - 24) / (Number(grid[1]) + Number(grid[2]) + Number(grid[3]));
  const camCol = fr * Number(grid[2]) - 2 * 26 - 4;
  const labelCol = camCol - fixed - 4 * 12;
  assert.ok(labelCol >= 300, `label column is ${Math.round(labelCol)} design px`);
});

test("signing out (the kiosk's idle return does this first) kills that session on the server, not just the cookie", async () => {
  const s = await login();
  assert.equal((await fetch(base + "/api/dash/settings", { headers: { cookie: s.cookie } })).status, 200);
  const out = await fetch(base + "/api/logout", { method: "POST", headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/json" }, body: "{}" });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
  const again = await fetch(base + "/api/dash/settings", { headers: { cookie: s.cookie } });
  assert.equal(again.status, 401, "the old cookie no longer works");
  assert.ok(four(await again.json()));
  assert.equal((await fetch(base + "/dash-settings?from=dash", { headers: { cookie: s.cookie }, redirect: "manual" })).status, 302, "the page sends it back to sign-in");
  // a fresh sign-in still works, and the revocation survives an admin pane restart (same key file)
  const s2 = await login();
  assert.equal((await fetch(base + "/api/dash/settings", { headers: { cookie: s2.cookie } })).status, 200);
  const re = createAdminServer({
    configPath: path.join(dir, "config.json"), passwordFile: path.join(dir, "pw"), go2rtcApi: "",
    sessionKeyFile: path.join(dir, "admin-session.key"), webRoot: path.join(__dirname, "../../web/admin"), title: "t",
    dash: { dir: dashDir, port: 8181, url: null }, bridge: { status: () => null, request: async () => null },
  });
  await new Promise<void>((r) => re.listen(0, "127.0.0.1", () => r()));
  try {
    const b = `http://127.0.0.1:${(re.address() as AddressInfo).port}`;
    assert.equal((await fetch(b + "/api/dash/settings", { headers: { cookie: s.cookie } })).status, 401, "still signed out after a restart");
    assert.equal((await fetch(b + "/api/dash/settings", { headers: { cookie: s2.cookie } })).status, 200);
  } finally { re.closeAllConnections(); re.close(); }
});

test("#14: GET says why Constructicon fonts aren't available; a good address + token lists them; POST copies one into the folder", async () => {
  const s = await login();
  let r = await fetch(base + "/api/dash/settings", { headers: { cookie: s.cookie } });
  let j = await r.json();
  assert.equal(j.constructicon.available, false);
  assert.match(j.constructicon.reason, /no Constructicon address is set/);
  assert.deepEqual(j.constructicon.fonts, []);

  // A fake Constructicon and a token file, wired through a second admin server.
  const fake = http.createServer((req, res) => {
    if (req.url === "/api/brand-assets" && req.headers.authorization === "Bearer tok-xyz") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify([{ slug: "AlbLight0001", title: "AlbertusMT-Light.otf" }, { slug: "rMrRHh34w5nN", title: "AlbertusMT.otf" }]));
    }
    if (req.url === "/f/AlbLight0001") { res.setHeader("content-type", "font/otf"); return res.end("OTTO-light"); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r2) => fake.listen(0, "127.0.0.1", () => r2()));
  const cxBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const tokenFile = path.join(dir, "constructicon_token");
  fs.writeFileSync(tokenFile, "tok-xyz\n");
  const a = createAdminServer({
    configPath: path.join(dir, "config.json"), passwordFile: path.join(dir, "pw"), go2rtcApi: "",
    sessionKeyFile: path.join(dir, "admin-session.key"), webRoot: path.join(__dirname, "../../web/admin"), title: "unscrypted admin - TEST",
    dash: { dir: dashDir, port: 8181, url: null }, constructicon: { tokenFile },
    bridge: { status: () => null, request: async () => null },
  });
  await new Promise<void>((r2) => a.listen(0, "127.0.0.1", () => r2()));
  const b = `http://127.0.0.1:${(a.address() as AddressInfo).port}`;
  try {
    const lr = await fetch(b + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "letmein" }) });
    const sess = { cookie: lr.headers.get("set-cookie")!.split(";")[0], csrf: (await lr.json()).csrf as string };
    const hdr = { cookie: sess.cookie, "x-csrf-token": sess.csrf, "content-type": "application/json" };

    const badUrl = await fetch(b + "/api/dash/settings", { method: "PUT", headers: hdr, body: JSON.stringify({ constructicon: { url: "ftp://nope/x" } }) });
    assert.equal(badUrl.status, 400);
    assert.match((await badUrl.json()).error.happened, /Constructicon address: must be just http\(s\):\/\/host/);

    const saved = await fetch(b + "/api/dash/settings", { method: "PUT", headers: hdr, body: JSON.stringify({ constructicon: { url: cxBase + "/" } }) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).settings.constructicon.url, cxBase, "a trailing slash is dropped");

    r = await fetch(b + "/api/dash/settings", { headers: { cookie: sess.cookie } });
    j = await r.json();
    assert.equal(j.constructicon.available, true);
    assert.equal(j.constructicon.reason, null);
    assert.deepEqual(j.constructicon.fonts, [
      { slug: "rMrRHh34w5nN", name: "AlbertusMT", ext: "otf", file: null },
      { slug: "AlbLight0001", name: "AlbertusMT-Light", ext: "otf", file: null },
    ]);
    assert.doesNotMatch(JSON.stringify(j), /tok-xyz/, "the token never reaches the browser");

    const noSlug = await fetch(b + "/api/dash/fonts/constructicon", { method: "POST", headers: hdr, body: "{}" });
    assert.equal(noSlug.status, 400);
    const got = await fetch(b + "/api/dash/fonts/constructicon", { method: "POST", headers: hdr, body: JSON.stringify({ slug: "AlbLight0001" }) });
    assert.equal(got.status, 200);
    const g = await got.json();
    assert.equal(g.file, "cx-AlbLight0001.otf");
    assert.equal(g.name, "AlbertusMT-Light");
    assert.ok(g.fonts.some((f: any) => f.file === "cx-AlbLight0001.otf" && f.name === "AlbertusMT-Light"), "the folder listing now has it, named");
    assert.equal(fs.readFileSync(path.join(dashDir, "fonts", "cx-AlbLight0001.otf"), "utf8"), "OTTO-light");
    // and it can be chosen and saved like any folder font
    const pick = await fetch(b + "/api/dash/settings", { method: "PUT", headers: hdr, body: JSON.stringify({ fonts: { clock: { kind: "file", file: "cx-AlbLight0001.otf" } } }) });
    assert.equal(pick.status, 200);
    r = await fetch(b + "/api/dash/settings", { headers: { cookie: sess.cookie } });
    j = await r.json();
    assert.equal(j.constructicon.fonts.find((f: any) => f.slug === "AlbLight0001").file, "cx-AlbLight0001.otf", "listed as already in the folder");
    // unsigned: refused like everything else
    assert.equal((await fetch(b + "/api/dash/fonts/constructicon", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "AlbLight0001" }) })).status, 401);
  } finally {
    a.close(); fake.close();
    fs.rmSync(path.join(dashDir, "fonts", "cx-AlbLight0001.otf"), { force: true });
    fs.writeFileSync(path.join(dashDir, "fonts", "names.json"), JSON.stringify({ "rMrRHh34w5nN.otf": "AlbertusMT" }));
    await fetch(b + "/api/dash/settings", { method: "PUT" }).catch(() => undefined);
  }
});
