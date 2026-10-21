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

/** ffmpeg socket I/O timeout (µs): a wedged go2rtc or camera ends the read instead of hanging it. */
const RTSP_TIMEOUT_US = "10000000";
const readsFrom = (f: FeedChoice) => (f.via === "go2rtc" ? "through go2rtc" : "the camera directly");

/**
 * Don't let ffmpeg analyse the input before it starts sending (#35). By default it reads about 20
 * frames to guess the frame rate (2 s at 10 fps), and on a stream joined mid-GOP it waits for the
 * next keyframe first. Then it sends all of that at once: a 2-4 s burst whose RTP timestamps run
 * ahead of real time for the rest of the session, with RTCP sender reports to match. Through
 * go2rtc's restream that put the first video 3-6 s after HomeKit asked. With no analysis the first
 * packet is the next keyframe, then steady real time. The camera's parameters come from the SDP,
 * which is all a copy needs.
 */
export const NO_PROBE_ARGS = ["-analyzeduration", "0", "-probesize", "32"];

/** The live view's input args for the chosen feed (go2rtc's restream or the camera, #16). */
export function buildLiveInputArgs(feed: FeedChoice): string[] {
  return ["-hide_banner", "-loglevel", "warning", "-rtsp_transport", "tcp", "-timeout", RTSP_TIMEOUT_US, ...NO_PROBE_ARGS, "-i", feed.url];
}

/**
 * The live view's video codec args. A copy repeats SPS/PPS before every keyframe (dump_extra, #35):
 * HomeKit gets no SDP, so a camera (or restream) that sends them only in its SDP would otherwise
 * give HomeKit a stream it can't decode. Repeating them when the camera already does is harmless.
 */
export function buildLiveVideoCodecArgs(copy: boolean, fps: number, maxBitRateK: number): string[] {
  if (copy) return ["-an", "-c:v", "copy", "-bsf:v", "dump_extra"];
  return ["-an", "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-pix_fmt", "yuv420p", "-r", String(fps), "-b:v", `${maxBitRateK}k`];
}

/** A one-frame JPEG snapshot of the chosen feed, scaled to fit width x height. */
export function buildSnapshotArgs(feed: FeedChoice, width: number, height: number): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-timeout", RTSP_TIMEOUT_US, ...NO_PROBE_ARGS, "-i", feed.url,
    "-frames:v", "1", "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease`, "-f", "mjpeg", "pipe:1",
  ];
}

/** A HomeKit snapshot is reused this long: the Home app asks about every 10 s per tile while open. */
const SNAPSHOT_CACHE_MS = 10_000;

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

export class StreamingDelegate implements CameraStreamingDelegate {
  // HAP sets this when the controller is configured; we use its snapshot
  // handling helpers indirectly. Assigned by the camera module.
  controller?: CameraController;

  private readonly pendingSessions = new Map<string, SessionInfo>();
  private readonly activeSessions = new Map<string, SpawnedFfmpeg[]>();

