/**
 * ffmpeg discovery + spawn helpers.
 *
 * unscrypted shells out to ffmpeg for everything media: live SRTP egress,
 * snapshots, and the fragmented-MP4 generator used by the prebuffer / recording.
 */

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { Logger } from "./logger";

let cachedPath: string | null | undefined;

/**
 * Resolve and verify the ffmpeg binary. Returns the path if runnable, else null.
 * Result is cached. Pass force=true to re-check.
 */
export async function resolveFfmpeg(
  ffmpegPath: string,
  log: Logger,
  force = false,
): Promise<string | null> {
  if (!force && cachedPath !== undefined) {
    return cachedPath;
  }
  const ok = await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const proc = spawn(ffmpegPath, ["-version"], { stdio: "ignore" });
      proc.on("error", () => done(false));
      proc.on("exit", (code) => done(code === 0));
    } catch {
      done(false);
    }
  });
  cachedPath = ok ? ffmpegPath : null;
  if (!ok) {
    log.warn(
      `ffmpeg not runnable at "${ffmpegPath}". Live view, snapshots and recording ` +
        `will be unavailable until ffmpeg is installed / configured (config.ffmpegPath).`,
    );
  } else {
    log.debug(`ffmpeg OK at "${ffmpegPath}"`);
  }
  return cachedPath;
}

export interface SpawnedFfmpeg {
  proc: ChildProcessWithoutNullStreams;
  /** Resolves with the exit code (or null on signal). */
  done: Promise<number | null>;
  kill: () => void;
}

/**
 * Spawn ffmpeg with the given args. stderr is logged at debug level (ffmpeg is
 * chatty); non-zero, non-killed exits are logged at warn so failures are loud,
 * never silent.
 */
export function spawnFfmpeg(
  ffmpegPath: string,
  args: string[],
  log: Logger,
  opts: { label: string; logStderr?: boolean } = { label: "ffmpeg" },
): SpawnedFfmpeg {
  log.debug(`spawn ${opts.label}: ffmpeg ${args.join(" ")}`);
  const proc = spawn(ffmpegPath, args) as ChildProcessWithoutNullStreams;
  let killed = false;

  let stderrTail = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-4000);
    if (opts.logStderr) {
      log.debug(`[${opts.label}] ${text.trimEnd()}`);
    }
  });

  const done = new Promise<number | null>((resolve) => {
    proc.on("error", (err) => {
      log.error(`[${opts.label}] failed to run ffmpeg: ${err.message}`);
      resolve(null);
    });
    proc.on("exit", (code, signal) => {
      if (killed || signal === "SIGKILL" || signal === "SIGTERM") {
        log.debug(`[${opts.label}] exited (signal=${signal})`);
      } else if (code !== 0) {
        log.warn(
          `[${opts.label}] ffmpeg exited with code ${code}. Last stderr:\n${stderrTail.trimEnd()}`,
        );
      } else {
        log.debug(`[${opts.label}] exited cleanly`);
      }
      resolve(code);
    });
  });

  const kill = () => {
    if (!killed && proc.exitCode === null) {
      killed = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };

  return { proc, done, kill };
}

/** SRTP suite string ffmpeg expects for HomeKit. */
export const SRTP_SUITE = "AES_CM_128_HMAC_SHA1_80";

/** HomeKit live-stream MTU. The spec wants ~1200 for video RTP payloads. */
export const HOMEKIT_MTU = 1200;

/**
 * Input args for a HomeKit live view (#55). ffmpeg normally probes an RTSP input for ~2.8 s before it
 * writes anything, then flushes the probed frames in one burst. The phone then gets ~28 frames in
 * 200 ms whose RTP timestamps run ~2.8 s ahead of real time, so the whole stream stays early by that
 * much (measured: 105k RTP ticks per second over a 20 s capture instead of 90k). Probing only the
 * first packet removes the burst; ffmpeg still gets SPS/PPS from the RTSP SDP, and the camera's own
 * timestamps (90,000 per second steady-state) pass through untouched.
 */
export function liveViewInputArgs(rtspUrl: string): string[] {
  return ["-probesize", "32", "-analyzeduration", "0", "-rtsp_transport", "tcp", "-i", rtspUrl];
}
