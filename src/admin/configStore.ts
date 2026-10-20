/**
 * The admin pane's view of config.json: read it raw, redact secrets for the browser, merge an
 * edit (write-only secrets + the camera-name lock), validate with the bridge's own validator, and
 * write it back atomically with a backup of the previous version.
 */

import * as fs from "fs";
import * as path from "path";
import { Config, CameraConfig, FoscamConfig, OnvifConfig, resolveConfig, ConfigError } from "../config";
import { UserError } from "./errors";

export type Secret = { set: boolean };
export type PublicCamera = Omit<CameraConfig, "rtspPassword" | "foscam" | "onvif"> & {
  rtspPassword?: Secret;
  foscam?: Omit<FoscamConfig, "password"> & { password: Secret };
  onvif?: Omit<OnvifConfig, "password"> & { password: Secret };
};
export type CameraEdit = Partial<Omit<CameraConfig, "foscam" | "onvif">> & {
  foscam?: Partial<FoscamConfig> | null;
  onvif?: Partial<OnvifConfig> | null;
};

const MASK = "***";
const URL_CREDS = /^(rtsp:\/\/[^:/@]+:)([^@]*)(@.*)$/i;

/** Top-level camera fields the pane may set. Anything else in an edit is refused. */
const EDITABLE_KEYS: ReadonlySet<string> = new Set([
  "name", "rtspMain", "rtspSub", "host", "rtspPort", "rtspUser", "rtspPassword", "rtspMainPath",
  "rtspSubPath", "foscam", "onvif", "prebufferSeconds", "hksv", "maxRecordingSeconds", "copyVideo",
  "audio", "manufacturer", "model", "serialNumber",
]);
const FOSCAM_KEYS: ReadonlySet<string> = new Set(["cgiBase", "username", "password", "pollIntervalMs", "motionCooldownMs"]);
const ONVIF_KEYS: ReadonlySet<string> = new Set([
  "host", "port", "username", "password", "pollIntervalMs", "motionCooldownMs", "notifyPort", "notifyHost",
]);

export function maskUrl(url: string | undefined): string | undefined {
  return url?.replace(URL_CREDS, `$1${MASK}$3`);
}

/** If the submitted URL still carries the mask, put the stored password back. */
function unmaskUrl(submitted: string, stored: string | undefined): string {
  const m = URL_CREDS.exec(submitted);
  if (!m || m[2] !== MASK) return submitted;
  const old = stored ? URL_CREDS.exec(stored) : null;
  if (!old) {
    throw new UserError({
      attempted: "Save the camera's stream URL",
      happened: `The URL still has "${MASK}" as its password, and there's no stored password to keep.`,
      changed: "Nothing was saved.",
      next: "Type the real password into the URL (it's stored server-side and never shown again).",
    });
  }
  return `${m[1]}${old[2]}${m[3]}`;
}

