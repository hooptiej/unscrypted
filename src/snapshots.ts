/**
 * HomeKit snapshots on a deadline, and the per-camera probe memory (#99, #96).
 *
 * Measured on prod 0.1.11: the iPhone gives a /resource snapshot about 5 s, then drops the whole
 * HAP connection (and any live view on it). Snapshots took 0.4-6.2 s, and over 5 s on a camera
 * stuck in full probing, so whole stretches of trying never reached a live stream.
 */

import { Logger } from "./logger";

/** How long a fresh capture gets before HomeKit is answered from the last good image (the phone gives up at ~5 s). */
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
  /** Render the "camera slow" card when there's no earlier image to fall back on. */
  placeholder: (reason: string) => Promise<Buffer>;
  deadlineMs?: number;
  now?: () => number;
}

/**
 * Answers every snapshot within the deadline: the fresh capture if it's in time, else the last
 * good image (any age, the owner's call), else a "camera slow" card. A late capture keeps running
 * and refreshes the last good image for next time. Concurrent requests share one capture, so a
 * slow camera never piles up ffmpeg runs. Every answer is logged with its timing.
 */
export class SnapshotServer {
  private lastGood?: { jpeg: Buffer; at: number };
  private inflight?: { started: number; done: Promise<Capture> };
  private readonly deadlineMs: number;
  private readonly now: () => number;

  constructor(private readonly o: SnapshotServerOptions) {
    this.deadlineMs = o.deadlineMs ?? SNAPSHOT_DEADLINE_MS;
    this.now = o.now ?? Date.now;
  }

  /** Age of the last good image in ms, or null if there's none yet (admin/status use). */
  lastGoodAgeMs(): number | null {
    return this.lastGood ? this.now() - this.lastGood.at : null;
  }

  async get(): Promise<Buffer> {
    const asked = this.now();
    const run = this.fresh();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), this.deadlineMs); });
    try {
      const first = await Promise.race([run.done, late]);
      if (first !== "late") {
        const ms = this.now() - asked;
        if (first.real) this.o.log.info(`snapshot ${first.from}: fresh in ${ms} ms`);
        else this.o.log.warn(`snapshot ${first.from}: no picture (${first.reason}) after ${ms} ms; served the placeholder card`);
        return first.jpeg;
      }
    } catch (err) {
      // The capture couldn't even produce a placeholder: an earlier picture beats an error.
      if (this.lastGood) {
        this.o.log.warn(`snapshot failed (${(err as Error).message}); served the last good image from ${this.ago()} ago`);
        return this.lastGood.jpeg;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const waited = this.now() - run.started;
    if (this.lastGood) {
      this.o.log.warn(`snapshot: no fresh picture within ${this.deadlineMs} ms (the capture has been running ${waited} ms); ` +
        `served the last good image from ${this.ago()} ago so the Home app doesn't give up. The capture carries on and refreshes it.`);
      return this.lastGood.jpeg;
    }
    this.o.log.warn(`snapshot: no fresh picture within ${this.deadlineMs} ms and no earlier picture yet; served the "camera slow" card. The capture carries on.`);
    return this.o.placeholder("camera slow to answer");
  }

  /** The capture in flight, or a new one. Successful real frames become the last good image. */
  private fresh(): { started: number; done: Promise<Capture> } {
    if (this.inflight) return this.inflight;
    const started = this.now();
    const done = this.o.capture().then((c) => {
      if (c.real) {
        const ms = this.now() - started;
        if (ms > this.deadlineMs) this.o.log.info(`snapshot ${c.from}: the late capture finished after ${ms} ms; the next snapshot uses it`);
        this.lastGood = { jpeg: c.jpeg, at: this.now() };
      }
      return c;
    });
    const entry = { started, done };
    this.inflight = entry;
    const clear = () => { if (this.inflight === entry) this.inflight = undefined; };
    done.then(clear, clear);
    return entry;
  }

  private ago(): string {
    const s = Math.round((this.now() - (this.lastGood?.at ?? this.now())) / 1000);
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
