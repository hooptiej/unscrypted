/**
 * Messages between the bridge (parent) and the admin web server (forked child), plus the one
 * pure decision of how a saved camera change takes effect.
 */

import { ResolvedCamera } from "../config";
import { ChildStatus } from "./supervisor";
import { UserErrorBody } from "./errors";
import type { FeedStatus } from "./go2rtcWatch";
import type { CameraDirect, FeedVia, SourceState } from "../source";

export type MotionKind = "foscam-cgi" | "onvif" | "none";

export interface CameraStatus {
  name: string; stream: string; hksv: boolean; motionKind: MotionKind;
  /** go2rtc's view of the main and sub streams (null when go2rtc isn't watched in this instance). */
  feed: FeedStatus | null; subFeed: FeedStatus | null;
  /** Where HomeKit's next pipeline for this camera reads from. */
  via: FeedVia;
  /** This camera alone reading directly (per-camera fallback), with the reason and the retry time. */
  direct: (CameraDirect & { text: string }) | null;
  prebuffer: { running: boolean; via: FeedVia | null; lastFragmentAt: number | null } | null;
  liveSessions: number; recordingActive: boolean; motionActive: boolean; lastMotionAt: number | null;
  pendingRestart: boolean;   // saved change needs a bridge restart to take effect
}

export interface BridgeStatus {
  bridgeName: string; pin: string; setupURI: string; paired: boolean; hapPort: number | null; hapEnabled: boolean;
  cameras: CameraStatus[]; go2rtc: ChildStatus; dash: ChildStatus; startedAt: number; version: string;
  /** Where HomeKit reads the cameras from, in words. Times inside `text` are {{t:<ms>}} tokens the pane localises. */
  homekitSource: SourceState & { text: string };
}

export type ApplyMode = "live" | "added" | "restart-needed";

export type ToAdmin =
  | { type: "status"; status: BridgeStatus }
  | { type: "applied"; reqId: string; ok: true; mode: ApplyMode; message: string }
  | { type: "applied"; reqId: string; ok: false; error: UserErrorBody };

export type ToBridge =
  | { type: "apply"; reqId: string; name: string; isNew: boolean }
  | { type: "restart-bridge"; reqId: string }
  | { type: "reload-go2rtc"; reqId: string };

/** Shape-check a message from the admin child. Returns a reason string when it's malformed. */
export function checkToBridge(m: unknown): ToBridge | string {
  if (!m || typeof m !== "object") return "message is not an object";
  const o = m as Record<string, unknown>;
  if (typeof o.reqId !== "string" || !o.reqId) return "message has no reqId";
  switch (o.type) {
    case "apply":
      if (typeof o.name !== "string" || !o.name) return "apply message has no camera name";
      return { type: "apply", reqId: o.reqId, name: o.name, isNew: o.isNew === true };
    case "restart-bridge":
    case "reload-go2rtc":
      return { type: o.type, reqId: o.reqId };
    default:
      return `unknown message type ${JSON.stringify(o.type)}`;
  }
}

// Fields that change what the accessory advertises to Home: these need a bridge restart.
const HAP_SHAPE: (keyof ResolvedCamera)[] = ["hksv", "prebufferSeconds", "manufacturer", "model", "serialNumber"];

export const motionKindOf = (c: Pick<ResolvedCamera, "foscam" | "onvif">): MotionKind =>
  (c.foscam ? "foscam-cgi" : c.onvif ? "onvif" : "none");

export function classifyChange(before: ResolvedCamera | undefined, after: ResolvedCamera): ApplyMode {
  if (!before) return "added";
  if (HAP_SHAPE.some((k) => before[k] !== after[k])) return "restart-needed";
  if (motionKindOf(before) !== motionKindOf(after)) return "restart-needed";
  return "live";
}
