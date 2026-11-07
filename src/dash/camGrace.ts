/**
 * The grace period before a camera counts as offline (#113). One missed RTSP check is a normal
 * camera hiccup, not an outage: a camera is only declared offline after it has gone unanswered for
 * the whole grace (15 to 30 s is what the owner asked for; the default is 20 s). Until then the
 * verdict stays "up" and nothing changes on the wall. When the grace does run out, the offline
 * "since" is when the camera first stopped answering, not when the grace ran out, so the banner
 * tells the truth about how long it has been gone.
 *
 * Pure bookkeeping (no I/O, the caller passes the clock) so the timing can be tested exactly.
 */

export const DEFAULT_OFFLINE_GRACE_SECONDS = 20;
export const MIN_OFFLINE_GRACE_SECONDS = 5;
export const MAX_OFFLINE_GRACE_SECONDS = 120;

/**
 * What the grace says about one camera right now.
 *  - "checking": no good answer has come in yet (just started), so there's nothing to say either way.
 *  - "up": answering, or missing checks for less than the grace (a blip: `failingSince` is set).
 *  - "down": unanswered for the whole grace. `since` is when it first stopped answering.
 */
export interface Verdict {
  state: "checking" | "up" | "down";
  /** Why the latest check failed, in plain words (null while answering). */
  reason: string | null;
  /** Up: since when it has been answering. Down: since when it stopped answering. */
  since: number;
  /** Set while a blip is being waited out (up) or once down: when the first missed check was. */
  failingSince: number | null;
}

interface Track { everUp: boolean; upSince: number; failingSince: number | null; reason: string | null }

export class CamGrace {
  private readonly tracks = new Map<string, Track>();

  /** `graceMs` is read on every call, so a changed setting applies on the next check. */
  constructor(private readonly graceMs: () => number) {}

  /** Feed one check's result (reason null = the camera answered) and get the verdict back. */
  observe(key: string, reason: string | null, now: number): Verdict {
    let t = this.tracks.get(key);
    if (!t) { t = { everUp: false, upSince: now, failingSince: null, reason: null }; this.tracks.set(key, t); }
    if (reason === null) {
      // Back (or still here). A blip that ended inside the grace never happened: `upSince` stays put.
      if (t.failingSince !== null && now - t.failingSince >= this.graceMs()) t.upSince = now;   // it was down; it's back
      else if (!t.everUp) t.upSince = now;
      t.everUp = true; t.failingSince = null; t.reason = null;
      return { state: "up", reason: null, since: t.upSince, failingSince: null };
    }
    if (t.failingSince === null) t.failingSince = now;
    t.reason = reason;
    return this.verdict(t, now);
  }

  /** The verdict at `now` from what the last checks said (no new check). */
  private verdict(t: Track, now: number): Verdict {
    if (t.failingSince !== null && now - t.failingSince >= this.graceMs()) {
      return { state: "down", reason: t.reason, since: t.failingSince, failingSince: t.failingSince };
    }
    if (!t.everUp) return { state: "checking", reason: t.reason, since: now, failingSince: t.failingSince };
    return { state: "up", reason: null, since: t.upSince, failingSince: t.failingSince };
  }

  /** Forget every camera not in `keep` (removed from config.json). */
  keepOnly(keep: Set<string>): void {
    for (const k of [...this.tracks.keys()]) if (!keep.has(k)) this.tracks.delete(k);
  }
}
