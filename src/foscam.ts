/**
 * Foscam CGI client + motion poller.
 *
 * Foscam cameras expose a documented HTTP CGI API:
 *   http://<ip>:88/cgi-bin/CGIProxy.fcgi?cmd=<cmd>&usr=<user>&pwd=<pw>
 *
 * Responses are small XML documents. For motion we poll `getDevState` and read
 * the `motionDetectAlarm` field:
 *   0 = detection disabled on the camera
 *   1 = enabled, no alarm
 *   2 = enabled, alarm triggered
 *
 * We deliberately avoid an XML dependency — the payloads are flat <tag>v</tag>
 * elements, so a regex read is robust enough and keeps the image tiny.
 *
 * (ONVIF event subscription on port 888 is a lower-latency option for later;
 * CGI polling is the simple, dependency-free first cut.)
 */

import * as http from "http";
import * as https from "https";
import { Logger } from "./logger";
import { redactCgi } from "./util";

export interface FoscamClientOptions {
  cgiBase: string; // e.g. http://192.168.1.50:88  (no trailing slash)
  username: string;
  password: string;
  timeoutMs?: number;
}

export class FoscamClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly opts: FoscamClientOptions,
    private readonly log: Logger,
  ) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  /** Build a CGI URL for a command. Credentials are URL-encoded. */
  buildUrl(cmd: string, extra: Record<string, string> = {}): string {
    const params = new URLSearchParams({
      cmd,
      usr: this.opts.username,
      pwd: this.opts.password,
      ...extra,
    });
    return `${this.opts.cgiBase}/cgi-bin/CGIProxy.fcgi?${params.toString()}`;
  }

  /** Issue a CGI command and return the raw response body. */
  request(cmd: string, extra: Record<string, string> = {}): Promise<string> {
    const url = this.buildUrl(cmd, extra);
    const isHttps = url.startsWith("https:");
    const lib = isHttps ? https : http;

    return new Promise<string>((resolve, reject) => {
      const req = lib.get(url, { timeout: this.timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(
                `Foscam CGI ${cmd} HTTP ${res.statusCode} (${redactCgi(url)})`,
              ),
            );
            return;
          }
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      });
      req.on("timeout", () => {
        req.destroy(new Error(`Foscam CGI ${cmd} timed out after ${this.timeoutMs}ms`));
      });
      req.on("error", (err) => reject(err));
    });
  }

  /** Read a single flat XML field value, or undefined if absent. */
  static readField(body: string, field: string): string | undefined {
    const m = new RegExp(`<${field}>([^<]*)</${field}>`, "i").exec(body);
    return m ? m[1] : undefined;
  }

  /**
   * Poll getDevState and return the motionDetectAlarm value as a number, or
   * undefined if the camera didn't report it. Throws on network/HTTP failure.
   */
  async getMotionState(): Promise<number | undefined> {
    const body = await this.request("getDevState");
    const raw = FoscamClient.readField(body, "motionDetectAlarm");
    if (raw === undefined) {
      return undefined;
    }
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? undefined : n;
  }
}

export interface MotionPollerOptions {
  pollIntervalMs: number;
  /** Hold the sensor "on" this long after the last trigger before clearing. */
  cooldownMs: number;
}

/**
 * Polls a Foscam camera and drives a motion callback. Degrades gracefully: if
 * the camera is unreachable it logs (throttled) and keeps trying — it never
 * throws out of the poll loop, and never silently stops.
 */
export class MotionPoller {
  private timer: NodeJS.Timeout | null = null;
  private clearTimer: NodeJS.Timeout | null = null;
  private motionOn = false;
  private consecutiveErrors = 0;
  private lastErrorLogged = 0;
  private stopped = false;

  constructor(
    private readonly client: FoscamClient,
    private readonly options: MotionPollerOptions,
    private readonly onMotion: (active: boolean) => void,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.stopped = false;
    this.log.info(
      `motion poller started (every ${this.options.pollIntervalMs}ms, cooldown ${this.options.cooldownMs}ms)`,
    );
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
  }

  private scheduleNext(delay: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const state = await this.client.getMotionState();
      this.consecutiveErrors = 0;
      if (state === 2) {
        this.trigger();
      } else if (state === 0) {
        // Detection disabled on the camera — warn once in a while so a
        // misconfigured camera doesn't fail silently.
        this.maybeWarn(
          "camera reports motion detection is DISABLED (motionDetectAlarm=0); " +
            "enable it in the Foscam settings or no HomeKit motion events will fire",
        );
      }
      // state === 1 (armed, no alarm) or undefined: nothing to do.
    } catch (err) {
      this.consecutiveErrors += 1;
      this.maybeWarn(
        `motion poll failed (${this.consecutiveErrors} in a row): ${(err as Error).message}`,
      );
    } finally {
      this.scheduleNext(this.options.pollIntervalMs);
    }
  }

  private maybeWarn(msg: string): void {
    const now = Date.now();
    if (now - this.lastErrorLogged > 30_000) {
      this.lastErrorLogged = now;
      this.log.warn(msg);
    } else {
      this.log.debug(msg);
    }
  }

  private trigger(): void {
    if (!this.motionOn) {
      this.motionOn = true;
      this.log.info("motion detected -> MotionSensor ON");
      this.onMotion(true);
    }
    // (Re)arm the cooldown clear.
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
    }
    this.clearTimer = setTimeout(() => {
      this.motionOn = false;
      this.log.info("motion cleared -> MotionSensor OFF");
      this.onMotion(false);
      this.clearTimer = null;
    }, this.options.cooldownMs);
  }
}
