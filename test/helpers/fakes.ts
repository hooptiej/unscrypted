/**
 * Shared fakes for the motion and recording tests (#47): a camera, a log catcher, a wait helper,
 * and a fake ffmpeg (the node binary running a one-line script, so real exit codes and signals).
 */

import { ResolvedCamera } from "../../src/config";
import { FfmpegDeps, spawnFfmpeg } from "../../src/ffmpeg";
import { setLogLevel } from "../../src/logger";

export function fakeCamera(over: Partial<ResolvedCamera> = {}): ResolvedCamera {
  return {
    name: "Test Cam",
    rtspMain: "rtsp://u:p@127.0.0.1:8554/main",
    rtspSub: "rtsp://u:p@127.0.0.1:8554/sub",
    prebufferSeconds: 4,
    hksv: true,
    maxRecordingSeconds: 170,
    copyVideo: true,
    liveTranscode: true,
    audio: false,
    manufacturer: "Test",
    model: "Fake",
    serialNumber: "unscrypted-test",
    ...over,
  };
}

/** Catch every log line (any level) until restore(). Lines look like "[ts] [WARN] [scope] text". */
export function captureLogs(): { lines: string[]; restore: () => void; warns: () => string[] } {
  const lines: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  const catcher = (...a: unknown[]): void => { lines.push(a.map(String).join(" ")); };
  console.log = catcher;
  console.error = catcher;
  setLogLevel("debug");
  return {
    lines,
    warns: () => lines.filter((l) => l.includes("[WARN]")),
    restore: () => {
      console.log = realLog;
      console.error = realErr;
      setLogLevel("error");
    },
  };
}

/** Wait (real time) until cond() is true; throws with `what` if it isn't within timeoutMs. */
export async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Snippets for the fake ffmpeg's script. */
export const FFMPEG = {
  /** Runs until killed. */
  runs: "setInterval(() => {}, 1000)",
  /** Exits cleanly at once, as ffmpeg does when its RTSP input ends. */
  exitsClean: "process.exit(0)",
  /** Fails at once. */
  fails: "process.stderr.write('Connection refused\\n'); process.exit(1)",
};

export interface FakeFfmpeg extends FfmpegDeps {
  /** The args each spawn was given (what real ffmpeg would have run). */
  calls: string[][];
}

/**
 * A fake ffmpeg: spawn N runs `scripts[N]` (the last one repeats) in the node binary, through the
 * real spawnFfmpeg so exit handling is the production code's.
 */
export function fakeFfmpeg(...scripts: string[]): FakeFfmpeg {
  const calls: string[][] = [];
  return {
    calls,
    resolve: async () => "fake-ffmpeg",
    spawn: (_path, args, log, opts) => {
      const script = scripts[Math.min(calls.length, scripts.length - 1)];
      calls.push(args);
      return spawnFfmpeg(process.execPath, ["-e", script], log, opts);
    },
  };
}
