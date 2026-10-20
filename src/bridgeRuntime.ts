/**
 * Bridge-side runtime for the admin pane: keeps the camera registry, applies saved camera
 * changes at runtime, builds the status snapshot, and supervises the two children (go2rtc and
 * the admin web server). Nothing here may take the HomeKit bridge down: every child is
 * supervised, and every message from the admin child is handled inside a try/catch whose
 * failure goes back to the pane as a plain-words error.
 */

import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { fork } from "child_process";
import { Bridge } from "hap-nodejs";
import { loadConfig, ConfigError, ResolvedConfig, ResolvedCamera } from "./config";
import { Logger } from "./logger";
import { UnscryptedCamera } from "./camera";
import { Supervisor, ChildStatus } from "./admin/supervisor";
import { Go2rtcManager } from "./admin/go2rtc";
import { streamNames } from "./admin/go2rtcConfig";
import { ApplyMode, BridgeStatus, CameraStatus, ToAdmin, checkToBridge, classifyChange, motionKindOf } from "./admin/ipc";
import { UserError, toErrorJson } from "./admin/errors";

export interface RuntimeOptions {
  config: ResolvedConfig;
  configPath: string;
  /** The published bridge, or null when HAP is off (test instance). */
  bridge: Bridge | null;
  cameras: UnscryptedCamera[];
  log: Logger;
  ffmpegPath: string;
  version: string;
  admin: { port: number; enabled: boolean; disabledReason?: string };
  go2rtc: { binary: string; apiPort: number; webrtcPort: number | null; runtimeDir: string; enabled: boolean; disabledReason?: string };
  /** Graceful shutdown; Docker's restart policy brings the bridge back. */
  requestRestart: (reason: string) => void;
}

/** The admin child's entry: compiled main.js, or main.ts when running under tsx (npm run dev). */
function resolveAdminEntry(): string | null {
  const js = path.join(__dirname, "admin", "main.js");
  if (fs.existsSync(js)) return js;
  const ts = path.join(__dirname, "admin", "main.ts");
  if (__filename.endsWith(".ts") && fs.existsSync(ts)) return ts;
  return null;
}

export class BridgeRuntime {
  private readonly cams = new Map<string, UnscryptedCamera>();
  private readonly pendingRestart = new Set<string>();
  private readonly reach = new Map<string, { ok: boolean | null; at: number | null; err: string | null }>();
  private config: ResolvedConfig;
  private go2rtc: Go2rtcManager | null = null;
  private go2rtcOff: string | null = null;
  private admin: Supervisor | null = null;
  private readonly startedAt = Date.now();
  private timers: NodeJS.Timeout[] = [];
  private probing = false;
  private lastStatusError: string | null = null;

  constructor(private readonly o: RuntimeOptions) {
    this.config = o.config;
    for (const c of o.cameras) this.cams.set(c.name, c);
  }

  start(): void {
    const log = this.o.log;
    const g = this.o.go2rtc;
    if (!g.enabled) {
      this.go2rtcOff = g.disabledReason ?? "disabled in this instance (UNSCRYPTED_GO2RTC=off)";
      log.info(`go2rtc not started: ${this.go2rtcOff}. Feed previews and checks are unavailable.`);
    } else if (path.isAbsolute(g.binary) && !fs.existsSync(g.binary)) {
      this.go2rtcOff = `go2rtc binary not found at ${g.binary}`;
      log.warn(
        `${this.go2rtcOff}: feed previews and checks are unavailable; the HomeKit bridge is unaffected. ` +
          "Install go2rtc there or set UNSCRYPTED_GO2RTC_BIN (UNSCRYPTED_GO2RTC=off silences this).",
      );
    } else {
      this.go2rtc = new Go2rtcManager({
        binary: g.binary, runtimeDir: g.runtimeDir, ports: { api: g.apiPort, webrtc: g.webrtcPort },
        log: log.child("go2rtc"), onState: () => this.pushStatus(),
      });
      this.go2rtc.start(this.config);
    }

    const a = this.o.admin;
    const entry = a.enabled ? resolveAdminEntry() : null;
    if (!a.enabled) {
      log.info(`admin pane not started: ${a.disabledReason ?? "disabled (UNSCRYPTED_ADMIN=off)"}.`);
    } else if (!entry) {
      log.warn(
        `admin pane not started: this build has no admin server (${path.join(__dirname, "admin", "main.js")} is missing). ` +
          "The HomeKit bridge is unaffected.",
      );
    } else {
      this.admin = new Supervisor({
        name: "admin-pane", log: log.child("admin"), onState: () => this.pushStatus(),
        start: () => {
          const child = fork(entry, [], {
            env: {
              ...process.env,
              UNSCRYPTED_ADMIN_PORT: String(a.port),
              UNSCRYPTED_CONFIG: this.o.configPath,
              UNSCRYPTED_GO2RTC_API: this.go2rtc?.apiBase() ?? "",
              // Sign-in key lives beside the pairing state so sign-ins survive restarts.
              UNSCRYPTED_ADMIN_KEY_FILE: process.env.UNSCRYPTED_ADMIN_KEY_FILE
                || path.join(path.dirname(this.o.config.persistDir), "admin-session.key"),
            },
          });
          child.on("message", (m: unknown) => void this.onMessage(m));
          setTimeout(() => this.pushStatus(), 200);
          return child;
        },
      });
      this.admin.start();
      log.info(`admin pane starting on port ${a.port}`);
    }

    this.timers.push(setInterval(() => this.pushStatus(), 2000));
    this.timers.push(setInterval(() => void this.probeAll(), 30_000));
    void this.probeAll();
  }

