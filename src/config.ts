/**
 * Config loading and validation.
 *
 * The real config.json holds camera passwords and is gitignored. A sanitized
 * config.example.json ships in the repo. Secrets NEVER come from source — only
 * from the config file (or env overrides for the HAP pin/username).
 */

import * as fs from "fs";
import * as path from "path";

export interface FoscamConfig {
  /**
   * Base URL for the Foscam CGI API, e.g. "http://192.168.1.50:88".
   * The poller hits `${cgiBase}/cgi-bin/CGIProxy.fcgi`.
   */
  cgiBase: string;
  /** Foscam account username (often "admin"). */
  username: string;
  /** Foscam account password. Comes from config only — never hardcode. */
  password: string;
  /** How often to poll getDevState for motion, in ms. Default 1000. */
  pollIntervalMs?: number;
  /**
   * After a motion trigger, how long (ms) to hold the MotionSensor "on"
   * before clearing if no further triggers arrive. Default 8000.
   */
  motionCooldownMs?: number;
}

export interface CameraConfig {
  /** Display name shown in the Home app. Must be unique. */
  name: string;

  /**
   * Primary (high-res) RTSP URL. Used for live view and recording.
   * Either provide the full rtsp:// URL (may embed user:pass), OR the host +
   * rtsp fields below and unscrypted will assemble it.
   */
  rtspMain?: string;
  /** Secondary (low-res) RTSP URL. Used for snapshots / low-bandwidth. */
  rtspSub?: string;

  /** Alternative to rtspMain/rtspSub: assemble URLs from parts. */
  host?: string;
  rtspPort?: number; // default 554
  rtspUser?: string;
  rtspPassword?: string;
  rtspMainPath?: string; // default /videoMain
  rtspSubPath?: string; // default /videoSub

  /** Foscam CGI control block — drives the motion poller. Optional. */
  foscam?: FoscamConfig;

  /** Rolling prebuffer length in seconds (HAP requires >= 4). Default 4. */
  prebufferSeconds?: number;

  /** Enable HomeKit Secure Video recording for this camera. Default true. */
  hksv?: boolean;

  /** Max recording length in seconds (HAP caps around 180). Default 170. */
  maxRecordingSeconds?: number;

  /**
   * Whether video can be copied (-c:v copy) rather than transcoded.
   * Foscam streams are already H.264, so default true. Set false to force
   * a transcode (e.g. if the camera emits an unsupported profile).
   */
  copyVideo?: boolean;

  /** Audio sample rate for the camera's source audio. Informational. */
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
}

export interface BridgeConfig {
  /** Bridge display name in the Home app. Default "Unscrypted". */
  name?: string;
  /**
   * HAP username — a locally-administered MAC-style id, e.g. "CC:22:3D:E3:CE:F6".
   * Stable identity for the bridge; keep it the same across restarts.
   */
  username?: string;
  /** 8-digit HomeKit setup pin, format "XXX-XX-XXX". */
  pin?: string;
  /** TCP port for the HAP server. Default 51826. */
  port?: number;
  /** Optional 4-char setup id used in the QR code. */
  setupId?: string;
}

export interface Config {
  bridge: BridgeConfig;
  cameras: CameraConfig[];
  /** Where HAP pairing state is persisted. Default ./persist. */
  persistDir?: string;
  /** Path to ffmpeg binary. Default: "ffmpeg" (resolved on PATH). */
  ffmpegPath?: string;
  logLevel?: "debug" | "info" | "warn" | "error";
}

export class ConfigError extends Error {}

function assembleRtsp(
  cam: CameraConfig,
  which: "main" | "sub",
): string | undefined {
  const direct = which === "main" ? cam.rtspMain : cam.rtspSub;
  if (direct) {
    return direct;
  }
  if (!cam.host) {
    return undefined;
  }
  const port = cam.rtspPort ?? 554;
  const user = cam.rtspUser;
  const pass = cam.rtspPassword;
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass ?? "")}@` : "";
  const streamPath =
    which === "main"
      ? cam.rtspMainPath ?? "/videoMain"
      : cam.rtspSubPath ?? "/videoSub";
  const normalized = streamPath.startsWith("/") ? streamPath : `/${streamPath}`;
  return `rtsp://${auth}${cam.host}:${port}${normalized}`;
}

/** Resolved, validated form of a camera — URLs assembled, defaults applied. */
export interface ResolvedCamera {
  name: string;
  rtspMain: string;
  rtspSub?: string;
  foscam?: Required<Pick<FoscamConfig, "cgiBase" | "username" | "password">> &
    Pick<FoscamConfig, "pollIntervalMs" | "motionCooldownMs">;
  prebufferSeconds: number;
  hksv: boolean;
  maxRecordingSeconds: number;
  copyVideo: boolean;
  manufacturer: string;
  model: string;
  serialNumber: string;
}

