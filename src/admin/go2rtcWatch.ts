/**
 * Reads go2rtc's own state every few seconds, over loopback only, never a camera (#16): health
 * (supervisor running + API answers + RTSP restream port accepts) drives the HomeKit source
 * selector, and /api/streams gives each stream's producer state (so the selector can tell a
 * camera outage from a go2rtc fault, and snapshots can pick a stream go2rtc already holds).
 */
import * as net from "net";
import { Logger } from "../logger";
import { ChildStatus } from "./supervisor";
import { Go2rtcClient, explainGo2rtcFailure } from "./go2rtc";
import { Go2rtcHealth, StreamView } from "../source";

export type FeedState = "streaming" | "starting" | "stalled" | "down" | "idle" | "unknown";
export interface FeedStatus { state: FeedState; since: number; reason: string | null; lastVideoAt: number | null; consumers: number }
export interface StreamSample { consumers: number; connected: boolean; bytes: number | null }

const STALL_MS = 10_000;
const DOWN_MS = 10_000;

/** Counts and byte totals per stream from /api/streams. Keeps no URLs (they hold passwords). */
export function parseStreams(json: unknown): Map<string, StreamSample> {
  const out = new Map<string, StreamSample>();
  if (!json || typeof json !== "object" || Array.isArray(json)) return out;
  for (const [name, s] of Object.entries(json as Record<string, any>)) {
    const prods: any[] = Array.isArray(s?.producers) ? s.producers : [];
    const live = prods.find((p) => typeof p?.remote_addr === "string" || typeof p?.bytes_recv === "number");
    out.set(name, { consumers: Array.isArray(s?.consumers) ? s.consumers.length : 0, connected: Boolean(live),
      bytes: typeof live?.bytes_recv === "number" ? live.bytes_recv : null });
  }
  return out;
}

/** One stream's next feed state from its previous state and the latest sample. Pure. */
export function nextFeed(prev: { feed: FeedStatus; bytes: number | null } | undefined, sample: StreamSample | undefined,
  now: number, go2rtcOk: boolean, lastError: string | null): { feed: FeedStatus; bytes: number | null } {
  const lastVideoAt = prev?.feed.lastVideoAt ?? null;
  const mk = (state: FeedState, reason: string | null, extra: Partial<FeedStatus> = {}, bytes: number | null = null) => ({
    feed: { state, reason, lastVideoAt, consumers: sample?.consumers ?? 0, since: prev && prev.feed.state === state ? prev.feed.since : now, ...extra },
    bytes,
  });
  if (!go2rtcOk) return mk("unknown", "go2rtc is down, so the camera's state can't be read");
  if (!sample) return mk("unknown", "go2rtc doesn't know this stream yet (a config change may still be loading)");
  if (sample.consumers === 0) return mk("idle", null);
  if (sample.connected) {
    const grew = sample.bytes !== null && prev?.bytes !== null && prev?.bytes !== undefined && sample.bytes > prev.bytes;
    if (grew) return mk("streaming", null, { lastVideoAt: now }, sample.bytes);
    const quietFor = now - (lastVideoAt ?? prev?.feed.since ?? now);
    if (prev?.feed.state === "streaming" && quietFor < STALL_MS) return { feed: { ...prev.feed, consumers: sample.consumers }, bytes: sample.bytes };
    if (!prev || prev.bytes === null || prev.feed.state === "starting") return mk("starting", null, {}, sample.bytes);
    return mk("stalled", "The camera is connected but stopped sending video", {}, sample.bytes);
  }
  const waiting = prev && (prev.feed.state === "starting" || prev.feed.state === "down") ? prev.feed.since : now;
  if (now - waiting < DOWN_MS && prev?.feed.state !== "down") return { feed: { ...mk("starting", null).feed, since: waiting }, bytes: null };
  const why = lastError ? explainGo2rtcFailure(lastError).happened : "no error reported yet";
  return mk("down", `go2rtc can't get video from the camera: ${why}`);
}

const tcpOk = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port, timeout: 1000 });
  const done = (ok: boolean) => { s.destroy(); resolve(ok); };
  s.once("connect", () => done(true)); s.once("timeout", () => done(false)); s.once("error", () => done(false));
});

export interface WatcherOptions {
  client: Go2rtcClient;
  rtspPort: number | null;
  supervisor: () => ChildStatus;
  /** go2rtc's last producer error for a stream name, if recent. */
  lastError: (stream: string) => { error: string; at: number } | null;
  /** The configured stream names, so a removed camera's state is dropped. */
  known?: () => Set<string>;
  log: Logger;
  intervalMs?: number;
  onHealth: (h: Go2rtcHealth) => void;
}

export class Go2rtcWatcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private last: Go2rtcHealth | null = null;
  private readonly state = new Map<string, { feed: FeedStatus; bytes: number | null }>();

  constructor(private readonly o: WatcherOptions) {}

  start(): void { if (!this.timer) { this.timer = setInterval(() => void this.tick(), this.o.intervalMs ?? 5000); void this.tick(); } }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  health(): Go2rtcHealth | null { return this.last; }
  feeds(): Map<string, FeedStatus> { return new Map([...this.state].map(([k, v]) => [k, v.feed])); }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const now = Date.now();
    try {
      const sup = this.o.supervisor();
      let streams: Map<string, StreamSample> | null = null;
      let error: string | null = null;
      if (sup.state !== "running") error = `go2rtc isn't running (${sup.state}${sup.lastError ? `: ${sup.lastError}` : ""})`;
      try { streams = parseStreams(await this.o.client.streams()); }
      catch (err) { error ??= `go2rtc's API didn't answer: ${(err as Error).message}`; }
      const rtspOk = this.o.rtspPort ? await tcpOk(this.o.rtspPort) : false;
      if (this.o.rtspPort && !rtspOk) error ??= `go2rtc's RTSP restream isn't accepting connections on 127.0.0.1:${this.o.rtspPort}`;
      const h: Go2rtcHealth = { supervisor: sup.state, apiOk: streams !== null, rtspOk, at: now, error,
        startedAt: sup.state === "running" ? sup.since : null };
      const ok = h.supervisor === "running" && h.apiOk;
      const names = new Set([...(streams?.keys() ?? []), ...this.state.keys()]);
      const views: Record<string, StreamView> = {};
      for (const n of names) {
        if (n.startsWith("check_")) continue;   // feed-check temp streams aren't cameras
        const pe = this.o.lastError(n);
        const next = nextFeed(this.state.get(n), streams?.get(n), now, ok, pe?.error ?? null);
        this.state.set(n, next);
        views[n] = { state: next.feed.state, errorAt: pe?.at ?? null, error: pe ? explainGo2rtcFailure(pe.error).happened : null };
      }
      // A stream gone from both go2rtc and the bridge's camera list (a removed camera) is dropped.
      const known = this.o.known?.();
      if (known) for (const k of [...this.state.keys()]) if (!known.has(k) && !streams?.has(k)) this.state.delete(k);
      if (streams) h.streams = views;
      this.last = h;
      this.o.onHealth(h);
    } catch (err) {
      this.o.log.error(`go2rtc health check failed unexpectedly (HomeKit keeps its current source): ${(err as Error).stack ?? err}`);
    } finally {
      this.busy = false;
    }
  }
}
