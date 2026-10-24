import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { explainGo2rtcFailure, Go2rtcClient, Go2rtcManager, maskSecretsInLine } from "../../src/admin/go2rtc";
import { Logger } from "../../src/logger";
import { tempDir } from "../helpers/tmp";

const log = new Logger("test");

test("maps common go2rtc failures to plain words", () => {
  assert.match(explainGo2rtcFailure("rtsp: wrong user/pass 401 Unauthorized").happened, /login/i);
  assert.match(explainGo2rtcFailure("dial tcp 10.0.1.3:554: connect: connection refused").happened, /refused/i);
  assert.match(explainGo2rtcFailure("dial tcp 10.0.1.3:554: i/o timeout").happened, /didn't answer/i);
  assert.match(explainGo2rtcFailure("rtsp: 404 Not Found").happened, /path/i);
  const other = explainGo2rtcFailure("weird thing");
  assert.match(other.happened, /weird thing/);
  assert.ok(other.next.length > 0);
});

test("passwords in URLs are masked in go2rtc log lines", () => {
  const line = maskSecretsInLine("ERR streams: dial rtsp://admin:hunter2@10.0.1.3:554/11 failed");
  assert.ok(!line.includes("hunter2"));
  assert.match(line, /rtsp:\/\/admin:\*\*\*@10\.0\.1\.3/);
});

test("manager with a missing binary reports 'missing' and still writes the yaml", async () => {
  const dir = tempDir("unscr-g2r-");
  const m = new Go2rtcManager({ binary: path.join(dir, "no-such-go2rtc"), runtimeDir: path.join(dir, "rt"),
    ports: { api: 1999, webrtc: null, rtsp: null }, log });
  m.start({ cameras: [{ name: "Cam", rtspMain: "rtsp://h/1", audio: true }] } as any);
  const end = Date.now() + 5000;
  while (m.status().state !== "missing" && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  await m.stop();
  assert.match(m.status().lastError ?? "", /ENOENT/);
  assert.match(fs.readFileSync(path.join(dir, "rt", "go2rtc.yaml"), "utf8"), /cam: "rtsp:\/\/h\/1"/);
});

test("manager reports a yaml write failure instead of throwing", async () => {
  const dir = tempDir("unscr-g2r-");
  const blocker = path.join(dir, "file-not-dir");
  fs.writeFileSync(blocker, "x");
  const m = new Go2rtcManager({ binary: "go2rtc", runtimeDir: path.join(blocker, "rt"), ports: { api: 1999, webrtc: null, rtsp: null }, log });
  assert.doesNotThrow(() => m.start({ cameras: [{ name: "Cam", rtspMain: "rtsp://h/1", audio: true }] } as any));
  assert.match(m.status().lastError ?? "", /go2rtc\.yaml/);
  assert.equal(m.status().state, "stopped");
  await m.stop();
});

test("client surfaces go2rtc's error text on a failed frame", async () => {
  const srv = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/frame.jpeg")) { res.statusCode = 500; res.end("dial tcp 10.0.0.9:554: i/o timeout"); return; }
    res.statusCode = 200; res.end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const c = new Go2rtcClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, 2000);
    await assert.rejects(c.frame("cam"), /i\/o timeout/);
    await c.addTempStream("t", "rtsp://h/1");
    await c.removeStream("t");
  } finally {
    srv.close();
  }
});

test("client times out loudly when go2rtc doesn't answer", async () => {
  const srv = http.createServer(() => { /* never answers */ });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const c = new Go2rtcClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, 100);
    await assert.rejects(c.frame("cam"), /did not answer/);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});
