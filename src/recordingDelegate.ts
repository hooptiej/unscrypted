/**
 * CameraRecordingDelegate — HomeKit Secure Video.
 *
 * Lifecycle (driven by HAP-NodeJS):
 *   updateRecordingActive(true)  -> start the rolling prebuffer
 *   updateRecordingConfiguration -> remember fragment length / selected config
 *   (motion fires -> HAP opens a recording stream)
 *   handleRecordingStreamRequest -> async generator:
 *        1. yield the init segment (ftyp+moov)
 *        2. yield the buffered pre-event fragments
 *        3. yield live fragments until HAP closes the stream or we hit the cap
 *   closeRecordingStream         -> stop yielding
 *
 * Pacing: the generator is pull-based — HAP awaits transmission of each yielded
 * packet before requesting the next, so we inherit backpressure and don't flood
 * the HDS connection with the prebuffer burst.
 *
 * KNOWN LIMITATION (needs real-device verification): we always mux audio into
 * the fragments. HAP asks us to honour RecordingAudioActive (drop audio when
 * off). Doing that cleanly needs a second audio-less pipeline; for this first
 * cut we log the mismatch rather than silently ignoring it.
 */

import {
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  CameraController,
  Characteristic,
  HDSProtocolSpecificErrorReason,
  RecordingPacket,
} from "hap-nodejs";
import { Logger } from "./logger";
import { Prebuffer } from "./prebuffer";
import { ResolvedCamera } from "./config";

/**
 * HAP's HDSProtocolSpecificErrorReason values, by name with a plain-words gloss (#10). hap-nodejs
 * declares the enum `const`, so it is spelled out here rather than read from the package.
 */
const CLOSE_REASONS: Record<number, [name: string, plain: string]> = {
  0: ["NORMAL", "the clip ended normally"],
  1: ["NOT_ALLOWED", "HomeKit didn't allow it"],
  2: ["BUSY", "HomeKit was busy"],
  3: ["CANCELLED", "the clip was cancelled (by HomeKit, or by hap-nodejs when it didn't close in time)"],
  4: ["UNSUPPORTED", "HomeKit doesn't support what was sent"],
  5: ["UNEXPECTED_FAILURE", "an unexpected failure"],
  6: ["TIMEOUT", "HomeKit timed out waiting for video"],
  7: ["BAD_DATA", "HomeKit couldn't use the video it got"],
  8: ["PROTOCOL_ERROR", "a protocol error"],
  9: ["INVALID_CONFIGURATION", "an invalid configuration"],
};

/** A recording close reason for the log: "TIMEOUT (6): HomeKit timed out waiting for video". */
export function describeCloseReason(reason: number | undefined): string {
  if (reason === undefined) return "the HomeKit data connection closed";
  const known = CLOSE_REASONS[reason];
  return known ? `${known[0]} (${reason}): ${known[1]}` : `unknown reason ${reason}`;
}

/** Minimal async queue of buffers with close + async iteration. */
class FragmentQueue {
  private items: Buffer[] = [];
  private resolvers: Array<(r: IteratorResult<Buffer>) => void> = [];
  private closed = false;

  push(b: Buffer): void {
    if (this.closed) {
      return;
    }
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve({ value: b, done: false });
    } else {
      this.items.push(b);
    }
  }

  close(): void {
    this.closed = true;
    let r = this.resolvers.shift();
    while (r) {
      r({ value: undefined, done: true });
      r = this.resolvers.shift();
    }
  }

  next(): Promise<IteratorResult<Buffer>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ value: item, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.resolvers.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return { next: () => this.next() };
  }
}

export class RecordingDelegate implements CameraRecordingDelegate {
  controller?: CameraController;

  private recordingActive = false;
  private configuration: CameraRecordingConfiguration | undefined;
  private readonly closeSignals = new Map<number, () => void>();

  constructor(
    private readonly camera: ResolvedCamera,
    private readonly prebuffer: Prebuffer,
    private readonly log: Logger,
  ) {}

  /** Whether HomeKit currently has recording switched on for this camera (admin pane status). */
  isRecordingActive(): boolean {
    return this.recordingActive;
  }

  /** How many clips are being sent to HomeKit right now (a source switch waits for these). */
  activeClips(): number {
    return this.closeSignals.size;
  }

  updateRecordingActive(active: boolean): void {
    this.recordingActive = active;
    this.log.info(`recording ${active ? "ENABLED" : "disabled"} by HomeKit`);
    if (active) {
      void this.prebuffer.start();
    } else {
      this.prebuffer.stop("HomeKit switched recording off");
    }
  }

  updateRecordingConfiguration(
    configuration: CameraRecordingConfiguration | undefined,
  ): void {
    this.configuration = configuration;
    if (configuration) {
      this.log.info(
        `recording config selected: ${configuration.videoCodec.resolution[0]}x${configuration.videoCodec.resolution[1]} ` +
          `@${configuration.videoCodec.resolution[2]}fps, fragment ${configuration.mediaContainerConfiguration.fragmentLength}ms, ` +
          `prebuffer ${configuration.prebufferLength}ms`,
      );
    } else {
      this.log.warn("recording configuration cleared");
    }
  }

