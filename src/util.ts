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

/** A scheme://user:password@ URL. The password runs greedy to the LAST '@' in the token, so a password holding '@' or '/' is still covered. */
const URL_CREDS_RE = /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)[^\s]*@/gi;
/** Foscam CGI credentials carried in a query string. */
const CGI_CREDS_RE = /([?&](?:pwd|usr)=)[^&\s]*/gi;

/**
 * Mask every credential in a piece of text bound for a log: the password in any
 * scheme://user:password@host URL, and Foscam usr=/pwd= query values. Safe on text with
 * neither (returned unchanged). Use it on anything a camera URL or ffmpeg/go2rtc output
 * may have ended up in.
 */
export function maskSecrets(text: string): string {
  return text.replace(URL_CREDS_RE, "$1***@").replace(CGI_CREDS_RE, "$1***");
}

/** Redact credentials embedded in an rtsp:// (or any) URL for safe logging. */
export function redactUrl(url: string): string {
  return maskSecrets(url);
}

/** Redact a query string carrying usr=/pwd= (Foscam CGI) for safe logging. */
export function redactCgi(url: string): string {
  return maskSecrets(url);
}
