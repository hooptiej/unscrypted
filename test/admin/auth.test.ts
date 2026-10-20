import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkPassword, issueSession, verifySession, LoginLimiter, loadAdminPassword, csrfToken, checkCsrf, SESSION_DAYS,
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
