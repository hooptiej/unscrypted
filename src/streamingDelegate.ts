/**
 * CameraStreamingDelegate — live view + snapshots.
 *
 * Live view: HomeKit hands us, in prepareStream, its SRTP keys/salt and the
 * target address+ports. We let ffmpeg emit SRTP directly to that endpoint
 * (the simplest path — no app-level RTP handling), encrypting with HomeKit's
 * keys via `-srtp_out_suite`/`-srtp_out_params`.
 *
 * HomeKit codec constraints honoured here:
 *   - video: H.264 (copied from the Foscam if already H.264/Main<=4.0, else
 *     transcoded to Main), MTU 1200
 *   - audio: Opus, transcoded from the camera's G.711
 */

import * as dgram from "dgram";
import {
  CameraStreamingDelegate,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  StreamingRequest,
  StreamRequestCallback,
  StreamRequestTypes,
  CameraController,
  AudioStreamingCodecType,
} from "hap-nodejs";
import { Logger } from "./logger";
import { resolveFfmpeg, spawnFfmpeg, SpawnedFfmpeg, SRTP_SUITE, HOMEKIT_MTU } from "./ffmpeg";
import { ResolvedCamera } from "./config";
import { reserveUdpPort } from "./util";
import { directPicker, FeedChoice, FeedFailure, FeedPicker } from "./source";

/** ffmpeg socket I/O timeout (�s): a wedged go2rtc or camera ends the read instead of hanging it. */
const RTSP_TIMEOUT_US = "10000000";
/**
 * Input flags that start on the first decodable frame instead of probing for seconds (#33).
 * Measured on a Boavision 1080p/15fps camera from the NAS: ffmpeg's default probing cost ~2.7 s
 * on every live start (3.6 s vs 0.9 s to the first frame, direct). RTSP's SDP already carries
 * the H.264 parameter sets, so there is nothing to probe for.
 */
export const LOW_LATENCY_INPUT = ["-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0"];
const readsFrom = (f: FeedChoice) => (f.via === "go2rtc" ? "through go2rtc" : "the camera directly");

/**
 * How ffmpeg looks at the input before it starts (#78). "fast" is LOW_LATENCY_INPUT: right for the
 * Boavisions (~1.1 s to the first frame). A Foscam FI9803P sends audio first and its keyframe late,
 * so with "fast" ffmpeg gives up before it ever sees video ("Output file #0 does not contain any
 * stream", exit 1 in ~0.7 s) on every snapshot and live view. "full" is ffmpeg's default probing
 * (a frame in ~6 s on that camera). A camera starts "fast" and is switched to "full" the first time
 * it misses; nothing to configure.
 */
export type ProbeMode = "fast" | "full";
const probeArgs = (probe: ProbeMode): string[] => (probe === "fast" ? LOW_LATENCY_INPUT : []);
/** ffmpeg's one line for "I stopped probing before I saw a video stream". */
export const PROBE_MISS = /does not contain any stream/i;
/** True when a failed ffmpeg run was the fast probe missing the video stream, not the camera or go2rtc failing. */
export const isProbeMiss = (code: number | null, stderr: string): boolean => code !== 0 && PROBE_MISS.test(stderr || "");

/** The live view's input args for the chosen feed (go2rtc's restream or the camera, #16). */
export function buildLiveInputArgs(feed: FeedChoice, probe: ProbeMode = "fast"): string[] {
  return ["-hide_banner", "-loglevel", "warning", "-rtsp_transport", "tcp", ...probeArgs(probe), "-timeout", RTSP_TIMEOUT_US, "-i", feed.url];
}

/** A one-frame JPEG snapshot of the chosen feed, scaled to fit width x height. */
export function buildSnapshotArgs(feed: FeedChoice, width: number, height: number, probe: ProbeMode = "fast"): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", ...probeArgs(probe), "-timeout", RTSP_TIMEOUT_US, "-i", feed.url,
    "-frames:v", "1", "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease`, "-f", "mjpeg", "pipe:1",
  ];
}

interface SessionInfo {
  address: string;
  ipv6: boolean;

  videoPort: number;
  videoReturnPort: number;
  videoReturnSocket: dgram.Socket;
  videoSSRC: number;
  videoSRTP: Buffer; // key + salt

  audioPort: number;
  audioReturnPort: number;
  audioReturnSocket: dgram.Socket;
  audioSSRC: number;
  audioSRTP: Buffer; // key + salt
}

