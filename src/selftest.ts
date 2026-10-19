/**
 * Self-test (`--selftest`): exercises the ffmpeg -> fragmented-MP4 -> parser
 * pipeline that underpins the prebuffer and HKSV recording, WITHOUT needing a
 * real camera or an iPhone.
 *
 * It runs ffmpeg against a generated lavfi test pattern (video testsrc + audio
 * sine), produces fragmented MP4 on stdout, feeds it through FragmentedMp4Parser,
 * and reports whether an init segment and keyframe-aligned fragments were parsed.
 *
 * If ffmpeg is unavailable it says so plainly and exits non-zero — it never
 * fakes success.
 */

import { Logger } from "./logger";
import { resolveFfmpeg, spawnFfmpeg } from "./ffmpeg";
import { FragmentedMp4Parser } from "./mp4";

export async function runSelfTest(ffmpegPath: string, log: Logger): Promise<boolean> {
  log.info("=== unscrypted self-test: ffmpeg -> fMP4 -> parser ===");

  const ff = await resolveFfmpeg(ffmpegPath, log, true);
  if (!ff) {
    log.error(
      "SELF-TEST FAILED: ffmpeg is not available. Install ffmpeg or set config.ffmpegPath.",
    );
    return false;
  }

  const seconds = 8;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=1280x720:rate=15:duration=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "main",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "30", // 2s keyframe cadence at 15fps
    "-force_key_frames",
    "expr:gte(t,n_forced*2)",
    "-c:a",
    "aac",
    "-ar",
    "32000",
    "-b:a",
    "32k",
    "-ac",
    "1",
    "-f",
    "mp4",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration",
    "2000000",
    "pipe:1",
  ];

  let initBytes = 0;
  let fragments = 0;
  let fragmentBytes = 0;

  const parser = new FragmentedMp4Parser(
    (segment) => {
      initBytes = segment.length;
      log.info(`  parsed init segment: ${segment.length} bytes (ftyp+moov)`);
    },
    (fragment) => {
      fragments += 1;
      fragmentBytes += fragment.length;
    },
  );

  const proc = spawnFfmpeg(ff, args, log, { label: "selftest" });
  proc.proc.stdout.on("data", (chunk: Buffer) => parser.push(chunk));
  const code = await proc.done;

  log.info(
    `  ffmpeg exit ${code}; init=${initBytes} bytes; fragments=${fragments} (${fragmentBytes} bytes total)`,
  );

  const ok = code === 0 && initBytes > 0 && fragments >= 2;
  if (ok) {
    log.info(
      "SELF-TEST PASSED: fragmented MP4 pipeline produced a parseable init segment and multiple keyframe fragments.",
    );
  } else {
    log.error(
      "SELF-TEST FAILED: did not get a clean init segment + >=2 fragments. See ffmpeg output above.",
    );
  }
  return ok;
}
