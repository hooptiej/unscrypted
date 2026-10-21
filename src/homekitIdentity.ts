/**
 * Standalone HomeKit cameras (#57): a camera can opt out of the bridge and be published as its
 * own HAP accessory, with its own username (MAC-style id), PIN, setup id and TCP port.
 *
 * This file holds the pure parts: validating a camera's `homekit` block, and filling in any
 * identity fields a standalone camera is missing (generated once, then saved to config.json by
 * the caller so pairings survive restarts). Bridged is the default: a camera with no `homekit`
 * block, or `mode: "bridged"`, behaves exactly as before.
 */

import * as crypto from "crypto";
import * as net from "net";
import type { Config } from "./config";

export type HomekitMode = "bridged" | "standalone";

/** The per-camera `homekit` block in config.json. */
export interface CameraHomekitConfig {
  /** "bridged" (default) or "standalone" (its own accessory, paired separately). */
  mode?: HomekitMode;
  /** MAC-style HAP id, e.g. "0E:4B:21:9C:A0:13". Generated if missing. */
  username?: string;
  /** Setup code "XXX-XX-XXX". Generated if missing. */
  pin?: string;
  /** 4-character setup id for the QR code. Generated if missing. */
  setupId?: string;
  /** TCP port for this accessory's HAP server. Generated (next free from 51830) if missing. */
  port?: number;
}

export type ResolvedHomekit =
  | { mode: "bridged" }
  | { mode: "standalone"; username: string | null; pin: string | null; setupId: string | null; port: number | null };

/** Where generated standalone ports start counting. */
export const STANDALONE_BASE_PORT = 51830;

const USERNAME_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const PIN_RE = /^\d{3}-\d{2}-\d{3}$/;
const SETUP_ID_RE = /^[0-9A-Z]{4}$/;
const SETUP_ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** PINs HomeKit refuses (HAP spec: all-same digits and the two straight runs). */
const TRIVIAL_PINS = new Set([
  ...Array.from({ length: 10 }, (_, d) => String(d).repeat(8)),
  "12345678", "87654321",
]);

export const isValidUsername = (s: string): boolean => USERNAME_RE.test(s);
export const isValidSetupId = (s: string): boolean => SETUP_ID_RE.test(s);
export function isValidPin(s: string): boolean {
  return PIN_RE.test(s) && !TRIVIAL_PINS.has(s.replace(/-/g, ""));
}

/** Random bytes source, injectable for tests. */
export type RandomBytes = (n: number) => Buffer;
const defaultRandom: RandomBytes = (n) => crypto.randomBytes(n);

