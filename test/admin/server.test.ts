import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { createAdminServer, AdminDeps } from "../../src/admin/server";
import { BridgeStatus } from "../../src/admin/ipc";
import { setLogLevel } from "../../src/logger";

setLogLevel("error");

const applied: any[] = [];
let dir = "";
let base = "";
let srv: http.Server;
let fakeG2: http.Server;
let g2Base = "";
const g2Calls: string[] = [];
let frameFails: string | null = null;
let bridgeReply: (m: any) => any = (m) => ({ type: "applied", reqId: "x", ok: true, mode: "live", message: `applied ${m.name ?? m.type}` });

const status = (over: Partial<BridgeStatus> = {}): BridgeStatus => ({
  bridgeName: "U", pin: "031-45-154", setupURI: "X-HM://0023ISYWYUNSC", paired: false, hapPort: 51826, hapEnabled: true,
  cameras: [], startedAt: Date.now(), version: "test",
  go2rtc: { name: "go2rtc", state: "running", restarts: 0, lastError: null, nextRetryAt: null, since: 0 },
  dash: { name: "dash", state: "running", restarts: 0, lastError: null, nextRetryAt: null, since: 0 },
  homekitSource: { mode: "go2rtc", since: 0, reason: null, downSince: null, healthySince: 0, unhealthySince: null, returnAt: null,
    text: "HomeKit reads every camera through go2rtc: one connection per camera stream." }, ...over,
});
let currentStatus: BridgeStatus | null = status();

function listen(s: http.Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}

