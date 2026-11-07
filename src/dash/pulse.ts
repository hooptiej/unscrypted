/**
 * The new-build pulse (#103): a light breathes in its own colour while a build waits on test for the
 * owner to try it. It turns on when a light's build page shows a new `build` value (the dash reads it),
 * or when a Claude flips the token switch; it turns off when the owner taps the light on the wall, or a
 * Claude switches it off. Only the dash process writes pulse.json (the open clear and the token switch
 * both go through the same process), so there is one writer. Every refusal is a plain four-part error,
 * and the token is never logged or sent back.
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";
import * as crypto from "crypto";
import { UserError } from "../shared/errors";
import { Logger } from "../logger";
import { ServiceNode, flatLamps, checkBuildUrl } from "./settings";

/** How often each watched build page is read. Slower than the light checks: a build changes once a day at most. */
export const BUILD_CHECK_MS = 60_000;
const BUILD_TIMEOUT_MS = 5_000;
const BUILD_MAX_BYTES = 64 * 1024;
const BUILD_MAX_CHARS = 80;

export type PulseBy = "dash" | "claude" | "tap";
export interface PulseRecord {
  /** The build page the last build was read from. A different address starts over with a first look. */
  url: string | null;
  /** The last build seen there (or set by a Claude). A different one is a new build. */
  seen: string | null;
  on: boolean;
  build: string | null;
  note: string | null;
  since: number | null;
  by: PulseBy | null;
}
/** What the open dashboard shows for a pulsing light. */
export interface PulseView { build: string | null; reason: string; since: number; by: PulseBy }
/** One row of the token switch's list. */
export interface PulseLampView { id: string; name: string; watched: boolean; on: boolean; build: string | null; since: number | null; by: PulseBy | null; note: string | null }
export interface PulseOutcome { changed: boolean; on: boolean; message: string }

const EMPTY: PulseRecord = { url: null, seen: null, on: false, build: null, note: null, since: null, by: null };

interface PulseFile { lamps: Record<string, PulseRecord> }

/** pulse.json in the dash folder. Reads never throw; a write that fails throws and leaves memory as it was. */
export class PulseStore {
  private data: PulseFile = { lamps: {} };
  /** Why pulse.json couldn't be read at start, in plain words; null when it was read or never existed. */
  readonly warning: string | null = null;

  constructor(readonly file: string) {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") this.warning = `${file} couldn't be read (${code ?? (err as Error).message}); the new-build pulses are off until it can be read.`;
      return;
    }
    try {
      const raw = JSON.parse(text);
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || !raw.lamps || typeof raw.lamps !== "object" || Array.isArray(raw.lamps)) {
        throw new Error("it isn't the pulse file's shape");
      }
      this.data = { lamps: raw.lamps };
    } catch (err) {
      const why = err instanceof SyntaxError ? "it isn't valid JSON" : (err as Error).message;
      this.warning = `${file} couldn't be read (${why}); the new-build pulses are off until the next change rewrites it (the old file is kept as pulse.json.bak).`;
    }
  }

  get(id: string): PulseRecord | undefined {
    return Object.prototype.hasOwnProperty.call(this.data.lamps, id) ? this.data.lamps[id] : undefined;
  }

  /** Writes one light's record (atomic, previous file kept as .bak). Throws a plain Error if it can't. */
  set(id: string, rec: PulseRecord): void {
    const next: PulseFile = { lamps: { ...this.data.lamps, [id]: rec } };
    const tmp = this.file + ".tmp";
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + ".bak");
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`${this.file} couldn't be written (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
    }
    this.data = next;
  }
}

export type BuildRead = { ok: true; build: string } | { ok: false; reason: string };

/** The JSON `build` field of a page, or a plain reason it couldn't be had. Never throws; no address in a reason. */
export function readBuild(url: string, timeoutMs = BUILD_TIMEOUT_MS): Promise<BuildRead> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: BuildRead) => { if (!settled) { settled = true; resolve(v); } };
    const lib = url.startsWith("https:") ? https : http;
    let req: http.ClientRequest;
    try {
      // rejectUnauthorized off: this only reads a build number from a LAN page, and trusts nothing else from it.
      req = lib.get(url, { timeout: timeoutMs, rejectUnauthorized: false } as https.RequestOptions, (res) => {
        const code = res.statusCode ?? 0;
        if (code !== 200) { res.resume(); done({ ok: false, reason: `answered ${code}, expected 200` }); return; }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > BUILD_MAX_BYTES) { done({ ok: false, reason: `its answer is bigger than ${BUILD_MAX_BYTES / 1024} KB` }); req.destroy(); }
        });
        res.on("end", () => done(parseBuild(body)));
        res.on("error", (e: NodeJS.ErrnoException) => done({ ok: false, reason: `the answer broke off (${e.code ?? "unknown error"})` }));
      });
    } catch {
      done({ ok: false, reason: "it isn't a usable web address" });
      return;
    }
    req.on("timeout", () => { done({ ok: false, reason: `no answer within ${timeoutMs / 1000} s` }); req.destroy(); });
    req.on("error", (e: NodeJS.ErrnoException) => done({ ok: false, reason: e.code === "ECONNREFUSED" ? "connection refused (nothing listening)" : `didn't answer (${e.code ?? "unknown error"})` }));
  });
}

