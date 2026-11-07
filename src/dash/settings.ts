/**
 * The dashboard's own settings (/data/dash/settings.json). Kept apart from config.json so a bad
 * dashboard setting can never break camera config or HomeKit. Edited only from the signed-in
 * admin pane; the open dash process only reads it.
 */

import * as fs from "fs";
import * as path from "path";
import { UserError } from "../shared/errors";

export type SystemFamily = "sans" | "serif" | "mono" | "inherit";
export type FontSpec = { kind: "system"; family: SystemFamily } | { kind: "file"; file: string };
export type ServiceCheck =
  | { kind: "tcp"; host: string; port: number }
  | { kind: "alive"; host: string; port: number }
  | { kind: "http"; url: string; ok: "any" | "200" }
  | { kind: "bridge" }
  /** A light that can't be checked from here yet; it shows red with this reason (owner Q1 = c). */
  | { kind: "blocked"; reason: string; short?: string };
export interface ServiceNode {
  id: string; name: string; link?: string; rollup?: boolean; check: ServiceCheck; children?: ServiceNode[];
  /** The build page this light watches (#103): its JSON `build` field. A new value starts the light's pulse. */
  build?: { url: string };
}
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
  /** Where Constructicon is (#14), e.g. http://192.168.1.20; "" = the Constructicon font list is off. The token is a secrets file, never here. */
  constructicon: { url: string };
  /**
   * Background glow knobs (#25), whole percents from -100 to +100. 0 is the look #24 shipped;
   * intensity scales the glow's strength (-100 = no glow, +100 = double), size scales its ellipse.
   */
  glow: { intensity: number; size: number };
  /**
   * The new-build pulse's knobs (#103), whole percents from -100 to +100, 0 = the standard breath.
   * speed: -100% slower, +100% faster. strength: -100% no halo (the "new build" label still shows), +100% doubles it.
   */
  pulse: { speed: number; strength: number };
  services: ServiceNode[];
}

export const GRID_MAX = 4;
export const GLOW_MIN = -100, GLOW_MAX = 100;
export const PULSE_MIN = -100, PULSE_MAX = 100;
export const FONT_FILE = /^[A-Za-z0-9_-]{1,64}\.(otf|ttf|woff2?)$/;

/**
 * A light that can't be checked from the host's own network: an app on an ipvlan network, with no
 * ipvlan shim on the host. The "blocked" check kind keeps it red with this reason instead of a
 * timeout. The one-line label shows on the wall display; the full reason on tap/hover.
 */
export const IPVLAN_SHORT = "can't check yet";
export const IPVLAN_REASON = "can't be checked from this host's own network (the app is on an ipvlan LAN; add the host shim, scripts/nas/ipvlan-shim.sh)";

// The default lights are install-neutral (#44): just the HomeKit bridge's own status, which every
// install has. Everything else a house watches (its NAS, its apps, their links) lives in that
// install's own ./data/dash/settings.json and is edited on the settings page; a saved list always
// overrides this one. Nothing about one house's network belongs in the image.
export const DEFAULT_SERVICES: ServiceNode[] = [
  { id: "homekit", name: "HomeKit bridge", check: { kind: "bridge" } },
];