function makeServer(over: Partial<AdminDeps> = {}): http.Server {
  return createAdminServer({
    configPath: path.join(dir, "config.json"), passwordFile: path.join(dir, "pw"), go2rtcApi: g2Base,
    sessionKeyFile: path.join(dir, "data", "admin-session.key"),
    webRoot: path.join(dir, "web"), title: "unscrypted admin - TEST",
    bridge: {
      status: () => currentStatus,
      request: async (m: any) => { applied.push(m); return bridgeReply(m); },
    },
    ...over,
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "unscr-srv-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    bridge: { name: "U", username: "CC:22:3D:E3:CE:F6", pin: "031-45-154" },
    cameras: [
      { name: "Garage", rtspMain: "rtsp://admin:s3cret@10.0.0.3:554/11" },
      { name: "Front", host: "10.0.0.5", rtspUser: "admin", rtspPassword: "pw2",
        onvif: { host: "10.0.0.5", port: 8080, username: "admin", password: "onvifpw", notifyPort: 8101 } },
    ] }, null, 2));
  fs.writeFileSync(path.join(dir, "pw"), "letmein\n");
  fs.mkdirSync(path.join(dir, "web"));
  fs.writeFileSync(path.join(dir, "web", "index.html"), "<!doctype html><title>__TITLE__</title>");
  fakeG2 = http.createServer((req, res) => {
    g2Calls.push(`${req.method} ${req.url}`);
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/api/streams") { res.writeHead(200); return res.end(); }
    if (u.pathname === "/api/frame.jpeg") {
      if (frameFails) { res.writeHead(500); return res.end(frameFails); }
      res.writeHead(200, { "content-type": "image/jpeg" }); return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    if (u.pathname === "/video-rtc.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end("export class VideoRTC {}"); }
    res.writeHead(404); res.end("nope");
  });
  g2Base = await listen(fakeG2);
  srv = makeServer();
  base = await listen(srv);
});
after(() => { srv.close(); fakeG2.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function login(b = base) {
  const r = await fetch(b + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "letmein" }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.csrf, "login returns the CSRF token");
  return { cookie: r.headers.get("set-cookie")!.split(";")[0], csrf: j.csrf as string };
}
async function send(method: string, p: string, body: unknown, s?: { cookie: string; csrf: string }) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (s) { headers.cookie = s.cookie; headers["x-csrf-token"] = s.csrf; }
  return fetch(base + p, { method, headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}
const readCfg = () => fs.readFileSync(path.join(dir, "config.json"), "utf8");

test("pages carry the title and security headers", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>unscrypted admin - TEST<\/title>/);
  assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(r.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const api = await fetch(base + "/api/cameras");
  assert.equal(api.headers.get("x-content-type-options"), "nosniff");
});

test("shipped pane files exist and contain nothing the CSP would block", () => {
  const root = path.join(__dirname, "../../web/admin");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /<title>__TITLE__<\/title>/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, "no inline <script>");
  assert.doesNotMatch(html, /\sstyle=|<style/i, "no inline styles");
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline event handlers");
  const js = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write|eval\(/, "server text never goes in as HTML");
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  assert.match(css, /--accent:\s*#7a8a2e/);
});

test("healthz needs no sign-in", async () => {
  const r = await fetch(base + "/healthz");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("unauthenticated API is refused with a clear message", async () => {
  const r = await fetch(base + "/api/cameras");
  assert.equal(r.status, 401);
  const j = await r.json();
  for (const k of ["attempted", "happened", "changed", "next"]) assert.ok(j.error[k].length > 0, k);
});

test("session endpoint says signed-in state and re-issues the CSRF token", async () => {
  const anon = await (await fetch(base + "/api/session")).json();
  assert.equal(anon.signedIn, false);
  const s = await login();
  const me = await (await fetch(base + "/api/session", { headers: { cookie: s.cookie } })).json();
  assert.equal(me.signedIn, true);
  assert.equal(me.csrf, s.csrf);
});

test("wrong password is 401 and says what to do", async () => {
  const r = await send("POST", "/api/login", { password: "nope" });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error.next, /admin_password/);
});

test("login refuses a non-JSON (form) post", async () => {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=letmein" });
  assert.equal(r.status, 415);
});

test("cookie is HttpOnly, SameSite=Strict, 30 days", async () => {
  const r = await send("POST", "/api/login", { password: "letmein" });
  const c = r.headers.get("set-cookie")!;
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Max-Age=2592000/);
});

test("camera list never contains a password", async () => {
  const s = await login();
  const t = await (await fetch(base + "/api/cameras", { headers: { cookie: s.cookie } })).text();
  for (const secret of ["s3cret", "pw2", "onvifpw", "letmein"]) assert.ok(!t.includes(secret), secret);
  assert.ok(t.includes("***"));
  assert.ok(t.includes('"set":true'));
});

test("state-changing request without the CSRF token is refused, nothing written", async () => {
  const s = await login();
  const before = readCfg();
  const r = await fetch(base + "/api/cameras/Garage", { method: "PUT", headers: { cookie: s.cookie, "content-type": "application/json" }, body: JSON.stringify({ prebufferSeconds: 7 }) });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error.changed, /nothing/i);
  assert.equal(readCfg(), before);
});

test("cross-site Origin is refused even with a token", async () => {
  const s = await login();
  const r = await fetch(base + "/api/bridge/restart", { method: "POST", headers: { cookie: s.cookie, "x-csrf-token": s.csrf, origin: "http://evil.example" } });
  assert.equal(r.status, 403);
});

test("rename via PUT is refused and config.json is unchanged", async () => {
  const s = await login();
  const before = readCfg();
  const r = await send("PUT", "/api/cameras/Garage", { name: "Garage2" }, s);
  assert.equal(r.status, 409);
  assert.match((await r.json()).error.happened, /identity/);
  assert.equal(readCfg(), before);
});

test("edit saves atomically, keeps password, tells the bridge", async () => {
  const s = await login();
  const r = await send("PUT", "/api/cameras/Garage", { prebufferSeconds: 6 }, s);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.saved, true);
  assert.equal(j.mode, "live");
  const saved = JSON.parse(readCfg());
  assert.equal(saved.cameras[0].prebufferSeconds, 6);
  assert.ok(saved.cameras[0].rtspMain.includes("s3cret"));
  assert.deepEqual(applied.at(-1), { type: "apply", name: "Garage", isNew: false });
  assert.ok(fs.readdirSync(path.join(dir, "backups")).length >= 1);
  assert.deepEqual(j.notes, [], "no stream change, no prebuffer warning");
});

