/**
 * The dashboard's own settings (/data/dash/settings.json). Kept apart from config.json so a bad
 * dashboard setting can never break camera config or HomeKit. Edited only from the signed-in
 * admin pane; the open dash process only reads it.
 */

import * as fs from "fs";
import * as path from "path";
import { UserError } from "../admin/errors";

export type SystemFamily = "sans" | "serif" | "mono" | "inherit";
export type FontSpec = { kind: "system"; family: SystemFamily } | { kind: "file"; file: string };
export type ServiceCheck =
  | { kind: "tcp"; host: string; port: number }
  | { kind: "alive"; host: string; port: number }
  | { kind: "http"; url: string; ok: "any" | "200" }
  | { kind: "bridge" }
  /** A light that can't be checked from here yet; it shows red with this reason (owner Q1 = c). */
  | { kind: "blocked"; reason: string; short?: string };
export interface ServiceNode { id: string; name: string; link?: string; rollup?: boolean; check: ServiceCheck; children?: ServiceNode[] }
export interface DashCameraPref { camera: string; label: string; shown: boolean; stream: "main" | "sub" }
export interface DashSettings {
  idleSeconds: number;
  pollSeconds: number;
  reloadMinutes: number;
  /** Grid order. `camera` is the config.json camera name (HomeKit identity, never edited here). */
  cameras: DashCameraPref[];
  weather: { place: string; lat: number | null; lon: number | null; unit: "fahrenheit" | "celsius"; refreshSeconds: number };
  photos: { source: "folder" | "icloud"; folder: string; icloudUrl: string; rotateSeconds: number; refreshMinutes: number; maxPhotos: number; caption: string };
  fonts: { ui: FontSpec; clock: FontSpec };
  services: ServiceNode[];
}

export const GRID_MAX = 4;
export const FONT_FILE = /^[A-Za-z0-9_-]{1,64}\.(otf|ttf|woff2?)$/;

/** Owner Q1 = c: the ipvlan apps can't be reached from the host network yet, and the light says so. */
/** The one-line label for it on the wall display; the full reason shows on tap/hover. */
export const IPVLAN_SHORT = "can't check yet";
export const IPVLAN_REASON = "can't be checked from the NAS's own network yet (it sits on the ipvlan LAN; tracked in hooptiej/unscrypted#11)";

// Hosts as seen from the NAS's own network (unscrypted runs with host networking).
// Constructicon/Questlog can't be reached from there yet (owner Q1 = c: the lights say why);
// the old Scrypted light is replaced by the HomeKit bridge's own status (owner Q2 = a).
export const DEFAULT_SERVICES: ServiceNode[] = [
  { id: "server", name: "NAS", rollup: true, check: { kind: "alive", host: "10.0.1.78", port: 80 }, children: [
    { id: "smb", name: "SMB", check: { kind: "tcp", host: "127.0.0.1", port: 445 } },
    { id: "homekit", name: "HomeKit bridge", check: { kind: "bridge" } },
    // Homedash checked these with http (10.0.1.240/.241 ok any, .250/.246 ok 200). Swap back to
    // those checks once hooptiej/unscrypted#11 gives the host network a way to reach them.
    { id: "constructicon", name: "Constructicon", link: "http://constructicon.local", check: { kind: "blocked", reason: IPVLAN_REASON }, children: [
      { id: "constructicon-dev", name: "dev", link: "http://10.0.1.241", check: { kind: "blocked", reason: IPVLAN_REASON } },
    ] },
    { id: "questlog", name: "Questlog", link: "http://questlog.local", check: { kind: "blocked", reason: IPVLAN_REASON }, children: [
      { id: "questlog-dev", name: "dev", link: "http://questlog-dev.local", check: { kind: "blocked", reason: IPVLAN_REASON } },
    ] },
  ] },
];