export function redactCamera(cam: CameraConfig): PublicCamera {
  const out: any = { ...cam, rtspMain: maskUrl(cam.rtspMain), rtspSub: maskUrl(cam.rtspSub) };
  if (cam.rtspPassword !== undefined) out.rtspPassword = { set: cam.rtspPassword !== "" };
  if (cam.foscam) out.foscam = { ...cam.foscam, password: { set: cam.foscam.password !== "" } };
  if (cam.onvif) out.onvif = { ...cam.onvif, password: { set: cam.onvif.password !== "" } };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export type Login = { user: string; password: string };
/** One camera's logins, for the signed-in admin's Show button only (#18). Never in the camera list. */
export type CameraLogins = { name: string; rtsp: Login | null; foscam: Login | null; onvif: Login | null; webUi: string | null };

const URL_LOGIN = /^rtsp:\/\/([^:/@]+):([^@]*)@/i;
const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

/** The RTSP login: the rtspUser/rtspPassword parts, or else the user:pass in rtspMain (then rtspSub). URLs are percent-decoded, as the bridge encodes them. */
function rtspLogin(cam: CameraConfig): Login | null {
  if (cam.rtspUser !== undefined || cam.rtspPassword !== undefined) return { user: cam.rtspUser ?? "", password: cam.rtspPassword ?? "" };
  for (const u of [cam.rtspMain, cam.rtspSub]) {
    const m = u ? URL_LOGIN.exec(u) : null;
    if (m) return { user: decode(m[1]), password: decode(m[2]) };
  }
  return null;
}

export function cameraLogins(cam: CameraConfig): CameraLogins {
  const webUi = cam.foscam?.cgiBase || (cam.host ? `http://${cam.host}` : null)
    || (cam.onvif?.host ? `http://${cam.onvif.host}:${cam.onvif.port ?? 80}` : null);
  return {
    name: cam.name,
    rtsp: rtspLogin(cam),
    foscam: cam.foscam ? { user: cam.foscam.username ?? "", password: cam.foscam.password ?? "" } : null,
    onvif: cam.onvif ? { user: cam.onvif.username ?? "", password: cam.onvif.password ?? "" } : null,
    webUi,
  };
}

export function redactConfig(raw: Config): { cameras: PublicCamera[] } {
  return { cameras: raw.cameras.map(redactCamera) };
}

export function readRawConfig(file: string): Config {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new UserError({
      attempted: `Read ${file}`,
      happened: `The config file couldn't be read: ${(err as Error).message}`,
      changed: "Nothing was changed.",
      next: "Check the ./config folder is mounted and readable by the container, then reload.",
    }, 500);
  }
  try {
    return JSON.parse(text) as Config;
  } catch (err) {
    throw new UserError({
      attempted: `Read ${file}`,
      happened: `config.json isn't valid JSON: ${(err as Error).message}`,
      changed: "Nothing was changed.",
      next: "Fix the file by hand (or restore the newest copy from ./config/backups), then reload.",
    }, 500);
  }
}

/** A secret field from the browser: a string replaces, anything else (absent, {set:...}) keeps. */
const isNewSecret = (v: unknown): v is string => typeof v === "string";

function refuseUnknown(camName: string, where: string, edit: object, allowed: ReadonlySet<string>): void {
  const bad = Object.keys(edit).filter((k) => !allowed.has(k));
  if (bad.length > 0) {
    throw new UserError({
      attempted: `Save camera "${camName}"`,
      happened: `Unknown field${bad.length > 1 ? "s" : ""} ${where}: ${bad.join(", ")}.`,
      changed: "Nothing was saved.",
      next: "Reload the page (it may be out of date with the server) and save again.",
    });
  }
}

function mergeBlock<T extends { password: string }>(
  stored: T | undefined, edit: Partial<T> | null | undefined,
): T | undefined {
  if (edit === null) return undefined;          // explicit removal of the block
  if (edit === undefined) return stored;
  const merged = { ...(stored ?? {}), ...edit } as T;
  if (!isNewSecret(edit.password)) {
    if (stored) merged.password = stored.password;
    else delete (merged as Partial<T>).password;  // let the validator say a password field is needed
  }
  return merged;
}

