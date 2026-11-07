import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "../helpers/tmp";
import { UserError } from "../../src/shared/errors";
import { Logger } from "../../src/logger";
import { securityHeaders, sendJson, readFontFile, proxyGo2rtcFile, proxyGo2rtcSocket } from "../../src/shared/http";

/** A logger that keeps what it was told, so a test can check the WARN names what went wrong. */
function spyLog(): { log: Logger; warns: string[] } {
  const warns: string[] = [];
  return { warns, log: { warn: (m: string) => { warns.push(m); }, info() {}, error() {}, debug() {}, child() { return this; } } as unknown as Logger };
}

const listen = (s: http.Server | net.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as net.AddressInfo).port)));

test("securityHeaders: CSP, no framing, nosniff, no-store; a hostile Host header never reaches the policy", () => {
  const h = securityHeaders({ headers: { host: "dash.local:8180" } } as http.IncomingMessage);
  assert.match(h["content-security-policy"], /connect-src 'self' ws:\/\/dash\.local:8180 wss:\/\/dash\.local:8180;/);
  assert.equal(h["x-frame-options"], "DENY");
  assert.equal(h["x-content-type-options"], "nosniff");
  assert.equal(h["cache-control"], "no-store");
  const bad = securityHeaders({ headers: { host: "evil.example; script-src *" } } as http.IncomingMessage);
  assert.doesNotMatch(bad["content-security-policy"], /evil/);
});

test("sendJson writes the status, a JSON content type and the body", async () => {
  const s = http.createServer((_req, res) => sendJson(res, 418, { a: 1 }, { "x-extra": "y" }));
  const port = await listen(s);
  const r = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(r.status, 418);
  assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(r.headers.get("x-extra"), "y");
  assert.deepEqual(await r.json(), { a: 1 });
  s.close();
});

test("readFontFile: the bytes when it's there, the caller's 404 when it isn't, a logged 500 naming the code when it can't be read", () => {
  const dir = tempDir("unscr-font-");
  fs.writeFileSync(path.join(dir, "a.woff2"), "FONT");
  fs.mkdirSync(path.join(dir, "dir.woff2"));   // reading a directory is EISDIR, not "missing"
  const { log, warns } = spyLog();
  const opts = { attempted: "Load a font", log, changed: "Nothing.", unreadableNext: "Fix the permissions.",
    notThere: () => new UserError({ attempted: "Load a font", happened: "gone", changed: "Nothing.", next: "x" }, 404) };
  assert.equal(readFontFile(dir, "a.woff2", opts).toString(), "FONT");
  assert.throws(() => readFontFile(dir, "missing.woff2", opts), (e: unknown) => e instanceof UserError && e.status === 404);
  assert.throws(() => readFontFile(dir, "dir.woff2", opts), (e: unknown) =>
    e instanceof UserError && e.status === 500 && /couldn't be read \(EISDIR\)/.test(e.body.happened) && e.body.next === "Fix the permissions.");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /dir\.woff2.*EISDIR/);
});

test("proxyGo2rtcFile: streams go2rtc's answer; a dead go2rtc is the caller's 503 with the reason appended", async () => {
  const g2 = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/javascript" }); res.end(`// ${req.url}`); });
  const g2port = await listen(g2);
  const { log } = spyLog();
  const down = (attempted: string) => new UserError({ attempted, happened: "go2rtc is down.", changed: "Nothing.", next: "Wait." }, 503);
  let api = `http://127.0.0.1:${g2port}`;
  const front = http.createServer((_req, res) => { void proxyGo2rtcFile({ go2rtcApi: api, target: "/video-rtc.js", res, attempted: "Load the player", log, label: "player file", down }); });
  const port = await listen(front);
  const ok = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "// /video-rtc.js");
  g2.close();
  api = "http://127.0.0.1:1";   // nothing listens here
  const bad = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(bad.status, 503);
  const body = await bad.json() as { error: { attempted: string; happened: string } };
  assert.equal(body.error.attempted, "Load the player");
  assert.match(body.error.happened, /^go2rtc is down\. \(/);
  front.close();
});

/** A fake go2rtc that answers any upgrade with 101 and then echoes bytes, remembering the headers it was sent. */
async function fakeWsGo2rtc(): Promise<{ port: number; seen: { headers: http.IncomingHttpHeaders; url: string }[]; close: () => void }> {
  const seen: { headers: http.IncomingHttpHeaders; url: string }[] = [];
  const g2 = http.createServer();
  g2.on("upgrade", (req, sock) => {
    seen.push({ headers: req.headers, url: req.url ?? "" });
    sock.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
    sock.on("data", (c) => sock.write(c));
    sock.on("error", () => {});
  });
  const port = await listen(g2);
  return { port, seen, close: () => g2.close() };
}

test("proxyGo2rtcSocket without a filter (the admin pane): bytes pass both ways; cookie, origin and authorization never reach go2rtc", async () => {
  const g2 = await fakeWsGo2rtc();
  const { log } = spyLog();
  let gone = 0;
  const front = http.createServer();
  front.on("upgrade", (req, socket, head) => {
    proxyGo2rtcSocket({ req, socket, head, go2rtcApi: `http://127.0.0.1:${g2.port}`, src: "cam_1", log, label: "live preview", onGone: () => { gone++; } });
  });
  const port = await listen(front);
  const sock = net.connect(port, "127.0.0.1");
  const got: Buffer[] = [];
  sock.on("data", (c) => got.push(c));
  sock.write("GET /go2rtc/api/ws?src=cam_1 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: unscrypted_admin=abc\r\nOrigin: http://x\r\nAuthorization: Bearer t\r\nSec-WebSocket-Key: abc\r\n\r\n");
  await new Promise((r) => setTimeout(r, 200));
  sock.write("hello");
  await new Promise((r) => setTimeout(r, 200));
  assert.match(Buffer.concat(got).toString(), /101 Switching Protocols[\s\S]*hello/);
  assert.equal(g2.seen.length, 1);
  assert.equal(g2.seen[0].url, "/api/ws?src=cam_1");
  for (const h of ["cookie", "origin", "authorization"]) assert.equal(g2.seen[0].headers[h], undefined, `${h} must not reach go2rtc`);
  sock.destroy();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(gone, 1, "onGone runs exactly once");
  front.close(); g2.close();
});

test("proxyGo2rtcSocket: an unreachable go2rtc is a 502 that says so, and is logged", async () => {
  const { log, warns } = spyLog();
  const front = http.createServer();
  front.on("upgrade", (req, socket, head) => {
    proxyGo2rtcSocket({ req, socket, head, go2rtcApi: "http://127.0.0.1:1", src: "cam_1", log, label: "live preview" });
  });
  const port = await listen(front);
  const sock = net.connect(port, "127.0.0.1");
  let text = "";
  sock.on("data", (c) => { text += c; });
  sock.write("GET /x HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  await new Promise((r) => sock.on("close", r));
  assert.match(text, /^HTTP\/1\.1 502 Bad Gateway[\s\S]*go2rtc\) didn't answer/);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /live preview: couldn't reach go2rtc/);
  front.close();
});
