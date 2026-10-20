/**
 * Where HomeKit's ffmpeg pipelines read a camera from (#16): go2rtc's loopback restream normally,
 * the camera itself while go2rtc is down. The switch has hysteresis so a crash-looping go2rtc
 * can't make HomeKit flap. Pure decision logic plus a small stateful wrapper; no I/O.
 *
 * Two kinds of fallback (owner, Q3 = yes):
 *  - global: go2rtc itself is unhealthy (not running, API silent, or RTSP port closed) for 15 s.
 *    Every camera goes direct until go2rtc has been healthy for 60 s AND 2 min have passed.
 *  - per camera: go2rtc is healthy, but a HomeKit pipeline reading one camera through it failed
 *    3 times within 2 minutes. That camera alone reads directly for 10 minutes, then tries go2rtc
 *    again. Failures while go2rtc is unhealthy, or within 20 s of go2rtc (re)starting, don't count:
 *    those are go2rtc's fault, not the camera's, and the global switch handles them.
 */
import { Logger } from "./logger";
import { ResolvedCamera } from "./config";
import { restreamUrl, streamNames } from "./admin/go2rtcConfig";

export type FeedVia = "go2rtc" | "camera";
export type SourceMode = "go2rtc" | "direct" | "off";
export interface FeedChoice { url: string; via: FeedVia }
export type FeedPicker = (which: "main" | "sub") => FeedChoice | null;
/** A pipeline tells the selector its read failed (ffmpeg exited, no picture). Only go2rtc reads count. */
export type FeedFailure = (feed: FeedChoice, why: string) => void;
/** startedAt: when go2rtc last entered "running" (null when it isn't running). */
export interface Go2rtcHealth { supervisor: string; apiOk: boolean; rtspOk: boolean; at: number; error: string | null; startedAt?: number | null }
export interface SourceState { mode: SourceMode; since: number; reason: string | null; downSince: number | null; healthySince: number | null; unhealthySince: number | null; returnAt: number | null }
export interface SourceTimings {
  downGraceMs: number; healthyForMs: number; minDirectMs: number;
  /** Per-camera fallback: this many failures within camWindowMs send one camera direct for camDirectMs. */
  camFailures: number; camWindowMs: number; camDirectMs: number;
  /** Failures this soon after go2rtc (re)started are go2rtc's restart, not the camera. */
  restartGraceMs: number;
}
export const DEFAULT_TIMINGS: SourceTimings = {
  downGraceMs: 15_000, healthyForMs: 60_000, minDirectMs: 120_000,
  camFailures: 3, camWindowMs: 120_000, camDirectMs: 600_000, restartGraceMs: 20_000,
};
/** One camera reading directly while go2rtc is healthy (per-camera fallback). */
export interface CameraDirect { since: number; until: number; reason: string }

export const isHealthy = (h: Go2rtcHealth) => h.supervisor === "running" && h.apiOk && h.rtspOk;

export function nextSourceState(s: SourceState, h: Go2rtcHealth, t: Pick<SourceTimings, "downGraceMs" | "healthyForMs" | "minDirectMs">): SourceState {
  if (s.mode === "off") return s;
  const ok = isHealthy(h);
  const now = h.at;
  const healthySince = ok ? (s.healthySince ?? now) : null;
  const unhealthySince = ok ? null : (s.unhealthySince ?? now);
  if (s.mode === "go2rtc") {
    if (!ok && now - unhealthySince! >= t.downGraceMs) {
      return { mode: "direct", since: now, reason: h.error ?? "go2rtc isn't healthy", downSince: unhealthySince, healthySince, unhealthySince, returnAt: null };
    }
    return { ...s, healthySince, unhealthySince };
  }
  // direct
  if (!ok) return { ...s, reason: h.error ?? s.reason, healthySince, unhealthySince, returnAt: null };
  const returnAt = Math.max(healthySince! + t.healthyForMs, s.since + t.minDirectMs);
  if (now >= returnAt) return { mode: "go2rtc", since: now, reason: null, downSince: null, healthySince, unhealthySince: null, returnAt: null };
  return { ...s, healthySince, unhealthySince, returnAt };
}

