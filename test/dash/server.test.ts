import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as net from "net";
import { AddressInfo } from "net";
import { tempDir } from "../helpers/tmp";
import { createDashServer, DashDeps } from "../../src/dash/server";
import { setLogLevel } from "../../src/logger";

setLogLevel("error");
let base = "";
let srv: http.Server;
const webRoot = tempDir("unscr-dashweb-");

function deps(over: Partial<DashDeps> = {}): DashDeps {
  return {
    webRoot, title: "Homedash - TEST", go2rtcApi: "",
    publicConfig: () => ({ title: "Homedash - TEST", env: "test", adminPort: 8191, idleSeconds: 30, pollSeconds: 4, reloadMinutes: 20, cameras: [], fonts: { ui: { family: "x" }, clock: { inherit: true } } }),
    state: () => ({ updated: 1 }),
    allowedStreams: () => new Set<string>(),
    go2rtcInfo: () => ({ state: "running", lastError: null, nextRetryAt: null }),
    photos: () => ({ items: [], album: "", rotateSeconds: 20, error: "No iCloud album link is set." }),
    photoFile: () => null, fontsDir: tempDir("unscr-dashfonts-"),
    ...over,
  };
}

function listen(s: http.Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}

before(async () => {
  fs.writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>__TITLE__</title>");
  fs.writeFileSync(path.join(webRoot, "app.js"), "export {};");
  fs.writeFileSync(path.join(webRoot, "style.css"), "body{}");
  srv = createDashServer(deps());
  base = await listen(srv);
});
after(() => srv.close());

test("page has the title and the security headers, and sets no cookie", async () => {
  const r = await fetch(base + "/", { headers: { cookie: "unscrypted_admin=abc" } });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>Homedash - TEST<\/title>/);
  assert.match(r.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("set-cookie"), null);
});

test("healthz answers for the kiosk's wait probe", async () => {
  assert.deepEqual(await (await fetch(base + "/healthz")).json(), { ok: true });
});

test("watch only: every non-GET is refused with the four-part error", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    for (const p of ["/", "/api/config", "/api/state", "/api/dash/settings", "/go2rtc/api/streams"]) {
      const r = await fetch(base + p, { method, body: method === "DELETE" ? undefined : "{}" });
      assert.equal(r.status, 405, `${method} ${p}`);
      const b = await r.json();
      assert.ok(b.error.attempted && b.error.happened && b.error.changed && b.error.next);
      assert.match(b.error.next, /admin pane/);
    }
  }
});

test("unknown paths are a 404 with a reason, not a blank page", async () => {
  const r = await fetch(base + "/api/pairing");
  assert.equal(r.status, 404);
  assert.match((await r.json()).error.happened, /No such page/);
});

test("missing web files say the build is broken, not a blank page", async () => {
  const s = createDashServer(deps({ webRoot: path.join(webRoot, "nope") }));
  const b = await listen(s);
  try {
    const r = await fetch(b + "/");
    assert.equal(r.status, 500);
    assert.match((await r.json()).error.happened, /web files are missing/);
  } finally { s.close(); }
});

// ---------- go2rtc proxy (scripts + filtered signalling socket) ----------

function upgrade(port: number, pathAndQuery: string, extra = ""): Promise<{ head: string; sock: net.Socket }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(
      `GET ${pathAndQuery} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`));
    let buf = "";
    sock.on("data", (d) => { buf += d.toString("latin1"); if (buf.includes("\r\n\r\n")) resolve({ head: buf.split("\r\n\r\n")[0], sock }); });
    sock.on("error", reject);
  });
}
function maskedText(s: string): Buffer {
  const p = Buffer.from(s), mask = Buffer.from([9, 8, 7, 6]);
  if (p.length > 125) throw new Error("test helper: short frames only");
  return Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), mask, Buffer.from(p.map((b, i) => b ^ mask[i & 3]))]);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const closed = (s: net.Socket) => new Promise<void>((r) => { if (s.destroyed) r(); else s.once("close", () => r()); });

let g2: http.Server;
const g2Seen: { headers: http.IncomingHttpHeaders; url: string; after: Buffer[] }[] = [];
let g2Port = 0;

