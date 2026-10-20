/**
 * Status checks for the dashboard's service lights (port of Homedash's run_check and
 * evaluate_services). Reasons are plain words with no address in them: the open dashboard API
 * never carries camera or server IPs. A red light always says why.
 */

import * as net from "net";
import * as http from "http";
import * as https from "https";
import { ServiceCheck, ServiceNode, IPVLAN_REASON } from "./settings";
import { DashBridgeInfo } from "./ipc";

export type Light = "ok" | "warn" | "down";
export interface LightNode { id: string; name: string; state: Light; reason: string | null; link?: string; children: LightNode[] }

export { IPVLAN_REASON };

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

/** The HTTP status code, or a rejection whose message is a plain reason without the address. */
function httpStatus(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    // rejectUnauthorized off: this only asks "is it answering", it sends and trusts nothing.
    const r = lib.get(url, { timeout: timeoutMs, rejectUnauthorized: false } as https.RequestOptions, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on("timeout", () => r.destroy(Object.assign(new Error(`no answer within ${timeoutMs / 1000} s`), { code: "TIMEOUT" })));
    r.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "TIMEOUT") reject(e);
      else if (e.code === "ECONNREFUSED") reject(new Error("connection refused (nothing listening)"));
      else reject(new Error(`didn't answer (${e.code ?? "unknown error"})`));
    });
  });
}

/** null = healthy; otherwise why not. Never throws. */
export async function runCheck(c: ServiceCheck, bridge: () => DashBridgeInfo | null, timeoutMs = 3000): Promise<string | null> {
  try {
    switch (c.kind) {
      case "tcp": return await tcpProbe(c.host, c.port, timeoutMs);
      case "alive": return await tcpProbe(c.host, c.port, timeoutMs, true);   // a refusal proves the host answered
      case "http": {
        const code = await httpStatus(c.url, timeoutMs);
        return c.ok === "200" && code !== 200 ? `answered ${code}, expected 200` : null;
      }
      case "bridge": {
        const b = bridge();
        if (!b) return "the bridge hasn't reported yet";
        if (!b.hapEnabled) return "HomeKit is off on this instance (test)";
        return b.paired ? null : "not paired with Home";
      }
      case "blocked": return c.reason || "can't be checked from here";
      default: return `unknown check kind "${(c as { kind?: unknown }).kind}" in the dashboard settings file`;
    }
  } catch (err) {
    return (err as Error).message;
  }
}

export class ServiceWatcher {
  private fails = new Map<string, number>();
  constructor(private readonly failsBeforeDown = 2) {}

  async poll(tree: ServiceNode[], bridge: () => DashBridgeInfo | null): Promise<LightNode[]> {
    const flat: ServiceNode[] = [];
    const walk = (ns: ServiceNode[]) => ns.forEach((n) => { flat.push(n); walk(n.children ?? []); });
    walk(tree);
    const raw = new Map(await Promise.all(flat.map(async (n) => [n.id, await runCheck(n.check, bridge)] as const)));
    const up = new Map<string, boolean>();
    for (const [id, reason] of raw) {
      const f = reason === null ? 0 : (this.fails.get(id) ?? 0) + 1;
      this.fails.set(id, f);
      up.set(id, reason === null || f < this.failsBeforeDown);   // one miss is a blip, not an outage
    }
    const anyDown = (n: ServiceNode): boolean => (n.children ?? []).some((k) => !up.get(k.id) || anyDown(k));
    const build = (n: ServiceNode): LightNode => {
      const ok = up.get(n.id)!;
      const state: Light = !ok ? "down" : n.rollup && anyDown(n) ? "warn" : "ok";
      const out: LightNode = { id: n.id, name: n.name, state, reason: ok ? null : raw.get(n.id) ?? null, children: (n.children ?? []).map(build) };
      if (n.link && /^https?:\/\//.test(n.link)) out.link = n.link;
      return out;
    };
    return tree.map(build);
  }
}