/** The `build` field out of a page's body, or the plain reason it isn't there. */
export function parseBuild(body: string): BuildRead {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return { ok: false, reason: "its answer isn't JSON" }; }
  const b = j && typeof j === "object" && !Array.isArray(j) ? (j as { build?: unknown }).build : undefined;
  const text = typeof b === "string" ? b.trim() : typeof b === "number" ? String(b) : "";
  if (!text) return { ok: false, reason: "its answer has no build field" };
  if (text.length > BUILD_MAX_CHARS) return { ok: false, reason: `its build field is longer than ${BUILD_MAX_CHARS} characters` };
  return { ok: true, build: text };
}

/** The words the wall shows when a light pulses (the "new build" label opens them on tap). */
export function pulseReason(rec: PulseRecord): string {
  if (rec.by === "claude") {
    const what = rec.note ?? (rec.build ? `Build ${rec.build} is waiting for you to try on test` : "Something is waiting for you to try on test");
    return `${/[.!?]$/.test(what) ? what : `${what}.`} Tap the dot once you've seen it.`;
  }
  return `New build ${rec.build} is waiting for you to try on test. Tap the dot once you've seen it.`;
}

/** The pulse a light shows, or null when it isn't on. */
export function viewOf(rec: PulseRecord | undefined): PulseView | null {
  if (!rec || !rec.on || rec.since === null || rec.by === null) return null;
  return { build: rec.build, reason: pulseReason(rec), since: rec.since, by: rec.by };
}

export type BuildFetcher = (url: string) => Promise<BuildRead>;

/**
 * Reads each watched light's build page when it's due (once a minute). The first build seen is only
 * recorded; a new one starts the light's pulse. A failed read changes nothing, and the reason is kept
 * for the settings page. Never throws.
 */
export class BuildWatch {
  private checkedAt = new Map<string, number>();
  private errors = new Map<string, string>();

  constructor(private readonly store: PulseStore, private readonly log: Logger, private readonly fetchBuild: BuildFetcher = (u) => readBuild(u)) {}

  /** Why a watched light's build page couldn't be read or saved, in plain words; null when it's fine. */
  errorFor(id: string): string | null {
    return this.errors.get(id) ?? null;
  }

  async round(tree: ServiceNode[], now: number): Promise<void> {
    const watched = flatLamps(tree).filter((n) => n.build);
    const ids = new Set(watched.map((n) => n.id));
    for (const id of [...this.errors.keys()]) if (!ids.has(id)) this.errors.delete(id);
    await Promise.all(watched
      .filter((n) => now - (this.checkedAt.get(n.id) ?? -Infinity) >= BUILD_CHECK_MS)
      .map((n) => this.checkOne(n, now)));
  }

  private async checkOne(n: ServiceNode, now: number): Promise<void> {
    this.checkedAt.set(n.id, now);
    const url = n.build!.url;
    const bad = checkBuildUrl(url);
    const got: BuildRead = bad ? { ok: false, reason: bad } : await this.fetchBuild(url);
    if (!got.ok) { this.fail(n, `couldn't read its build page (${got.reason}); its pulse is unchanged`); return; }
    const rec = this.store.get(n.id) ?? EMPTY;
    try {
      if (rec.url !== url) {
        this.store.set(n.id, { ...rec, url, seen: got.build });
        this.log.info(`"${n.name}": build ${got.build} recorded from its build page (first look, no pulse)`);
      } else if (rec.seen !== got.build) {
        this.store.set(n.id, { ...rec, seen: got.build, on: true, build: got.build, note: null, since: now, by: "dash" });
        this.log.info(`"${n.name}": new build ${got.build} is waiting on test; its light pulses until it's tapped or switched off`);
      }
      this.errors.delete(n.id);
    } catch (err) {
      this.fail(n, `build ${got.build} was read, but ${(err as Error).message}; it's tried again at the next check`);
    }
  }

  private fail(n: ServiceNode, why: string): void {
    if (this.errors.get(n.id) === why) return;
    this.errors.set(n.id, why);
    this.log.warn(`"${n.name}": ${why}`);
  }
}

/** The token switch and the open clear, as the dash server calls them. Each refusal throws a UserError. */
export interface PulseApi {
  /** Throws unless the request's bearer token is the one in the secrets file (read on every call). */
  checkToken(authorization: string | undefined, attempted: string): void;
  list(): PulseLampView[];
  set(id: string, on: boolean, opts: { build?: string; note?: string }): PulseOutcome;
  clear(id: string): PulseOutcome;
}