export const DEFAULTS: DashSettings = {
  idleSeconds: 30,
  pollSeconds: 4,
  reloadMinutes: 20,
  cameras: [],
  weather: { place: "", lat: null, lon: null, unit: "fahrenheit", refreshSeconds: 600 },
  photos: { source: "folder", folder: "/data/dash/photos", icloudUrl: "", rotateSeconds: 20, refreshMinutes: 30, maxPhotos: 0, caption: "" },
  fonts: { ui: { kind: "system", family: "sans" }, clock: { kind: "system", family: "inherit" } },
  constructicon: { url: "" },
  glow: { intensity: 0, size: 0 },
  pulse: { speed: 0, strength: 0 },
  services: DEFAULT_SERVICES,
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Every light in the tree, parents before their children. */
export function flatLamps(nodes: ServiceNode[] = []): ServiceNode[] {
  return nodes.flatMap((n) => [n, ...flatLamps(n.children ?? [])]);
}

/** null when a build-page address is usable (http or https with a host); otherwise the plain reason. */
export function checkBuildUrl(u: string): string | null {
  let ok = false;
  try { const p = new URL(u); ok = (p.protocol === "http:" || p.protocol === "https:") && Boolean(p.host); } catch { ok = false; }
  return ok ? null : "isn't a web address (http:// or https:// with a host, and a path to the page that has the build)";
}

function bad(field: string, msg: string): UserError {
  return new UserError({ attempted: "Save the dashboard settings", happened: `${field}: ${msg}`, changed: "Nothing was saved.", next: "Fix that field and save again." });
}

export interface LoadedSettings {
  settings: DashSettings;
  warning: string | null;
  mtimeMs: number;
  /** In-memory migrations applied to what the file said (logged once by the caller). Empty when none. */
  migrated: string[];
}

/** Never throws, never writes. A broken file falls back to defaults and says so. */
export function loadSettings(file: string): LoadedSettings {
  let text: string;
  let mtimeMs = 0;
  try {
    text = fs.readFileSync(file, "utf8");
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: clone(DEFAULTS), warning: null, mtimeMs: 0, migrated: [] };
    return { settings: clone(DEFAULTS), warning: `${file} couldn't be read (${(err as Error).message}); showing default dashboard settings.`, mtimeMs, migrated: [] };
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("it isn't a JSON object");
    const d = clone(DEFAULTS);
    const migrated: string[] = [];
    const glow = loadGlow(raw.glow);
    const pulse = loadPulse(raw.pulse);
    const s: DashSettings = {
      ...d, ...raw,
      weather: { ...d.weather, ...(raw.weather ?? {}) },
      photos: { ...d.photos, ...(raw.photos ?? {}) },
      fonts: { ...d.fonts, ...(raw.fonts ?? {}) },
      constructicon: { url: typeof raw.constructicon?.url === "string" ? raw.constructicon.url : "" },
      glow: glow.glow,
      pulse: pulse.pulse,
      cameras: Array.isArray(raw.cameras) ? raw.cameras : d.cameras,
      services: Array.isArray(raw.services) ? raw.services.map((n: ServiceNode) => renameOldServer(n)) : d.services,
    };
    const fixed = [...glow.fixed, ...pulse.fixed];
    return { settings: s, warning: fixed.length ? `${file}: ${fixed.join("; ")}. Save the dashboard settings page to fix the file.` : null, mtimeMs, migrated };
  } catch (err) {
    // The parser's message quotes a piece of the file (hosts, the album link), and this warning is shown on
    // the open dashboard, so say where, never what.
    const msg = (err as Error).message;
    const pos = /position (\d+)/.exec(msg)?.[1];
    const why = err instanceof SyntaxError ? `it isn't valid JSON${pos ? ` (near character ${pos})` : ""}` : "it isn't a JSON object";
    return { settings: clone(DEFAULTS), warning: `${file} couldn't be read (${why}); showing default dashboard settings. Fix it on the dashboard settings page (saving there rewrites it).`, mtimeMs, migrated: [] };
  }
}

/**
 * The glow knobs from a hand-edited file: a missing one is 0 (today's look), an out-of-range one is
 * clamped and a non-number one is 0, each said in `fixed` so the open dashboard can show why.
 */
