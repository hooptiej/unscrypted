#!/usr/bin/env node
/**
 * unscrypted — a from-scratch, self-hosted bridge that exposes IP cameras to
 * Apple HomeKit, including HomeKit Secure Video (HKSV).
 *
 * Entry point: load config, build a HAP Bridge with one camera accessory per
 * configured camera, publish it (advertising over mDNS), print the pairing
 * setup code + QR, and start the motion pollers.
 *
 * Designed to degrade gracefully: an unreachable camera does NOT stop the
 * bridge. ffmpeg being absent disables media but the accessory still publishes
 * and pairs.
 */

import * as fs from "fs";
import * as path from "path";
import qrcode from "qrcode-terminal";
import {
  Bridge,
  Categories,
  HAPStorage,
  MDNSAdvertiser,
  uuid,
} from "hap-nodejs";
import * as os from "os";
import { loadConfig, findConfigPath, ConfigError, ResolvedConfig } from "./config";
import { BridgeRuntime } from "./bridgeRuntime";
import { rootLogger, setLogLevel, Logger } from "./logger";
import { resolveFfmpeg } from "./ffmpeg";
import { UnscryptedCamera } from "./camera";
import { runSelfTest } from "./selftest";
import { probeOnvif } from "./onvif";
import { hasPairingState } from "./util";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const selftest = argv.includes("--selftest");
  const configFlagIdx = argv.indexOf("--config");
  const configPath =
    configFlagIdx >= 0 ? argv[configFlagIdx + 1] : undefined;

  // --probe-onvif <host[:port]> [user] [pass]
  // Standalone ONVIF connectivity/motion probe. If user/pass are omitted we try
  // to reuse credentials from a matching camera in config.json (its onvif block,
  // or the rtsp URL's embedded user:pass), so no secrets need to hit the CLI.
  const probeIdx = argv.indexOf("--probe-onvif");
  if (probeIdx >= 0) {
    await runProbe(argv, probeIdx, configPath);
    return;
  }

  let config: ResolvedConfig;
  let resolvedConfigPath: string;
  try {
    resolvedConfigPath = findConfigPath(configPath);
    config = loadConfig(resolvedConfigPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      rootLogger.error(`config error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  setLogLevel(config.logLevel);
  const log = rootLogger;

  log.info(`unscrypted starting (log level ${config.logLevel})`);

  // Verify ffmpeg once up front so the situation is clear in the logs.
  const ff = await resolveFfmpeg(config.ffmpegPath, log);
  if (!ff) {
    log.warn(
      "ffmpeg not found — the bridge will still publish and pair, but live view, " +
        "snapshots and recording will not work until ffmpeg is available.",
    );
  }

  if (selftest) {
    const ok = await runSelfTest(config.ffmpegPath, log);
    process.exit(ok ? 0 : 1);
  }

  // Persist directory for HAP pairing state.
  if (config.persistDirOverridden) {
    log.warn(
      `config.persistDir (${config.persistDirOverridden}) is ignored: ` +
        `UNSCRYPTED_PERSIST_DIR (${config.persistDir}) takes precedence.`,
    );
    // Guard (#4): never start under a fresh identity while the real pairing keys sit in the
    // ignored folder. Home would see a new, unpaired bridge and every camera would need re-adding.
    if (hasPairingState(config.persistDirOverridden) && !hasPairingState(config.persistDir)) {
      log.error(
        `Not starting: the HAP pairing keys are in ${config.persistDirOverridden}, but ` +
          `${config.persistDir} (the folder in use) is empty. Starting now would make Home see a ` +
          `new, unpaired bridge. Nothing was changed. Copy the files from ` +
          `${config.persistDirOverridden} into ${config.persistDir}, then start again.`,
      );
      process.exit(2);
    }
  }
  // HAP-off mode is for the test instance: it must never collide with prod's HomeKit identity.
  const hapEnabled = process.env.UNSCRYPTED_HAP !== "off";

  fs.mkdirSync(config.persistDir, { recursive: true });
  if (hapEnabled && !hasPairingState(config.persistDir)) {
    log.warn(
      `No HAP pairing state in ${config.persistDir}: starting as a NEW bridge. ` +
        "Pair it in the Home app with the setup code below. If this bridge was paired before, " +
        "stop it and restore its pairing files into this folder instead.",
    );
  }
  HAPStorage.setCustomStoragePath(config.persistDir);
  log.info(`HAP pairing state: ${config.persistDir}`);

  // Build the bridge.
  const bridge = new Bridge(
    config.bridge.name,
    uuid.generate(`unscrypted:bridge:${config.bridge.name}`),
  );

  const cameras: UnscryptedCamera[] = [];
  for (const camConfig of config.cameras) {
    try {
      const cam = new UnscryptedCamera(camConfig, config.ffmpegPath, log);
      bridge.addBridgedAccessory(cam.accessory);
      cameras.push(cam);
    } catch (err) {
      // One bad camera must not take down the whole bridge.
      log.error(
        `failed to configure camera "${camConfig.name}": ${(err as Error).message}. Skipping it.`,
      );
    }
  }

  if (cameras.length === 0) {
    log.error("no cameras could be configured; exiting");
    process.exit(3);
  }

  // A stray async error in the bridge's own code must be loud, never a silent exit.
  process.on("unhandledRejection", (e) => {
    log.error(`unhandled rejection (bridge kept running): ${(e as Error)?.stack ?? e}`);
  });

  if (hapEnabled) {
    // Publish the bridge (starts the HAP server + mDNS advertisement).
    await bridge.publish({
      username: config.bridge.username,
      pincode: config.bridge.pin,
      port: config.bridge.port,
      category: Categories.BRIDGE,
      setupID: config.bridge.setupId,
      advertiser: MDNSAdvertiser.CIAO,
    });

    printPairingInfo(log, config, bridge);

    // Start background work (motion pollers). The prebuffer starts on demand when
    // HomeKit enables recording.
    for (const cam of cameras) {
      cam.start();
    }

    log.info(
      `unscrypted is up: ${cameras.length} camera(s) bridged on port ${config.bridge.port}`,
    );
  } else {
    // Motion sources stay off too: they'd take camera event subscriptions and the shared ONVIF
    // notify port that the real (HAP-on) bridge on the same host is already using.
    log.warn(
      "HAP disabled (UNSCRYPTED_HAP=off): this instance is NOT visible to HomeKit. " +
        `${cameras.length} camera(s) configured for status and feed checks only; motion sources not started.`,
    );
  }

  const admin = envPort("UNSCRYPTED_ADMIN_PORT", 8190, log);
  const go2rtcApi = envPort("UNSCRYPTED_GO2RTC_API_PORT", 1986, log);
  const go2rtcWebrtc = envPort("UNSCRYPTED_GO2RTC_WEBRTC_PORT", 8557, log);
  const dashPort = envPort("UNSCRYPTED_DASH_PORT", 8180, log);
  const runtime = new BridgeRuntime({
    config,
    configPath: resolvedConfigPath,
    bridge: hapEnabled ? bridge : null,
    cameras,
    log,
    ffmpegPath: config.ffmpegPath,
    version: (require("../package.json") as { version: string }).version,
    admin: {
      port: admin.port,
      enabled: process.env.UNSCRYPTED_ADMIN !== "off" && admin.error === null,
      disabledReason: admin.error ?? undefined,
    },
    go2rtc: {
      binary: process.env.UNSCRYPTED_GO2RTC_BIN ?? "/usr/local/bin/go2rtc",
      apiPort: go2rtcApi.port,
      // WebRTC media for the pane's live preview (the way Homedash plays these cameras; MSE
      // doesn't play them). UNSCRYPTED_GO2RTC_WEBRTC=off turns just the live preview off.
      webrtcPort: process.env.UNSCRYPTED_GO2RTC_WEBRTC === "off" || go2rtcWebrtc.error ? null : go2rtcWebrtc.port,
      runtimeDir: process.env.UNSCRYPTED_RUNTIME_DIR ?? path.join(os.tmpdir(), "unscrypted"),
      enabled: process.env.UNSCRYPTED_GO2RTC !== "off" && go2rtcApi.error === null,
      disabledReason: go2rtcApi.error ?? undefined,
    },
    dash: {
      // 0.0.0.0 = every address on the host; a single LAN IP (e.g. its own alias on port 80) also works.
      host: process.env.UNSCRYPTED_DASH_HOST || "0.0.0.0",
      port: dashPort.port,
      enabled: process.env.UNSCRYPTED_DASH !== "off" && dashPort.error === null,
      // The dashboard's settings, fonts and photo cache sit beside the pairing state in ./data.
      dir: process.env.UNSCRYPTED_DASH_DIR ?? path.join(path.dirname(config.persistDir), "dash"),
      title: process.env.UNSCRYPTED_DASH_TITLE,
      disabledReason: dashPort.error ?? undefined,
    },
    requestRestart: (reason) => void shutdown(reason),
  });
  try {
    runtime.start();
  } catch (err) {
    // The pane and go2rtc are extras: failing to start them must not stop HomeKit.
    log.error(
      `admin pane / dashboard / go2rtc failed to start (HomeKit bridge keeps running without them): ${(err as Error).stack ?? err}`,
    );
  }

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info(`received ${signal}, shutting down...`);
    try {
      await runtime.stop();
    } catch (err) {
      log.warn(`error stopping the admin pane / dashboard / go2rtc: ${(err as Error).message}`);
    }
    for (const cam of cameras) {
      cam.shutdown();
    }
    if (hapEnabled) {
      try {
        await bridge.unpublish();
      } catch (err) {
        log.warn(`error during unpublish: ${(err as Error).message}`);
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/** A TCP port from the environment, or the default. A bad value disables that child, loudly. */
function envPort(name: string, def: number, log: Logger): { port: number; error: string | null } {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return { port: def, error: null };
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = `${name}="${raw}" is not a valid TCP port (1-65535)`;
    log.error(`${error}; that service is disabled until it's fixed. The HomeKit bridge is unaffected.`);
    return { port: def, error };
  }
  return { port, error: null };
}

async function runProbe(
  argv: string[],
  probeIdx: number,
  configPath?: string,
): Promise<void> {
  const log = rootLogger.child("probe");
  const target = argv[probeIdx + 1];
  if (!target) {
    log.error("usage: --probe-onvif <host[:port]> [username] [password]");
    process.exit(2);
  }
  let [host, portStr] = target.split(":");
  let port = portStr ? Number.parseInt(portStr, 10) : 80;
  let username = argv[probeIdx + 2];
  let password = argv[probeIdx + 3];

  // If creds weren't passed, mine them from config.json for a matching camera.
  if (!username || password === undefined) {
    try {
      const candidates = [
        configPath,
        process.env.UNSCRYPTED_CONFIG,
        path.resolve(process.cwd(), "config.json"),
      ].filter((p): p is string => Boolean(p));
      for (const c of candidates) {
        if (!fs.existsSync(c)) continue;
        const raw = JSON.parse(fs.readFileSync(c, "utf8")) as {
          cameras?: Array<Record<string, unknown>>;
        };
        for (const cam of raw.cameras ?? []) {
          const onvif = cam.onvif as
            | { host?: string; port?: number; username?: string; password?: string }
            | undefined;
          if (onvif?.host === host) {
            username = username ?? onvif.username;
            password = password ?? onvif.password;
            if (onvif.port && !portStr) port = onvif.port;
          }
          // Reuse rtsp creds if the main URL points at this host.
          const rtspMain = typeof cam.rtspMain === "string" ? cam.rtspMain : "";
          const m = new RegExp(`rtsp://([^:]+):([^@]+)@${host.replace(/\./g, "\\.")}[:/]`).exec(
            rtspMain,
          );
          if (m) {
            username = username ?? m[1];
            password = password ?? m[2];
          }
        }
        if (username && password !== undefined) break;
      }
    } catch (err) {
      log.warn(`could not read config for credentials: ${(err as Error).message}`);
    }
  }

  if (!username || password === undefined) {
    log.error(
      "no credentials: pass them as `--probe-onvif <host[:port]> <user> <pass>`, " +
        "or add the camera to config.json first",
    );
    process.exit(2);
  }

  log.info(`probing ${host}:${port} as "${username}" (password hidden)`);
  try {
    const ok = await probeOnvif({ host, port, username, password }, log, 30);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    log.error(`probe failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

function printPairingInfo(
  log: Logger,
  config: ResolvedConfig,
  bridge: Bridge,
): void {
  const uri = bridge.setupURI();
  log.info("");
  log.info("──────────────────────────────────────────────");
  log.info(`  Pair "${config.bridge.name}" in the Home app:`);
  log.info(`  Setup code:  ${config.bridge.pin}`);
  log.info("  Scan this QR code, or enter the code manually:");
  log.info("──────────────────────────────────────────────");
  // qrcode-terminal prints the QR to stdout.
  qrcode.generate(uri, { small: true });
  log.info(`  (setup URI: ${uri})`);
  log.info("──────────────────────────────────────────────");
  log.info("");
}

main().catch((err) => {
  rootLogger.error(`fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