export function applyCameraEdit(raw: Config, originalName: string | null, edit: CameraEdit): Config {
  const next: Config = JSON.parse(JSON.stringify(raw));
  if (!Array.isArray(next.cameras)) next.cameras = [];
  let cam: CameraConfig;
  if (originalName === null) {
    const name = typeof edit.name === "string" ? edit.name.trim() : "";
    if (!name) {
      throw new UserError({ attempted: "Add a camera", happened: "No name was given.", changed: "Nothing was saved.",
        next: "Pick a name. It's permanent: Home uses it as the camera's identity." });
    }
    if (next.cameras.some((c) => c.name === name)) {
      throw new UserError({ attempted: `Add camera "${name}"`, happened: "A camera with that name already exists.",
        changed: "Nothing was saved.", next: "Pick a different name, or edit the existing camera instead." }, 409);
    }
    cam = { name } as CameraConfig;
    next.cameras.push(cam);
  } else {
    const found = next.cameras.find((c) => c.name === originalName);
    if (!found) {
      throw new UserError({ attempted: `Edit camera "${originalName}"`, happened: "No camera with that name is in config.json.",
        changed: "Nothing was saved.", next: "Reload the page; someone may have edited config.json by hand." }, 404);
    }
    if (edit.name !== undefined && edit.name !== originalName) {
      throw new UserError({
        attempted: `Rename camera "${originalName}" to "${edit.name}"`,
        happened: "Renaming is blocked: HomeKit uses the camera's name as its identity, so a rename makes Home see a brand-new camera and orphans the old one's recordings and automations.",
        changed: "Nothing was saved.",
        next: "Keep the name here and rename the camera inside the Home app instead (that only changes what Home displays).",
      }, 409);
    }
    cam = found;
  }

  refuseUnknown(cam.name, "on the camera", edit, EDITABLE_KEYS);
  if (edit.foscam) refuseUnknown(cam.name, "in the Foscam block", edit.foscam, FOSCAM_KEYS);
  if (edit.onvif) refuseUnknown(cam.name, "in the ONVIF block", edit.onvif, ONVIF_KEYS);

  const { foscam, onvif, name: _ignored, ...plain } = edit;
  for (const [k, v] of Object.entries(plain)) {
    if (v === undefined) continue;
    if (k === "rtspPassword") {
      if (isNewSecret(v)) cam.rtspPassword = v;
      continue;
    }
    if ((k === "rtspMain" || k === "rtspSub") && typeof v === "string") {
      (cam as any)[k] = unmaskUrl(v, (cam as any)[k]);
    } else {
      (cam as any)[k] = v;
    }
  }
  const f = mergeBlock(cam.foscam, foscam as Partial<FoscamConfig> | null | undefined);
  const o = mergeBlock(cam.onvif, onvif as Partial<OnvifConfig> | null | undefined);
  if (f) cam.foscam = f; else delete cam.foscam;
  if (o) cam.onvif = o; else delete cam.onvif;

  try {
    resolveConfig(next, "/");   // the existing validator; throws ConfigError
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new UserError({ attempted: `Save camera "${cam.name}"`, happened: err.message,
        changed: "Nothing was saved; config.json is untouched.", next: "Fix the field named above and save again." });
    }
    throw err;
  }
  return next;
}

export function writeConfigAtomic(file: string, next: Config, opts: { keepBackups?: number } = {}): { backupPath: string | null; warning?: string } {
  const keep = opts.keepBackups ?? 20;
  const dir = path.dirname(file);
  const backups = path.join(dir, "backups");
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  let backupPath: string | null = null;
  try {
    fs.mkdirSync(backups, { recursive: true });
    if (fs.existsSync(file)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = path.join(backups, `config-${stamp}-${process.hrtime.bigint()}.json`);
      fs.copyFileSync(file, backupPath);
      fs.chmodSync(backupPath, 0o600);
    }
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(next, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    let cleanup = "";
    if (fs.existsSync(tmp)) {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        cleanup = ` A temp file was left behind at ${tmp} (${(e as Error).message}); it is safe to delete.`;
      }
    }
    throw new UserError({
      attempted: `Save ${file}`,
      happened: `Writing the config failed: ${(err as Error).message}`,
      changed: `config.json was not replaced; the previous version is still in place.${cleanup}`,
      next: "Check that the ./config folder is mounted read-write and the disk isn't full, then save again.",
    }, 500);
  }
  // Pruning is housekeeping: the save already succeeded, so a failure here is reported as a
  // warning alongside the success rather than as a failed save.
  try {
    const all = fs.readdirSync(backups).filter((n) => n.startsWith("config-")).sort();
    for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(backups, old));
  } catch (err) {
    return {
      backupPath,
      warning: `Saved, but old backups in ${backups} couldn't be pruned (${(err as Error).message}). Delete old files there by hand if the folder grows.`,
    };
  }
  return { backupPath };
}