type LiveVideo = { width: number; height: number; fps: number; max_bit_rate: number; pt: number };
type LiveAudio = {
  channel: number;
  sample_rate: number;
  max_bit_rate: number;
  pt: number;
  codec: AudioStreamingCodecType;
};

interface ActiveSession {
  procs: SpawnedFfmpeg[];
  info: SessionInfo;
  video: LiveVideo;
  audio: LiveAudio;
  watchdog?: NodeJS.Timeout;
}

const SNAPSHOT_TIMEOUT_MS = 15_000;
const PLACEHOLDER_TIMEOUT_MS = 8_000;
// Bundled with the image via fonts-dejavu-core (Debian bookworm-slim). Override
// for other hosts (e.g. running the --test-snapshot CLI outside the container).
const FONT_FILE =
  process.env.UNSCRYPTED_FONT_FILE || "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

/** Map a snapshot/ffmpeg failure to a short, human reason shown on the tile (#64). */
export function snapshotFailureReason(message: string): string {
  const m = (message || "").toLowerCase();
  if (m.includes("no route to host")) return "camera unreachable";
  if (m.includes("connection refused")) return "camera starting up";
  if (m.includes("timed out") || m.includes("timeout")) return "camera not responding";
  if (m.includes("401") || m.includes("unauthorized")) return "camera auth failed";
  if (m.includes("no output") || m.includes("exit 1")) return "no video from camera";
  if (m.includes("ffmpeg unavailable")) return "snapshot tool missing";
  return "camera error";
}

/** A failed ffmpeg run, with what it said, so the caller can tell a probe miss from a real failure (#78). */
export class FfmpegRunError extends Error {
  constructor(message: string, readonly code: number | null, readonly stderr: string) { super(message); }
  get probeMiss(): boolean { return isProbeMiss(this.code, this.stderr); }
}

/** Run ffmpeg and collect its stdout into a single Buffer. */
function runFfmpegToBuffer(
  ffmpegPath: string,
  args: string[],
  log: Logger,
  label: string,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const ff = spawnFfmpeg(ffmpegPath, args, log, { label });
    const chunks: Buffer[] = [];
    ff.proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    const timer = setTimeout(() => {
      ff.kill();
      reject(new FfmpegRunError(`${label} timed out`, null, ff.stderrTail()));
    }, timeoutMs);
    void ff.done.then((code) => {
      clearTimeout(timer);
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new FfmpegRunError(`${label} produced no output (exit ${code})`, code, ff.stderrTail()));
      }
    });
  });
}

/**
 * Grab a single JPEG frame from an RTSP source, scaled to fit width x height. Starts with the
 * given probe mode; when the fast probe misses the video stream (#78) it says so, calls
 * `onProbeMiss` (so the camera remembers), and tries once more with full probing.
 */
export async function captureSnapshotJpeg(
  ffmpegPath: string,
  source: string | FeedChoice,
  width: number,
  height: number,
  log: Logger,
  probe: ProbeMode = "fast",
  onProbeMiss?: () => void,
): Promise<Buffer> {
  const feed: FeedChoice = typeof source === "string" ? { url: source, via: "camera" } : source;
  try {
    return await runFfmpegToBuffer(ffmpegPath, buildSnapshotArgs(feed, width, height, probe), log, "snapshot", SNAPSHOT_TIMEOUT_MS);
  } catch (err) {
    if (probe !== "fast" || !(err instanceof FfmpegRunError) || !err.probeMiss) throw err;
    log.info(`snapshot ${readsFrom(feed)}: the fast probe found no video stream (the camera sends its video late); retrying with full probing`);
    onProbeMiss?.();
    return runFfmpegToBuffer(ffmpegPath, buildSnapshotArgs(feed, width, height, "full"), log, "snapshot", SNAPSHOT_TIMEOUT_MS);
  }
}

// drawtext metacharacters that must be escaped inside a single text='...' value.
function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/,/g, "\\,");
}

/**
 * Render a captioned "camera unavailable" JPEG — no camera source needed. A dark
 * card with the camera name and a plain-language reason + time, so a dead/flaky
 * source shows WHAT and WHY on the Home tile instead of a mute spinner (#64).
 */