  /** Cheap reachability: can we open a TCP connection to the camera's RTSP host:port? */
  private async probeAll(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      await Promise.all(this.config.cameras.map(async (c) => {
        const res = await probeRtsp(c.rtspMain);
        this.reach.set(c.name, { ok: res.ok, at: Date.now(), err: res.err });
      }));
    } finally {
      this.probing = false;
    }
  }

  private go2rtcStatus(): ChildStatus {
    if (this.go2rtc) return this.go2rtc.status();
    return {
      name: "go2rtc", state: this.go2rtcOff?.startsWith("go2rtc binary not found") ? "missing" : "stopped",
      restarts: 0, lastError: this.go2rtcOff, nextRetryAt: null, since: this.startedAt,
    };
  }

  status(): BridgeStatus {
    const names = streamNames(this.config.cameras);
    const b = this.o.bridge;
    const cameras: CameraStatus[] = this.config.cameras.map((rc) => {
      const cam = this.cams.get(rc.name);
      const r = this.reach.get(rc.name);
      const s = cam?.snapshotStatus();
      return {
        name: rc.name, stream: names.get(rc.name)!.main, hksv: rc.hksv,
        motionKind: s?.motionKind ?? motionKindOf(rc),
        reachable: r?.ok ?? null, reachableCheckedAt: r?.at ?? null, reachError: r?.err ?? null,
        liveSessions: s?.liveSessions ?? 0, recordingActive: s?.recordingActive ?? false,
        motionActive: s?.motionActive ?? false, lastMotionAt: s?.lastMotionAt ?? null,
        pendingRestart: this.pendingRestart.has(rc.name) || !cam,
      };
    });
    return {
      bridgeName: this.config.bridge.name, pin: this.config.bridge.pin,
      setupURI: b ? b.setupURI() : "", paired: Boolean(b?._accessoryInfo?.paired()),
      hapPort: b ? this.config.bridge.port : null, hapEnabled: Boolean(b),
      cameras, go2rtc: this.go2rtcStatus(), startedAt: this.startedAt, version: this.o.version,
    };
  }

  private send(m: ToAdmin): void {
    const c = this.admin?.child();
    if (!c?.connected) return;   // no pane running: nothing to tell (status is re-sent on connect)
    try {
      c.send(m, (err) => {
        if (err) this.o.log.warn(`couldn't send "${m.type}" to the admin pane: ${err.message}`);
      });
    } catch (err) {
      this.o.log.warn(`couldn't send "${m.type}" to the admin pane: ${(err as Error).message}`);
    }
  }

  private pushStatus(): void {
    if (!this.admin?.child()?.connected) return;
    let status: BridgeStatus;
    try {
      status = this.status();
      this.lastStatusError = null;
    } catch (err) {
      const msg = (err as Error).stack ?? String(err);
      if (msg !== this.lastStatusError) {
        this.o.log.error(`couldn't build the admin status snapshot (the pane will show stale status): ${msg}`);
        this.lastStatusError = msg;
      }
      return;
    }
    this.send({ type: "status", status });
  }

  private async onMessage(raw: unknown): Promise<void> {
    const m = checkToBridge(raw);
    if (typeof m === "string") {
      this.o.log.warn(`ignored a malformed message from the admin pane: ${m}`);
      const reqId = (raw as { reqId?: unknown } | null)?.reqId;
      if (typeof reqId === "string") {
        this.send({ type: "applied", reqId, ok: false, error: {
          attempted: "Send a request to the bridge", happened: `The bridge didn't understand it: ${m}.`,
          changed: "Nothing.", next: "Reload the page. If it repeats, the pane and bridge versions differ; restart the container." } });
      }
      return;
    }
    try {
      if (m.type === "apply") {
        await this.applyCamera(m.reqId, m.name);
      } else if (m.type === "reload-go2rtc") {
        if (!this.go2rtc) {
          throw new UserError({ attempted: "Restart go2rtc", happened: `go2rtc isn't running in this instance: ${this.go2rtcOff}.`,
            changed: "Nothing.", next: "Install go2rtc in the image (or set UNSCRYPTED_GO2RTC_BIN) and restart the container." }, 409);
        }
        await this.go2rtc.reload(this.config);
        this.send({ type: "applied", reqId: m.reqId, ok: true, mode: "live", message: "go2rtc restarted with the current config." });
      } else {
        this.send({ type: "applied", reqId: m.reqId, ok: true, mode: "restart-needed",
          message: "Bridge is restarting now. Home will show cameras as No Response for about 30 seconds." });
        setTimeout(() => this.o.requestRestart("restart requested from the admin pane"), 500);
      }
    } catch (err) {
      const attempted = m.type === "apply" ? `Apply the saved change to "${m.name}"` : "Handle a request from the admin pane";
      if (!(err instanceof UserError)) this.o.log.error(`${attempted} failed: ${(err as Error).stack ?? err}`);
      const { body } = toErrorJson(err, attempted);
      this.send({ type: "applied", reqId: m.reqId, ok: false, error: body.error });
    }
  }

  private async applyCamera(reqId: string, name: string): Promise<void> {
    let next: ResolvedConfig;
    try {
      next = loadConfig(this.o.configPath);   // validated by the existing loader
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new UserError({
          attempted: `Apply the saved change to "${name}"`,
          happened: `config.json no longer loads: ${err.message}`,
          changed: "The running bridge kept its previous settings.",
          next: "Fix config.json (or restore the newest copy from ./config/backups), then save again.",
        });
      }
      throw err;
    }
    const after = next.cameras.find((c) => c.name === name);
    if (!after) {
      throw new UserError({
        attempted: `Apply the saved change to "${name}"`,
        happened: "That camera isn't in config.json any more.",
        changed: "The running bridge kept its previous settings.",
        next: "Reload the page; config.json may have been edited by hand.",
      }, 404);
    }
    const cam = this.cams.get(name);
    // Compare against what is actually running, so a change still waiting for a restart keeps
    // saying so even if a later, live-only edit arrives.
    const before = cam?.resolved;
    let mode: ApplyMode = classifyChange(before, after);
    let message: string;

    if (mode === "live" && cam) {
      cam.reconfigure(after);
      this.pendingRestart.delete(name);
      message = `Saved and applied to "${name}" without restarting. Home was not disturbed.`;
    } else if (mode === "added") {   // also a boot-time camera that failed to configure (no instance)
      ({ mode, message } = this.addCamera(after));
    } else {
      this.pendingRestart.add(name);
      message = `Saved. "${name}" changed something Home sees (HKSV, prebuffer, motion source or model), so it takes effect after a bridge restart. Use "Restart bridge" when convenient.`;
    }

    // Adopt only this camera's new settings. bridge.* and the persist folder never change at runtime.
    const idx = this.config.cameras.findIndex((c) => c.name === name);
    const cameras = [...this.config.cameras];
    if (idx >= 0) cameras[idx] = after; else cameras.push(after);
    this.config = { ...this.config, cameras };

    if (this.go2rtc) {
      try {
        await this.go2rtc.reload(this.config);
      } catch (err) {
        this.o.log.error(`go2rtc reload after saving "${name}" failed: ${(err as Error).message}`);
        message += ` The live preview wasn't updated: ${(err as Error).message}.`;
      }
    }
    this.send({ type: "applied", reqId, ok: true, mode, message });
    this.pushStatus();
  }

  private addCamera(after: ResolvedCamera): { mode: ApplyMode; message: string } {
    const name = after.name;
    let cam: UnscryptedCamera;
    try {
      cam = new UnscryptedCamera(after, this.o.ffmpegPath, this.o.log);
      if (this.o.bridge) this.o.bridge.addBridgedAccessory(cam.accessory);
    } catch (err) {
      this.pendingRestart.add(name);
      this.o.log.error(`couldn't add camera "${name}" at runtime: ${(err as Error).stack ?? err}`);
      return {
        mode: "restart-needed",
        message: `Saved to config.json, but "${name}" couldn't be added without a restart (${(err as Error).message}). Use "Restart bridge"; if it still fails, the bridge log says why.`,
      };
    }
    this.cams.set(name, cam);
    this.pendingRestart.delete(name);
    if (!this.o.bridge) {
      return { mode: "added", message: `Added "${name}". HomeKit is off on this instance, so it won't appear in Home.` };
    }
    cam.start();
    return { mode: "added", message: `Added "${name}". It should appear in Home within a minute (pull down to refresh the Home app).` };
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    const results = await Promise.allSettled([this.admin?.stop(), this.go2rtc?.stop()]);
    for (const r of results) {
      if (r.status === "rejected") this.o.log.warn(`error stopping a child process during shutdown: ${(r.reason as Error)?.message ?? r.reason}`);
    }
  }
}

/** TCP connect to the RTSP host:port within 3s. Never rejects. */
export function probeRtsp(rtspUrl: string, timeoutMs = 3000): Promise<{ ok: boolean; err: string | null }> {
  let host = "";
  let port = 554;
  try {
    const u = new URL(rtspUrl);
    host = u.hostname;
    port = Number(u.port || 554);
  } catch (err) {
    return Promise.resolve({ ok: false, err: `stream URL can't be parsed (${(err as Error).message})` });
  }
  if (!host) return Promise.resolve({ ok: false, err: "stream URL has no host" });
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: timeoutMs });
    s.once("connect", () => { s.destroy(); resolve({ ok: true, err: null }); });
    s.once("timeout", () => { s.destroy(); resolve({ ok: false, err: `no answer from ${host}:${port} within ${timeoutMs / 1000}s` }); });
    s.once("error", (e) => { s.destroy(); resolve({ ok: false, err: `${host}:${port}: ${e.message}` }); });
  });
}