/** A random locally administered, unicast MAC (first octet x2, x6, xA or xE). */
export function generateUsername(rand: RandomBytes = defaultRandom): string {
  const b = rand(6);
  b[0] = (b[0] & 0xfc) | 0x02;
  return Array.from(b, (x) => x.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

/** A random HomeKit setup code, never one of the trivial ones HomeKit refuses. */
export function generatePin(rand: RandomBytes = defaultRandom): string {
  for (;;) {
    const n = rand(4).readUInt32BE(0) % 100_000_000;
    const d = String(n).padStart(8, "0");
    if (!TRIVIAL_PINS.has(d)) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  }
}

export function generateSetupId(rand: RandomBytes = defaultRandom): string {
  return Array.from(rand(4), (x) => SETUP_ID_CHARS[x % SETUP_ID_CHARS.length]).join("");
}

/**
 * Validate one camera's `homekit` block. Returns the resolved form, or throws an Error whose
 * message names the bad field (the caller wraps it in a ConfigError with the camera's name).
 * Identity fields may be missing here: they are generated at startup.
 */
export function resolveHomekit(raw: unknown): ResolvedHomekit {
  if (raw === undefined || raw === null) return { mode: "bridged" };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`"homekit" must be an object`);
  const h = raw as CameraHomekitConfig;
  const mode = h.mode ?? "bridged";
  if (mode !== "bridged" && mode !== "standalone") {
    throw new Error(`homekit.mode must be "bridged" or "standalone" (got ${JSON.stringify(h.mode)})`);
  }
  if (mode === "bridged") return { mode };
  const username = h.username === undefined ? null : String(h.username).toUpperCase();
  if (username !== null && !isValidUsername(username)) {
    throw new Error(`homekit.username must be a MAC-style id like "0E:4B:21:9C:A0:13" (got "${h.username}")`);
  }
  if (h.pin !== undefined && !isValidPin(String(h.pin))) {
    throw new Error(`homekit.pin must be formatted "XXX-XX-XXX" and not a trivial code like 111-11-111 or 123-45-678 (got "${h.pin}")`);
  }
  const setupId = h.setupId === undefined ? null : String(h.setupId).toUpperCase();
  if (setupId !== null && !isValidSetupId(setupId)) {
    throw new Error(`homekit.setupId must be 4 letters or digits (got "${h.setupId}")`);
  }
  if (h.port !== undefined && (!Number.isInteger(h.port) || h.port < 1 || h.port > 65535)) {
    throw new Error(`homekit.port must be a valid TCP port (got ${JSON.stringify(h.port)})`);
  }
  return { mode, username, pin: h.pin ?? null, setupId, port: h.port ?? null };
}

export interface GeneratedIdentity {
  camera: string;
  /** Which fields were filled in, e.g. ["username", "pin", "setupId", "port"]. */
  fields: (keyof CameraHomekitConfig)[];
  username: string;
  setupId: string;
  port: number;
}

export interface EnsureOptions {
  basePort?: number;
  rand?: RandomBytes;
  /** Is this TCP port free on the host right now? Default: always true (config-only check). */
  isPortFree?: (port: number) => Promise<boolean>;
}

/**
 * Fill in missing identity fields for every standalone camera. Pure apart from `isPortFree`:
 * returns a new Config (the input is not modified) and what was generated. Generated ports skip
 * the bridge's port, every port another standalone camera already has, and ports in use.
 */
export async function ensureStandaloneIdentities(
  raw: Config, opts: EnsureOptions = {},
): Promise<{ config: Config; generated: GeneratedIdentity[] }> {
  const next: Config = JSON.parse(JSON.stringify(raw));
  const rand = opts.rand ?? defaultRandom;
  const isPortFree = opts.isPortFree ?? (async () => true);
  const generated: GeneratedIdentity[] = [];
  const cams = Array.isArray(next.cameras) ? next.cameras : [];

  const usedPorts = new Set<number>([next.bridge?.port ?? 51826]);
  const usedNames = new Set<string>([String(next.bridge?.username ?? "").toUpperCase()]);
  for (const c of cams) {
    if (c.homekit?.port !== undefined) usedPorts.add(c.homekit.port);
    if (c.homekit?.username) usedNames.add(String(c.homekit.username).toUpperCase());
  }

  let nextPort = opts.basePort ?? STANDALONE_BASE_PORT;
  for (const c of cams) {
    const h = c.homekit;
    if (!h || h.mode !== "standalone") continue;
    const fields: (keyof CameraHomekitConfig)[] = [];
    if (h.username === undefined) {
      let u: string;
      do { u = generateUsername(rand); } while (usedNames.has(u));
      usedNames.add(u);
      h.username = u;
      fields.push("username");
    }
    if (h.pin === undefined) { h.pin = generatePin(rand); fields.push("pin"); }
    if (h.setupId === undefined) { h.setupId = generateSetupId(rand); fields.push("setupId"); }
    if (h.port === undefined) {
      while (usedPorts.has(nextPort) || !(await isPortFree(nextPort))) {
        nextPort++;
        if (nextPort > 65535) throw new Error(`no free TCP port at or above ${opts.basePort ?? STANDALONE_BASE_PORT} for "${c.name}"`);
      }
      h.port = nextPort;
      usedPorts.add(nextPort);
      fields.push("port");
    }
    if (fields.length) {
      generated.push({ camera: c.name, fields, username: String(h.username), setupId: String(h.setupId), port: h.port });
    }
  }
  return { config: next, generated };
}

/** Can we listen on this TCP port (on `host`, or every address)? Never rejects. */
export function tcpPortFree(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}
