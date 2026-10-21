/**
 * Bridge -> dash child messages. The dash child gets ONLY what it needs to show video and say
 * whether a camera is sending: camera names, go2rtc stream names, and each stream's feed state
 * from go2rtc (fixed plain-words reasons). Never credentials, URLs or addresses. The dash child
 * never reads config.json itself, and never contacts a camera (#16: no more TCP probes).
 */

import { ResolvedConfig } from "../config";
import { streamNames } from "../admin/go2rtcConfig";
import type { FeedState, FeedStatus } from "../admin/go2rtcWatch";

export interface DashCamera { name: string; main: string; sub: string | null }
export interface DashBridgeInfo { hapEnabled: boolean; paired: boolean; go2rtc: { state: string; lastError: string | null; nextRetryAt: number | null } }
/** A tile's camera state. `up` false means the tile shows the reason (and keeps its player retrying). */
export interface DashFeed { state: FeedState; up: boolean; reason: string | null; since: number }
export type ToDash =
  | { type: "cameras"; cameras: DashCamera[] }
  | { type: "bridge"; bridge: DashBridgeInfo }
  | { type: "feeds"; feeds: Record<string, DashFeed> };

export function dashCameras(cfg: Pick<ResolvedConfig, "cameras">): DashCamera[] {
  const names = streamNames(cfg.cameras);
  return cfg.cameras.map((c) => {
    const n = names.get(c.name)!;
    return { name: c.name, main: n.main, sub: n.sub ?? null };
  });
}

// Fixed strings: nothing from go2rtc's log reaches the open dash, so no address can leak into it.
const DASH_REASON: Record<string, string> = {
  down: "Camera not sending video: go2rtc can't connect to it",
  stalled: "Camera connected but stopped sending video",
};

/** go2rtc's feed state as the open dashboard shows it. Idle/starting/unknown tiles keep trying to play. */
export function dashFeed(f: FeedStatus | undefined, go2rtcOk: boolean): DashFeed {
  if (!f || !go2rtcOk) return { state: "unknown", up: true, reason: null, since: f?.since ?? Date.now() };
  const bad = f.state === "down" || f.state === "stalled";
  return { state: f.state, up: !bad, reason: bad ? DASH_REASON[f.state] : null, since: f.since };
}

/** Shape-check a message from the bridge. Returns a reason string when it's malformed. */
export function checkToDash(m: unknown): ToDash | string {
  if (!m || typeof m !== "object") return "message is not an object";
  const o = m as Record<string, unknown>;
  if (o.type === "cameras") return Array.isArray(o.cameras) ? { type: "cameras", cameras: o.cameras as DashCamera[] } : "cameras message has no list";
  if (o.type === "bridge") return o.bridge && typeof o.bridge === "object" ? { type: "bridge", bridge: o.bridge as DashBridgeInfo } : "bridge message has no status";
  if (o.type === "feeds") return o.feeds && typeof o.feeds === "object" && !Array.isArray(o.feeds) ? { type: "feeds", feeds: o.feeds as Record<string, DashFeed> } : "feeds message has no feed map";
  return `unknown message type ${JSON.stringify(o.type)}`;
}
