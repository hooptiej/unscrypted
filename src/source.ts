/**
 * Where HomeKit's ffmpeg pipelines read a camera from (#16): go2rtc's loopback restream normally,
 * the camera itself while go2rtc is down. One camera, one caller: go2rtc holds the camera's RTSP
 * session and the recording buffer, snapshots, the dashboard and (by policy) the live view all
 * read from it. The switch has hysteresis so a crash-looping go2rtc can't make HomeKit flap.
 * Pure decision logic plus a small stateful wrapper; no I/O. Every switch is logged at warn/info,
 * never debug: the owner decided "fallback: yes", and a fallback nobody can see is a silent failure.
 *
 * Two kinds of fallback:
 *  - global: go2rtc itself is unhealthy (not running, API silent, or RTSP port closed) for 15 s.
 *    Every camera goes direct until go2rtc has been healthy for 60 s AND 2 min have passed.
 *  - per camera: go2rtc is healthy, but a HomeKit pipeline reading one camera through it failed
 *    3 times within 2 minutes. That camera alone reads directly for 10 minutes, then tries go2rtc
 *    again. Failures while go2rtc is unhealthy, or within 20 s of go2rtc (re)starting, don't count.
 *
 * Camera outages never count (owner decision, 2026-10-20): when go2rtc's own view of the stream
 * says it can't reach the camera either, the camera is rebooting or off the network. A direct read
 * would fail too, and would be a second client the moment the camera is back.
 */
import { Logger } from "./logger";
import { ResolvedCamera } from "./config";
import { restreamUrl, streamNames } from "./admin/go2rtcConfig";

export type FeedVia = "go2rtc" | "camera";
export type SourceMode = "go2rtc" | "direct" | "off";
export interface FeedChoice { url: string; via: FeedVia }
/**
 * What a pipeline wants: the main or sub stream; "snapshot" = the cheapest still (a stream go2rtc
 * already holds, else sub, else main); "live" = main, by the live-view policy (see LivePolicy).
 */
export type FeedWant = "main" | "sub" | "snapshot" | "live";
export type FeedPicker = (which: FeedWant) => FeedChoice | null;
/** A pipeline tells the selector its read failed (ffmpeg exited, no picture). Only go2rtc reads count. */
export type FeedFailure = (feed: FeedChoice, why: string) => void;
/**
 * The live view's source while go2rtc is healthy. "go2rtc" = one connection per camera even while
 * someone watches, but a viewer joining a held stream waits for the camera's next keyframe (up to
 * one GOP: 4 s on the Boavisions, #33). "camera" = a fresh camera session per viewer, which starts
 * on a keyframe (~1 s), at the cost of a second connection while a live view is open.
 */
export type LivePolicy = "go2rtc" | "camera";
/** go2rtc's own view of one stream, from the watcher: its feed state and its last producer error. No URLs. */
export interface StreamView { state: string; errorAt: number | null; error: string | null }
export interface Go2rtcHealth {
  supervisor: string; apiOk: boolean; rtspOk: boolean; at: number; error: string | null;
  /** When go2rtc last entered "running" (null when it isn't running). */
  startedAt?: number | null;
  /** go2rtc's view of each stream by name (absent when it couldn't be read). */
  streams?: Record<string, StreamView>;
}
/** Feed states in which go2rtc itself has no video from the camera: the camera is down, not go2rtc. */
const OUTAGE_STATES: Record<string, string> = {
  down: "go2rtc can't connect to it either",
  starting: "go2rtc is still trying to connect to it",
  stalled: "go2rtc is connected but the camera stopped sending video",
};
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

/** The global go2rtc/direct decision. Pure. */
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
    return `HomeKit reads the cameras directly: ${s.reason ?? "go2rtc's restream is switched off in this instance"}. Each HomeKit stream is its own connection to the camera.`;
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

/** Always the camera itself (tests, or an instance without go2rtc). */
export function directPicker(cam: Pick<ResolvedCamera, "rtspMain" | "rtspSub">): FeedPicker {
  return (which) => {
    const url = which === "sub" ? cam.rtspSub : which === "snapshot" ? cam.rtspSub ?? cam.rtspMain : cam.rtspMain;
    return url ? { url, via: "camera" } : null;
  };
}