async function proxyServer(over: Partial<DashDeps> = {}): Promise<{ s: http.Server; port: number }> {
  const s = createDashServer(deps({ go2rtcApi: `http://127.0.0.1:${g2Port}`, allowedStreams: () => new Set(["dogcamtest", "dogcamtest_sub"]), ...over }));
  const b = await listen(s);
  return { s, port: Number(new URL(b).port) };
}

before(async () => {
  g2 = http.createServer((req, res) => {
    if (req.url === "/video-stream.js" || req.url === "/video-rtc.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end(`// fake ${req.url}`); }
    res.writeHead(500); res.end("the dash must not reach this");
  });
  g2.on("upgrade", (req, sock) => {
    const seen = { headers: req.headers, url: req.url ?? "", after: [] as Buffer[] };
    g2Seen.push(seen);
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    sock.on("data", (d) => seen.after.push(d));
    sock.on("error", () => sock.destroy());
  });
  const b = await listen(g2);
  g2Port = Number(new URL(b).port);
});
after(() => g2.close());

test("the player scripts come from go2rtc; nothing else of go2rtc's is passed", async () => {
  const { s, port } = await proxyServer();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/go2rtc/video-stream.js`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /fake \/video-stream\.js/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/go2rtc/video-rtc.js`)).status, 200);
    for (const p of ["/go2rtc/api/streams", "/go2rtc/api/frame.jpeg?src=dogcamtest", "/go2rtc/api/config", "/go2rtc/"]) {
      const x = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(x.status, 404, p);
      assert.match((await x.json()).error.happened, /isn't passed through/);
    }
  } finally { s.close(); }
});

test("a configured camera's socket is proxied, and the admin cookie never reaches go2rtc", async () => {
  const { s, port } = await proxyServer();
  try {
    const n = g2Seen.length;
    const { head, sock } = await upgrade(port, "/go2rtc/api/ws?src=dogcamtest", "Cookie: unscrypted_admin=abc\r\nOrigin: http://evil.example\r\n");
    assert.match(head, /^HTTP\/1\.1 101/);
    const seen = g2Seen[n];
    assert.equal(seen.url, "/api/ws?src=dogcamtest");
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.headers.origin, undefined);
    sock.write(maskedText(JSON.stringify({ type: "webrtc/offer", value: "v=0" })));
    await sleep(100);
    assert.equal(Buffer.concat(seen.after).length > 0, true, "the offer reached go2rtc");
    sock.destroy();
  } finally { s.close(); }
});

test("feed-check streams, unknown streams and junk names are refused before go2rtc", async () => {
  const { s, port } = await proxyServer();
  try {
    const n = g2Seen.length;
    const a = await upgrade(port, "/go2rtc/api/ws?src=check_1234abcd");
    assert.match(a.head, /^HTTP\/1\.1 403/);
    const b = await upgrade(port, "/go2rtc/api/ws?src=couch_cam");
    assert.match(b.head, /^HTTP\/1\.1 403/);
    const c = await upgrade(port, "/go2rtc/api/ws?src=../api");
    assert.match(c.head, /^HTTP\/1\.1 400/);
    const d2 = await upgrade(port, "/go2rtc/api/streams?src=dogcamtest");
    assert.match(d2.head, /^HTTP\/1\.1 404/);
    assert.equal(g2Seen.length, n, "go2rtc saw none of them");
    [a, b, c, d2].forEach((x) => x.sock.destroy());
  } finally { s.close(); }
});

test("an MSE request on the socket closes it, and go2rtc gets nothing of it", async () => {
  const { s, port } = await proxyServer();
  try {
    const n = g2Seen.length;
    const { head, sock } = await upgrade(port, "/go2rtc/api/ws?src=dogcamtest");
    assert.match(head, /^HTTP\/1\.1 101/);
    sock.write(maskedText(JSON.stringify({ type: "mse", value: "avc1" })));
    await closed(sock);
    await sleep(50);
    assert.equal(Buffer.concat(g2Seen[n].after).length, 0);
  } finally { s.close(); }
});

