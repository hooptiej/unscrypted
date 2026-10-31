/**
 * HomeKit snapshots that never make the Home app wait, and the per-camera probe memory (#99, #96).
 *
 * Measured on prod: the iPhone gives a /resource snapshot about 5 s, then drops the whole HAP
 * connection (0.1.11). And it queues snapshots ahead of a live view's START on the same
 * connection, which hap-nodejs serves one request at a time: on 0.1.12 the wait from SetupEndpoints
 * to START was 98-99% snapshot time (11.9-57.2 s; 0.0-0.1 s when no snapshot was queued).
 */

import { Logger } from "./logger";

/** How long the very first snapshot of a camera waits for a capture before the "camera slow" card (the phone gives up at ~5 s). */
export const SNAPSHOT_DEADLINE_MS = 4_000;

/** What a fresh capture came back as: a real frame, or a placeholder card explaining why there isn't one. */
export interface Capture {
  jpeg: Buffer;
  real: boolean;
  /** Where it was read from, for the log ("through go2rtc", "the camera directly"). */
  from: string;
  /** Why it isn't real (placeholder only). */
  reason?: string;
}

export interface SnapshotServerOptions {
  name: string;
  log: Logger;
  /** Take a fresh snapshot. Must always resolve (a real frame or a placeholder) or reject when even that fails. */
  capture: () => Promise<Capture>;
  /** Render the "camera slow" card when there's no image yet. */
  placeholder: (reason: string) => Promise<Buffer>;
  deadlineMs?: number;
  now?: () => number;
}

/**
 * Answers snapshots without making the Home app wait (#99). Once a camera has any image, every
 * snapshot is answered at once with the latest one and a fresh capture runs in the background
 * (concurrent requests share it, so a slow camera never piles up ffmpeg runs). "Latest" is the
 * newest finished capture: a real frame, or the #64 card saying why the camera is down. A capture
 * that's merely slow changes nothing until it finishes. The very first snapshot waits for a fresh
 * capture up to the deadline, then gets a "camera slow" card. Every answer is logged.
 */
export class SnapshotServer {
  private lastAnswer?: { jpeg: Buffer; at: number; real: boolean };
  private lastGoodAt?: number;
  private inflight?: { started: number; done: Promise<Capture> };
  private readonly deadlineMs: number;
  private readonly now: () => number;

  constructor(private readonly o: SnapshotServerOptions) {
    this.deadlineMs = o.deadlineMs ?? SNAPSHOT_DEADLINE_MS;
    this.now = o.now ?? Date.now;
  }

  /** Age of the last real picture in ms, or null if there's none yet (admin/status use). */
  lastGoodAgeMs(): number | null {
    return this.lastGoodAt === undefined ? null : this.now() - this.lastGoodAt;
  }

  async get(): Promise<Buffer> {
    // Instant answer once there's anything to show (owner's call): every millisecond here is a
    // millisecond before a queued live view's START. The refresh runs in the background.
    if (this.lastAnswer) {
      const served = this.lastAnswer;
      this.fresh().done.catch((err: Error) => this.o.log.warn(`snapshot refresh failed (${err.message}); the Home app keeps the previous image`));
      this.o.log.info(`snapshot: answered at once with the ${served.real ? "last picture" : "'why' card"} from ${this.agoOf(served.at)} ago; refreshing in the background`);
      return served.jpeg;
    }
    return this.firstAnswer();
  }

  /** No image yet: wait for a fresh capture up to the deadline, then the "camera slow" card. */
  private async firstAnswer(): Promise<Buffer> {
    const asked = this.now();
    const run = this.fresh();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), this.deadlineMs); });
    try {
      const first = await Promise.race([run.done, late]);
      if (first !== "late") {
        this.o.log.info(`snapshot: first answer after ${this.now() - asked} ms`);
        return first.jpeg;
      }
    } finally {
      clearTimeout(timer);
    }
    run.done.catch((err: Error) => this.o.log.warn(`snapshot capture failed after the deadline (${err.message})`));
    this.o.log.warn(`snapshot: no picture within ${this.deadlineMs} ms and none earlier; served the "camera slow" card. The capture carries on, and the next snapshot uses it.`);
    return this.o.placeholder("camera slow to answer");
  }

  /** The capture in flight, or a new one. Whatever it finishes with is what the next snapshot serves. */
  private fresh(): { started: number; done: Promise<Capture> } {
    if (this.inflight) return this.inflight;
    const started = this.now();
    const done = this.o.capture().then((c) => {
      const ms = this.now() - started;
      if (c.real) {
        this.o.log.info(`snapshot ${c.from}: captured in ${ms} ms`);
        this.lastGoodAt = this.now();
      } else {
        this.o.log.warn(`snapshot ${c.from}: no picture (${c.reason}) after ${ms} ms; snapshots show the card saying so until the camera answers`);
      }
      this.lastAnswer = { jpeg: c.jpeg, at: this.now(), real: c.real };
      return c;
    });
    const entry = { started, done };
    this.inflight = entry;
    const clear = () => { if (this.inflight === entry) this.inflight = undefined; };
    done.then(clear, clear);
    return entry;
  }

  private agoOf(at: number): string {
    const s = Math.round((this.now() - at) / 1000);
    return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
  }
}

/** How long a camera stays on full probing before it gets a fresh look with the fast probe. */
export const FULL_PROBE_TTL_MS = 30 * 60_000;

export type ProbeMode = "fast" | "full";

/**
 * Per-camera probe memory (#78, #99). A camera moves to full probing only when the full-probe
 * retry actually worked after a fast-probe miss: a camera that sends its video late. A miss where
 * the retry failed too is an outage, not a late camera, and changes nothing. Full probing expires
 * after FULL_PROBE_TTL_MS, so a camera that only looked late gets the fast probe back.
 */
export class ProbeMemory {
  private fullSince?: number;

  constructor(
    private readonly name: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = FULL_PROBE_TTL_MS,
  ) {}

  get mode(): ProbeMode {
    if (this.fullSince !== undefined && this.now() - this.fullSince >= this.ttlMs) {
      this.fullSince = undefined;
      this.log.info(`"${this.name}": trying the fast probe again after ${Math.round(this.ttlMs / 60_000)} min on full probing (#99)`);
    }
    return this.fullSince === undefined ? "fast" : "full";
  }

  /** The fast probe missed and the full-probe retry worked: this camera sends its video late. */
  learnedLate(where: string): void {
    if (this.fullSince !== undefined) { this.fullSince = this.now(); return; }
    this.fullSince = this.now();
    this.log.warn(`"${this.name}": ffmpeg's fast probe found no video stream on a ${where}, and full probing did (this camera sends its video late, like the Foscam FI9803P). ` +
      `Live view and snapshots for it use full probing for the next ${Math.round(this.ttlMs / 60_000)} min: a few seconds slower to the first frame, but they work. Other cameras are unaffected. (#78, #99)`);
  }

  /** The fast probe missed and the full-probe retry failed too: an outage, so the probe stays as it is. */
  missedDuringOutage(where: string): void {
    this.log.info(`"${this.name}": the fast probe and the full-probe retry both failed on a ${where}; that's the camera or go2rtc being unreachable, ` +
      `not a late camera, so the probe stays ${this.mode} (#99)`);
  }
}
