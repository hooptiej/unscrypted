/**
 * Bridge -> dash child messages. The dash child gets ONLY what it needs to show video and probe
 * reachability: camera names, go2rtc stream names, and RTSP host:port. Never credentials, never
 * URLs. The dash child never reads config.json itself.
 */

import { ResolvedConfig } from "../config";
import { streamNames } from "../admin/go2rtcConfig";

export interface DashCamera { name: string; main: string; sub: string | null; probe: { host: string; port: number } | null }
export interface DashBridgeInfo { hapEnabled: boolean; paired: boolean; go2rtc: { state: string; lastError: string | null; nextRetryAt: number | null } }
export type ToDash = { type: "cameras"; cameras: DashCamera[] } | { type: "bridge"; bridge: DashBridgeInfo };

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