/** Plain-words status line. `clock` formats a time (the admin UI swaps in the viewer's local time). */
export function sourceText(s: SourceState, clock: (ms: number) => string): string {
  if (s.mode === "off") {
    return `HomeKit reads the cameras directly: ${s.reason ?? "go2rtc is switched off in this instance"}. Each HomeKit stream is its own connection to the camera.`;
  }
  if (s.mode === "direct") {
    const back = s.returnAt
      ? `go2rtc is healthy again; HomeKit switches back to it at ${clock(s.returnAt)} if it stays healthy.`
      : "HomeKit switches back on its own once go2rtc has been healthy for a minute.";
    return `HomeKit is reading the cameras directly because go2rtc is down (since ${clock(s.downSince ?? s.since)}): ${s.reason}. Cameras may see an extra connection each until go2rtc is back. ${back}`;
  }
  return "HomeKit reads every camera through go2rtc: one connection per camera stream.";
}

/** Plain-words line for one camera on per-camera fallback. */
export function cameraDirectText(name: string, d: CameraDirect, clock: (ms: number) => string): string {
  return `HomeKit is reading "${name}" directly (since ${clock(d.since)}): ${d.reason}. ` +
    `The camera may see two connections (go2rtc's and HomeKit's) until then. HomeKit tries go2rtc again for it at ${clock(d.until)}.`;
}

export function directPicker(cam: Pick<ResolvedCamera, "rtspMain" | "rtspSub">): FeedPicker {
  return (which) => {
    const url = which === "main" ? cam.rtspMain : cam.rtspSub;
    return url ? { url, via: "camera" } : null;
  };
}