test("live views are capped, and a closed view frees its slot", async () => {
  const { s, port } = await proxyServer({ maxStreams: 1 });
  try {
    const first = await upgrade(port, "/go2rtc/api/ws?src=dogcamtest");
    assert.match(first.head, /^HTTP\/1\.1 101/);
    const second = await upgrade(port, "/go2rtc/api/ws?src=dogcamtest_sub");
    assert.match(second.head, /^HTTP\/1\.1 503/);
    second.sock.destroy();
    first.sock.destroy();
    await sleep(100);
    const third = await upgrade(port, "/go2rtc/api/ws?src=dogcamtest");
    assert.match(third.head, /^HTTP\/1\.1 101/);
    third.sock.destroy();
  } finally { s.close(); }
});

test("go2rtc off: the socket and the scripts say why (503), naming its state", async () => {
  const restarting = await proxyServer({ go2rtcInfo: () => ({ state: "backoff", lastError: "exited with code 1", nextRetryAt: Date.now() + 4000 }) });
  const off = await proxyServer({ go2rtcApi: "" });
  try {
    const n = g2Seen.length;
    const { head, sock } = await upgrade(restarting.port, "/go2rtc/api/ws?src=dogcamtest");
    assert.match(head, /^HTTP\/1\.1 503/);
    sock.destroy();
    assert.equal(g2Seen.length, n);
    const r = await fetch(`http://127.0.0.1:${restarting.port}/go2rtc/video-stream.js`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error.happened, /backoff, restarting in \d s\)\. Last error: exited with code 1/);
    const o = await fetch(`http://127.0.0.1:${off.port}/go2rtc/video-stream.js`);
    assert.equal(o.status, 503);
    assert.match((await o.json()).error.happened, /switched off in this instance/);
  } finally { restarting.s.close(); off.s.close(); }
});

test("photos: the list says why it's empty; only published ids are served, with their type", async () => {
  const pdir = tempDir("unscr-dashphotos-");
  const jpg = path.join(pdir, "a.jpg");
  fs.writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const s = createDashServer(deps({
    photos: () => ({ items: [{ id: "0123456789ab", v: 1 }], album: "Family", rotateSeconds: 15, error: null }),
    photoFile: (id) => (id === "0123456789ab" ? jpg : null),
  }));
  const b = await listen(s);
  try {
    assert.match((await (await fetch(base + "/api/photos")).json()).error, /No iCloud album link is set/);
    assert.deepEqual(await (await fetch(b + "/api/photos")).json(), { items: [{ id: "0123456789ab", v: 1 }], album: "Family", rotateSeconds: 15, error: null });
    const r = await fetch(b + "/api/photo/0123456789ab?v=1");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/jpeg");
    assert.equal((await r.arrayBuffer()).byteLength, 4);
    for (const bad of ["/api/photo/ffffffffffff", "/api/photo/..%2f..%2fsettings.json", "/api/photo/"]) {
      const x = await fetch(b + bad);
      assert.equal(x.status, 404, bad);
      assert.match((await x.json()).error.happened, /photo/i);
    }
  } finally { s.close(); }
});

test("fonts: only real font files from the fonts folder, with a long cache; no path tricks", async () => {
  const fdir = tempDir("unscr-dashfonts-");
  fs.writeFileSync(path.join(fdir, "rMrRHh34w5nN.otf"), "OTTO");
  fs.writeFileSync(path.join(path.dirname(fdir), "settings.json"), "{}");
  const s = createDashServer(deps({ fontsDir: fdir }));
  const b = await listen(s);
  try {
    const r = await fetch(b + "/fonts/rMrRHh34w5nN.otf");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "font/otf");
    assert.match(r.headers.get("cache-control")!, /max-age=86400/);
    for (const bad of ["/fonts/../settings.json", "/fonts/..%2fsettings.json", "/fonts/Gone.otf", "/fonts/names.json"]) {
      const x = await fetch(b + bad);
      assert.equal(x.status, 404, bad);
      assert.match((await x.json()).error.happened, /font|No such page/i);   // fetch itself folds "/fonts/../x" to "/x"
    }
  } finally { s.close(); }
});