export function renderPlaceholderJpeg(
  ffmpegPath: string,
  width: number,
  height: number,
  title: string,
  reason: string,
  log: Logger,
): Promise<Buffer> {
  const w = Math.max(width || 0, 160);
  const h = Math.max(height || 0, 90);
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const fs1 = Math.max(14, Math.round(h / 9));
  const fs2 = Math.max(11, Math.round(h / 15));
  const line1 = escapeDrawtext(title || "Camera");
  const line2 = escapeDrawtext(`${reason} - ${time}`);
  const font = `fontfile=${FONT_FILE}:`;
  const vf = [
    `drawtext=${font}text='${line1}':fontcolor=white:fontsize=${fs1}:x=(w-text_w)/2:y=(h-text_h)/2-${fs1}`,
    `drawtext=${font}text='${line2}':fontcolor=0x9aa0a6:fontsize=${fs2}:x=(w-text_w)/2:y=(h/2)+4`,
  ].join(",");
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x111317:s=${w}x${h}`,
    "-frames:v",
    "1",
    "-vf",
    vf,
    "-f",
    "mjpeg",
    "pipe:1",
  ];
  return runFfmpegToBuffer(ffmpegPath, args, log, "placeholder", PLACEHOLDER_TIMEOUT_MS);
}

export class StreamingDelegate implements CameraStreamingDelegate {
  // HAP sets this when the controller is configured; we use its snapshot
  // handling helpers indirectly. Assigned by the camera module.
  controller?: CameraController;

  private readonly pendingSessions = new Map<string, SessionInfo>();
  // Active live sessions: ffmpeg proc(s), the SessionInfo (reused to re-spawn
  // ffmpeg on RECONFIGURE to the same endpoint), the last video/audio params,
  // and an RTCP-silence watchdog that releases a stale session cleanly (#40/#695).
  private readonly activeSessions = new Map<string, ActiveSession>();

  constructor(
    private readonly camera: ResolvedCamera,
    private readonly ffmpegPath: string,
    private readonly log: Logger,
    /** Where to read the camera from at each spawn (go2rtc's restream or the camera, #16). */
    private readonly pick: FeedPicker = directPicker(camera),
    /** Told when a read through go2rtc fails, so a camera go2rtc keeps failing on can go direct. */
    private readonly onFailure?: FeedFailure,
  ) {}

  private reportFailure(feed: FeedChoice, why: string): void {
    try { this.onFailure?.(feed, why); }
    catch (err) { this.log.error(`couldn't report a failed read to the source selector: ${(err as Error).message}`); }
  }

  /** How this camera's reads probe the input (#78): fast until the first miss, full from then on. */
  probe: ProbeMode = "fast";

  /** Remember that this camera needs full probing, and say so once. */
  private useFullProbe(where: string): void {
    if (this.probe === "full") return;
    this.probe = "full";
    this.log.warn(`"${this.camera.name}": ffmpeg's fast probe found no video stream on a ${where} (this camera sends its video late, like the Foscam FI9803P). ` +
      "Live view and snapshots for it use full probing from now on: a few seconds slower to the first frame, but they work. Other cameras are unaffected. (#78)");
  }

  // ---- Snapshots -----------------------------------------------------------

  handleSnapshotRequest(
    request: SnapshotRequest,
    callback: SnapshotRequestCallback,
  ): void {
    void this.snapshotWithFallback(request)
      .then((buf) => callback(undefined, buf))
      .catch((err: Error) => {
        this.log.warn(`snapshot failed: ${err.message}`);
        callback(err);
      });
  }

  // Real snapshot first; if the source can't be reached or decoded, return a
  // captioned "camera unavailable" placeholder so the Home tile says WHAT and WHY
  // instead of a mute spinner or a stale frame (#64). Only if the placeholder
  // itself can't be rendered do we surface the original error — never worse than
  // the pre-#64 behaviour.
  private async snapshotWithFallback(request: SnapshotRequest): Promise<Buffer> {
    const ff = await resolveFfmpeg(this.ffmpegPath, this.log);
    if (!ff) {
      throw new Error("ffmpeg unavailable; cannot produce snapshot");
    }
    // The cheapest still: a stream go2rtc already holds, else the sub stream (never main while a
    // sub exists, #55), or the camera itself while go2rtc is down.
    const feed = this.pick("snapshot");
    if (!feed) throw new Error("no stream URL configured for this camera");
    try {
      return await captureSnapshotJpeg(ff, feed, request.width, request.height, this.log, this.probe, () => this.useFullProbe("snapshot"));
    } catch (err) {
      const reason = snapshotFailureReason((err as Error).message);
      this.log.warn(
        `snapshot ${readsFrom(feed)} failed (${reason}): ${(err as Error).message}; serving placeholder`,
      );
      // A probe miss is ffmpeg giving up early, not the feed failing: it never counts toward sending the camera direct (#78).
      if (!(err instanceof FfmpegRunError && err.probeMiss)) this.reportFailure(feed, `snapshot: ${(err as Error).message}`);
      try {
        return await renderPlaceholderJpeg(
          ff,
          request.width,
          request.height,
          this.camera.name,
          reason,
          this.log,
        );
      } catch (e2) {
        this.log.warn(`placeholder render failed: ${(e2 as Error).message}`);
        throw err; // never worse than the pre-#64 behaviour
      }
    }
  }

  // ---- Live streaming ------------------------------------------------------

  async prepareStream(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback,
  ): Promise<void> {
    try {
      const ipv6 = request.addressVersion === "ipv6";
      const videoReturn = await reserveUdpPort(ipv6 ? "udp6" : "udp4");
      const audioReturn = await reserveUdpPort(ipv6 ? "udp6" : "udp4");

      const videoSSRC = CameraController.generateSynchronisationSource();
      const audioSSRC = CameraController.generateSynchronisationSource();

      const sessionInfo: SessionInfo = {
        address: request.targetAddress,
        ipv6,
        videoPort: request.video.port,
        videoReturnPort: videoReturn.port,
        videoReturnSocket: videoReturn.socket,
        videoSSRC,
        videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
        audioPort: request.audio.port,
        audioReturnPort: audioReturn.port,
        audioReturnSocket: audioReturn.socket,
        audioSSRC,
        audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      };
      this.pendingSessions.set(request.sessionID, sessionInfo);

      const response: PrepareStreamResponse = {
        video: {
          port: videoReturn.port,
          ssrc: videoSSRC,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
        audio: {
          port: audioReturn.port,
          ssrc: audioSSRC,
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        },
      };
      callback(undefined, response);
    } catch (err) {
      this.log.error(`prepareStream failed: ${(err as Error).message}`);
      callback(err as Error);
    }
  }

  handleStreamRequest(
    request: StreamingRequest,
    callback: StreamRequestCallback,
  ): void {
    switch (request.type) {
      case StreamRequestTypes.START:
        void this.startStream(request, callback);
        break;
      case StreamRequestTypes.RECONFIGURE:
        void this.reconfigureStream(request, callback);
        break;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  /** Build the live-view ffmpeg command for a session + encode params (shared by START/RECONFIGURE). */
  private buildLiveArgs(
    feed: FeedChoice,
    session: SessionInfo,
    video: LiveVideo,
    audio: LiveAudio,
    probe: ProbeMode = this.probe,
  ): string[] {
    const videoKeySalt = session.videoSRTP.toString("base64");
    const audioKeySalt = session.audioSRTP.toString("base64");

    const args: string[] = buildLiveInputArgs(feed, probe);

    // --- Video ---
    if (this.camera.liveTranscode) {
      // HomeKit-correct live transcode (#63). Reshape the stream the hub has to
      // relay: `-tune zerolatency` (which disables B-frames), a short keyframe
      // interval, and scale/bitrate to what the controller actually asked for in
      // SETUP. `-c:v copy` can't do any of this, which is why passthrough (main
      // OR sub) spins on the hub. The recording/prebuffer path is unaffected —
      // this branch only touches the live view.
      const w = video.width;
      const h = video.height;
      const kbps = video.max_bit_rate;
      args.push(
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-r",
        String(video.fps),
        "-vf",
        `scale='min(${w},iw)':'min(${h},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
        "-b:v",
        `${kbps}k`,
        "-maxrate",
        `${kbps}k`,
        "-bufsize",
        `${kbps * 2}k`,
        "-g",
        String(video.fps * 2),
        "-force_key_frames",
        "expr:gte(t,n_forced*1)",
        "-bf",
        "0",
      );
    } else if (this.camera.copyVideo) {
      args.push("-an", "-c:v", "copy");
    } else {
      args.push(
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-profile:v",
        "main",
        "-pix_fmt",
        "yuv420p",
        "-r",
        String(video.fps),
        "-b:v",
        `${video.max_bit_rate}k`,
      );
    }
    args.push(
      "-payload_type",
      String(video.pt),
      "-ssrc",
      String(session.videoSSRC),
      "-f",
      "rtp",
      "-srtp_out_suite",
      SRTP_SUITE,
      "-srtp_out_params",
      videoKeySalt,
      `srtp://${session.address}:${session.videoPort}?rtcpport=${session.videoPort}&pkt_size=${HOMEKIT_MTU}`,
    );

    // --- Audio (transcode -> Opus), ONLY if the camera has an audio track.
    // A video-only camera has no audio stream to map; emitting an audio output
    // makes ffmpeg fail ("Output file does not contain any stream") and that
    // kills the whole live view. HomeKit tolerates a video-only stream. ---
    if (this.camera.audio) {
      args.push(
        "-vn",
        "-c:a",
        "libopus",
        "-application",
        "lowdelay",
        "-ac",
        String(audio.channel || 1),
        "-ar",
        `${audio.sample_rate}k`,
        "-b:a",
        `${audio.max_bit_rate}k`,
        "-payload_type",
        String(audio.pt),
        "-ssrc",
        String(session.audioSSRC),
        "-f",
        "rtp",
        "-srtp_out_suite",
        SRTP_SUITE,
        "-srtp_out_params",
        audioKeySalt,
        `srtp://${session.address}:${session.audioPort}?rtcpport=${session.audioPort}&pkt_size=188`,
      );
    }

    if (audio.codec !== AudioStreamingCodecType.OPUS) {
      this.log.debug(
        `controller requested audio codec ${audio.codec}; we always transcode to Opus`,
      );
    }

    return args;
  }

  private async startStream(
    request: Extract<StreamingRequest, { type: StreamRequestTypes.START }>,
    callback: StreamRequestCallback,
  ): Promise<void> {
    const session = this.pendingSessions.get(request.sessionID);
    if (!session) {
      callback(new Error("no pending session for stream start"));
      return;
    }
    const proc = await this.spawnLive(
      request.sessionID,
      session,
      request.video,
      request.audio,
    );
    if (!proc) {
      callback(new Error("ffmpeg unavailable; cannot start live stream"));
      return;
    }
    this.pendingSessions.delete(request.sessionID);

    // --- Keep-alive (#40/#695): service HomeKit's RTCP return sockets. ---
    // HomeKit sends RTCP receiver reports to the return ports we advertised in
    // prepareStream. If we orphan them, iOS tears the stream down (~30s) while
    // macOS tolerates it. Drain every packet, and reset a watchdog on each one:
    // when RTCP goes silent (viewer gone / stalled), release the session CLEANLY
    // so HAP frees it and the next open isn't blocked (#695). Instrumented: log
    // the first RTCP (return-path proof) and any watchdog fire.
    const rtcpTimeoutMs = Math.max(
      30000,
      Math.min((request.video.rtcp_interval || 0) * 5 * 1000, 300000),
    );
    let rtcpSeen = 0;
    const bump = (which: string): void => {
      rtcpSeen++;
      if (rtcpSeen === 1) {
        this.log.info(
          `live view: first RTCP (${which}) from controller for ${this.camera.name} — return path OK`,
        );
      }
      this.armWatchdog(request.sessionID, rtcpTimeoutMs);
    };
    session.videoReturnSocket.on("message", () => bump("video"));
    session.audioReturnSocket.on("message", () => bump("audio"));
    this.armWatchdog(request.sessionID, rtcpTimeoutMs);

    this.log.info(`live stream started for ${this.camera.name}`);
    callback();
  }

  /** Re-spawn ffmpeg for an existing session with new encode params (RECONFIGURE). */
  private async reconfigureStream(
    request: Extract<StreamingRequest, { type: StreamRequestTypes.RECONFIGURE }>,
    callback: StreamRequestCallback,
  ): Promise<void> {
    const active = this.activeSessions.get(request.sessionID);
    if (!active) {
      this.log.info(
        `stream reconfigure for ${this.camera.name} but no active session; ignoring`,
      );
      callback();
      return;
    }
    this.log.info(
      `stream reconfigure for ${this.camera.name}: ${request.video.width}x${request.video.height}@${request.video.fps} ${request.video.max_bit_rate}k — re-spawning ffmpeg`,
    );
    const oldProcs = active.procs;
    const newVideo: LiveVideo = {
      width: request.video.width,
      height: request.video.height,
      fps: request.video.fps,
      max_bit_rate: request.video.max_bit_rate,
      pt: active.video.pt,
    };
    const proc = await this.spawnLive(
      request.sessionID,
      active.info,
      newVideo,
      active.audio,
    );
    if (!proc) {
      this.log.warn(`reconfigure re-spawn failed for ${this.camera.name}; stopping`);
      this.stopStream(request.sessionID);
      callback(new Error("reconfigure re-spawn failed"));
      return;
    }
    // New ffmpeg is up and recorded as the active proc; retire the old one. Its
    // exit handler sees it's no longer current and won't tear the session down.
    for (const p of oldProcs) {
      p.kill();
    }
    callback();
  }

  /** Build + spawn the live ffmpeg for a session and (re)store the active record. */
  private async spawnLive(
    sessionID: string,
    session: SessionInfo,
    video: LiveVideo,
    audio: LiveAudio,
  ): Promise<SpawnedFfmpeg | undefined> {
    const ff = await resolveFfmpeg(this.ffmpegPath, this.log);
    if (!ff) {
      return undefined;
    }
    const feed = this.pick("live");
    if (!feed) {
      this.log.error("live view can't start: this camera has no main stream URL");
      return undefined;
    }
    const probe = this.probe;
    const args = this.buildLiveArgs(feed, session, video, audio, probe);
    this.log.info(`live view reading ${readsFrom(feed)}${probe === "full" ? " (full probing)" : ""}`);
    const proc = spawnFfmpeg(ff, args, this.log, {
      label: `live:${this.camera.name}:${sessionID.slice(0, 8)}`,
    });
    const prev = this.activeSessions.get(sessionID);
    this.activeSessions.set(sessionID, {
      procs: [proc],
      info: session,
      video,
      audio,
      watchdog: prev?.watchdog,
    });

    // ffmpeg exiting unexpectedly (non-zero) tears the session down, loudly. One exception (#78): the
    // fast probe missing the video stream is retried once with full probing, same session, same endpoint.
    void proc.done.then(async (code) => {
      const cur = this.activeSessions.get(sessionID);
      if (!(cur && cur.procs.includes(proc) && code !== null && code !== 0)) return;
      if (probe === "fast" && isProbeMiss(code, proc.stderrTail())) {
        this.useFullProbe("live view");
        const again = await this.spawnLive(sessionID, session, cur.video, cur.audio);
        if (again) return;
        this.log.warn(`live stream couldn't be restarted with full probing for ${this.camera.name}; stopping session`);
        this.stopStream(sessionID);
        return;
      }
      this.log.warn(`live stream ffmpeg exited (code ${code}) while reading ${readsFrom(feed)}; stopping session`);
      this.reportFailure(feed, `live view ffmpeg exited with code ${code}`);
      this.stopStream(sessionID);
    });
    return proc;
  }

  /** (Re)arm the RTCP-silence watchdog: clean release if the controller goes quiet. */
  private armWatchdog(sessionID: string, timeoutMs: number): void {
    const active = this.activeSessions.get(sessionID);
    if (!active) {
      return;
    }
    if (active.watchdog) {
      clearTimeout(active.watchdog);
    }
    active.watchdog = setTimeout(() => {
      this.log.info(
        `live view: no RTCP for ${Math.round(timeoutMs / 1000)}s on ${this.camera.name}; releasing session`,
      );
      this.stopStream(sessionID);
    }, timeoutMs);
  }

  private stopStream(sessionID: string): void {
    const active = this.activeSessions.get(sessionID);
    if (active) {
      if (active.watchdog) {
        clearTimeout(active.watchdog);
      }
      for (const p of active.procs) {
        p.kill();
      }
      // Close the session's RTCP return sockets (fixes the orphan/leak, #40).
      try {
        active.info.videoReturnSocket.close();
        active.info.audioReturnSocket.close();
      } catch {
        /* ignore */
      }
      this.activeSessions.delete(sessionID);
      this.log.info(`live stream stopped for ${this.camera.name}`);
    }
    const pending = this.pendingSessions.get(sessionID);
    if (pending) {
      try {
        pending.videoReturnSocket.close();
        pending.audioReturnSocket.close();
      } catch {
        /* ignore */
      }
      this.pendingSessions.delete(sessionID);
    }
  }

  /** How many Home app live views are open right now (admin pane status). */
  liveSessionCount(): number {
    return this.activeSessions.size;
  }

  /** Tear everything down (process shutdown). */
  shutdown(): void {
    for (const id of [...this.activeSessions.keys()]) {
      this.stopStream(id);
    }
    for (const id of [...this.pendingSessions.keys()]) {
      this.stopStream(id);
    }
  }
}