export interface ResolvedConfig {
  bridge: Required<Omit<BridgeConfig, never>>;
  cameras: ResolvedCamera[];
  persistDir: string;
  ffmpegPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function resolveConfig(raw: Config, baseDir: string): ResolvedConfig {
  if (!raw || typeof raw !== "object") {
    throw new ConfigError("config root must be an object");
  }
  if (!Array.isArray(raw.cameras) || raw.cameras.length === 0) {
    throw new ConfigError("config.cameras must be a non-empty array");
  }

  const bridge: ResolvedConfig["bridge"] = {
    name: raw.bridge?.name ?? "Unscrypted",
    username: (raw.bridge?.username ?? process.env.UNSCRYPTED_BRIDGE_USERNAME ?? "CC:22:3D:E3:CE:F6").toUpperCase(),
    pin: raw.bridge?.pin ?? process.env.UNSCRYPTED_BRIDGE_PIN ?? "031-45-154",
    port: raw.bridge?.port ?? 51826,
    setupId: raw.bridge?.setupId ?? "UNSC",
  };

  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(bridge.username)) {
    throw new ConfigError(
      `bridge.username must be a MAC-style id like "CC:22:3D:E3:CE:F6" (got "${bridge.username}")`,
    );
  }
  if (!/^\d{3}-\d{2}-\d{3}$/.test(bridge.pin)) {
    throw new ConfigError(
      `bridge.pin must be formatted "XXX-XX-XXX" (got "${bridge.pin}")`,
    );
  }

  const seenNames = new Set<string>();
  const cameras: ResolvedCamera[] = raw.cameras.map((cam, i) => {
    if (!cam.name) {
      throw new ConfigError(`cameras[${i}] is missing a "name"`);
    }
    if (seenNames.has(cam.name)) {
      throw new ConfigError(`duplicate camera name "${cam.name}"`);
    }
    seenNames.add(cam.name);

    const rtspMain = assembleRtsp(cam, "main");
    if (!rtspMain) {
      throw new ConfigError(
        `cameras[${i}] "${cam.name}": provide rtspMain, or host + rtsp fields`,
      );
    }
    const rtspSub = assembleRtsp(cam, "sub");

    let foscam: ResolvedCamera["foscam"];
    if (cam.foscam) {
      if (!cam.foscam.cgiBase || !cam.foscam.username || !cam.foscam.password) {
        throw new ConfigError(
          `cameras[${i}] "${cam.name}": foscam block needs cgiBase, username, password`,
        );
      }
      foscam = {
        cgiBase: cam.foscam.cgiBase.replace(/\/+$/, ""),
        username: cam.foscam.username,
        password: cam.foscam.password,
        pollIntervalMs: cam.foscam.pollIntervalMs ?? 1000,
        motionCooldownMs: cam.foscam.motionCooldownMs ?? 8000,
      };
    }

    const prebufferSeconds = Math.max(4, cam.prebufferSeconds ?? 4);

    return {
      name: cam.name,
      rtspMain,
      rtspSub,
      foscam,
      prebufferSeconds,
      hksv: cam.hksv ?? true,
      maxRecordingSeconds: Math.min(180, cam.maxRecordingSeconds ?? 170),
      copyVideo: cam.copyVideo ?? true,
      manufacturer: cam.manufacturer ?? "Foscam",
      model: cam.model ?? "IP Camera",
      serialNumber: cam.serialNumber ?? `unscrypted-${cam.name.replace(/\s+/g, "-")}`,
    };
  });

  const persistDir = path.resolve(
    baseDir,
    raw.persistDir ?? process.env.UNSCRYPTED_PERSIST_DIR ?? "persist",
  );

  return {
    bridge,
    cameras,
    persistDir,
    ffmpegPath: raw.ffmpegPath ?? process.env.UNSCRYPTED_FFMPEG ?? "ffmpeg",
    logLevel: raw.logLevel ?? (process.env.UNSCRYPTED_LOG_LEVEL as ResolvedConfig["logLevel"]) ?? "info",
  };
}

export function loadConfig(explicitPath?: string): ResolvedConfig {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        process.env.UNSCRYPTED_CONFIG,
        path.resolve(process.cwd(), "config.json"),
        "/config/config.json",
      ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const text = fs.readFileSync(candidate, "utf8");
      let parsed: Config;
      try {
        parsed = JSON.parse(text) as Config;
      } catch (err) {
        throw new ConfigError(
          `failed to parse ${candidate}: ${(err as Error).message}`,
        );
      }
      return resolveConfig(parsed, path.dirname(candidate));
    }
  }

  throw new ConfigError(
    `no config file found. Looked in: ${candidates.join(", ")}. ` +
      `Copy config.example.json to config.json and fill in your cameras.`,
  );
}
