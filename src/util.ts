/** Small shared helpers. */

import * as dgram from "dgram";
import * as fs from "fs";

/** True when `dir` holds HAP pairing state (hap-nodejs writes AccessoryInfo.<username>.json). */
export function hasPairingState(dir: string): boolean {
  return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith("AccessoryInfo."));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reserve a free UDP port by binding a socket to port 0 and reading back the
 * assigned port. The socket is returned so the caller keeps it bound (preventing
 * a race where another process grabs the port) and can close it when done.
 */
export function reserveUdpPort(
  type: "udp4" | "udp6" = "udp4",
): Promise<{ port: number; socket: dgram.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(type);
    socket.once("error", reject);
    socket.bind(0, () => {
      const address = socket.address();
      resolve({ port: address.port, socket });
    });
  });
}

/** Redact credentials embedded in an rtsp:// (or any) URL for safe logging. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+):([^@/]+)@/, "//$1:***@");
}

/** Redact a query string carrying usr=/pwd= (Foscam CGI) for safe logging. */
export function redactCgi(url: string): string {
  return url.replace(/([?&](?:pwd|usr)=)[^&]*/gi, "$1***");
}
