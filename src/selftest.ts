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
 *
 * `--selftest --source <rtsp url> [--seconds N] [--audio]` (#16) runs the REAL prebuffer args
 * (buildPrebufferArgs) against that source instead, e.g. go2rtc's loopback restream, and checks
 * what HomeKit needs from every fragment: it starts on a keyframe, timestamps start at zero and
 * only increase, no B-frames, an avcC in the init segment. It also reports the longest fragment
 * against HomeKit's 4 s.
 */

import { Logger } from "./logger";
import { resolveFfmpeg, spawnFfmpeg } from "./ffmpeg";
import { FragmentedMp4Parser, FragmentInfo, inspectFragment, videoTimescale, videoTrack } from "./mp4";
import { buildPrebufferArgs } from "./prebuffer";
import { redactUrl } from "./util";

export interface FragmentCheck {
  problems: string[];
  longestSeconds: number | null;
  timescale: number | null;
  /** Fragments carrying the video track (the ones judged). */
  videoFragments: number;
  /** Fragments with only another track (an audio-only tail when ffmpeg stops): counted, not judged. */
  otherTrackFragments: number;
}

/**
 * The HKSV checks on a captured init segment + fragments (each inspected for the init's video
 * track). Pure; each problem is in plain words and names the fragment by its number in the stream.
 */
export function checkFragments(init: Buffer | null, infos: FragmentInfo[], seconds: number): FragmentCheck {
  const problems: string[] = [];
  const ts = init ? videoTimescale(init) : null;
  const vid = init ? videoTrack(init)?.trackId ?? null : null;
  if (!init) problems.push("no init segment (ftyp+moov): ffmpeg never got a usable stream");
  else if (!init.includes(Buffer.from("avcC"))) problems.push("the init segment has no avcC (H.264 setup data): HomeKit can't decode it");
  if (init && ts === null) problems.push("no video timescale in the init segment");

  const unreadable = infos.findIndex((f) => f.trackId === null);
  if (unreadable >= 0) problems.push(`fragment #${unreadable + 1} couldn't be read (no moof/traf): the fMP4 stream is damaged`);
  // Stream position + info of each video fragment; with no track id in the init, every readable fragment counts.
  const video = infos.map((f, i) => ({ n: i + 1, f })).filter(({ f }) => f.trackId !== null && (vid === null || f.trackId === vid));
  const otherTrackFragments = infos.filter((f) => f.trackId !== null && vid !== null && f.trackId !== vid).length;

  if (video.length < 2) problems.push(`only ${video.length} video fragment(s); expected at least 2 in ${seconds}s`);
  const notKey = video.find(({ f }) => f.firstSampleIsSync !== true);
  if (notKey) problems.push(`fragment #${notKey.n} doesn't start on a keyframe: HomeKit needs every fragment to`);
  if (video.some(({ f }) => f.hasCompositionOffsets)) problems.push("B-frames found (non-zero composition offsets): HomeKit recording needs a stream without them");
  const t0 = video[0]?.f.baseMediaDecodeTime;
  if (ts && video.length > 0 && (t0 === null || t0 === undefined || t0 > ts / 2)) {
    problems.push(`the first fragment's decode time is ${t0} ticks (${t0 === null || t0 === undefined ? "?" : (t0 / ts).toFixed(2)} s), not ~0: timestamps don't start at zero`);
  }
  for (let i = 1; i < video.length; i++) {
    if ((video[i].f.baseMediaDecodeTime ?? -1) <= (video[i - 1].f.baseMediaDecodeTime ?? -1)) { problems.push(`decode time went backwards at fragment #${video[i].n}`); break; }
  }
  let longestSeconds: number | null = null;
  if (ts && video.length >= 2) {
    longestSeconds = Math.max(...video.slice(1).map(({ f }, i) => ((f.baseMediaDecodeTime ?? 0) - (video[i].f.baseMediaDecodeTime ?? 0)) / ts));
  }
  return { problems, longestSeconds, timescale: ts, videoFragments: video.length, otherTrackFragments };
}

export async function runSelfTest(
  ffmpegPath: string,
  log: Logger,
  opts: { source?: string; seconds?: number; audio?: boolean } = {},
): Promise<boolean> {
  log.info(opts.source
    ? `=== unscrypted self-test: ${redactUrl(opts.source)} -> prebuffer pipeline -> fMP4 checks ===`
    : "=== unscrypted self-test: ffmpeg -> fMP4 -> parser ===");

  const ff = await resolveFfmpeg(ffmpegPath, log, true);
  if (!ff) {
    log.error(
      "SELF-TEST FAILED: ffmpeg is not available. Install ffmpeg or set config.ffmpegPath.",
    );
    return false;
  }

  const seconds = opts.source ? opts.seconds ?? 12 : 8;
  const lavfiArgs = [
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
    // No B-frames, like the cameras: libx264's main profile adds them by default, and HKSV wants none.
    "-bf",
    "0",
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
  let args = lavfiArgs;
  if (opts.source) {
    // Exactly the prebuffer's args (copy mode), with an output duration so the test ends.
    args = buildPrebufferArgs({ copyVideo: true, audio: opts.audio ?? false }, opts.source);
    args.splice(args.length - 1, 0, "-t", String(seconds));
  }

  let init: Buffer | null = null;
  let videoTrackId: number | undefined;
  const infos: FragmentInfo[] = [];
  let fragmentBytes = 0;
  let parseError: string | null = null;

  const parser = new FragmentedMp4Parser(
    (segment) => {
      init = segment;
      videoTrackId = videoTrack(segment)?.trackId;
      log.info(`  parsed init segment: ${segment.length} bytes (ftyp+moov), video track ${videoTrackId ?? "not found"}`);
    },
    (fragment) => {
      infos.push(inspectFragment(fragment, videoTrackId));
      fragmentBytes += fragment.length;
    },
  );

  const proc = spawnFfmpeg(ff, args, log, { label: "selftest" });
  proc.proc.stdout.on("data", (chunk: Buffer) => {
    try {
      parser.push(chunk);
    } catch (err) {
      parseError ??= (err as Error).message;
    }
  });
  const code = await proc.done;

  const initSeg = init as Buffer | null;
  log.info(
    `  ffmpeg exit ${code}; init=${initSeg?.length ?? 0} bytes; fragments=${infos.length} (${fragmentBytes} bytes total)`,
  );

  const { problems, longestSeconds, timescale, videoFragments, otherTrackFragments } = checkFragments(initSeg, infos, seconds);
  if (parseError) problems.unshift(`the fMP4 parser failed: ${parseError}`);
  const vids = infos.filter((f) => f.trackId !== null && (videoTrackId === undefined || f.trackId === videoTrackId));
  if (timescale && vids.length > 0) {
    const t0 = vids[0].baseMediaDecodeTime;
    log.info(`  first fragment decode time: ${t0 ?? "?"} ticks (${t0 === null ? "?" : (t0 / timescale).toFixed(3)} s at ${timescale} Hz)`);
  }
  log.info(`  keyframe-aligned video fragments: ${vids.filter((f) => f.firstSampleIsSync === true).length}/${videoFragments}; ` +
    `with composition offsets (B-frames): ${vids.filter((f) => f.hasCompositionOffsets).length}` +
    (otherTrackFragments ? `; audio-only fragments (not judged): ${otherTrackFragments}` : ""));
  if (longestSeconds !== null) {
    log.info(`  longest fragment: ${longestSeconds.toFixed(2)} s (HomeKit wants at most 4 s)`);
    if (longestSeconds > 4.0) {
      log.warn(`  fragments run up to ${longestSeconds.toFixed(2)} s, longer than HomeKit's 4 s: the camera's keyframe interval is long (a camera setting, not the restream). Recording may still work; shorten the I-frame interval if clips fail.`);
    }
  }

  const ok = code === 0 && problems.length === 0;
  if (ok) {
    log.info(`SELF-TEST PASSED: ${videoFragments} keyframe-aligned fragments, timestamps from zero, no B-frames, avcC present.`);
  } else {
    log.error(`SELF-TEST FAILED (ffmpeg exit ${code}):\n  - ${problems.join("\n  - ") || "ffmpeg exited non-zero; see its stderr above"}`);
  }
  return ok;
}
