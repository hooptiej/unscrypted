/**
 * Reachability checks for the dashboard. Reasons are plain words with no address in them: the
 * open dashboard API never carries camera or server IPs. (The service lights build on this later.)
 */

import * as net from "net";

/** null when the TCP port accepts; otherwise a plain reason with no address in it. */
export function tcpProbe(host: string, port: number, timeoutMs = 1500, refusedIsUp = false): Promise<string | null> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: timeoutMs });
    s.once("connect", () => { s.destroy(); resolve(null); });
    s.once("timeout", () => { s.destroy(); resolve(`no answer within ${timeoutMs / 1000} s`); });
    s.once("error", (e: NodeJS.ErrnoException) => {
      s.destroy();
      if (e.code === "ECONNREFUSED") resolve(refusedIsUp ? null : "connection refused (nothing listening)");
      else resolve(e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH" ? "network unreachable" : `connection failed (${e.code ?? "unknown error"})`);
    });
  });
}
