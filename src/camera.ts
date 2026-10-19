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
import { Prebuffer } from "./prebuffer";
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

  constructor(
    private readonly camera: ResolvedCamera,
    private readonly ffmpegPath: string,
    parentLog: Logger,
  ) {
    const log = parentLog.child(camera.name);

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

    this.streamingDelegate = new StreamingDelegate(camera, ffmpegPath, log.child("stream"));

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
      this.prebuffer = new Prebuffer(camera, ffmpegPath, log.child("prebuffer"));
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

    // Wire the selected motion source to the controller's MotionSensor.
    if (camera.foscam) {
      const client = new FoscamClient(
        {
          cgiBase: camera.foscam.cgiBase,
          username: camera.foscam.username,
          password: camera.foscam.password,
        },
        log.child("foscam"),
      );
      this.motionSource = new MotionPoller(
        client,
        {
          pollIntervalMs: camera.foscam.pollIntervalMs ?? 1000,
          cooldownMs: camera.foscam.motionCooldownMs ?? 8000,
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
      this.motionSource = new OnvifMotionSource(
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
  }

  private setMotion(active: boolean): void {
    const svc = this.controller.motionService;
    if (svc) {
      svc.updateCharacteristic(Characteristic.MotionDetected, active);
    }
  }

  /** Called after the bridge is published. Starts background pollers. */
  start(): void {
    this.motionSource?.start();
    // We intentionally do NOT eagerly start the prebuffer here — HAP calls
    // updateRecordingActive(true) once the user enables recording, which starts
    // it. This saves CPU when recording is off.
  }

  shutdown(): void {
    this.motionSource?.stop();
    this.prebuffer?.stop();
    this.streamingDelegate.shutdown();
  }
}
