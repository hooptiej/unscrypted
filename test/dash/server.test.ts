import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
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