export const dur = (ms: number) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`; };

export interface SelectorOptions {
  /** go2rtc's loopback RTSP port; null = restream off, every pipeline reads the camera (mode "off"). */
  rtspPort: number | null;
  offReason?: string;
  live?: LivePolicy;
  log: Logger;
  timings?: Partial<SourceTimings>;
  now?: () => number;
}

export class SourceSelector {
  private st: SourceState;
  private names = new Map<string, { main: string; sub?: string }>();
  private readonly listeners = new Set<() => void>();
  private readonly timings: SourceTimings;
  private readonly now: () => number;
  private lastHealth: Go2rtcHealth | null = null;
  private readonly camDirect = new Map<string, CameraDirect>();
  private readonly failures = new Map<string, { at: number; why: string }[]>();
  /** Cameras whose failures are being ignored as a camera outage: when it started and the last ignore (one log per outage). */
  private readonly outages = new Map<string, { since: number; lastAt: number }>();
  readonly live: LivePolicy;

  constructor(private readonly o: SelectorOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...o.timings };
    this.now = o.now ?? Date.now;
    this.live = o.live ?? "camera";
    const t = this.now();
    this.st = o.rtspPort
      ? { mode: "go2rtc", since: t, reason: null, downSince: null, healthySince: null, unhealthySince: t, returnAt: null }
      : { mode: "off", since: t, reason: o.offReason ?? "go2rtc's RTSP restream is switched off in this instance", downSince: null, healthySince: null, unhealthySince: null, returnAt: null };
  }

  setCameras(cams: Pick<ResolvedCamera, "name" | "rtspSub">[]): void {
    this.names = streamNames(cams);
    for (const m of [this.camDirect, this.failures, this.outages]) {
      for (const k of [...m.keys()]) if (!this.names.has(k)) m.delete(k);
    }
  }

  /** The camera's go2rtc stream names (main and sub). */
  private streamsOf(name: string): string[] {
    const n = this.names.get(name);
    return n ? [n.main, ...(n.sub ? [n.sub] : [])] : [];
  }

  /**
   * Why a failed read of `name` is the camera's own outage rather than go2rtc's fault, or null.
   * Looks at go2rtc's latest view of the stream that failed (or all the camera's streams).
   */
  private cameraOutage(name: string, stream: string | undefined, windowStart: number): string | null {
    const views = this.lastHealth?.streams;
    if (!views) return null;
    const own = this.streamsOf(name);
    for (const s of stream && own.includes(stream) ? [stream] : own) {
      const v = views[s];
      if (!v) continue;
      if (OUTAGE_STATES[v.state]) return `${OUTAGE_STATES[v.state]}${v.state === "down" && v.error ? ` (${v.error})` : ""}`;
      if (v.errorAt !== null && v.errorAt >= windowStart) {
        return `go2rtc's own connection to it also failed at ${new Date(v.errorAt).toISOString()}${v.error ? ` (${v.error})` : ""}`;
      }
    }
    return null;
  }

  state(): SourceState { return { ...this.st }; }
  /** The camera's per-camera fallback, or null when it follows the global mode. */
  cameraDirect(name: string): CameraDirect | null { const d = this.camDirect.get(name); return d ? { ...d } : null; }
  /** go2rtc's latest view of one stream (null when unknown). */
  streamView(stream: string): StreamView | null { return this.lastHealth?.streams?.[stream] ?? null; }

  private notify(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch (err) { this.o.log.error(`a source-change listener threw (the others still ran): ${(err as Error).stack ?? err}`); }
    }
  }

  /** The watcher's verdict on go2rtc, every few seconds. */
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
        this.o.log.warn(`HomeKit is reading the cameras through go2rtc again (it was direct for ${dur(this.st.since - prev.since)}).`);
      }
    }
    // A camera outage ends when go2rtc has video from the camera again.
    for (const [name, o] of [...this.outages]) {
      const views = h.streams;
      if (!views || !this.streamsOf(name).some((s) => views[s]?.state === "streaming")) continue;
      this.outages.delete(name);
      this.o.log.info(`"${name}": go2rtc has video from the camera again (it was unreachable from about ${new Date(o.since).toISOString()}, ${dur(h.at - o.since)}). ` +
        "HomeKit kept reading it through go2rtc the whole time.");
    }
    for (const [name, d] of [...this.camDirect]) {
      if (h.at < d.until) continue;
      this.camDirect.delete(name);
      this.failures.delete(name);
      this.o.log.warn(`HomeKit is trying go2rtc again for "${name}" (it read the camera directly for ${dur(h.at - d.since)}). ` +
        `If go2rtc still can't get video from it, it goes direct again after ${this.timings.camFailures} more failures.`);
      changed = true;
    }
    if (changed) this.notify();
  }

  /**
   * A HomeKit pipeline reading `name` through go2rtc failed. Counts toward that camera's own
   * fallback only while go2rtc is healthy and not just restarted, and only when go2rtc itself has
   * video from the camera (a camera outage never counts). `stream` is the go2rtc stream that was
   * read, when known. Never throws.
   */
  reportFailure(name: string, why: string, stream?: string): void {
    const t = this.timings;
    const now = this.now();
    const h = this.lastHealth;
    if (this.st.mode !== "go2rtc" || this.camDirect.has(name) || !this.names.has(name)) return;
    if (!h || !isHealthy(h)) return;   // go2rtc's own trouble: the global switch handles it
    if (h.startedAt && now - h.startedAt < t.restartGraceMs) return;
    const outage = this.cameraOutage(name, stream, now - t.camWindowMs);
    if (outage) {
      // The camera itself is unreachable: earlier counted failures were most likely the start of it.
      this.failures.delete(name);
      const prev = this.outages.get(name);
      if (!prev || now - prev.lastAt > t.camDirectMs) {
        this.o.log.warn(`"${name}": reading through go2rtc failed (${why}), but ${outage}. ` +
          "That's the camera being unreachable (a reboot or a network drop), not go2rtc, so it doesn't count toward reading this camera directly. " +
          "HomeKit keeps reading it through go2rtc and picks it up again when the camera is back. (Logged once per outage.)");
      }
      this.outages.set(name, { since: prev?.since ?? now, lastAt: now });
      return;
    }
    const list = (this.failures.get(name) ?? []).filter((f) => now - f.at < t.camWindowMs);
    if (list.length && now - list[list.length - 1].at < 3000) return;   // one incident, seen by two pipelines
    list.push({ at: now, why });
    this.failures.set(name, list);
    if (list.length < t.camFailures) {
      this.o.log.warn(`"${name}": reading through go2rtc failed (${why}); ${list.length} of ${t.camFailures} failures within ${dur(t.camWindowMs)} before HomeKit reads this camera directly.`);
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
    return (feed, why) => {
      if (feed.via !== "go2rtc") return;
      // The restream URL ends in the go2rtc stream name (rtsp://127.0.0.1:<port>/<stream>).
      const stream = feed.url.slice(feed.url.lastIndexOf("/") + 1) || undefined;
      this.reportFailure(cam.name, why, stream);
    };
  }

  /** True while HomeKit's pipelines for this camera should read through go2rtc. */
  private viaGo2rtc(name: string): boolean {
    return this.st.mode === "go2rtc" && Boolean(this.o.rtspPort) && this.names.has(name) && !this.camDirect.has(name);
  }

  /**
   * The picker one camera's pipelines call at each spawn. Closes over the camera object (which
   * reconfigure() mutates), so URL edits apply on the next spawn.
   */
  picker(cam: Pick<ResolvedCamera, "name" | "rtspMain" | "rtspSub">): FeedPicker {
    const direct = directPicker(cam);
    return (which) => {
      if (!this.viaGo2rtc(cam.name)) return direct(which);
      if (which === "live" && this.live === "camera") return direct("main");
      const n = this.names.get(cam.name)!;
      const port = this.o.rtspPort!;
      const g = (stream: string): FeedChoice => ({ url: restreamUrl(port, stream), via: "go2rtc" });
      if (which === "sub") return n.sub ? g(n.sub) : null;
      if (which === "snapshot") {
        // The cheapest still: a stream go2rtc already holds costs the camera nothing (no new
        // session, #55). Otherwise the sub stream, like before; main only when there's no sub.
        const held = [n.sub, n.main].find((s) => s && this.streamView(s)?.state === "streaming");
        return g(held ?? n.sub ?? n.main);
      }
      return g(n.main);
    };
  }

  onChange(cb: () => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
}
