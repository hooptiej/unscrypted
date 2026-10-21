/** Small shared helpers. */

import * as dgram from "dgram";
import * as fs from "fs";

/** True when `dir` holds HAP pairing state (hap-nodejs writes AccessoryInfo.<username>.json). */
export function hasPairingState(dir: string): boolean {
  return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith("AccessoryInfo."));
}

/**
 * Where HomeKit listens and advertises (#36), from UNSCRYPTED_HAP_BIND: a comma list of IP
 * addresses or interface names, passed to hap-nodejs's `bind`. Unset means every address the
 * host has, which on a NAS with extra addresses (a dashboard alias, an ipvlan shim) lets Apple
 * devices connect on one address while live video is sent from another, and live view dies
 * after a second. Returns undefined for unset/blank.
 */
export function parseHapBind(raw: string | undefined): string[] | undefined {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

/** The host's non-internal IPv4 addresses, for the "more than one address" warning. */
export function hostIpv4s(ifaces: NodeJS.Dict<{ family: string | number; internal: boolean; address: string }[]>): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if ((a.family === "IPv4" || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  return out;
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
