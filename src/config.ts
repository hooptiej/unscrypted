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

export interface OnvifConfig {
  /** Camera host/IP for the ONVIF service, e.g. "10.0.1.3". */
  host: string;
  /**
   * ONVIF service port. Default 80.
   *
   * NOTE: many generic XM/Sofia cameras actually serve ONVIF on 8080 (port 80
   * is the web UI), so set this explicitly if the device service 404s on 80.
   */
  port?: number;
  /** ONVIF account username (often "admin"). */
  username: string;
  /** ONVIF account password. Comes from config only — never hardcode. */
  password: string;
  /**
   * For cameras that support PullPoint: how long (ms) each PullMessages call
   * blocks waiting for events, and the base cadence between pulls. Default
   * 60000 (a long-poll). Ignored for push/base-notification cameras.
   */
  pollIntervalMs?: number;
  /**
   * After a motion trigger, how long (ms) to hold the MotionSensor "on" before
   * clearing if no further triggers arrive. Default 8000.
   */
  motionCooldownMs?: number;
  /**
   * TCP port the local notification receiver listens on for push
   * (base-notification) cameras that don't implement PullPoint. Default 0
   * (ephemeral — a fresh port each boot). Set a fixed port if a firewall sits
   * between unscrypted and the cameras so you can allow it. A single receiver
   * is shared across all ONVIF cameras.
   */
  notifyPort?: number;
  /**
   * Override the local IP advertised to the camera as the notification consumer
   * address. Default: auto-detected by seeing which local interface routes to
   * the camera. Set this if auto-detection picks the wrong NIC (e.g. in Docker).
   */
  notifyHost?: string;
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

  /**
   * Motion source blocks. A camera may configure AT MOST ONE. If neither is
   * present the camera has no motion source (motion="none") — live view and
   * recording still work, but nothing flips the HomeKit MotionSensor, so HKSV
   * recordings won't be triggered.
   *   - foscam: Foscam CGI polling (port 88 getDevState).
   *   - onvif:  ONVIF event subscription (PullPoint, or base-notification push).
   */
  /** Foscam CGI control block — drives the motion poller. Optional. */
  foscam?: FoscamConfig;

  /** ONVIF event control block — drives the ONVIF motion source. Optional. */
  onvif?: OnvifConfig;

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

  /**
   * Whether the camera provides an audio track. Default true. Set false for
   * video-only cameras (e.g. the mic is disabled) so ffmpeg doesn't fail trying
   * to map a non-existent audio stream (which kills the whole live view).
   */
  audio?: boolean;

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
  onvif?: Required<Pick<OnvifConfig, "host" | "port" | "username" | "password">> & {
    pollIntervalMs: number;
    motionCooldownMs: number;
    notifyPort: number;
    notifyHost?: string;
  };
  prebufferSeconds: number;
  hksv: boolean;
  maxRecordingSeconds: number;
  copyVideo: boolean;
  audio: boolean;
  manufacturer: string;
  model: string;
  serialNumber: string;
}

export interface ResolvedConfig {
  bridge: Required<Omit<BridgeConfig, never>>;
  cameras: ResolvedCamera[];
  persistDir: string;
  /** config.persistDir, resolved, when UNSCRYPTED_PERSIST_DIR overrode it (else undefined). */
  persistDirOverridden?: string;
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

    if (cam.foscam && cam.onvif) {
      throw new ConfigError(
        `cameras[${i}] "${cam.name}": configure at most one motion source — remove either the "foscam" or the "onvif" block`,
      );
    }

    let foscam: ResolvedCamera["foscam"];
    if (cam.foscam) {
      if (!cam.foscam.cgiBase || !cam.foscam.username || cam.foscam.password == null) {
        throw new ConfigError(
          `cameras[${i}] "${cam.name}": foscam block needs cgiBase, username, and a password field (empty string allowed for no-password cameras)`,
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

    let onvif: ResolvedCamera["onvif"];
    if (cam.onvif) {
      if (!cam.onvif.host || !cam.onvif.username || cam.onvif.password == null) {
        throw new ConfigError(
          `cameras[${i}] "${cam.name}": onvif block needs host, username, and a password field (empty string allowed for no-password cameras)`,
        );
      }
      const port = cam.onvif.port ?? 80;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigError(
          `cameras[${i}] "${cam.name}": onvif.port must be a valid TCP port (got ${port})`,
        );
      }
      const notifyPort = cam.onvif.notifyPort ?? 0;
      if (!Number.isInteger(notifyPort) || notifyPort < 0 || notifyPort > 65535) {
        throw new ConfigError(
          `cameras[${i}] "${cam.name}": onvif.notifyPort must be 0 (ephemeral) or a valid TCP port (got ${notifyPort})`,
        );
      }
      onvif = {
        host: cam.onvif.host,
        port,
        username: cam.onvif.username,
        password: cam.onvif.password,
        pollIntervalMs: cam.onvif.pollIntervalMs ?? 60000,
        motionCooldownMs: cam.onvif.motionCooldownMs ?? 8000,
        notifyPort,
        notifyHost: cam.onvif.notifyHost,
      };
    }

    const prebufferSeconds = Math.max(4, cam.prebufferSeconds ?? 4);

    return {
      name: cam.name,
      rtspMain,
      rtspSub,
      foscam,
      onvif,
      prebufferSeconds,
      hksv: cam.hksv ?? true,
      maxRecordingSeconds: Math.min(180, cam.maxRecordingSeconds ?? 170),
      copyVideo: cam.copyVideo ?? true,
      audio: cam.audio ?? true,
      manufacturer: cam.manufacturer ?? "Foscam",
      model: cam.model ?? "IP Camera",
      serialNumber: cam.serialNumber ?? `unscrypted-${cam.name.replace(/\s+/g, "-")}`,
    };
  });

  // UNSCRYPTED_PERSIST_DIR wins over config.persistDir: in Docker it names the bind-mounted
  // /data/persist, and a stale config key must not send the pairing keys somewhere that isn't
  // persisted (#4: "persist" put them in an anonymous volume that a compose down would drop).
  const configPersistDir = raw.persistDir ? path.resolve(baseDir, raw.persistDir) : undefined;
  const persistDir = path.resolve(
    baseDir,
    process.env.UNSCRYPTED_PERSIST_DIR ?? raw.persistDir ?? "persist",
  );

  return {
    bridge,
    cameras,
    persistDir,
    persistDirOverridden:
      configPersistDir && configPersistDir !== persistDir ? configPersistDir : undefined,
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