  private isAudioActive(): boolean {
    // Best-effort read of RecordingAudioActive from the operating-mode service.
    try {
      const svc = this.controller?.recordingManagement?.operatingModeService;
      if (!svc) {
        this.log.debug("isAudioActive: no operating-mode service yet; assuming audio is active");
        return true;
      }
      const value = svc.getCharacteristic(Characteristic.RecordingAudioActive).value;
      return value !== 0 && value !== false;
    } catch (err) {
      this.log.debug(`isAudioActive: couldn't read RecordingAudioActive (${(err as Error).message}); assuming audio is active`);
      return true;
    }
  }

  async *handleRecordingStreamRequest(
    streamId: number,
    signal?: AbortSignal,
  ): AsyncGenerator<RecordingPacket> {
    this.log.info(`recording stream ${streamId} requested`);

    if (!this.recordingActive) {
      this.log.warn(`recording stream ${streamId} requested but recording is not active`);
    }
    if (!this.isAudioActive()) {
      this.log.warn(
        `RecordingAudioActive is OFF but this build always muxes audio — ` +
          `clip ${streamId} will still contain audio (known limitation).`,
      );
    }

    // HomeKit can request a clip within a few hundred ms of enabling recording,
    // before the prebuffer's ffmpeg has connected and produced its init segment.
    // Make sure it's running and give it a brief window to warm up rather than
    // aborting on a cold start.
    await this.prebuffer.start();
    const warm = await this.prebuffer.waitForInit(8000);
    const session = warm ? this.prebuffer.openSession() : null;
    if (!session) {
      // Camera genuinely unreachable / pipeline not producing. Fail loudly.
      this.log.error(
        `recording stream ${streamId}: prebuffer has no data after warm-up (camera unreachable or ffmpeg not producing). Aborting clip.`,
      );
      return;
    }

    const fragmentMs =
      this.configuration?.mediaContainerConfiguration.fragmentLength ?? 4000;
    const maxMs = this.camera.maxRecordingSeconds * 1000;
    // Safety cap on fragment count so a stuck stream can't run forever.
    const maxFragments = Math.ceil(maxMs / Math.max(1000, fragmentMs)) + 4;

    const queue = new FragmentQueue();
    // If the buffer's ffmpeg stops under this clip, the clip ends here (the buffer WARNs, naming it):
    // whatever comes after is a new ffmpeg with a new init segment, never part of this clip (#41).
    let bufferEnded: string | null = null;
    const unsubscribe = session.subscribeLive(
      (f) => queue.push(f),
      (why) => { bufferEnded = why; queue.close(); },
      `clip ${streamId}`,
    );
    let aborted = false;
    const onClose = () => {
      aborted = true;
      queue.close();
    };
    this.closeSignals.set(streamId, onClose);
    if (signal) {
      if (signal.aborted) {
        onClose();
      } else {
        signal.addEventListener("abort", onClose, { once: true });
      }
    }

    const start = Date.now();
    let count = 0;

    try {
      // 1) Initialization segment.
      yield { data: session.initSegment, isLast: false };

      // 2) Pre-event fragments already in the ring.
      for (const frag of session.prebufferedFragments) {
        if (aborted) {
          return;
        }
        count += 1;
        yield { data: frag, isLast: false };
      }

      // 3) Live fragments until close / max duration / cap.
      for await (const frag of queue) {
        if (aborted) {
          return;
        }
        count += 1;
        const elapsed = Date.now() - start;
        const hitCap = count >= maxFragments || elapsed >= maxMs;
        yield { data: frag, isLast: hitCap };
        if (hitCap) {
          this.log.info(
            `recording stream ${streamId} reached cap (${count} fragments, ${elapsed}ms); ending`,
          );
          return;
        }
      }
    } catch (err) {
      this.log.error(
        `recording stream ${streamId} error: ${(err as Error).message}`,
      );
    } finally {
      unsubscribe();
      signal?.removeEventListener?.("abort", onClose);
      this.closeSignals.delete(streamId);
      this.log.info(
        `recording stream ${streamId} finished (${count} fragments)` +
          (bufferEnded ? ` because the recording buffer stopped under it (${bufferEnded})` : ""),
      );
    }
  }

  acknowledgeStream(streamId: number): void {
    this.log.debug(`recording stream ${streamId} acknowledged by HomeKit`);
  }

  closeRecordingStream(
    streamId: number,
    reason: HDSProtocolSpecificErrorReason | undefined,
  ): void {
    // A non-zero reason is a failed or cut-short clip: WARN, so a run of them shows at the default
    // log level (#10: ~120 timeouts in a row once logged only as INFO "closed (reason 6)").
    const why = describeCloseReason(reason);
    if (reason !== undefined && reason !== 0) {
      this.log.warn(`recording stream ${streamId} closed with ${why}`);
    } else {
      this.log.info(`recording stream ${streamId} closed (${why})`);
    }
    const close = this.closeSignals.get(streamId);
    if (close) {
      close();
    }
  }
}