export const DEFAULTS: DashSettings = {
  idleSeconds: 30,
  pollSeconds: 4,
  reloadMinutes: 20,
  cameras: [],
  weather: { place: "", lat: null, lon: null, unit: "fahrenheit", refreshSeconds: 600 },
  photos: { source: "folder", folder: "/data/dash/photos", icloudUrl: "", rotateSeconds: 20, refreshMinutes: 30, maxPhotos: 0, caption: "" },
  fonts: { ui: { kind: "system", family: "sans" }, clock: { kind: "system", family: "inherit" } },
  services: DEFAULT_SERVICES,
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function bad(field: string, msg: string): UserError {
  return new UserError({ attempted: "Save the dashboard settings", happened: `${field}: ${msg}`, changed: "Nothing was saved.", next: "Fix that field and save again." });
}

/** Never throws, never writes. A broken file falls back to defaults and says so. */
export function loadSettings(file: string): { settings: DashSettings; warning: string | null; mtimeMs: number } {
  let text: string;
  let mtimeMs = 0;
  try {
    text = fs.readFileSync(file, "utf8");
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: clone(DEFAULTS), warning: null, mtimeMs: 0 };
    return { settings: clone(DEFAULTS), warning: `${file} couldn't be read (${(err as Error).message}); showing default dashboard settings.`, mtimeMs };
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("it isn't a JSON object");
    const d = clone(DEFAULTS);
    const s: DashSettings = {
      ...d, ...raw,
      weather: { ...d.weather, ...(raw.weather ?? {}) },
      photos: { ...d.photos, ...(raw.photos ?? {}) },
      fonts: { ...d.fonts, ...(raw.fonts ?? {}) },
      cameras: Array.isArray(raw.cameras) ? raw.cameras : d.cameras,
      services: Array.isArray(raw.services) ? raw.services.map(renameOldServer) : d.services,
    };
    return { settings: s, warning: null, mtimeMs };
  } catch (err) {
    return { settings: clone(DEFAULTS), warning: `${file} couldn't be read (${(err as Error).message}); showing default dashboard settings. Fix it on the dashboard settings page (saving there rewrites it).`, mtimeMs };
  }
}

/** The old default's rollup was called "Server"; it checks the NAS itself, so it's "NAS" now (owner eye-check). */
function renameOldServer(n: ServiceNode): ServiceNode {
  return n && n.id === "server" && n.name === "Server" ? { ...n, name: "NAS" } : n;
}

const int = (v: unknown, lo: number, hi: number, label: string): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isInteger(n)) throw bad(label, "must be a whole number");
  if (n < lo || n > hi) throw bad(label, `must be between ${lo} and ${hi}`);
  return n;
};
const text = (v: unknown, max: number, label: string): string => {
  const s = String(v ?? "").trim();
  if (s.length > max) throw bad(label, `is too long (at most ${max} characters)`);
  return s;
};
const coord = (v: unknown, lo: number, hi: number, label: string): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(label, "must be a number");
  if (n < lo || n > hi) throw bad(label, `must be between ${lo} and ${hi}`);
  return n;
};
function font(v: any, role: "ui" | "clock", fontFiles: string[]): FontSpec {
  const label = role === "ui" ? "Interface font" : "Clock font";
  if (v?.kind === "system") {
    const ok = role === "clock" ? ["sans", "serif", "mono", "inherit"] : ["sans", "serif", "mono"];
    if (!ok.includes(v.family)) throw bad(label, `"${v.family}" isn't one of ${ok.join(", ")}`);
    return { kind: "system", family: v.family };
  }
  if (v?.kind === "file") {
    if (typeof v.file !== "string" || !FONT_FILE.test(v.file) || !fontFiles.includes(v.file)) throw bad(label, `"${v.file}" isn't in the fonts folder (/data/dash/fonts)`);
    return { kind: "file", file: v.file };
  }
  throw bad(label, "must be a system font or a font file");
}

