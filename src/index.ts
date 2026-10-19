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
import { loadConfig, ConfigError, ResolvedConfig } from "./config";
import { rootLogger, setLogLevel, Logger } from "./logger";
import { resolveFfmpeg } from "./ffmpeg";
import { UnscryptedCamera } from "./camera";
import { runSelfTest } from "./selftest";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const selftest = argv.includes("--selftest");
  const configFlagIdx = argv.indexOf("--config");
  const configPath =
    configFlagIdx >= 0 ? argv[configFlagIdx + 1] : undefined;

  let config: ResolvedConfig;
  try {
    config = loadConfig(configPath);
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
  fs.mkdirSync(config.persistDir, { recursive: true });
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

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info(`received ${signal}, shutting down...`);
    for (const cam of cameras) {
      cam.shutdown();
    }
    try {
      await bridge.unpublish();
    } catch (err) {
      log.warn(`error during unpublish: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
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