export const dur = (ms: number) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`; };

export class SourceSelector {
  private st: SourceState;
  private names = new Map<string, { main: string; sub?: string }>();
  private readonly listeners = new Set<() => void>();
  private readonly timings: SourceTimings;
  private readonly now: () => number;
  private lastHealth: Go2rtcHealth | null = null;
  private readonly camDirect = new Map<string, CameraDirect>();
  private readonly failures = new Map<string, { at: number; why: string }[]>();

  constructor(private readonly o: { rtspPort: number | null; offReason?: string; log: Logger; timings?: Partial<SourceTimings>; now?: () => number }) {
    this.timings = { ...DEFAULT_TIMINGS, ...o.timings };
    this.now = o.now ?? Date.now;
    const t = this.now();
    this.st = o.rtspPort
      ? { mode: "go2rtc", since: t, reason: null, downSince: null, healthySince: null, unhealthySince: t, returnAt: null }
      : { mode: "off", since: t, reason: o.offReason ?? "go2rtc's RTSP restream is switched off in this instance", downSince: null, healthySince: null, unhealthySince: null, returnAt: null };
  }

  setCameras(cams: Pick<ResolvedCamera, "name" | "rtspSub">[]): void {
    this.names = streamNames(cams);
    for (const k of [...this.camDirect.keys()]) if (!this.names.has(k)) this.camDirect.delete(k);
    for (const k of [...this.failures.keys()]) if (!this.names.has(k)) this.failures.delete(k);
  }
  state(): SourceState { return { ...this.st }; }
  /** The camera's per-camera fallback, or null when it follows the global mode. */
  cameraDirect(name: string): CameraDirect | null { const d = this.camDirect.get(name); return d ? { ...d } : null; }

  private notify(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch (err) { this.o.log.error(`a source-change listener threw (the others still ran): ${(err as Error).stack ?? err}`); }
    }
  }

  update(h: Go2rtcHealth): void {
    const prev = this.st;
    const prevHealth = this.lastHealth;
    this.lastHealth = h;
    this.st = nextSourceState(prev, h, this.timings);
    let changed = prev.mode !== this.st.mode;
    // Failures seen while go2rtc was unhealthy, or around a go2rtc restart, were go2rtc's, not a camera's.
    const restarted = (h.startedAt ?? null) !== (prevHealth?.startedAt ?? null);
    if (!isHealthy(h) || restarted) this.failures.clear();
    if (changed) {
      if (this.st.mode === "direct") {
        this.o.log.warn(`HomeKit now reads the cameras directly: go2rtc is down (${this.st.reason}) since ${new Date(this.st.downSince ?? this.st.since).toISOString()}. ` +
          `Cameras may see an extra connection each until it's back; HomeKit switches back on its own once go2rtc has been healthy for ${this.timings.healthyForMs / 1000} s.`);
      } else {
        this.o.log.info(`HomeKit is reading the cameras through go2rtc again (it was direct for ${dur(this.st.since - prev.since)}).`);
      }
    }
    for (const [name, d] of [...this.camDirect]) {
      if (h.at < d.until) continue;
      this.camDirect.delete(name);
      this.failures.delete(name);
      this.o.log.info(`HomeKit is trying go2rtc again for "${name}" (it read the camera directly for ${dur(h.at - d.since)}). ` +
        `If go2rtc still can't get video from it, it goes direct again after ${this.timings.camFailures} more failures.`);
      changed = true;
    }
    if (changed) this.notify();
  }

  /**
   * A HomeKit pipeline reading `name` through go2rtc failed. Counts toward that camera's own
   * fallback only while go2rtc is healthy and not just restarted. Never throws.
   */
  reportFailure(name: string, why: string): void {
    const t = this.timings;
    const now = this.now();
    const h = this.lastHealth;
    if (this.st.mode !== "go2rtc" || this.camDirect.has(name) || !this.names.has(name)) return;
    if (!h || !isHealthy(h)) return;   // go2rtc's own trouble: the global switch handles it
    if (h.startedAt && now - h.startedAt < t.restartGraceMs) return;
    const list = (this.failures.get(name) ?? []).filter((f) => now - f.at < t.camWindowMs);
    if (list.length && now - list[list.length - 1].at < 3000) return;   // one incident, seen by two pipelines
    list.push({ at: now, why });
    this.failures.set(name, list);
    if (list.length < t.camFailures) {
      this.o.log.info(`"${name}": reading through go2rtc failed (${why}); ${list.length} of ${t.camFailures} failures within ${dur(t.camWindowMs)} before HomeKit reads this camera directly.`);
      return;
    }
    const d: CameraDirect = { since: now, until: now + t.camDirectMs,
      reason: `go2rtc couldn't get video from it ${list.length} times within ${dur(t.camWindowMs)} (last: ${why})` };
    this.camDirect.set(name, d);
    this.failures.delete(name);
    this.o.log.warn(`HomeKit now reads "${name}" directly: ${d.reason}. Other cameras still read through go2rtc. ` +
      `The camera may see two connections until HomeKit tries go2rtc again for it at ${new Date(d.until).toISOString()} (in ${dur(t.camDirectMs)}).`);
    this.notify();
  }

  /** The failure callback for one camera's pipelines (only reads through go2rtc count). */
  failureReporter(cam: Pick<ResolvedCamera, "name">): FeedFailure {
    return (feed, why) => { if (feed.via === "go2rtc") this.reportFailure(cam.name, why); };
  }

  picker(cam: Pick<ResolvedCamera, "name" | "rtspMain" | "rtspSub">): FeedPicker {
    const direct = directPicker(cam);
    return (which) => {
      const d = direct(which);
      if (!d) return null;
      const n = this.names.get(cam.name);
      const stream = which === "main" ? n?.main : n?.sub;
      if (this.st.mode !== "go2rtc" || !this.o.rtspPort || !stream || this.camDirect.has(cam.name)) return d;
      return { url: restreamUrl(this.o.rtspPort, stream), via: "go2rtc" };
    };
  }

  onChange(cb: () => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
}
