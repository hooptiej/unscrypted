/**
 * go2rtc: writes its YAML (mode 0600, it holds camera passwords) to a runtime dir, keeps the
 * binary running under a Supervisor, and talks to its loopback-only HTTP API. go2rtc only feeds
 * the admin pane's previews and feed checks; HomeKit never depends on it.
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { spawn } from "child_process";
import { Logger } from "../logger";
import { ResolvedConfig } from "../config";
import { Supervisor, ChildStatus } from "./supervisor";
import { buildGo2rtcYaml, Go2rtcPorts } from "./go2rtcConfig";

export interface Go2rtcOptions { binary: string; runtimeDir: string; ports: Go2rtcPorts; log: Logger; onState?: (s: ChildStatus) => void }

const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)[^@\s]*@/gi;

/** go2rtc sometimes logs a stream's source URL; keep camera passwords out of `docker logs`. */
export function maskSecretsInLine(line: string): string {
  return line.replace(URL_PASSWORD, "$1***@");
}

export class Go2rtcManager {
  private readonly sup: Supervisor;
  private readonly yamlPath: string;
  private configError: string | null = null;
  private reloading: Promise<void> = Promise.resolve();

  constructor(private readonly o: Go2rtcOptions) {
    this.yamlPath = path.join(o.runtimeDir, "go2rtc.yaml");
    this.sup = new Supervisor({
      name: "go2rtc",
      log: o.log,
      onState: o.onState,
      start: () => {
        const p = spawn(o.binary, ["-config", this.yamlPath], { stdio: ["ignore", "pipe", "pipe"] });
        const pipe = (b: Buffer) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => o.log.info(maskSecretsInLine(l)));
        p.stdout?.on("data", pipe);
        p.stderr?.on("data", pipe);
        return p;
      },
    });
  }

  private writeYaml(cfg: Pick<ResolvedConfig, "cameras">): void {
    fs.mkdirSync(this.o.runtimeDir, { recursive: true, mode: 0o700 });
    const tmp = this.yamlPath + ".tmp";
    fs.writeFileSync(tmp, buildGo2rtcYaml(cfg, this.o.ports), { mode: 0o600 });
    fs.renameSync(tmp, this.yamlPath);
  }

  /** Writes the YAML and starts go2rtc. Never throws: a failure shows up in status() and the log. */
  start(cfg: Pick<ResolvedConfig, "cameras">): void {
    try {
      this.writeYaml(cfg);
    } catch (err) {
      this.configError = `couldn't write ${this.yamlPath}: ${(err as Error).message}`;
      this.o.log.error(`go2rtc not started: ${this.configError}. Feed previews and checks are unavailable; the HomeKit bridge is unaffected. Check that ${this.o.runtimeDir} is writable.`);
      this.o.onState?.(this.status());
      return;
    }
    this.configError = null;
    this.sup.start();
  }

  /**
   * Rewrites the YAML and restarts the go2rtc child (a few seconds of no preview; HomeKit is
   * unaffected). Reloads are serialized. Rejects if the YAML can't be written, in which case
   * go2rtc keeps running with the previous camera list.
   */
  reload(cfg: Pick<ResolvedConfig, "cameras">): Promise<void> {
    const run = async () => {
      try {
        this.writeYaml(cfg);
      } catch (err) {
        throw new Error(`couldn't write ${this.yamlPath} (${(err as Error).message}); go2rtc keeps running with the previous camera list`);
      }
      this.configError = null;
      await this.sup.stop();
      this.sup.start();
    };
    const next = this.reloading.then(run, run);
    this.reloading = next.catch(() => undefined);   // the caller gets the rejection via `next`
    return next;
  }

  async stop(): Promise<void> {
    await this.reloading;
    await this.sup.stop();
  }

  status(): ChildStatus {
    const s = this.sup.status();
    return this.configError && s.state === "stopped" ? { ...s, lastError: this.configError } : s;
  }

  apiBase(): string { return `http://127.0.0.1:${this.o.ports.api}`; }
}

export class Go2rtcClient {
  constructor(private readonly base: string, private readonly timeoutMs = 15000) {}

  private req(method: string, p: string): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const r = http.request(this.base + p, { method }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      r.setTimeout(this.timeoutMs, () => r.destroy(new Error(`go2rtc did not answer within ${this.timeoutMs / 1000}s`)));
      r.on("error", reject);
      r.end();
    });
  }

  async addTempStream(name: string, src: string): Promise<void> {
    const r = await this.req("PUT", `/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`);
    if (r.status >= 300) throw new Error(r.body.toString() || `HTTP ${r.status}`);
  }

  async removeStream(name: string): Promise<void> {
    const r = await this.req("DELETE", `/api/streams?src=${encodeURIComponent(name)}`);
    if (r.status >= 300) throw new Error(r.body.toString() || `HTTP ${r.status}`);
  }

  async frame(src: string): Promise<Buffer> {
    const r = await this.req("GET", `/api/frame.jpeg?src=${encodeURIComponent(src)}`);
    if (r.status !== 200 || r.body.length === 0) throw new Error(r.body.toString() || `HTTP ${r.status}`);
    return r.body;
  }
}

export function explainGo2rtcFailure(raw: string): { happened: string; next: string } {
  const s = raw.toLowerCase();
  if (/401|unauthorized|wrong user/.test(s)) return { happened: "The camera rejected the login (user name or password is wrong).", next: "Re-enter the camera's password and check the user name, then try the check again." };
  if (/connection refused/.test(s)) return { happened: "The camera refused the connection on that port.", next: "Check the RTSP port (usually 554) and that RTSP is enabled in the camera's own settings." };
  if (/timeout|no route|host is unreachable|no such host/.test(s)) return { happened: "The camera didn't answer at that address.", next: "Check the IP address and that the camera is powered and on the network (try pinging it)." };
  if (/404|not found/.test(s)) return { happened: "The camera answered but has no stream at that path.", next: "Check the stream path (Foscam: /videoMain, XM cameras: /11 and /12)." };
  return { happened: `go2rtc reported: ${raw}`, next: "Check the URL and login. If it looks right, look at `docker logs unscrypted` for the go2rtc lines around this time." };
}
