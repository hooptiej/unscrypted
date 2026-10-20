/**
 * Status checks for the dashboard's service lights (port of Homedash's run_check and
 * evaluate_services). Reasons are plain words with no address in them: the open dashboard API
 * never carries camera or server IPs. A red light always says why.
 */

import * as net from "net";
import * as http from "http";
import * as https from "https";
import { ServiceCheck, ServiceNode, IPVLAN_REASON, IPVLAN_SHORT } from "./settings";
import { DashBridgeInfo } from "./ipc";

export type Light = "ok" | "warn" | "down";
/**
 * `short` is the one-line label under a non-green light on the wall; `reason` is the full reason
 * (tap/hover there, and on the settings page). Both are null exactly when the light is green.
 */
export interface LightNode { id: string; name: string; state: Light; short: string | null; reason: string | null; link?: string; children: LightNode[] }
export interface Reason { short: string; full: string }

export { IPVLAN_REASON, IPVLAN_SHORT };

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

/** A probe's full reason, shortened to a one-line label for the wall display. */
function shortFor(full: string): string {
  if (/refused|no answer|didn't answer|unreachable|connection failed/.test(full)) return "not answering";
  const code = /^answered (\d+)/.exec(full);
  return code ? `answered ${code[1]}` : "check failed";
}

/** null = healthy; otherwise why not, short (one line on the wall) and full. Never throws. */
export async function runCheckDetailed(c: ServiceCheck, bridge: () => DashBridgeInfo | null, timeoutMs = 3000): Promise<Reason | null> {
  const probe = (full: string | null): Reason | null => (full === null ? null : { short: shortFor(full), full });
  try {
    switch (c.kind) {
      case "tcp": return probe(await tcpProbe(c.host, c.port, timeoutMs));
      case "alive": return probe(await tcpProbe(c.host, c.port, timeoutMs, true));   // a refusal proves the host answered
      case "http": {
        const code = await httpStatus(c.url, timeoutMs);
        return probe(c.ok === "200" && code !== 200 ? `answered ${code}, expected 200` : null);
      }
      case "bridge": {
        const b = bridge();
        if (!b) return { short: "no report yet", full: "the bridge hasn't reported yet" };
        if (!b.hapEnabled) return { short: "HomeKit off (test)", full: "HomeKit is off on this instance (test)" };
        return b.paired ? null : { short: "not paired", full: "not paired with Home" };
      }
      case "blocked": {
        const full = c.reason || "can't be checked from here";
        return { short: c.short || (full === IPVLAN_REASON ? IPVLAN_SHORT : "can't check yet"), full };
      }
      default: return { short: "bad setting", full: `unknown check kind "${(c as { kind?: unknown }).kind}" in the dashboard settings file` };
    }
  } catch (err) {
    return probe((err as Error).message);
  }
}

/** The full reason only (null = healthy). Never throws. */
export async function runCheck(c: ServiceCheck, bridge: () => DashBridgeInfo | null, timeoutMs = 3000): Promise<string | null> {
  return (await runCheckDetailed(c, bridge, timeoutMs))?.full ?? null;
}

export class ServiceWatcher {
  private fails = new Map<string, number>();
  constructor(private readonly failsBeforeDown = 2) {}

  async poll(tree: ServiceNode[], bridge: () => DashBridgeInfo | null): Promise<LightNode[]> {
    const flat: ServiceNode[] = [];
    const walk = (ns: ServiceNode[]) => ns.forEach((n) => { flat.push(n); walk(n.children ?? []); });
    walk(tree);
    const raw = new Map(await Promise.all(flat.map(async (n) => [n.id, await runCheckDetailed(n.check, bridge)] as const)));
    const up = new Map<string, boolean>();
    for (const [id, reason] of raw) {
      const f = reason === null ? 0 : (this.fails.get(id) ?? 0) + 1;
      this.fails.set(id, f);
      up.set(id, reason === null || f < this.failsBeforeDown);   // one miss is a blip, not an outage
    }
    // Everything below a node that isn't green, for a rollup's own reason ("which, and why").
    const notGreen = (n: ServiceNode, under: string | null, acc: { name: string; r: Reason }[] = []) => {
      for (const k of n.children ?? []) {
        if (!up.get(k.id)) acc.push({ name: under ? `${k.name} (under ${under})` : k.name, r: raw.get(k.id)! });
        notGreen(k, k.name, acc);
      }
      return acc;
    };
    const build = (n: ServiceNode): LightNode => {
      const ok = up.get(n.id)!;
      const below = n.rollup && ok ? notGreen(n, null) : [];
      const state: Light = !ok ? "down" : below.length ? "warn" : "ok";
      let reason: Reason | null = ok ? null : raw.get(n.id) ?? { short: "check failed", full: "the check gave no reason" };
      if (state === "warn") {
        const blocked = below.every((x) => x.r.short === IPVLAN_SHORT);
        reason = { short: blocked ? `${below.length} can't be checked yet` : `${below.length} check${below.length === 1 ? "" : "s"} not green`,
          full: `Below this: ${below.map((x) => `${x.name}: ${x.r.short}`).join("; ")}.` };
      }
      const out: LightNode = { id: n.id, name: n.name, state, short: reason?.short ?? null, reason: reason?.full ?? null, children: (n.children ?? []).map(build) };
      if (n.link && /^https?:\/\//.test(n.link)) out.link = n.link;
      return out;
    };
    return tree.map(build);
  }
}
