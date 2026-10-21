/**
 * Messages between the bridge (parent) and the admin web server (forked child), plus the one
 * pure decision of how a saved camera change takes effect.
 */

import { ResolvedCamera } from "../config";
import { ChildStatus } from "./supervisor";
import { UserErrorBody } from "./errors";

export type MotionKind = "foscam-cgi" | "onvif" | "none";

export interface CameraStatus {
  name: string; stream: string; hksv: boolean; motionKind: MotionKind;
  reachable: boolean | null; reachableCheckedAt: number | null; reachError: string | null;
  liveSessions: number; recordingActive: boolean; motionActive: boolean; lastMotionAt: number | null;
  pendingRestart: boolean;   // saved change needs a bridge restart to take effect
  /** How the camera reaches HomeKit (#57). No secrets here: the PIN is only in `pairings`. */
  homekit: CameraHomekitStatus;
}

export interface CameraHomekitStatus {
  mode: "bridged" | "standalone";
  /** Standalone only: its own HAP port, whether it's advertising, paired, and why not. */
  port: number | null; published: boolean; paired: boolean; error: string | null;
}

/** One standalone camera's pairing details, for the Pairing page only (stripped from /api/status). */
export interface StandalonePairing {
  name: string; pin: string | null; setupURI: string; paired: boolean; published: boolean; port: number | null; error: string | null;
}

export interface BridgeStatus {
  bridgeName: string; pin: string; setupURI: string; paired: boolean; hapPort: number | null; hapEnabled: boolean;
  cameras: CameraStatus[]; go2rtc: ChildStatus; dash: ChildStatus; startedAt: number; version: string;
  pairings: StandalonePairing[];
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
  // Bridged <-> standalone, or a new standalone identity: a different accessory to Home (#57).
  if (JSON.stringify(before.homekit) !== JSON.stringify(after.homekit)) return "restart-needed";
  return "live";
}
