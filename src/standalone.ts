/**
 * Publishing standalone cameras (#57): each one is its own HAP accessory with its own server,
 * port and pairing, instead of riding the bridge's single HAP connection.
 *
 * Pairing files share the bridge's persist folder: hap-nodejs names them by username
 * (AccessoryInfo.<id>.json, IdentifierCache.<id>.json, ControllerStorage.<id>.json), and
 * config validation guarantees every accessory's username is different.
 *
 * Every failure is per camera and loud: a port clash or a publish error is logged with the
 * camera's name and shown in the admin pane, and the bridge and the other cameras keep running.
 */

import { Accessory, Categories, MDNSAdvertiser } from "hap-nodejs";
import { Logger } from "./logger";
import { UnscryptedCamera } from "./camera";
import { tcpPortFree } from "./homekitIdentity";

export interface StandaloneState {
  name: string;
  port: number | null;
  username: string | null;
  pin: string | null;
  setupId: string | null;
  published: boolean;
  /** Plain-words reason it isn't published, or a runtime server error after publishing. */
  error: string | null;
  accessory: Accessory;
}

export function standalonePaired(s: StandaloneState): boolean {
  return Boolean(s.accessory._accessoryInfo?.paired());
}

export function standaloneSetupURI(s: StandaloneState): string {
  if (!s.published) return "";
  try {
    return s.accessory.setupURI();
  } catch {
    return "";
  }
}

/** The address to test-listen on: a single bind address if there is exactly one IP, else all. */
function probeHost(hapBind: string[] | undefined): string | undefined {
  if (hapBind?.length === 1 && /^[\d.]+$|:/.test(hapBind[0])) return hapBind[0];
  return undefined;
}

export async function publishStandalone(
  cam: UnscryptedCamera, hapBind: string[] | undefined, log: Logger, identityError?: string,
): Promise<StandaloneState> {
  const hk = cam.resolved.homekit;
  const st: StandaloneState = {
    name: cam.name, port: null, username: null, pin: null, setupId: null,
    published: false, error: null, accessory: cam.accessory,
  };
  if (hk.mode !== "standalone") {
    st.error = "not a standalone camera";
    return st;
  }
  Object.assign(st, { port: hk.port, username: hk.username, pin: hk.pin, setupId: hk.setupId });
  const missing = (["username", "pin", "setupId", "port"] as const).filter((k) => hk[k] === null);
  if (missing.length) {
    st.error = `its HomeKit identity is incomplete (missing ${missing.join(", ")})` +
      (identityError ? ` and couldn't be generated and saved: ${identityError}` : "") +
      ". It is not published to HomeKit. Fix config.json (or the folder's permissions) and restart.";
    log.error(`standalone camera "${cam.name}": ${st.error}`);
    return st;
  }
  const port = hk.port as number;
  if (!(await tcpPortFree(port, probeHost(hapBind)))) {
    st.error = `TCP port ${port} is already in use on this host, so its HomeKit server can't start. ` +
      `It is not published; the bridge and the other cameras are unaffected. Pick a free homekit.port for it in config.json and restart.`;
    log.error(`standalone camera "${cam.name}": ${st.error}`);
    return st;
  }
  try {
    // publish() calls listen() synchronously, but hap-nodejs puts no "error" listener on its TCP
    // server: a listen failure would be an uncaught exception that kills the whole process.
    // Attach one before the error can be emitted (it arrives on a later tick).
    const p = cam.accessory.publish({
      username: hk.username as string,
      pincode: hk.pin as string,
      port,
      category: Categories.IP_CAMERA,
      setupID: hk.setupId as string,
      advertiser: MDNSAdvertiser.CIAO,
      ...(hapBind ? { bind: hapBind } : {}),
    });
    const tcp = (cam.accessory as unknown as { _server?: { httpServer?: { tcpServer?: NodeJS.EventEmitter } } })
      ._server?.httpServer?.tcpServer;
    tcp?.on("error", (err: Error) => {
      st.published = false;
      st.error = `its HomeKit server failed on port ${port}: ${err.message}. The bridge and the other cameras are unaffected; restart to retry.`;
      log.error(`standalone camera "${cam.name}": ${st.error}`);
    });
    await p;
    st.published = st.error === null;
  } catch (err) {
    st.error = `publishing to HomeKit failed: ${(err as Error).message}. The bridge and the other cameras are unaffected.`;
    log.error(`standalone camera "${cam.name}": ${(err as Error).stack ?? err}`);
  }
  return st;
}

export async function unpublishStandalone(states: StandaloneState[], log: Logger): Promise<void> {
  for (const s of states) {
    if (!s.published) continue;
    try {
      await s.accessory.unpublish();
    } catch (err) {
      log.warn(`error unpublishing standalone camera "${s.name}": ${(err as Error).message}`);
    }
  }
}