function loadGlow(v: unknown): { glow: DashSettings["glow"]; fixed: string[] } {
  const g = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const fixed: string[] = [];
  if (v !== undefined && g !== v) fixed.push("glow isn't an object, so the background glow uses 0% for both knobs");
  const one = (key: "intensity" | "size"): number => {
    if (!(key in g)) return 0;
    const n = typeof g[key] === "number" ? (g[key] as number) : NaN;
    if (!Number.isFinite(n)) { fixed.push(`glow.${key} isn't a number, so it's 0%`); return 0; }
    const c = Math.round(Math.max(GLOW_MIN, Math.min(GLOW_MAX, n)));
    if (c !== n) fixed.push(`glow.${key} is ${n}, so it's ${c}% (whole numbers from ${GLOW_MIN} to ${GLOW_MAX})`);
    return c;
  };
  return { glow: { intensity: one("intensity"), size: one("size") }, fixed };
}

/** The pulse knobs from a hand-edited file, read the same way as the glow knobs (missing = 0%, clamped, each said). */
function loadPulse(v: unknown): { pulse: DashSettings["pulse"]; fixed: string[] } {
  const p = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const fixed: string[] = [];
  if (v !== undefined && p !== v) fixed.push("pulse isn't an object, so the new-build pulse uses 0% for both sliders");
  const one = (key: "speed" | "strength"): number => {
    if (!(key in p)) return 0;
    const n = typeof p[key] === "number" ? (p[key] as number) : NaN;
    if (!Number.isFinite(n)) { fixed.push(`pulse.${key} isn't a number, so it's 0%`); return 0; }
    const c = Math.round(Math.max(PULSE_MIN, Math.min(PULSE_MAX, n)));
    if (c !== n) fixed.push(`pulse.${key} is ${n}, so it's ${c}% (whole numbers from ${PULSE_MIN} to ${PULSE_MAX})`);
    return c;
  };
  return { pulse: { speed: one("speed"), strength: one("strength") }, fixed };
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

/** A status light's id: lowercase letters, numbers and hyphens, starting with a letter or number. */
export const SERVICE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** How a validator reports a bad field: the caller supplies this so the same checks serve both the full-tree save and the on-demand check. */
export type BadField = (field: string, msg: string) => UserError;

/** null when a web address is usable (http or https with a host); otherwise the plain reason. A path is fine. */
function httpUrlReason(u: string): string | null {
  try { const p = new URL(u); return (p.protocol === "http:" || p.protocol === "https:") && Boolean(p.host) ? null : "must be a web address (http:// or https:// with a host)"; }
  catch { return "must be a web address (http:// or https:// with a host)"; }
}

/** A whole-number port in 1..65535, from a number or a numeric string; null when it isn't one. */
function portOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * One status light's check, validated by kind. Unknown kinds and unknown fields are refused by name,
 * never silently dropped (#109). `where` names the light in the error. Returns a clean ServiceCheck.
 */
export function validateServiceCheck(raw: unknown, bad: BadField, where = "A status light"): ServiceCheck {
  const label = `${where} check`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad(label, "must be an object with a kind (tcp, alive, http, bridge or blocked)");
  const c = raw as Record<string, unknown>;
  const only = (allowed: string[]) => { for (const k of Object.keys(c)) if (!allowed.includes(k)) throw bad(label, `has a field "${k}" that a ${String(c.kind)} check doesn't use`); };
  switch (c.kind) {
    case "tcp":
    case "alive": {
      only(["kind", "host", "port"]);
      if (typeof c.host !== "string" || !c.host.trim()) throw bad(label, "needs a host");
      const port = portOf(c.port);
      if (port === null) throw bad(label, "needs a port (a whole number from 1 to 65535)");
      return { kind: c.kind, host: c.host.trim(), port };
    }
    case "http": {
      only(["kind", "url", "ok"]);
      const u = typeof c.url === "string" ? c.url.trim() : "";
      const why = u ? httpUrlReason(u) : "needs a url";
      if (why) throw bad(label, `url ${why}`);
      if (c.ok !== "any" && c.ok !== "200") throw bad(label, 'ok must be "any" (answers at all) or "200" (answers 200)');
      return { kind: "http", url: u, ok: c.ok };
    }
    case "bridge": {
      only(["kind"]);
      return { kind: "bridge" };
    }
    case "blocked": {
      only(["kind", "reason", "short"]);
      if (typeof c.reason !== "string" || !c.reason.trim()) throw bad(label, "needs a reason (the words the wall shows)");
      const out: ServiceCheck = { kind: "blocked", reason: c.reason.trim() };
      if (c.short !== undefined && c.short !== null && c.short !== "") {
        if (typeof c.short !== "string") throw bad(label, "its short label must be text");
        out.short = c.short.trim();
      }
      return out;
    }
    default:
      throw bad(label, `has an unknown kind ${JSON.stringify(c.kind)} (use tcp, alive, http, bridge or blocked)`);
  }
}

/** One status light, validated in place. Collects ids into `ids` to enforce uniqueness across the whole tree. */
function validateServiceNode(raw: unknown, ids: Set<string>, bad: BadField): ServiceNode {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("A status light", "must be an object with a name, an id and a check");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["id", "name", "link", "rollup", "check", "children", "build"].includes(k)) throw bad("A status light", `has a field "${k}" that a status light doesn't use`);
  if (typeof o.name !== "string" || !o.name.trim()) throw bad("A status light", "needs a name");
  const name = o.name.trim();
  if (name.length > 60) throw bad(`Status light "${name}"`, "name is too long (at most 60 characters)");
  if (typeof o.id !== "string" || !SERVICE_ID.test(o.id)) throw bad(`Status light "${name}"`, `needs an id of lowercase letters, numbers and hyphens starting with a letter or number (not ${JSON.stringify(o.id)})`);
  if (ids.has(o.id)) throw bad(`Status light "${name}"`, `has the id "${o.id}", which another light already uses (every light's id must be unique)`);
  ids.add(o.id);
  const node: ServiceNode = { id: o.id, name, check: validateServiceCheck(o.check, bad, `Status light "${name}"`) };
  if (o.rollup !== undefined && o.rollup !== false) {
    if (o.rollup !== true) throw bad(`Status light "${name}"`, "rollup must be true or false");
    node.rollup = true;
  }
  if (o.link !== undefined && o.link !== null && o.link !== "") {
    if (typeof o.link !== "string") throw bad(`Status light "${name}"`, "its link must be a web address");
    const link = o.link.trim();
    const why = httpUrlReason(link);
    if (why) throw bad(`Status light "${name}"`, `its link ${why}`);
    node.link = link;
  }
  if (o.build !== undefined && o.build !== null) {
    if (typeof o.build !== "object" || Array.isArray(o.build)) throw bad(`Status light "${name}"`, "its build must be an object with a url");
    for (const k of Object.keys(o.build as object)) if (k !== "url") throw bad(`Build page for "${name}"`, `has a field "${k}" that a build watch doesn't use`);
    const bu = typeof (o.build as Record<string, unknown>).url === "string" ? ((o.build as Record<string, unknown>).url as string).trim() : "";
    if (bu) {
      if (bu.length > 300) throw bad(`Build page for "${name}"`, "is too long (at most 300 characters)");
      const why = checkBuildUrl(bu);
      if (why) throw bad(`Build page for "${name}"`, `"${bu}" ${why}`);
      node.build = { url: bu };
    }
  }
  if (o.children !== undefined && o.children !== null) {
    if (!Array.isArray(o.children)) throw bad(`Status light "${name}"`, "its children must be a list of lights");
    if (o.children.length) node.children = o.children.map((c) => validateServiceNode(c, ids, bad));
  }
  return node;
}

/**
 * A full replacement status-light tree (#109): validated recursively (names, unique ids of the right
 * charset, each check by kind, optional build url and link), returning the clean tree. Throws on the
 * first bad field, never writes.
 */
export function validateServiceTree(input: unknown, bad: BadField): ServiceNode[] {
  if (!Array.isArray(input)) throw bad("Status lights", "must be a list of lights");
  const ids = new Set<string>();
  return input.map((n) => validateServiceNode(n, ids, bad));
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
  if ("constructicon" in edit) {
    const c = edit.constructicon ?? {};
    if ("url" in c) {
      const u = text(c.url, 200, "Constructicon address").replace(/\/+$/, "");
      if (u) {
        let ok = false;
        try { const p = new URL(u); ok = (p.protocol === "http:" || p.protocol === "https:") && (p.pathname === "/" || p.pathname === "") && !p.search && !p.hash && !p.username; } catch { ok = false; }
        if (!ok) throw bad("Constructicon address", `must be just http(s)://host[:port] (for example http://192.168.1.20), or empty to switch the Constructicon font list off; "${u}" isn't`);
      }
      s.constructicon.url = u;
    }
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
  if ("glow" in edit) {
    const g = edit.glow;
    if (!g || typeof g !== "object" || Array.isArray(g)) throw bad("Background glow", "must be a pair of percents (intensity and size)");
    for (const k of Object.keys(g)) if (k !== "intensity" && k !== "size") throw bad("Background glow", `unknown setting "${k}" (only intensity and size)`);
    const pct = (v: unknown, label: string): number => {
      if (v === null || v === undefined || String(v).trim() === "") throw bad(label, `is empty; it must be a whole percent from ${GLOW_MIN} to ${GLOW_MAX} (0 = today's look)`);
      return int(v, GLOW_MIN, GLOW_MAX, label);
    };
    if ("intensity" in g) s.glow.intensity = pct(g.intensity, "Glow intensity (%)");
    if ("size" in g) s.glow.size = pct(g.size, "Glow size (%)");
  }
  if ("pulse" in edit) {
    const p = edit.pulse;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw bad("New-build pulse", "must be a pair of percents (speed and strength)");
    for (const k of Object.keys(p)) if (k !== "speed" && k !== "strength") throw bad("New-build pulse", `unknown setting "${k}" (only speed and strength)`);
    const pct = (v: unknown, label: string): number => {
      if (v === null || v === undefined || String(v).trim() === "") throw bad(label, `is empty; it must be a whole percent from ${PULSE_MIN} to ${PULSE_MAX} (0 = the standard breath)`);
      return int(v, PULSE_MIN, PULSE_MAX, label);
    };
    if ("speed" in p) s.pulse.speed = pct(p.speed, "Pulse speed (%)");
    if ("strength" in p) s.pulse.strength = pct(p.strength, "Pulse strength (%)");
  }
  if ("services" in edit) {
    // #109: the whole status-light tree, edited on the settings page. Validated recursively; the
    // ids the deploy pulse config references are kept stable by the UI (it never edits an id).
    s.services = validateServiceTree(edit.services, bad);
  }
  if ("lampBuilds" in edit) {
    // Each light's build page (#103): "" takes it off; a name that isn't a light is refused, nothing saved.
    const b = edit.lampBuilds;
    if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("Light build pages", "must be a list of light names and addresses");
    const lamps = flatLamps(s.services);
    for (const id of Object.keys(b)) {
      const lamp = lamps.find((n) => n.id === id);
      if (!lamp) throw bad("Light build pages", `there's no status light called "${id}"`);
      const u = text(b[id], 300, `Build page for ${lamp.name}`);
      if (!u) { delete lamp.build; continue; }
      const why = checkBuildUrl(u);
      if (why) throw bad(`Build page for ${lamp.name}`, `"${u}" ${why}`);
      lamp.build = { url: u };
    }
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
  if (!u || !u.host) return { url: null, error: `${name} ("${t}") isn't a web address like http://192.168.1.10:8190, so it's ignored and the address is worked out from the browser's own. Fix it in docker-compose.yml.` };
  return { url: t.replace(/\/+$/, ""), error: null };
}