/** Validates a partial edit and returns the whole new settings. Throws UserError; never writes. */
export function applySettingsEdit(cur: DashSettings, edit: any, ctx: { cameras: string[]; fontFiles: string[]; withSub?: string[] }): DashSettings {
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) throw bad("Request", "wasn't a settings object");
  const s = clone(cur);
  if ("idleSeconds" in edit) s.idleSeconds = int(edit.idleSeconds, 5, 600, "Fullscreen timeout (s)");
  if ("pollSeconds" in edit) s.pollSeconds = int(edit.pollSeconds, 2, 60, "Status check interval (s)");
  if ("reloadMinutes" in edit) s.reloadMinutes = int(edit.reloadMinutes, 1, 1440, "Page refresh (min)");
  if ("cameras" in edit) {
    if (!Array.isArray(edit.cameras)) throw bad("Cameras", "must be a list");
    const seen = new Set<string>();
    s.cameras = edit.cameras.map((c: any) => {
      const camera = String(c?.camera ?? "");
      if (!ctx.cameras.includes(camera)) throw bad("Cameras", `"${camera}" isn't in config.json (add cameras on the Cameras tab)`);
      if (seen.has(camera)) throw bad("Cameras", `"${camera}" is listed twice`);
      seen.add(camera);
      const label = text(c.label, 40, `Label for ${camera}`) || camera;
      if (c.stream !== "main" && c.stream !== "sub") throw bad(`Stream for ${camera}`, "must be main or sub");
      if (c.stream === "sub" && ctx.withSub && !ctx.withSub.includes(camera)) throw bad(`Stream for ${camera}`, "this camera has no sub stream in config.json (rtspSub), so it can only show main");
      return { camera, label, shown: c.shown === true, stream: c.stream };
    });
    const shown = s.cameras.filter((c) => c.shown).length;
    if (shown > GRID_MAX) throw bad("Cameras", `the grid shows at most ${GRID_MAX}; ${shown} are switched on. Switch one off.`);
  }
  if ("weather" in edit) {
    const w = edit.weather ?? {};
    if ("unit" in w) {
      if (w.unit !== "fahrenheit" && w.unit !== "celsius") throw bad("Temperature unit", "must be fahrenheit or celsius");
      s.weather.unit = w.unit;
    }
    if ("place" in w) {
      const place = text(w.place, 80, "Weather place");
      if (place !== s.weather.place && !("lat" in w)) { s.weather.lat = null; s.weather.lon = null; }
      s.weather.place = place;
    }
    if ("lat" in w) s.weather.lat = coord(w.lat, -90, 90, "Latitude");
    if ("lon" in w) s.weather.lon = coord(w.lon, -180, 180, "Longitude");
  }
  if ("photos" in edit) {
    const p = edit.photos ?? {};
    if ("source" in p) {
      if (p.source !== "icloud" && p.source !== "folder") throw bad("Photo source", "must be iCloud or folder");
      s.photos.source = p.source;
    }
    if ("icloudUrl" in p) {
      const u = text(p.icloudUrl, 400, "iCloud link");
      if (u && !u.startsWith("https://www.icloud.com/sharedalbum/")) throw bad("iCloud link", "doesn't look like an iCloud shared-album link (https://www.icloud.com/sharedalbum/#...)");
      s.photos.icloudUrl = u;
    }
    if ("folder" in p) {
      const f = text(p.folder, 300, "Photo folder");
      if (f && !path.posix.isAbsolute(f)) throw bad("Photo folder", "must be a full path inside the container, e.g. /data/dash/photos");
      s.photos.folder = f;
    }
    if ("rotateSeconds" in p) s.photos.rotateSeconds = int(p.rotateSeconds, 3, 600, "Seconds per photo");
    if ("caption" in p) s.photos.caption = text(p.caption, 80, "Caption");
  }
  if ("fonts" in edit) {
    const f = edit.fonts ?? {};
    for (const role of Object.keys(f)) if (role !== "ui" && role !== "clock") throw bad("Fonts", `unknown font role "${role}"`);
    if (f.ui) s.fonts.ui = font(f.ui, "ui", ctx.fontFiles);
    if (f.clock) s.fonts.clock = font(f.clock, "clock", ctx.fontFiles);
  }
  return s;
}

/** Atomic write (temp file, fsync, rename). The previous file is kept as settings.json.bak. */
export function saveSettings(file: string, s: DashSettings): { backupPath: string | null } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backupPath: string | null = null;
  if (fs.existsSync(file)) { fs.copyFileSync(file, file + ".bak"); backupPath = file + ".bak"; }
  const tmp = file + ".tmp";
  const fd = fs.openSync(tmp, "w", 0o644);
  try { fs.writeSync(fd, JSON.stringify(s, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  return { backupPath };
}

/**
 * Preferences in grid order, plus every config.json camera that has no preference yet (appended,
 * not shown, so a newly added camera is listed in Settings rather than silently absent).
 */
export function effectiveCameras(s: DashSettings, cameraNames: string[]): (DashCameraPref & { missing: boolean })[] {
  const out = s.cameras.map((c) => ({ ...c, missing: !cameraNames.includes(c.camera) }));
  for (const n of cameraNames) if (!s.cameras.some((c) => c.camera === n)) out.push({ camera: n, label: n, shown: false, stream: "main", missing: false });
  return out;
}

/**
 * A base web address from the environment (UNSCRYPTED_ADMIN_URL, UNSCRYPTED_DASH_URL), used when
 * the dashboard and the admin pane don't share a host (e.g. the dash on its own IP at port 80).
 * Unset is null (callers derive it); a bad value is ignored with a plain reason, never half-used.
 */
export function parseBaseUrl(name: string, v: string | undefined): { url: string | null; error: string | null } {
  const t = (v ?? "").trim();
  if (!t) return { url: null, error: null };
  let u: URL | null = null;
  try { u = /^https?:\/\/[^\s/]+/.test(t) ? new URL(t) : null; } catch { u = null; }
  if (!u || !u.host) return { url: null, error: `${name} ("${t}") isn't a web address like http://10.0.1.78:8190, so it's ignored and the address is worked out from the browser's own. Fix it in docker-compose.yml.` };
  return { url: t.replace(/\/+$/, ""), error: null };
}