  private readonly snapCache = new Map<string, { at: number; buf: Buffer }>();
  private readonly snapInflight = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly camera: ResolvedCamera,
    private readonly ffmpegPath: string,
    private readonly log: Logger,
    /** Where to read the camera from at each spawn (go2rtc's restream or the camera, #16). */
    private readonly pick: FeedPicker = directPicker(camera),
    /** Told when a read fails, so a camera go2rtc keeps failing on can go direct (Q3). */
    private readonly onFailure?: FeedFailure,
  ) {}

  private reportFailure(feed: FeedChoice, why: string): void {
    try { this.onFailure?.(feed, why); }
    catch (err) { this.log.error(`couldn't report a failed read to the source selector: ${(err as Error).message}`); }
  }

  // ---- Snapshots -----------------------------------------------------------

  handleSnapshotRequest(
    request: SnapshotRequest,
    callback: SnapshotRequestCallback,
  ): void {
    void this.takeSnapshot(request)
      .then((buf) => callback(undefined, buf))
      .catch((err: Error) => {
        this.log.warn(`snapshot failed: ${err.message}`);
        callback(err);
      });
  }

  /**
   * Snapshots read the main stream through go2rtc (owner Q1 = a): on a recording camera go2rtc
   * already holds that connection, so a snapshot opens none. Cached 10 s per size, and requests
   * that arrive while one is being made share it. A failure isn't cached.
   */
  private async takeSnapshot(request: SnapshotRequest): Promise<Buffer> {
    const key = `${request.width}x${request.height}`;
    const hit = this.snapCache.get(key);
    if (hit && Date.now() - hit.at < SNAPSHOT_CACHE_MS) return hit.buf;
    const running = this.snapInflight.get(key);
    if (running) return running;
    const p = this.snapshotNow(request)
      .then((buf) => { this.snapCache.set(key, { at: Date.now(), buf }); return buf; })
      .finally(() => this.snapInflight.delete(key));
    this.snapInflight.set(key, p);
    return p;
  }

  private async snapshotNow(request: SnapshotRequest): Promise<Buffer> {
    const ff = await resolveFfmpeg(this.ffmpegPath, this.log);
    if (!ff) {
      throw new Error("ffmpeg unavailable; cannot produce snapshot");
    }
    const feed = this.pick("main");
    if (!feed) throw new Error("no main stream URL configured for this camera");
    return this.readSnapshot(ff, feed, request);
  }

  /** One snapshot read; a failure through go2rtc counts toward this camera's own fallback. */
  private async readSnapshot(ff: string, feed: FeedChoice, request: Pick<SnapshotRequest, "width" | "height">): Promise<Buffer> {
    try {
      return await this.runToBuffer(ff, buildSnapshotArgs(feed, request.width, request.height), "snapshot", 15000);
    } catch (err) {
      const why = `snapshot reading ${readsFrom(feed)} failed: ${(err as Error).message}`;
      this.reportFailure(feed, why);
      throw new Error(why);
    }
  }

  private runToBuffer(
    ffmpegPath: string,
    args: string[],
    label: string,
    timeoutMs: number,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const ff = spawnFfmpeg(ffmpegPath, args, this.log, { label });
      const chunks: Buffer[] = [];
      ff.proc.stdout.on("data", (c: Buffer) => chunks.push(c));
      const timer = setTimeout(() => {
        ff.kill();
        reject(new Error(`${label} timed out`));
      }, timeoutMs);
      void ff.done.then((code) => {
        clearTimeout(timer);
        if (chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`${label} produced no output (exit ${code})`));
        }
      });
    });
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
        // We don't dynamically reconfigure the running ffmpeg in this first cut.
        this.log.debug(`stream reconfigure requested (ignored): ${request.sessionID}`);
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
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
    const ff = await resolveFfmpeg(this.ffmpegPath, this.log);
    if (!ff) {
      callback(new Error("ffmpeg unavailable; cannot start live stream"));
      return;
    }

    const video = request.video;
    const audio = request.audio;

    const videoKeySalt = session.videoSRTP.toString("base64");
    const audioKeySalt = session.audioSRTP.toString("base64");

    const feed = this.pick("main");
    if (!feed) {
      callback(new Error("no main stream URL configured"));
      return;
    }
    const args: string[] = [...buildLiveInputArgs(feed)];

    // --- Video ---
    args.push(...buildLiveVideoCodecArgs(this.camera.copyVideo, video.fps, video.max_bit_rate));
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

    const proc = spawnFfmpeg(ff, args, this.log, {
      label: `live:${this.camera.name}:${request.sessionID.slice(0, 8)}`,
    });
    this.activeSessions.set(request.sessionID, [proc]);
    this.pendingSessions.delete(request.sessionID);

    // ffmpeg exiting unexpectedly should tear the session down, loudly.
    void proc.done.then((code) => {
      const sessions = this.activeSessions.get(request.sessionID);
      if (sessions && sessions.includes(proc) && code !== null && code !== 0) {
        // ffmpeg's -timeout exit prints nothing, so say what we know.
        const why = `live view ffmpeg exited with code ${code} while reading ${readsFrom(feed)} (no video for 10 s, or the stream couldn't be opened)`;
        this.log.warn(`${why}; stopping session`);
        this.reportFailure(feed, why);
        this.stopStream(request.sessionID);
      }
    });

    this.log.info(`live stream started for ${this.camera.name} (reading ${readsFrom(feed)})`);
    callback();
  }

  private stopStream(sessionID: string): void {
    const procs = this.activeSessions.get(sessionID);
    if (procs) {
      for (const p of procs) {
        p.kill();
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