export interface PulseApiOptions {
  store: PulseStore;
  tree: () => ServiceNode[];
  tokenFile: string;
  log: Logger;
  /** Called after every change so the wall shows it at once. */
  changed: () => void;
  now?: () => number;
}

export function makePulseApi(o: PulseApiOptions): PulseApi {
  const now = o.now ?? Date.now;

  const lampOr404 = (attempted: string, id: string): ServiceNode => {
    const lamp = flatLamps(o.tree()).find((n) => n.id === id);
    if (lamp) return lamp;
    const known = flatLamps(o.tree()).map((n) => n.id);
    throw new UserError({ attempted, happened: `There's no status light called "${id}".`, changed: "Nothing.",
      next: known.length ? `Use one of these: ${known.join(", ")}.` : "No status lights are set up in the dashboard settings." }, 404);
  };

  const save = (attempted: string, id: string, rec: PulseRecord) => {
    try { o.store.set(id, rec); } catch (err) {
      throw new UserError({ attempted, happened: `${(err as Error).message}.`, changed: "Nothing; the pulse is as it was.",
        next: "Check that data/dash on the host exists and is writable by the container, then try again." }, 500);
    }
    o.changed();
  };

  return {
    checkToken(authorization, attempted) {
      let expected: string;
      try { expected = fs.readFileSync(o.tokenFile, "utf8").trim(); } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const why = code === "ENOENT" ? `There's no token file at ${o.tokenFile}` : `The token file at ${o.tokenFile} couldn't be read (${code ?? "unknown error"})`;
        throw new UserError({ attempted, happened: `${why}, so the switch is off.`, changed: "Nothing.",
          next: "Put the one-line token in secrets/dash_pulse_token on the host (see the README), then try again." }, 503);
      }
      if (!expected) throw new UserError({ attempted, happened: `The token file at ${o.tokenFile} is empty, so the switch is off.`, changed: "Nothing.",
        next: "Put the one-line token in secrets/dash_pulse_token on the host, then try again." }, 503);
      if (!authorization) throw new UserError({ attempted, happened: "No token was sent.", changed: "Nothing.",
        next: "Send the token as Authorization: Bearer <token>; the README has the curl." }, 401);
      const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
      if (!m) throw new UserError({ attempted, happened: "The Authorization header isn't Bearer <token>.", changed: "Nothing.",
        next: "Send the token as Authorization: Bearer <token>; the README has the curl." }, 401);
      const a = Buffer.from(m[1]), b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new UserError({ attempted,
        happened: "The token doesn't match the one in secrets/dash_pulse_token.", changed: "Nothing.",
        next: "Use the current token from secrets/dash_pulse_token on the host; it may have been changed." }, 403);
    },

    list() {
      return flatLamps(o.tree()).map((n) => {
        const rec = o.store.get(n.id);
        const on = rec?.on === true;
        return { id: n.id, name: n.name, watched: Boolean(n.build), on, build: rec?.build ?? null,
          since: on ? rec!.since : null, by: on ? rec!.by : null, note: on ? rec!.note : null };
      });
    },

    set(id, on, opts) {
      const attempted = `Switch the pulse ${on ? "on" : "off"} for "${id}"`;
      const lamp = lampOr404(attempted, id);
      const rec = o.store.get(id) ?? EMPTY;
      if (on) {
        const build = opts.build ?? null;
        save(attempted, id, { ...rec, seen: build ?? rec.seen, on: true, build: build ?? rec.build, note: opts.note ?? null, since: now(), by: "claude" });
        const note = build ? ` (build ${build})` : "";
        o.log.info(`"${lamp.name}": pulse on, set over the token switch${note}`);
        return { changed: true, on: true, message: `Pulse on for "${lamp.name}"${note}. It goes off when someone taps the light or it's switched off.` };
      }
      if (!rec.on) return { changed: false, on: false, message: `"${lamp.name}" had no pulse on, so nothing changed.` };
      save(attempted, id, { ...rec, on: false, by: "claude" });
      o.log.info(`"${lamp.name}": pulse off, set over the token switch`);
      return { changed: true, on: false, message: `Pulse off for "${lamp.name}".` };
    },

    clear(id) {
      const attempted = `Clear the pulse for "${id}"`;
      const lamp = lampOr404(attempted, id);
      const rec = o.store.get(id) ?? EMPTY;
      if (!rec.on) return { changed: false, on: false, message: `No pulse was on for "${lamp.name}".` };
      save(attempted, id, { ...rec, on: false, by: "tap" });
      o.log.info(`"${lamp.name}": pulse cleared from the wall`);
      return { changed: true, on: false, message: `Pulse cleared for "${lamp.name}".` };
    },
  };
}
