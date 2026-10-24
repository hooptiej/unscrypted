/**
 * One-shot import of Homedash's data/config.json into the dashboard's settings.json.
 *
 *   node dist/dash/importHomedash.js <homedash-config.json> <out settings.json> \
 *     --map dogcam=DogCamTest,backyardcam=BackyardCamTest,... [--force] [--config /config/config.json] [--fonts <dir>]
 *
 * Homedash's camera keys are mapped to config.json camera names (the HomeKit names, never
 * changed); Homedash's names become dashboard-only labels. Camera IPs aren't carried over (the
 * bridge already knows them). Prints what it mapped and everything it couldn't, and exits
 * non-zero on any refusal. Never overwrites an existing file without --force (and then keeps a .bak).
 */

import * as fs from "fs";
import * as path from "path";
import { DashSettings, DEFAULTS, FontSpec, applySettingsEdit, saveSettings } from "./settings";
import { listFonts } from "./fonts";
import { readRawConfig } from "../admin/configStore";
import { UserError } from "../admin/errors";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function parseMap(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = pair.indexOf("=");
    if (i <= 0 || i === pair.length - 1) throw new Error(`--map wants key=Camera Name pairs separated by commas; "${pair}" isn't one`);
    out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

function font(spec: any, role: "ui" | "clock", fontFiles: string[], warnings: string[]): FontSpec {
  const fallback: FontSpec = { kind: "system", family: role === "clock" ? "inherit" : "sans" };
  if (spec?.kind === "system") {
    const ok = role === "clock" ? ["sans", "serif", "mono", "inherit"] : ["sans", "serif", "mono"];
    if (ok.includes(spec.family)) return { kind: "system", family: spec.family };
    warnings.push(`${role} font: system font "${spec.family}" isn't one of ${ok.join(", ")}; using ${fallback.family}.`);
    return fallback;
  }
  if (spec?.kind === "constructicon") {
    const file = fontFiles.find((f) => f.slice(0, f.lastIndexOf(".")) === spec.slug);
    if (file) return { kind: "file", file };
    warnings.push(`${role} font: Constructicon font "${spec.slug}" isn't in the fonts folder; using ${fallback.family}. Copy ${spec.slug}.otf (or .ttf/.woff2) from Homedash's data/fonts into data/dash/fonts and pick it on the settings page.`);
    return fallback;
  }
  if (spec) warnings.push(`${role} font: unknown kind "${spec.kind}"; using ${fallback.family}.`);
  return fallback;
}

/** Homedash config -> dashboard settings. Throws on an unmapped camera; everything else it can't map is a warning. */
export function importHomedash(hd: any, map: Record<string, string>, fontFiles: string[]): { settings: DashSettings; warnings: string[] } {
  const warnings: string[] = [];
  const s = clone(DEFAULTS);
  if (typeof hd?.idle_seconds === "number") s.idleSeconds = hd.idle_seconds;
  if (typeof hd?.reload_minutes === "number") s.reloadMinutes = hd.reload_minutes;
  if (typeof hd?.poll_seconds === "number") s.pollSeconds = hd.poll_seconds;
  s.cameras = (Array.isArray(hd?.cameras) ? hd.cameras : []).map((c: any) => {
    const camera = map[c.key];
    if (!camera) throw new Error(`no --map entry for '${c.key}' (Homedash's "${c.name}"); add ${c.key}=<config.json camera name>`);
    return { camera, label: String(c.name ?? camera).slice(0, 40), shown: c.enabled !== false, stream: "main" as const };
  });
  const w = hd?.weather ?? {};
  s.weather = { place: String(w.place ?? ""), lat: typeof w.lat === "number" ? w.lat : null, lon: typeof w.lon === "number" ? w.lon : null,
    unit: w.unit === "celsius" ? "celsius" : "fahrenheit", refreshSeconds: Number(w.refresh_seconds) || DEFAULTS.weather.refreshSeconds };
  const p = hd?.photos ?? {};
  let folder = String(p.folder ?? DEFAULTS.photos.folder);
  if (folder === "/app/data/photos" || folder.startsWith("/app/data/photos/")) folder = "/data/dash/photos" + folder.slice("/app/data/photos".length);
  else if (folder.startsWith("/app/")) warnings.push(`photo folder "${folder}" is a path inside Homedash's container; set the folder again on the settings page if you use it.`);
  s.photos = { source: p.source === "icloud" ? "icloud" : "folder", folder, icloudUrl: String(p.icloud_url ?? ""),
    rotateSeconds: Number(p.rotate_seconds) || DEFAULTS.photos.rotateSeconds, refreshMinutes: Number(p.refresh_minutes) || DEFAULTS.photos.refreshMinutes,
    maxPhotos: Number(p.max_photos) || 0, caption: String(p.caption ?? "") };
  s.fonts = { ui: font(hd?.fonts?.ui, "ui", fontFiles, warnings), clock: font(hd?.fonts?.clock, "clock", fontFiles, warnings) };
  for (const k of Object.keys(hd ?? {})) {
    if (!["idle_seconds", "reload_minutes", "poll_seconds", "cameras", "weather", "photos", "fonts", "env", "go2rtc"].includes(k)) warnings.push(`"${k}" isn't carried over (the dashboard has no such setting).`);
  }
  if (hd?.services) warnings.push("Homedash's own services list is replaced by the dashboard's (Scrypted -> HomeKit bridge; see the settings file to edit).");
  return { settings: s, warnings };
}

function main(argv: string[]): number {
  const flag = (name: string) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const force = argv.includes("--force");
  if (force) argv.splice(argv.indexOf("--force"), 1);
  const mapArg = flag("--map");
  const configPath = flag("--config") ?? process.env.UNSCRYPTED_CONFIG ?? "/config/config.json";
  const [inFile, outFile] = argv;
  const fontsDir = flag("--fonts") ?? (outFile ? path.join(path.dirname(outFile), "fonts") : "");
  const fail = (happened: string, next: string) => {
    console.error(`Import Homedash's settings: ${happened}\nNothing was written.\nNext: ${next}`);
    return 1;
  };
  if (!inFile || !outFile || !mapArg) return fail("missing arguments.", "Run: importHomedash <homedash-config.json> <out settings.json> --map dogcam=DogCamTest,... [--force]");
  if (fs.existsSync(outFile) && !force) return fail(`${outFile} already exists.`, "Add --force to replace it (the old one is kept as settings.json.bak).");
  try {
    const hd = JSON.parse(fs.readFileSync(inFile, "utf8"));
    const fonts = listFonts(fontsDir);
    if (fonts.warning) console.warn(`warning: ${fonts.warning}`);
    const { settings, warnings } = importHomedash(hd, parseMap(mapArg), fonts.fonts.map((f) => f.file));
    const cameras = readRawConfig(configPath).cameras.map((c) => c.name);
    // Same checks as the settings page, so the result is a file the page can open and save.
    applySettingsEdit(DEFAULTS, settings, { cameras, fontFiles: fonts.fonts.map((f) => f.file) });
    const { backupPath } = saveSettings(outFile, settings);
    for (const c of settings.cameras) console.log(`camera: ${c.label} -> ${c.camera} (${c.shown ? "shown" : "off"}, ${c.stream})`);
    const unlisted = cameras.filter((n) => !settings.cameras.some((c) => c.camera === n));
    if (unlisted.length) console.log(`not in Homedash, listed as off: ${unlisted.join(", ")}`);
    console.log(`weather: ${settings.weather.place || "(no place)"}; photos: ${settings.photos.source}; fonts: ui ${JSON.stringify(settings.fonts.ui)}, clock ${JSON.stringify(settings.fonts.clock)}`);
    for (const w of warnings) console.log(`couldn't map: ${w}`);
    console.log(`wrote ${outFile}${backupPath ? ` (previous copy kept at ${backupPath})` : ""}. The dashboard picks it up within a few seconds.`);
    return 0;
  } catch (err) {
    const msg = err instanceof UserError ? `${err.body.happened}` : (err as Error).message;
    return fail(msg, "Fix the input (or the --map) and run it again.");
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