test("changing the stream address carries the recording-buffer warning", async () => {
  const s = await login();
  const r = await send("PUT", "/api/cameras/Garage", { rtspMain: "rtsp://admin:***@10.0.0.3:554/12" }, s);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.notes.join(" "), /recording buffer/);
  assert.ok(JSON.parse(readCfg()).cameras[0].rtspMain.includes("s3cret@10.0.0.3:554/12"));
});

test("add a camera tells the bridge it's new", async () => {
  const s = await login();
  const r = await send("POST", "/api/cameras", { name: "Shed", rtspMain: "rtsp://u:p@10.0.0.9/1" }, s);
  assert.equal(r.status, 200);
  assert.deepEqual(applied.at(-1), { type: "apply", name: "Shed", isNew: true });
});

test("bridge not answering: 202, saved but not live", async () => {
  const s2 = makeServer({ bridge: { status: () => currentStatus, request: async () => null } });
  const b2 = await listen(s2);
  try {
    const s = await login(b2);
    const r = await fetch(b2 + "/api/cameras/Garage", { method: "PUT", headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/json" }, body: JSON.stringify({ maxRecordingSeconds: 120 }) });
    assert.equal(r.status, 202);
    assert.match((await r.json()).message, /NOT live/);
  } finally { s2.close(); }
});

test("bridge refusing the apply: 500 that says the file WAS saved", async () => {
  bridgeReply = () => ({ type: "applied", reqId: "x", ok: false, error: { attempted: "a", happened: "boom", changed: "kept old", next: "n" } });
  try {
    const s = await login();
    const r = await send("PUT", "/api/cameras/Garage", { maxRecordingSeconds: 121 }, s);
    assert.equal(r.status, 500);
    const j = await r.json();
    assert.equal(j.saved, true);
    assert.match(j.error.changed, /WAS saved/);
  } finally {
    bridgeReply = (m) => ({ type: "applied", reqId: "x", ok: true, mode: "live", message: `applied ${m.name}` });
  }
});

test("feed check with go2rtc down says so plainly", async () => {
  currentStatus = status({ go2rtc: { name: "go2rtc", state: "backoff", restarts: 2, lastError: "exited with code 1", nextRetryAt: Date.now() + 8000, since: 0 } });
  try {
    const s = await login();
    const r = await send("POST", "/api/cameras/check", { name: "Garage", edit: {} }, s);
    assert.equal(r.status, 503);
    const e = (await r.json()).error;
    assert.match(e.happened, /go2rtc/i);
    assert.match(e.happened, /restarting in/);
  } finally { currentStatus = status(); }
});

test("feed check of an edited address: one temp stream, closed before the answer, frame kept in memory, nothing written", async () => {
  const s = await login();
  const before = readCfg();
  g2Calls.length = 0;
  const r = await send("POST", "/api/cameras/check", { name: "Garage", edit: { rtspMain: "rtsp://admin:***@10.0.0.3:554/13" } }, s);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.reused, false);
  assert.equal(j.wsUrl, null, "an edited address gets a still frame only (Q6)");
  assert.match(j.frameUrl, /^\/api\/cameras\/check\/[0-9a-f]{16}\/frame\.jpg$/);
  const put = g2Calls.findIndex((c) => c.startsWith("PUT /api/streams") && c.includes("name=check_"));
  assert.ok(put >= 0);
  assert.ok(decodeURIComponent(g2Calls[put]).includes("rtsp://admin:s3cret@10.0.0.3:554/13"), "stored password merged in for the check");
  const frame = g2Calls.findIndex((c) => c.startsWith("GET /api/frame.jpeg?src=check_"));
  const del = g2Calls.findIndex((c) => c.startsWith("DELETE /api/streams?src=check_"));
  assert.ok(put < frame && frame < del, `PUT, frame, DELETE in that order, all before the answer: ${g2Calls.join(", ")}`);
  assert.equal(readCfg(), before);
  const img = await fetch(base + j.frameUrl, { headers: { cookie: s.cookie } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  assert.equal(img.headers.get("cache-control"), "no-store");
  assert.deepEqual([...Buffer.from(await img.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);
  assert.equal((await fetch(base + j.frameUrl)).status, 401, "signed out");
  const gone = await fetch(base + "/api/cameras/check/0123456789abcdef/frame.jpg", { headers: { cookie: s.cookie } });
  assert.equal(gone.status, 404);
  const e = (await gone.json()).error;
  assert.match(e.happened, /expired/); assert.ok(e.attempted && e.changed && e.next);
  const old = await send("DELETE", "/api/cameras/check/check_abcd1234", undefined, s);
  assert.equal(old.status, 200);
  assert.match((await old.json()).message, /Nothing to close/);
});

test("feed check of an unchanged camera reuses its configured stream: no temp stream at all", async () => {
  const s = await login();
  currentStatus = status({ cameras: [{ name: "Garage", stream: "garage" } as any] });
  g2Calls.length = 0;
  try {
    const r = await send("POST", "/api/cameras/check", { name: "Garage", edit: {} }, s);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual([j.reused, j.stream, j.wsUrl], [true, "garage", "/go2rtc/api/ws?src=garage"]);
    assert.deepEqual(g2Calls, ["GET /api/frame.jpeg?src=garage"]);
    assert.equal((await fetch(base + j.frameUrl, { headers: { cookie: s.cookie } })).status, 200);
  } finally { currentStatus = status(); }
});

test("a failing temp-stream check still closes the test stream and explains in plain words", async () => {
  frameFails = "dial tcp 10.0.0.9:554: i/o timeout";
  g2Calls.length = 0;
  try {
    const s = await login();
    const r = await send("POST", "/api/cameras/check", { edit: { name: "New", rtspMain: "rtsp://u:x@10.0.0.9/1" } }, s);
    assert.equal(r.status, 502);
    const e = (await r.json()).error;
    assert.match(e.happened, /didn't answer/);
    assert.match(e.changed, /test connection was closed/);
    assert.ok(g2Calls.some((c) => c.startsWith("DELETE /api/streams?src=check_")), "temp stream deleted even though the frame failed");
  } finally { frameFails = null; }
});

test("feed check for a new camera and a failing camera explains the failure", async () => {
  frameFails = "rtsp: wrong user/pass 401 Unauthorized";
  try {
    const s = await login();
    const r = await send("POST", "/api/cameras/check", { edit: { name: "Garage", rtspMain: "rtsp://u:bad@10.0.0.9/1" } }, s);
    assert.equal(r.status, 502);
    const e = (await r.json()).error;
    assert.match(e.happened, /login/);
    assert.match(e.changed, /Nothing was saved/);
  } finally { frameFails = null; }
});

test("go2rtc proxy: frame works signed in, refused signed out, odd src and other paths refused", async () => {
  const s = await login();
  const ok = await fetch(base + "/go2rtc/api/frame.jpeg?src=garage", { headers: { cookie: s.cookie } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
  assert.equal((await fetch(base + "/go2rtc/api/frame.jpeg?src=garage")).status, 401);
  const bad = await fetch(base + "/go2rtc/api/frame.jpeg?src=" + encodeURIComponent("exec:rm -rf /"), { headers: { cookie: s.cookie } });
  assert.equal(bad.status, 400);
  const other = await fetch(base + "/go2rtc/api/streams", { headers: { cookie: s.cookie } });
  assert.equal(other.status, 404);
  const js = await fetch(base + "/go2rtc/video-rtc.js", { headers: { cookie: s.cookie } });
  assert.equal(js.status, 200);
});

test("status hides the pin and explains HAP-off", async () => {
  currentStatus = status({ hapEnabled: false, hapPort: null, setupURI: "" });
  try {
    const s = await login();
    const j = await (await fetch(base + "/api/status", { headers: { cookie: s.cookie } })).json();
    assert.equal(j.pin, undefined);
    assert.equal(j.setupURI, undefined);
    assert.match(j.notices.join(" "), /motion/i);
    const p = await fetch(base + "/api/pairing", { headers: { cookie: s.cookie } });
    assert.equal(p.status, 409);
  } finally { currentStatus = status(); }
});

test("status says when HomeKit reads the cameras directly, with local-time tokens; quiet in go2rtc mode", async () => {
  const s = await login();
  const get = async () => (await (await fetch(base + "/api/status", { headers: { cookie: s.cookie } })).json()).notices.join(" | ");
  assert.doesNotMatch(await get(), /HomeKit is reading/);
  currentStatus = status({
    go2rtc: { name: "go2rtc", state: "backoff", restarts: 3, lastError: "exited with code 1", nextRetryAt: null, since: 0 },
    homekitSource: { mode: "direct", since: 25_000, reason: "go2rtc isn't running (backoff: exited with code 1)", downSince: 10_000, healthySince: null, unhealthySince: 10_000, returnAt: null,
      text: "HomeKit is reading the cameras directly because go2rtc is down (since {{t:10000}}): go2rtc isn't running (backoff: exited with code 1). Cameras may see an extra connection each until go2rtc is back. HomeKit switches back on its own once go2rtc has been healthy for a minute." },
  });
  try {
    const n = await get();
    assert.match(n, /HomeKit is reading the cameras directly because go2rtc is down \(since \{\{t:\d+\}\}\)/);
    assert.match(n, /dashboard's video are unavailable\. HomeKit falls back to reading the cameras directly after 15 s/);
    assert.doesNotMatch(n, /HomeKit is unaffected/);
  } finally { currentStatus = status(); }
  currentStatus = status({ cameras: [{ name: "Garage", direct: { since: 1, until: 2, reason: "x", text: 'HomeKit is reading "Garage" directly (since {{t:1}}): x.' } } as any] });
  try { assert.match(await get(), /HomeKit is reading "Garage" directly/); } finally { currentStatus = status(); }
});

test("pairing returns a QR image and the code", async () => {
  const s = await login();
  const j = await (await fetch(base + "/api/pairing", { headers: { cookie: s.cookie } })).json();
  assert.equal(j.pin, "031-45-154");
  assert.match(j.qrImage, /^data:image\/svg\+xml;base64,/);
  assert.ok(j.note.length > 0);
});

test("a bad JSON body is a 400, server keeps serving", async () => {
  const s = await login();
  const r = await send("PUT", "/api/cameras/Garage", "{not json", s);
  assert.equal(r.status, 400);
  assert.equal((await fetch(base + "/healthz")).status, 200);
});

test("missing password file: 503 with setup instructions", async () => {
  const s2 = makeServer({ passwordFile: path.join(dir, "absent") });
  const b2 = await listen(s2);
  try {
    const r = await fetch(b2 + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error.next, /admin_password/);
  } finally { s2.close(); }
});

test("5 wrong passwords lock this address out with a retry time", async () => {
  const s2 = makeServer();
  const b2 = await listen(s2);
  try {
    const wrong = () => fetch(b2 + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "x" }) });
    for (let i = 0; i < 5; i++) assert.equal((await wrong()).status, 401);
    const r = await fetch(b2 + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "letmein" }) });
    assert.equal(r.status, 429);
    assert.match((await r.json()).error.next, /minute/);
  } finally { s2.close(); }
});

test("sign-ins survive an admin pane restart (the key is kept in a file)", async () => {
  const s = await login();
  const s2 = makeServer();   // same key file, as after a container restart
  const b2 = await listen(s2);
  try {
    const r = await fetch(b2 + "/api/cameras", { headers: { cookie: s.cookie } });
    assert.equal(r.status, 200, "the old cookie still works");
    const me = await (await fetch(b2 + "/api/session", { headers: { cookie: s.cookie } })).json();
    assert.equal(me.csrf, s.csrf, "and so does its CSRF token");
  } finally { s2.close(); }
});

test("a bad sign-in key file refuses the pane with a clear 503 and isn't replaced", async () => {
  const bad = path.join(dir, "bad.key");
  fs.writeFileSync(bad, "too short");
  const s2 = makeServer({ sessionKeyFile: bad });
  const b2 = await listen(s2);
  try {
    const r = await fetch(b2 + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "letmein" }) });
    assert.equal(r.status, 503);
    const e = (await r.json()).error;
    assert.match(e.happened, /9 bytes/);
    assert.match(e.changed, /HomeKit bridge is running normally/);
    const me = await (await fetch(b2 + "/api/session")).json();
    assert.equal(me.signedIn, false);
    assert.match(me.setupError.happened, /sign-in key/);
    assert.equal((await fetch(b2 + "/healthz")).status, 200);
    assert.equal(fs.readFileSync(bad, "utf8"), "too short");
  } finally { s2.close(); }
});

