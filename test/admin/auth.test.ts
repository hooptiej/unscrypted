import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkPassword, issueSession, verifySession, LoginLimiter, loadAdminPassword, csrfToken, checkCsrf, SESSION_DAYS,
  loadOrCreateSessionKey, SESSION_KEY_BYTES,
} from "../../src/admin/auth";
import { UserError } from "../../src/admin/errors";

const key = crypto.randomBytes(32);

test("password check", () => {
  assert.ok(checkPassword("hunter2", "hunter2"));
  assert.ok(!checkPassword("hunter3", "hunter2"));
  assert.ok(!checkPassword("", "hunter2"));
});

test("session round-trip, tamper and expiry", () => {
  const now = 1_700_000_000_000;
  const c = issueSession(key, now);
  assert.ok(verifySession(c, key, now + 1000));
  assert.ok(verifySession(c, key, now + (SESSION_DAYS - 1) * 864e5));
  assert.ok(!verifySession(c.replace(/.$/, (ch) => (ch === "a" ? "b" : "a")), key, now));
  assert.ok(!verifySession(c, key, now + 31 * 864e5));
  assert.ok(!verifySession(undefined, key, now));
  assert.ok(!verifySession("garbage", key, now));
  assert.ok(!verifySession(c, crypto.randomBytes(32), now), "another process's key doesn't verify");
});

test("two sessions issued in the same millisecond differ", () => {
  assert.notEqual(issueSession(key, 5), issueSession(key, 5));
});

test("limiter locks after 5 failures for 5 minutes, and says when to retry", () => {
  const l = new LoginLimiter();
  for (let i = 0; i < 4; i++) l.fail("1.2.3.4", 0);
  assert.ok(l.allow("1.2.3.4", 1000), "4 failures still allowed");
  l.fail("1.2.3.4", 0);
  assert.ok(!l.allow("1.2.3.4", 1000));
  assert.equal(l.retryInMs("1.2.3.4", 1000), 5 * 60_000 - 1000);
  assert.ok(l.allow("1.2.3.4", 5 * 60_000 + 1));
  assert.ok(l.allow("5.6.7.8", 1000));
  l.reset("1.2.3.4");
  assert.equal(l.retryInMs("1.2.3.4", 1000), 0);
});

test("CSRF token is tied to the session and checked in constant time", () => {
  const s1 = issueSession(key, 1);
  const s2 = issueSession(key, 1);
  const t = csrfToken(key, s1);
  assert.ok(checkCsrf(t, key, s1));
  assert.ok(!checkCsrf(t, key, s2));
  assert.ok(!checkCsrf(undefined, key, s1));
  assert.ok(!checkCsrf("", key, s1));
});

test("missing or empty password file is a 503 with setup instructions and the reason", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unscr-auth-"));
  try {
    const missing = path.join(dir, "nope");
    assert.throws(() => loadAdminPassword(missing), (e: unknown) =>
      e instanceof UserError && e.status === 503 && /ENOENT|no such file/i.test(e.body.happened) && /admin_password/.test(e.body.next));
    const empty = path.join(dir, "empty");
    fs.writeFileSync(empty, "  \n");
    assert.throws(() => loadAdminPassword(empty), (e: unknown) => e instanceof UserError && /empty/i.test(e.body.happened));
    const ok = path.join(dir, "ok");
    fs.writeFileSync(ok, "letmein\r\n");
    assert.equal(loadAdminPassword(ok), "letmein");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sign-in key: created once (32 bytes, owner-only), then read back unchanged after a restart", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unscr-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data", "admin-session.key");
  const first = loadOrCreateSessionKey(file);
  assert.equal(first.created, true);
  assert.equal(first.key.length, SESSION_KEY_BYTES);
  assert.deepEqual(fs.readFileSync(file), first.key);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const session = issueSession(first.key);
  const second = loadOrCreateSessionKey(file);   // a restart of the admin pane
  assert.equal(second.created, false);
  assert.ok(verifySession(session, second.key), "a session from before the restart still verifies");
});

test("sign-in key of the wrong length is refused, not replaced", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unscr-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "admin-session.key");
  fs.writeFileSync(file, "short");
  assert.throws(() => loadOrCreateSessionKey(file), (e: unknown) =>
    e instanceof UserError && e.status === 503 && /5 bytes/.test(e.body.happened) && /admin-session\.key/.test(e.body.next)
    && /HomeKit/.test(e.body.changed));
  assert.equal(fs.readFileSync(file, "utf8"), "short", "the bad key file is left as it was");
});

test("unreadable sign-in key is refused with the reason", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unscr-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "admin-session.key");
  fs.mkdirSync(file);   // a folder where the file should be: reading it fails with EISDIR
  assert.throws(() => loadOrCreateSessionKey(file), (e: unknown) =>
    e instanceof UserError && e.status === 503 && /couldn't be read/.test(e.body.happened));
  assert.ok(fs.statSync(file).isDirectory(), "nothing was replaced");
});
