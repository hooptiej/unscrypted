/**
 * Generic child-process supervisor. Keeps one child running, restarts it with exponential
 * backoff when it dies, and reports its state loudly. A child crashing never throws into the
 * caller: the HomeKit bridge keeps running whatever happens to go2rtc or the admin pane.
 */

import { ChildProcess } from "child_process";
import { Logger } from "../logger";

export type ChildState = "starting" | "running" | "backoff" | "stopped" | "missing";
export interface ChildStatus { name: string; state: ChildState; restarts: number; lastError: string | null; nextRetryAt: number | null; since: number }
export interface SupervisorOptions {
  name: string;
  /** spawn() or fork() the child. May throw; that's reported and retried like a crash. */
  start: () => ChildProcess;
  log: Logger;
  minBackoffMs?: number;   // default 1000
  maxBackoffMs?: number;   // default 60000
  healthyResetMs?: number; // default 300000: a run this long resets the backoff
  onState?: (s: ChildStatus) => void;
}

export class Supervisor {
  private proc: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private backoff: number;
  private wanted = false;
  private st: ChildStatus;
  private startedAt = 0;

  constructor(private readonly o: SupervisorOptions) {
    this.backoff = o.minBackoffMs ?? 1000;
    this.st = { name: o.name, state: "stopped", restarts: 0, lastError: null, nextRetryAt: null, since: Date.now() };
  }

  status(): ChildStatus { return { ...this.st }; }
  child(): ChildProcess | null { return this.proc; }

  private set(p: Partial<ChildStatus>): void {
    this.st = { ...this.st, ...p, since: p.state && p.state !== this.st.state ? Date.now() : this.st.since };
    try {
      this.o.onState?.(this.status());
    } catch (err) {
      this.o.log.error(`${this.o.name}: state listener threw (ignored, supervisor keeps going): ${(err as Error).stack ?? err}`);
    }
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.launch();
  }

  private launch(): void {
    this.timer = null;
    if (!this.wanted) return;
    this.set({ state: "starting", nextRetryAt: null });
    let proc: ChildProcess;
    try {
      proc = this.o.start();
    } catch (err) {
      this.startedAt = Date.now();
      this.fail(`could not start: ${(err as Error).message}`, false);
      return;
    }
    this.proc = proc;
    this.startedAt = Date.now();
    let spawned = false;
    proc.once("spawn", () => {
      spawned = true;
      if (this.proc === proc) this.set({ state: "running" });
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (spawned) {
        // e.g. a failed kill() or IPC send on a live child: it's still running, and 'exit' will
        // tell us if it dies. Relaunching here would leave two copies running.
        this.o.log.error(`${this.o.name} child error (it is still running): ${err.message}`);
        return;
      }
      if (this.proc !== proc) return;
      this.proc = null;
      this.fail(`could not start: ${err.message}`, err.code === "ENOENT");
    });
    proc.once("exit", (code, signal) => {
      if (this.proc !== proc) return;   // already handled by 'error', or stop() took it
      this.proc = null;
      if (!this.wanted) { this.set({ state: "stopped" }); return; }
      this.fail(signal ? `killed by ${signal}` : `exited with code ${code}`, false);
    });
  }

  private fail(reason: string, missing: boolean): void {
    if (!this.wanted) {
      this.set({ state: "stopped", lastError: reason, nextRetryAt: null });
      return;
    }
    if (Date.now() - this.startedAt > (this.o.healthyResetMs ?? 300_000)) this.backoff = this.o.minBackoffMs ?? 1000;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.o.maxBackoffMs ?? 60_000);
    const secs = wait >= 1000 ? `${Math.round(wait / 1000)}s` : `${wait}ms`;
    this.o.log.error(`${this.o.name} ${reason}; restarting in ${secs} (the HomeKit bridge is unaffected)`);
    this.set({ state: missing ? "missing" : "backoff", lastError: reason, restarts: this.st.restarts + 1, nextRetryAt: Date.now() + wait });
    this.timer = setTimeout(() => this.launch(), wait);
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null && p.signalCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.o.log.warn(`${this.o.name} didn't exit within 3s of SIGTERM; sending SIGKILL`);
          p.kill("SIGKILL");
          resolve();
        }, 3000);
        p.once("exit", () => { clearTimeout(t); resolve(); });
        if (!p.kill("SIGTERM")) {
          // kill() returns false when the signal couldn't be delivered (usually: already gone).
          clearTimeout(t);
          resolve();
        }
      });
    }
    this.set({ state: "stopped", nextRetryAt: null });
  }
}