const creds = (name: string) => `/api/cameras/${encodeURIComponent(name)}/credentials`;

test("credentials: not signed in is a 401, no CSRF token is a 403, cross-site is a 403", async () => {
  const anon = await send("POST", creds("Garage"), {});
  assert.equal(anon.status, 401);
  assert.ok(!(await anon.text()).includes("s3cret"));
  const s = await login();
  const noTok = await fetch(base + creds("Garage"), { method: "POST", headers: { cookie: s.cookie, "content-type": "application/json" }, body: "{}" });
  assert.equal(noTok.status, 403);
  assert.ok(!(await noTok.text()).includes("s3cret"));
  const evil = await fetch(base + creds("Garage"), { method: "POST", headers: { cookie: s.cookie, "x-csrf-token": s.csrf, origin: "http://evil.example" } });
  assert.equal(evil.status, 403);
  assert.ok(!(await evil.text()).includes("s3cret"));
  const get = await fetch(base + creds("Garage"), { headers: { cookie: s.cookie } });
  assert.equal(get.status, 404, "a plain GET (a link, a prefetch) never shows them");
});

test("credentials: one camera's logins, never cached; the list stays redacted", async () => {
  const s = await login();
  const r = await send("POST", creds("Garage"), {}, s);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), { name: "Garage", rtsp: { user: "admin", password: "s3cret" }, foscam: null, onvif: null, webUi: null });
  const f = await (await send("POST", creds("Front"), {}, s)).json();
  assert.deepEqual(f.rtsp, { user: "admin", password: "pw2" });
  assert.deepEqual(f.onvif, { user: "admin", password: "onvifpw" });
  assert.equal(f.webUi, "http://10.0.0.5");
  assert.ok(!JSON.stringify(f).includes("s3cret"), "only the camera asked for");
  const list = await (await fetch(base + "/api/cameras", { headers: { cookie: s.cookie } })).text();
  for (const secret of ["s3cret", "pw2", "onvifpw"]) assert.ok(!list.includes(secret), secret);
});

