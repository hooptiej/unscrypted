/**
 * Bridge -> dash child messages. The dash child gets ONLY what it needs to show video and probe
 * reachability: camera names, go2rtc stream names, and RTSP host:port. Never credentials, never
 * URLs. The dash child never reads config.json itself.
 */

import { ResolvedConfig } from "../config";
import { streamNames } from "../shared/streams";

export interface DashCamera { name: string; main: string; sub: string | null; probe: { host: string; port: number } | null }
export interface DashBridgeInfo { hapEnabled: boolean; paired: boolean; go2rtc: { state: string; lastError: string | null; nextRetryAt: number | null } }
export type ToDash = { type: "cameras"; cameras: DashCamera[] } | { type: "bridge"; bridge: DashBridgeInfo };

/**
 * Dash child -> bridge: which cameras have been offline for the whole grace (#113), by camera name, sent after every
 * reachability round (an empty list is the all-clear and also says the dashboard is alive). The bridge turns this into
 * HomeKit's StatusFault. No addresses: a reason is plain words.
 */
export type FromDash = { type: "camera-reach"; offline: Record<string, { since: number; reason: string }> };

/** Shape-check the camera-reach message. Returns a reason string when it's malformed, else null. */
export function checkCameraReach(m: unknown): { offline: Record<string, { since: number; reason: string }> } | string {
  const o = m as { type?: unknown; offline?: unknown } | null;
  if (!o || o.type !== "camera-reach") return "not a camera-reach message";
  if (!o.offline || typeof o.offline !== "object" || Array.isArray(o.offline)) return "camera-reach has no offline list";
  const out: Record<string, { since: number; reason: string }> = {};
  for (const [name, v] of Object.entries(o.offline as Record<string, unknown>)) {
    const e = v as { since?: unknown; reason?: unknown } | null;
    if (!e || typeof e.since !== "number" || !Number.isFinite(e.since) || typeof e.reason !== "string") return `camera-reach entry for "${name}" is malformed`;
    out[name] = { since: e.since, reason: e.reason };
  }
  return { offline: out };
}

function probeOf(url: string): DashCamera["probe"] {
  try {
    const u = new URL(url);
    return u.hostname ? { host: u.hostname, port: Number(u.port || 554) } : null;
  } catch {
    return null;   // config.ts already validated the URL; a null probe makes the tile say "address can't be read"
  }
}

export function dashCameras(cfg: Pick<ResolvedConfig, "cameras">): DashCamera[] {
  const names = streamNames(cfg.cameras);
  return cfg.cameras.map((c) => {
    const n = names.get(c.name)!;
    return { name: c.name, main: n.main, sub: n.sub ?? null, probe: probeOf(c.rtspMain) };
  });
}

/** Shape-check a message from the bridge. Returns a reason string when it's malformed. */
export function checkToDash(m: unknown): ToDash | string {
  if (!m || typeof m !== "object") return "message is not an object";
  const o = m as Record<string, unknown>;
  if (o.type === "cameras") return Array.isArray(o.cameras) ? { type: "cameras", cameras: o.cameras as DashCamera[] } : "cameras message has no list";
  if (o.type === "bridge") return o.bridge && typeof o.bridge === "object" ? { type: "bridge", bridge: o.bridge as DashBridgeInfo } : "bridge message has no status";
  return `unknown message type ${JSON.stringify(o.type)}`;
}
