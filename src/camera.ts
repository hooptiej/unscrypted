/**
 * Per-camera orchestration: builds the HAP Accessory + CameraController, wires
 * the streaming & recording delegates, the prebuffer, and the Foscam motion
 * poller. Config-driven so every Foscam (or any RTSP camera) is just another
 * entry in config.cameras.
 */

import {
  Accessory,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  CameraControllerOptions,
  Categories,
  Characteristic,
  H264Level,
  H264Profile,
  MediaContainerType,
  Service,
  SRTPCryptoSuites,
  uuid,
  VideoCodecType,
} from "hap-nodejs";
import { Logger } from "./logger";
import { ResolvedCamera } from "./config";
import { StreamingDelegate } from "./streamingDelegate";
import { RecordingDelegate } from "./recordingDelegate";
import { Prebuffer, PrebufferStatus } from "./prebuffer";
import { directPicker, FeedFailure, FeedPicker, FeedVia, SourceSelector } from "./source";
import { FoscamClient, MotionPoller } from "./foscam";
import { OnvifClient, OnvifMotionSource } from "./onvif";
import { redactUrl } from "./util";

/** A pluggable motion source: anything with a start/stop lifecycle. */
interface MotionSource {
  start(): void;
  stop(): void;
}

// Resolutions advertised for live view. [width, height, fps].
const STREAMING_RESOLUTIONS: [number, number, number][] = [
  [1280, 720, 15],
  [1280, 720, 30],
  [1024, 768, 30],
  [640, 480, 30],
  [640, 360, 30],
  [480, 360, 30],
  [480, 270, 30],
  [320, 240, 30],
  [320, 240, 15],
  [320, 180, 30],
];

// Recording requires at least 1920x1080 and 1280x720 to be offered.
const RECORDING_RESOLUTIONS: [number, number, number][] = [
  [1920, 1080, 30],
  [1280, 720, 30],
  [1280, 720, 15],
  [640, 480, 30],
  [320, 240, 15],
];