test("credentials: an unknown camera is a 404 in the four-part shape", async () => {
  const s = await login();
  const r = await send("POST", creds("Nope"), {}, s);
  assert.equal(r.status, 404);
  const e = (await r.json()).error;
  for (const k of ["attempted", "happened", "changed", "next"]) assert.ok(e[k].length > 0, k);
  assert.match(e.happened, /Nope/);
});

test("credentials: each reveal is logged by name, with no value in the log", async () => {
  const lines: string[] = [];
  const rec = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const fake: any = { debug: rec, info: rec, warn: rec, error: rec, child: () => fake };
  const s2 = makeServer({ log: fake });
  const b2 = await listen(s2);
  try {
    const s = await login(b2);
    const r = await fetch(b2 + creds("Front"), { method: "POST", headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });
    assert.equal(r.status, 200);
    assert.ok(lines.includes('credentials for "Front" shown'), lines.join("\n"));
    const all = lines.join("\n");
    for (const secret of ["s3cret", "pw2", "onvifpw", "letmein"]) assert.ok(!all.includes(secret), secret);
  } finally { s2.close(); }
});

test("the pane asks for logins only by POST from the Show button, and re-masks after 60 s", () => {
  const js = fs.readFileSync(path.join(__dirname, "../../web/admin/app.js"), "utf8");
  const calls = js.match(/api\("[A-Z]+", `\/api\/cameras\/\$\{encodeURIComponent\(cam\.name\)\}\/credentials`/g) ?? [];
  assert.deepEqual(calls.map((c) => c.slice(5, 9)), ["POST"], "exactly one call, a POST");
  const at = js.indexOf("/credentials`");
  assert.ok(js.lastIndexOf('showBtn.addEventListener("click"', at) > js.lastIndexOf("function loginBox", at), "inside the Show click handler");
  assert.match(js, /REVEAL_MS = 60_000/);
});
