/**
 * Admin sign-in: one password (a secrets file), an HMAC-signed session cookie that lasts 30 days,
 * a per-session CSRF token for every state-changing request, and a login lockout after 5 wrong
 * passwords. The signing key is made once and kept in a file next to the HAP pairing state
 * (/data/admin-session.key in Docker), so sign-ins survive restarts (owner decision 2026-10-20).
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { UserError } from "./errors";

export const SESSION_DAYS = 30;
export const SESSION_KEY_BYTES = 32;

function badKey(file: string, happened: string, next: string): UserError {
  return new UserError({
    attempted: "Load the admin pane's sign-in key",
    happened,
    changed: "The admin pane is refusing every request and the key file was left as it is; the HomeKit bridge is running normally.",
    next,
  }, 503);
}

/**
 * Reads the session-signing key, or makes and saves one (mode 0600) if there is none yet.
 * A key file that exists but can't be read, or has the wrong length, is refused, never quietly
 * replaced: that would hide the problem and sign everyone out on every restart.
 * The key itself never goes into a message or the log.
 */
export function loadOrCreateSessionKey(file: string): { key: Buffer; created: boolean } {
  const fix = `On the NAS: delete the key file (the container sees it as ${file}; in Docker it's ./data/admin-session.key next to docker-compose.yml) and restart the container. It makes a new key; everyone just signs in again.`;
  let key: Buffer;
  try {
    key = fs.readFileSync(file);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      throw badKey(file, `The sign-in key file couldn't be read (${e.code ?? e.message}).`, `Check its owner and permissions. ${fix}`);
    }
    const fresh = crypto.randomBytes(SESSION_KEY_BYTES);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, fresh, { mode: 0o600, flag: "wx" });
    } catch (werr) {
      const w = werr as NodeJS.ErrnoException;
      if (w.code === "EEXIST") return loadOrCreateSessionKey(file);   // another start made it first
      throw badKey(file, `There was no sign-in key yet, and a new one couldn't be saved at ${file} (${w.code ?? w.message}).`,
        "Make sure the container's /data folder is mounted and writable (./data in docker-compose.yml), then restart the container. Set UNSCRYPTED_ADMIN_KEY_FILE to use another path.");
    }
    return { key: fresh, created: true };
  }
  if (key.length !== SESSION_KEY_BYTES) {
    throw badKey(file, `The sign-in key file at ${file} is ${key.length} bytes; it must be exactly ${SESSION_KEY_BYTES}.`, fix);
  }
  return { key, created: false };
}
export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 5 * 60_000;

export function loadAdminPassword(file: string): string {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw noPassword(file, `The admin password file couldn't be read (${(err as Error).message}).`);
  }
  const pw = text.trim();
  if (!pw) throw noPassword(file, `The admin password file at ${file} is empty.`);
  return pw;
}

function noPassword(file: string, happened: string): UserError {
  return new UserError({
    attempted: "Start the admin pane's sign-in",
    happened,
    changed: "The admin pane is refusing every request; the HomeKit bridge is running normally.",
    next: `On the NAS: put a password (one line) in ~/unscrypted/secrets/admin_password, which the container reads as ${file}, then restart the container.`,
  }, 503);
}

export function checkPassword(given: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b) && given.length > 0;
}

const sign = (secret: Buffer, payload: string) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** `<expiry ms>.<random nonce>.<mac>`; the nonce makes every session (and its CSRF token) unique. */
export function issueSession(secret: Buffer, now = Date.now()): string {
  const payload = `${now + SESSION_DAYS * 864e5}.${crypto.randomBytes(12).toString("base64url")}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySession(cookie: string | undefined, secret: Buffer, now = Date.now()): boolean {
  if (!cookie) return false;
  const parts = cookie.split(".");
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  if (!safeEqual(parts[2], sign(secret, payload))) return false;
  return Number(parts[0]) > now;
}

/** The CSRF token for a session: the page sends it back in the x-csrf-token header. */
export function csrfToken(secret: Buffer, session: string): string {
  return sign(secret, `csrf:${session}`);
}

export function checkCsrf(given: string | undefined, secret: Buffer, session: string): boolean {
  return Boolean(given) && safeEqual(String(given), csrfToken(secret, session));
}

/** 5 wrong passwords from one address within 5 minutes locks that address out until they age out. */
export class LoginLimiter {
  private fails = new Map<string, number[]>();

  private recent(ip: string, now: number): number[] {
    const r = (this.fails.get(ip) ?? []).filter((t) => now - t < LOCKOUT_MS);
    if (r.length) this.fails.set(ip, r); else this.fails.delete(ip);
    return r;
  }

  allow(ip: string, now = Date.now()): boolean {
    return this.recent(ip, now).length < MAX_FAILURES;
  }

  /** How long until this address may try again (0 = now). */
  retryInMs(ip: string, now = Date.now()): number {
    const r = this.recent(ip, now);
    if (r.length < MAX_FAILURES) return 0;
    return r[r.length - MAX_FAILURES] + LOCKOUT_MS - now;
  }

  fail(ip: string, now = Date.now()): void {
    this.fails.set(ip, [...this.recent(ip, now), now]);
  }

  reset(ip: string): void {
    this.fails.delete(ip);
  }
}
