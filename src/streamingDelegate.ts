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
import {
  resolveFfmpeg,
  spawnFfmpeg,
  SpawnedFfmpeg,
  SRTP_SUITE,
  HOMEKIT_MTU,
  liveViewInputArgs,
} from "./ffmpeg";
import { ResolvedCamera } from "./config";
import { reserveUdpPort } from "./util";

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

  constructor(
    private readonly camera: ResolvedCamera,
    private readonly ffmpegPath: string,
    private readonly log: Logger,
  ) {}

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

  private async takeSnapshot(request: SnapshotRequest): Promise<Buffer> {
    const ff = await resolveFfmpeg(this.ffmpegPath, this.log);
    if (!ff) {
      throw new Error("ffmpeg unavailable; cannot produce snapshot");
    }
    // Prefer the sub stream for a cheap snapshot; fall back to main.
    const source = this.camera.rtspSub ?? this.camera.rtspMain;
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rtsp_transport",
      "tcp",
      "-i",
      source,
      "-frames:v",
      "1",
      "-vf",
      `scale=${request.width}:${request.height}:force_original_aspect_ratio=decrease`,
      "-f",
      "mjpeg",
      "pipe:1",
    ];
    return await this.runToBuffer(ff, args, "snapshot", 15000);
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

    const args: string[] = [
      "-hide_banner",
      "-loglevel",
      "warning",
      ...liveViewInputArgs(this.camera.rtspMain),
    ];

    // --- Video ---
    if (this.camera.copyVideo) {
      // dump_extra repeats SPS/PPS in-band before keyframes. HomeKit never sees the RTSP SDP, so a
      // source that carries them only there gives HomeKit an undecodable stream: it spins and ends
      // the session after ~30 s (#55; proven on the pattern camera 2026-10-21). Harmless when the
      // camera already sends them in-band.
      args.push("-an", "-c:v", "copy", "-bsf:v", "dump_extra");
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

    const proc = spawnFfmpeg(ff, args, this.log, {
      label: `live:${this.camera.name}:${request.sessionID.slice(0, 8)}`,
    });
    this.activeSessions.set(request.sessionID, [proc]);
    this.pendingSessions.delete(request.sessionID);

    // ffmpeg exiting unexpectedly should tear the session down, loudly.
    void proc.done.then((code) => {
      const sessions = this.activeSessions.get(request.sessionID);
      if (sessions && sessions.includes(proc) && code !== null && code !== 0) {
        this.log.warn(`live stream ffmpeg exited (code ${code}); stopping session`);
        this.stopStream(request.sessionID);
      }
    });

    this.log.info(`live stream started for ${this.camera.name}`);
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
