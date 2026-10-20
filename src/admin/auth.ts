/**
 * Admin sign-in: one password (a secrets file), an HMAC-signed session cookie that lasts 30 days,
 * a per-session CSRF token for every state-changing request, and a login lockout after 5 wrong
 * passwords. The signing key is random per admin-process start, so a restart of the pane (or the
 * bridge) signs everyone out; that keeps the design free of a second secret file.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import { UserError } from "./errors";

export const SESSION_DAYS = 30;
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