export class UnscryptedCamera {
  readonly accessory: Accessory;
  private readonly streamingDelegate: StreamingDelegate;
  private readonly recordingDelegate?: RecordingDelegate;
  private readonly prebuffer?: Prebuffer;
  private motionSource?: MotionSource;
  private controller!: CameraController;
  private readonly log: Logger;
  private started = false;
  private motionActive = false;
  private lastMotionAt: number | null = null;
  /** Where this camera's HomeKit pipelines read from at each spawn (#16). */
  private readonly pick: FeedPicker;
  private readonly onFeedFailure?: FeedFailure;
  private readonly offSource?: () => void;
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly camera: ResolvedCamera,
    private readonly ffmpegPath: string,
    parentLog: Logger,
    sources?: SourceSelector,
  ) {
    const log = parentLog.child(camera.name);
    this.log = log;
    // The picker closes over this same camera object, which reconfigure() mutates, so URL edits
    // apply on the next spawn.
    this.pick = sources ? sources.picker(camera) : directPicker(camera);
    this.onFeedFailure = sources?.failureReporter(camera);

    this.accessory = new Accessory(
      camera.name,
      uuid.generate(`unscrypted:camera:${camera.name}`),
    );

    const info = this.accessory.getService(Service.AccessoryInformation)!;
    info
      .setCharacteristic(Characteristic.Manufacturer, camera.manufacturer)
      .setCharacteristic(Characteristic.Model, camera.model)
      .setCharacteristic(Characteristic.SerialNumber, camera.serialNumber)
      .setCharacteristic(Characteristic.FirmwareRevision, "0.1.0");

    this.streamingDelegate = new StreamingDelegate(camera, ffmpegPath, log.child("stream"), this.pick, this.onFeedFailure);

    const controllerOptions: CameraControllerOptions = {
      cameraStreamCount: camera.hksv ? 1 : 2,
      delegate: this.streamingDelegate,
      streamingOptions: {
        supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          codec: {
            profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
            levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
          },
          resolutions: STREAMING_RESOLUTIONS,
        },
        audio: {
          twoWayAudio: false,
          codecs: [
            {
              type: AudioStreamingCodecType.OPUS,
              samplerate: [
                AudioStreamingSamplerate.KHZ_16,
                AudioStreamingSamplerate.KHZ_24,
              ],
            },
          ],
        },
      },
    };

    if (camera.hksv) {
      this.prebuffer = new Prebuffer(camera, ffmpegPath, log.child("prebuffer"), this.pick, this.onFeedFailure);
      this.recordingDelegate = new RecordingDelegate(
        camera,
        this.prebuffer,
        log.child("record"),
      );
      controllerOptions.recording = {
        options: {
          prebufferLength: camera.prebufferSeconds * 1000,
          mediaContainerConfiguration: [
            { type: MediaContainerType.FRAGMENTED_MP4, fragmentLength: 4000 },
          ],
          video: {
            type: VideoCodecType.H264,
            parameters: {
              profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
              levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
            },
            resolutions: RECORDING_RESOLUTIONS,
          },
          audio: {
            codecs: [
              {
                type: AudioRecordingCodecType.AAC_LC,
                samplerate: [
                  AudioRecordingSamplerate.KHZ_32,
                  AudioRecordingSamplerate.KHZ_24,
                  AudioRecordingSamplerate.KHZ_16,
                ],
                audioChannels: 1,
              },
            ],
          },
        },
        delegate: this.recordingDelegate,
      };
      // A motion sensor managed by the controller doubles as the HKSV motion
      // trigger.
      controllerOptions.sensors = { motion: true };
    } else {
      // Non-HKSV camera: still expose a standalone motion sensor if we have a
      // motion source to drive it.
      const hasMotionSource = Boolean(camera.foscam || camera.onvif);
      controllerOptions.sensors = hasMotionSource ? { motion: true } : undefined;
    }

    this.controller = new CameraController(controllerOptions);
    this.streamingDelegate.controller = this.controller;
    if (this.recordingDelegate) {
      this.recordingDelegate.controller = this.controller;
    }

    this.accessory.configureController(this.controller);

    const motionKind = camera.foscam ? "foscam-cgi" : camera.onvif ? "onvif" : "none";
    log.info(
      `camera "${camera.name}" configured ` +
        `(main=${redactUrl(camera.rtspMain)}, HKSV=${camera.hksv}, motion=${motionKind})`,
    );

    this.motionSource = this.buildMotionSource();
    this.offSource = sources?.onChange(() => this.syncPrebufferSource());
  }

  /**
   * The source mode changed (go2rtc <-> direct, globally or for this camera): re-point a running
   * recording buffer. A clip being recorded finishes first; the switch follows within 2 s.
   */
  private syncPrebufferSource(): void {
    const pb = this.prebuffer;
    if (!pb?.isRunning()) return;
    const want = this.pick("main")?.via;
    if (!want || want === pb.currentVia()) return;
    const where = want === "go2rtc" ? "through go2rtc" : "the camera directly";
    if ((this.recordingDelegate?.activeClips() ?? 0) > 0) {
      if (!this.syncTimer) {
        this.log.info(`recording buffer will switch to reading ${where} as soon as the clip being recorded ends`);
        this.syncTimer = setInterval(() => {
          if ((this.recordingDelegate?.activeClips() ?? 0) === 0) {
            clearInterval(this.syncTimer!);
            this.syncTimer = null;
            this.syncPrebufferSource();
          }
        }, 2000);
      }
      return;
    }
    this.log.info(`recording buffer switching to reading ${where} (the next few seconds of pre-roll are lost)`);
    pb.restart();
  }

  /** Test instance only (HomeKit off): run the recording buffer without HomeKit asking, to check the restream. */
  startPrebufferForTest(): boolean {
    if (!this.prebuffer) return false;
    void this.prebuffer.start();
    return true;
  }

  /** Wire the selected motion source (from the current camera config) to the MotionSensor. */
  private buildMotionSource(): MotionSource | undefined {
    const camera = this.camera;
    const log = this.log;
    if (camera.foscam) {
      const client = new FoscamClient(
        {
          cgiBase: camera.foscam.cgiBase,
          username: camera.foscam.username,
          password: camera.foscam.password,
        },
        log.child("foscam"),
      );
      return new MotionPoller(
        client,
        {
          pollIntervalMs: camera.foscam.pollIntervalMs ?? 1000,
          cooldownMs: camera.foscam.motionCooldownMs ?? 60000,
        },
        (active) => this.setMotion(active),
        log.child("motion"),
      );
    } else if (camera.onvif) {
      const client = new OnvifClient(
        {
          host: camera.onvif.host,
          port: camera.onvif.port,
          username: camera.onvif.username,
          password: camera.onvif.password,
        },
        log.child("onvif"),
      );
      return new OnvifMotionSource(
        client,
        camera.onvif.host,
        camera.onvif.port,
        camera.name,
        {
          cooldownMs: camera.onvif.motionCooldownMs,
          pullTimeoutMs: camera.onvif.pollIntervalMs,
          notifyPort: camera.onvif.notifyPort,
          notifyHost: camera.onvif.notifyHost,
        },
        (active) => this.setMotion(active),
        log.child("motion"),
      );
    }
    return undefined;
  }

  private setMotion(active: boolean): void {
    this.motionActive = active;
    if (active) {
      this.lastMotionAt = Date.now();
    }
    const svc = this.controller.motionService;
    if (svc) {
      svc.updateCharacteristic(Characteristic.MotionDetected, active);
    }
  }

  get name(): string {
    return this.camera.name;
  }

  get resolved(): ResolvedCamera {
    return this.camera;
  }

  snapshotStatus(): {
    hksv: boolean;
    motionKind: "foscam-cgi" | "onvif" | "none";
    liveSessions: number;
    recordingActive: boolean;
    motionActive: boolean;
    lastMotionAt: number | null;
    prebuffer: PrebufferStatus | null;
    via: FeedVia | null;
  } {
    return {
      hksv: this.camera.hksv,
      motionKind: this.camera.foscam ? "foscam-cgi" : this.camera.onvif ? "onvif" : "none",
      liveSessions: this.streamingDelegate.liveSessionCount(),
      recordingActive: this.recordingDelegate?.isRecordingActive() ?? false,
      motionActive: this.motionActive,
      lastMotionAt: this.lastMotionAt,
      prebuffer: this.prebuffer?.status() ?? null,
      via: this.pick("main")?.via ?? null,
    };
  }

  /**
   * Apply a "live" change (URLs, logins, motion timings) without touching what HomeKit sees.
   * The delegates and prebuffer hold this same camera object, so new values apply on their next
   * ffmpeg spawn (open live views keep their current stream until closed). Only the parts whose
   * settings actually changed are restarted: the motion source if its block changed, the
   * prebuffer (if running) if the main URL, audio or copy mode changed.
   */
  reconfigure(next: ResolvedCamera): { restarted: string[] } {
    if (next.name !== this.camera.name) {
      throw new Error(`reconfigure cannot rename a camera ("${this.camera.name}" -> "${next.name}")`);
    }
    const prev = { ...this.camera };
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const motionChanged = !same(prev.foscam, next.foscam) || !same(prev.onvif, next.onvif);
    const prebufferChanged =
      prev.rtspMain !== next.rtspMain || prev.audio !== next.audio || prev.copyVideo !== next.copyVideo;
    const restarted: string[] = [];

    if (motionChanged) {
      this.motionSource?.stop();
      if (this.motionActive) {
        this.setMotion(false); // don't leave Home showing motion that nothing will ever clear
      }
    }
    const prebufferWasRunning = prebufferChanged && (this.prebuffer?.isRunning() ?? false);
    if (prebufferWasRunning) {
      this.prebuffer?.stop();
    }

    Object.assign(this.camera, next);
    // Object.assign copies undefined values too, but drop removed optional keys outright so
    // the object matches what a fresh load of config.json would produce.
    if (!next.foscam) delete this.camera.foscam;
    if (!next.onvif) delete this.camera.onvif;
    if (!next.rtspSub) delete this.camera.rtspSub;

    if (motionChanged) {
      this.motionSource = this.buildMotionSource();
      if (this.started) {
        this.motionSource?.start();
        restarted.push("motion source");
      }
    }
    if (prebufferWasRunning && this.prebuffer) {
      restarted.push("prebuffer");
      this.prebuffer.start().catch((err) => {
        this.log.error(
          `prebuffer didn't restart after a config change: ${(err as Error).message}. ` +
            "HKSV recording for this camera won't work until it does; restart the bridge if this repeats.",
        );
      });
    }
    this.log.info(
      `applied a live config change${restarted.length ? ` (restarted: ${restarted.join(", ")})` : ""}`,
    );
    return { restarted };
  }

  /** Called after the bridge is published. Starts background pollers. */
  start(): void {
    this.started = true;
    this.motionSource?.start();
    // We intentionally do NOT eagerly start the prebuffer here — HAP calls
    // updateRecordingActive(true) once the user enables recording, which starts
    // it. This saves CPU when recording is off.
  }

  shutdown(): void {
    this.offSource?.();
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.motionSource?.stop();
    this.prebuffer?.stop();
    this.streamingDelegate.shutdown();
  }
}
