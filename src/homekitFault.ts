/**
 * Home's fault flag for an offline camera (#113, from #64). When a camera has been offline for the whole
 * grace, HomeKit's StatusFault characteristic goes to GENERAL_FAULT so Apple Home shows the fault instead
 * of a silent black tile, and back to NO_FAULT the moment the camera answers again.
 *
 * StatusFault lives on the camera's MotionSensor service (the only service HAP gives a camera that can
 * carry it). A camera with no motion sensor (HKSV off and no motion source) has nowhere to show it; that is
 * said once in the log, and the admin pane's status still shows the camera as offline.
 *
 * Idempotent: the same state twice changes nothing and logs nothing, so a steady stream of "still offline"
 * reports never spams HomeKit or the log.
 */

import { Characteristic } from "hap-nodejs";
import { Logger } from "./logger";

/** The slice of a HAP service this needs; the real MotionSensor service fits, and so does a test fake. */
export interface FaultService {
  updateCharacteristic(name: typeof Characteristic.StatusFault, value: number): unknown;
}

export interface Offline { since: number; reason: string }

export class CameraFault {
  private offline: Offline | null = null;

  constructor(private readonly svc: FaultService | undefined, name: string, private readonly log: Logger) {
    if (svc) svc.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
    else {
      log.info(
        `"${name}" has no motion sensor in Home (HKSV is off and there is no motion source), so Home has nowhere to show a camera-offline fault for it. ` +
          "The admin pane's status still says when it's offline.",
      );
    }
  }

  /** The camera is offline past the grace (since/why), or answering again (null). */
  set(offline: Offline | null): void {
    const was = this.offline;
    if (offline && was) { this.offline = offline; return; }   // still offline (the reason text may have changed): nothing to tell Home
    if (!offline && !was) return;
    this.offline = offline;
    if (offline) {
      this.log.warn(
        `camera offline since ${new Date(offline.since).toISOString()} (${offline.reason}); ` +
          (this.svc ? "Home now shows a fault on it (StatusFault)." : "Home has no motion sensor for it, so it can't show a fault."),
      );
    } else {
      this.log.info(`camera is answering again${this.svc ? "; Home's fault on it is cleared" : ""}`);
    }
    this.svc?.updateCharacteristic(Characteristic.StatusFault, offline ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT);
  }

  /** The current offline state (null = fine). */
  current(): Offline | null { return this.offline ? { ...this.offline } : null; }
}
