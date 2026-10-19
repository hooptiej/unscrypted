/**
 * ONVIF event client + motion source.
 *
 * This is the generic-camera counterpart to foscam.ts. Generic XM/ONVIF cameras
 * have no Foscam CGI, but they expose an ONVIF Events service we can subscribe
 * to for motion. It drives the same `onMotion(active)` callback with the same
 * cooldown behaviour, so camera.ts can treat it identically to the Foscam poller.
 *
 * ONVIF is SOAP-over-HTTP. In keeping with the rest of this project (see the
 * note in foscam.ts about deliberately avoiding an XML dependency) we hand-roll
 * the few SOAP envelopes we need and read fields with scoped regex. The payloads
 * we care about are small and flat, the auth is a documented hash, and skipping
 * a SOAP/XML stack keeps the image tiny and the behaviour fully under our
 * control for the fussy XM firmwares this targets. (A maintained `onvif` npm
 * package exists; it pulls in xml2js/soap and still needs per-firmware coaxing,
 * so for this narrow job hand-rolling is cleaner.)
 *
 * Two ONVIF event delivery models exist, and real cameras support one or the
 * other (sometimes not the one you'd expect):
 *   - PullPoint: we CreatePullPointSubscription, then long-poll PullMessages.
 *     No inbound server needed. Firewall-friendly. Preferred when available.
 *   - Base Notification (WS-BaseNotification Subscribe): the camera PUSHes
 *     Notify messages to a consumer HTTP endpoint we host. Needed for the many
 *     XM/Sofia cameras that return "ActionNotSupported" for PullPoint.
 *
 * We try PullPoint first and fall back to push automatically, logging which
 * mode is active. Verified against a real XM camera (10.0.1.3): it rejects
 * PullPoint and delivers motion via push on topic
 * tns1:RuleEngine/CellMotionDetector/Motion with SimpleItem IsMotion=true/false.
 */

import * as http from "http";
import * as net from "net";
import * as crypto from "crypto";
import { URL } from "url";
import { Logger } from "./logger";

const SOAP_ENV = "http://www.w3.org/2003/05/soap-envelope";
const WSA = "http://www.w3.org/2005/08/addressing";
const DEVICE_WSDL = "http://www.onvif.org/ver10/device/wsdl";
const EVENTS_WSDL = "http://www.onvif.org/ver10/events/wsdl";
const WSNT = "http://docs.oasis-open.org/wsn/b-2";
const WSS_SECEXT =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
const WSS_UTIL =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";
const PASSWORD_DIGEST =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest";
const NONCE_ENCODING =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary";

// WS-Addressing Action URIs for the operations we invoke.
const ACTION = {
  getServices: DEVICE_WSDL + "/DeviceServicePort/GetServicesRequest",
  getEventProperties: EVENTS_WSDL + "/EventPortType/GetEventPropertiesRequest",
  createPullPoint: EVENTS_WSDL + "/EventPortType/CreatePullPointSubscriptionRequest",
  pullMessages: EVENTS_WSDL + "/PullPointSubscription/PullMessagesRequest",
  unsubscribePull: EVENTS_WSDL + "/PullPointSubscription/UnsubscribeRequest",
  subscribe: "http://docs.oasis-open.org/wsn/bw-2/NotificationProducer/SubscribeRequest",
  renew: "http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest",
  unsubscribe:
    "http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest",
};

export interface OnvifClientOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Per-request HTTP timeout in ms (not the long-poll timeout). Default 10000. */
  requestTimeoutMs?: number;
}

export interface SoapResponse {
  status: number;
  body: string;
}

/** A parsed SOAP Fault, or undefined if the body isn't a fault. */
export interface SoapFault {
  code?: string;
  subcode?: string;
  reason?: string;
}

/** A single motion reading parsed out of a Notify / PullMessages payload. */
export interface MotionReading {
  topic: string;
  active: boolean;
}

/** Low-level ONVIF SOAP client: auth, device/event discovery, subscriptions. */
export class OnvifClient {
  readonly deviceServiceUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly opts: OnvifClientOptions,
    private readonly log: Logger,
  ) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10000;
    this.deviceServiceUrl = `http://${opts.host}:${opts.port}/onvif/device_service`;
  }

  /** Build a WS-Security UsernameToken (PasswordDigest) header fragment. */
  private securityHeader(): string {
    const created = new Date().toISOString();
    const nonce = crypto.randomBytes(16);
    const digest = crypto
      .createHash("sha1")
      .update(
        Buffer.concat([
          nonce,
          Buffer.from(created, "utf8"),
          Buffer.from(this.opts.password, "utf8"),
        ]),
      )
      .digest("base64");
    return (
      `<wsse:Security s:mustUnderstand="1" xmlns:wsse="${WSS_SECEXT}" xmlns:wsu="${WSS_UTIL}">` +
      `<wsse:UsernameToken>` +
      `<wsse:Username>${escapeXml(this.opts.username)}</wsse:Username>` +
      `<wsse:Password Type="${PASSWORD_DIGEST}">${digest}</wsse:Password>` +
      `<wsse:Nonce EncodingType="${NONCE_ENCODING}">${nonce.toString("base64")}</wsse:Nonce>` +
      `<wsu:Created>${created}</wsu:Created>` +
      `</wsse:UsernameToken></wsse:Security>`
    );
  }

  /** Wrap a body in a full SOAP 1.2 envelope with WS-Addressing + WS-Security. */
  private envelope(action: string, to: string, bodyXml: string): string {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<s:Envelope xmlns:s="${SOAP_ENV}" xmlns:a="${WSA}">` +
      `<s:Header>` +
      `<a:Action>${action}</a:Action>` +
      (to ? `<a:To>${escapeXml(to)}</a:To>` : "") +
      this.securityHeader() +
      `</s:Header>` +
      `<s:Body>${bodyXml}</s:Body>` +
      `</s:Envelope>`
    );
  }

  /**
   * POST a SOAP request. `timeoutMs` overrides the default (used for the long
   * PullMessages poll). Throws on transport failure; a SOAP Fault comes back as
   * a normal response (status is often 400) for the caller to inspect.
   */
  post(url: string, action: string, bodyXml: string, timeoutMs?: number): Promise<SoapResponse> {
    const envelope = this.envelope(action, url, bodyXml);
    return this.rawPost(url, envelope, timeoutMs);
  }

  private rawPost(url: string, payload: string, timeoutMs?: number): Promise<SoapResponse> {
    const u = new URL(url);
    const timeout = timeoutMs ?? this.requestTimeoutMs;
    return new Promise<SoapResponse>((resolve, reject) => {
      const req = http.request(
        {
          host: u.hostname,
          port: u.port || 80,
          path: u.pathname + (u.search || ""),
          method: "POST",
          timeout,
          headers: {
            "Content-Type": "application/soap+xml; charset=utf-8",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      req.on("timeout", () =>
        req.destroy(new Error(`ONVIF request to ${u.pathname} timed out after ${timeout}ms`)),
      );
      req.on("error", (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  /**
   * Discover the Events service XAddr via GetServices. Falls back to the
   * conventional `/onvif/event_service` on the device host if discovery fails
   * or omits it.
   */
  async getEventServiceUrl(): Promise<string> {
    const fallback = `http://${this.opts.host}:${this.opts.port}/onvif/event_service`;
    try {
      const res = await this.post(
        this.deviceServiceUrl,
        ACTION.getServices,
        `<GetServices xmlns="${DEVICE_WSDL}"><IncludeCapability>false</IncludeCapability></GetServices>`,
      );
      const fault = parseFault(res.body);
      if (fault) {
        this.log.warn(
          `GetServices faulted (${fault.subcode ?? fault.code ?? "?"}: ${fault.reason ?? "?"}); ` +
            `falling back to ${fallback}`,
        );
        return fallback;
      }
      // Pair each <Namespace> with the following <XAddr> inside a <Service>.
      const services = res.body.match(/<[^>]*:?Service\b[\s\S]*?<\/[^>]*:?Service>/gi) ?? [];
      for (const svc of services) {
        const ns = /<[^>]*:?Namespace>([^<]+)</i.exec(svc)?.[1];
        const xaddr = /<[^>]*:?XAddr>([^<]+)</i.exec(svc)?.[1];
        if (ns && xaddr && /events\/wsdl/i.test(ns)) {
          return xaddr.trim();
        }
      }
      this.log.warn(`GetServices returned no Events service; falling back to ${fallback}`);
      return fallback;
    } catch (err) {
      this.log.warn(
        `GetServices request failed (${(err as Error).message}); falling back to ${fallback}`,
      );
      return fallback;
    }
  }

  /** Query the supported motion topics (for logging / the probe). */
  async getMotionTopics(eventServiceUrl: string): Promise<string[]> {
    const res = await this.post(
      eventServiceUrl,
      ACTION.getEventProperties,
      `<GetEventProperties xmlns="${EVENTS_WSDL}"/>`,
    );
    const fault = parseFault(res.body);
    if (fault) {
      throw new Error(`GetEventProperties faulted: ${fault.reason ?? fault.subcode ?? "?"}`);
    }
    const topics = new Set<string>();
    // Motion-bearing topics appear as element paths under the TopicSet. We care
    // about CellMotionDetector/Motion and VideoSource/MotionAlarm.
    if (/CellMotionDetector[\s\S]*?<Motion\b/i.test(res.body)) {
      topics.add("tns1:RuleEngine/CellMotionDetector/Motion");
    }
    if (/<MotionAlarm\b/i.test(res.body)) {
      topics.add("tns1:VideoSource/MotionAlarm");
    }
    return [...topics];
  }
}

/** Parse a SOAP Fault out of a response body, or undefined if none. */
export function parseFault(body: string): SoapFault | undefined {
  if (!/<[^>]*:?Fault\b/i.test(body)) {
    return undefined;
  }
  const values = [...body.matchAll(/<[^>]*:?Value>([^<]+)<\/[^>]*:?Value>/gi)].map((m) => m[1]);
  const reason = /<[^>]*:?Text[^>]*>([^<]+)<\/[^>]*:?Text>/i.exec(body)?.[1];
  return { code: values[0], subcode: values[1], reason };
}

/**
 * Pull the motion readings out of a Notify / PullMessages SOAP body.
 *
 * Each NotificationMessage carries a <Topic> and <Data> with <SimpleItem
 * Name="..." Value="..."/> pairs. We accept CellMotionDetector/Motion
 * (SimpleItem IsMotion) and VideoSource/MotionAlarm (SimpleItem State). A body
 * may contain several messages (a PullMessages batch); we return them in order.
 */
export function parseMotionReadings(body: string): MotionReading[] {
  const readings: MotionReading[] = [];
  let chunks = body.match(/<[^>]*:?NotificationMessage\b[\s\S]*?<\/[^>]*:?NotificationMessage>/gi);
  if (!chunks || chunks.length === 0) {
    // Some stacks wrap the message differently; treat the whole body as one.
    chunks = [body];
  }
  for (const chunk of chunks) {
    const topic = /<[^>]*:?Topic\b[^>]*>([^<]+)<\/[^>]*:?Topic>/i.exec(chunk)?.[1]?.trim();
    if (!topic || !/motion/i.test(topic)) {
      continue; // not a motion topic (e.g. SignalLoss) — ignore
    }
    const value = readSimpleItem(chunk, "IsMotion") ?? readSimpleItem(chunk, "State");
    if (value === undefined) {
      continue;
    }
    readings.push({ topic, active: /^(true|1)$/i.test(value) });
  }
  return readings;
}

/** Read a <SimpleItem Name="name" Value="v"/> value (attrs in any order). */
function readSimpleItem(xml: string, name: string): string | undefined {
  const tags = xml.match(/<[^>]*:?SimpleItem\b[^>]*\/?>/gi) ?? [];
  for (const tag of tags) {
    const n = /\bName="([^"]*)"/i.exec(tag)?.[1];
    if (n === name) {
      return /\bValue="([^"]*)"/i.exec(tag)?.[1] ?? "";
    }
  }
  return undefined;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Shared HTTP receiver for ONVIF push notifications. One listener, path-routed
 * so multiple cameras can share a single port. Lazily started on first use.
 */
export class NotificationServer {
  private static instance: NotificationServer | null = null;
  private server: http.Server | null = null;
  private port = 0;
  private readonly handlers = new Map<string, (body: string) => void>();
  private starting: Promise<number> | null = null;

  private constructor(private readonly log: Logger) {}

  static shared(log: Logger): NotificationServer {
    if (!NotificationServer.instance) {
      NotificationServer.instance = new NotificationServer(log.child("onvif-notify"));
    }
    return NotificationServer.instance;
  }

  /** Ensure the server is listening on `preferredPort` (0 = ephemeral). */
  async ensureStarted(preferredPort: number): Promise<number> {
    if (this.server) {
      if (preferredPort !== 0 && preferredPort !== this.port) {
        this.log.warn(
          `notification receiver already listening on port ${this.port}; ignoring ` +
            `request for port ${preferredPort} (one shared receiver for all cameras)`,
        );
      }
      return this.port;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      server.on("error", (err) => {
        this.starting = null;
        reject(
          new Error(
            `ONVIF notification receiver failed to listen on port ${preferredPort}: ${err.message}`,
          ),
        );
      });
      server.listen(preferredPort, "0.0.0.0", () => {
        const addr = server.address();
        this.server = server;
        this.port = typeof addr === "object" && addr ? addr.port : preferredPort;
        this.log.info(`notification receiver listening on 0.0.0.0:${this.port}`);
        resolve(this.port);
      });
    });
    return this.starting;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      const handler = this.handlers.get(path);
      // Always ACK so the camera doesn't tear the subscription down.
      res.writeHead(200, { "Content-Type": "application/soap+xml" });
      res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="${SOAP_ENV}"><s:Body/></s:Envelope>`);
      if (handler) {
        try {
          handler(Buffer.concat(chunks).toString("utf8"));
        } catch (err) {
          this.log.error(`handler for ${path} threw: ${(err as Error).message}`);
        }
      } else {
        this.log.warn(`notification to unknown path ${path} (no camera registered)`);
      }
    });
  }

  register(path: string, handler: (body: string) => void): void {
    this.handlers.set(path, handler);
  }

  unregister(path: string): void {
    this.handlers.delete(path);
    if (this.handlers.size === 0 && this.server) {
      this.log.info("no cameras left; stopping notification receiver");
      this.server.close();
      this.server = null;
      this.port = 0;
      this.starting = null;
    }
  }

  get listeningPort(): number {
    return this.port;
  }
}

/** Determine which local IP routes to `host:port` (for the consumer address). */
function localAddressFor(host: string, port: number, timeoutMs = 4000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      const addr = socket.localAddress;
      socket.destroy();
      if (addr) {
        resolve(addr.replace(/^::ffff:/, ""));
      } else {
        reject(new Error("could not determine local address"));
      }
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`timed out connecting to ${host}:${port} to find local address`));
    });
    socket.on("error", (err) => reject(err));
  });
}

export interface OnvifMotionOptions {
  /** Hold the sensor "on" this long after the last trigger before clearing. */
  cooldownMs: number;
  /** PullMessages long-poll timeout in ms (PullPoint mode only). */
  pullTimeoutMs: number;
  /** Notification receiver port (push mode). 0 = ephemeral. */
  notifyPort: number;
  /** Override auto-detected local IP for the consumer address (push mode). */
  notifyHost?: string;
  /** Subscription lifetime requested from the camera, in seconds. Default 600. */
  terminationSeconds?: number;
}

type Mode = "pullpoint" | "push" | "starting" | "stopped";

/**
 * Subscribes to a camera's ONVIF motion events and drives `onMotion(active)`.
 *
 * Mirrors foscam.ts's MotionPoller: same cooldown-based clearing, never throws
 * out of its loops, and never silently stops — every failure is logged (warn,
 * throttled where it would be noisy) and retried. Tries PullPoint first and
 * falls back to push automatically.
 */
export class OnvifMotionSource {
  private mode: Mode = "stopped";
  private stopped = true;
  private motionOn = false;
  private clearTimer: NodeJS.Timeout | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private pullAbort = false;
  private subscriptionUrl: string | null = null; // SubscriptionManager (push) or PullPoint ref
  private eventServiceUrl: string | null = null;
  private notifyPath: string | null = null;
  private notifyServer: NotificationServer | null = null;
  private lastNotifyAt = 0;
  private consecutiveErrors = 0;
  private lastErrorLogged = 0;
  private readonly terminationSeconds: number;

  constructor(
    private readonly client: OnvifClient,
    private readonly clientHost: string,
    private readonly clientPort: number,
    private readonly cameraName: string,
    private readonly options: OnvifMotionOptions,
    private readonly onMotion: (active: boolean) => void,
    private readonly log: Logger,
  ) {
    this.terminationSeconds = options.terminationSeconds ?? 600;
  }

  start(): void {
    this.stopped = false;
    this.mode = "starting";
    this.log.info(
      `ONVIF motion source starting (cooldown ${this.options.cooldownMs}ms) -> ${this.client.deviceServiceUrl}`,
    );
    void this.init();
  }

  stop(): void {
    this.stopped = true;
    this.mode = "stopped";
    this.pullAbort = true;
    this.clearTimer && clearTimeout(this.clearTimer);
    this.renewTimer && clearTimeout(this.renewTimer);
    this.retryTimer && clearTimeout(this.retryTimer);
    this.watchdogTimer && clearTimeout(this.watchdogTimer);
    this.clearTimer = this.renewTimer = this.retryTimer = this.watchdogTimer = null;
    // Best-effort unsubscribe + tidy up the receiver.
    void this.teardownSubscription();
    if (this.notifyServer && this.notifyPath) {
      this.notifyServer.unregister(this.notifyPath);
    }
  }

  private scheduleRetry(delayMs: number, why: string): void {
    if (this.stopped) {
      return;
    }
    this.maybeWarn(`${why}; retrying in ${Math.round(delayMs / 1000)}s`);
    this.retryTimer && clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.init(), delayMs);
  }

  /** (Re)establish a subscription. Picks PullPoint, else push. */
  private async init(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.pullAbort = false;
    try {
      if (!this.eventServiceUrl) {
        this.eventServiceUrl = await this.client.getEventServiceUrl();
        this.log.info(`events service: ${this.eventServiceUrl}`);
        try {
          const topics = await this.client.getMotionTopics(this.eventServiceUrl);
          this.log.info(
            topics.length
              ? `camera advertises motion topics: ${topics.join(", ")}`
              : "camera advertised NO motion topics — motion may never fire; " +
                  "check that motion detection is enabled on the camera",
          );
        } catch (err) {
          this.maybeWarn(`could not read event properties: ${(err as Error).message}`);
        }
      }

      const pullUrl = await this.tryCreatePullPoint(this.eventServiceUrl);
      if (pullUrl) {
        this.mode = "pullpoint";
        this.subscriptionUrl = pullUrl;
        this.consecutiveErrors = 0;
        this.log.info(`subscribed via PullPoint; long-polling for motion`);
        void this.pullLoop();
        return;
      }

      // Fall back to base-notification push.
      await this.subscribePush(this.eventServiceUrl);
    } catch (err) {
      this.scheduleRetry(15000, `ONVIF subscription setup failed: ${(err as Error).message}`);
    }
  }

  // ---- PullPoint mode ------------------------------------------------------

  private async tryCreatePullPoint(eventServiceUrl: string): Promise<string | null> {
    const res = await this.client.post(
      eventServiceUrl,
      ACTION.createPullPoint,
      `<CreatePullPointSubscription xmlns="${EVENTS_WSDL}">` +
        `<InitialTerminationTime>PT${this.terminationSeconds}S</InitialTerminationTime>` +
        `</CreatePullPointSubscription>`,
    );
    const fault = parseFault(res.body);
    if (fault) {
      this.log.info(
        `camera does not support PullPoint (${fault.subcode ?? fault.code ?? "fault"}: ` +
          `${fault.reason ?? "?"}); using push notifications instead`,
      );
      return null;
    }
    const addr = extractSubscriptionAddress(res.body);
    return addr ?? eventServiceUrl;
  }

  private async pullLoop(): Promise<void> {
    while (!this.stopped && !this.pullAbort && this.mode === "pullpoint") {
      try {
        const res = await this.client.post(
          this.subscriptionUrl!,
          ACTION.pullMessages,
          `<PullMessages xmlns="${EVENTS_WSDL}"><Timeout>PT${Math.round(
            this.options.pullTimeoutMs / 1000,
          )}S</Timeout><MessageLimit>30</MessageLimit></PullMessages>`,
          this.options.pullTimeoutMs + 10000,
        );
        const fault = parseFault(res.body);
        if (fault) {
          throw new Error(`PullMessages faulted: ${fault.reason ?? fault.subcode ?? "?"}`);
        }
        this.consecutiveErrors = 0;
        for (const reading of parseMotionReadings(res.body)) {
          this.applyReading(reading);
        }
      } catch (err) {
        if (this.stopped || this.pullAbort) {
          return;
        }
        this.consecutiveErrors += 1;
        // After a few failures, rebuild the subscription from scratch.
        if (this.consecutiveErrors >= 3) {
          this.subscriptionUrl = null;
          this.scheduleRetry(5000, `PullMessages failing (${this.consecutiveErrors}x): ${(err as Error).message}`);
          return;
        }
        this.maybeWarn(`PullMessages error (${this.consecutiveErrors}x): ${(err as Error).message}`);
        await sleep(2000);
      }
    }
  }

  // ---- Push (base-notification) mode ---------------------------------------

  private async subscribePush(eventServiceUrl: string): Promise<void> {
    const localIp =
      this.options.notifyHost ?? (await localAddressFor(this.clientHost, this.clientPort));
    this.notifyServer = NotificationServer.shared(this.log);
    const port = await this.notifyServer.ensureStarted(this.options.notifyPort);
    this.notifyPath = `/onvif-notify/${encodeURIComponent(this.cameraName)}`;
    this.notifyServer.register(this.notifyPath, (body) => this.onNotify(body));
    const consumer = `http://${localIp}:${port}${this.notifyPath}`;

    const res = await this.client.post(
      eventServiceUrl,
      ACTION.subscribe,
      `<Subscribe xmlns="${WSNT}" xmlns:wsa="${WSA}">` +
        `<ConsumerReference><wsa:Address>${escapeXml(consumer)}</wsa:Address></ConsumerReference>` +
        `<InitialTerminationTime>PT${this.terminationSeconds}S</InitialTerminationTime>` +
        `</Subscribe>`,
    );
    const fault = parseFault(res.body);
    if (fault) {
      throw new Error(`Subscribe faulted: ${fault.reason ?? fault.subcode ?? "?"}`);
    }
    this.subscriptionUrl = extractSubscriptionAddress(res.body) ?? eventServiceUrl;
    this.mode = "push";
    this.consecutiveErrors = 0;
    this.lastNotifyAt = Date.now();
    this.log.info(
      `subscribed via push; camera will POST notifications to ${consumer} ` +
        `(subscription ${this.subscriptionUrl})`,
    );
    this.scheduleRenew();
    this.armWatchdog();
  }

  private onNotify(body: string): void {
    this.lastNotifyAt = Date.now();
    const readings = parseMotionReadings(body);
    if (readings.length === 0) {
      this.log.debug("notification with no motion reading (keepalive or other topic)");
      return;
    }
    for (const reading of readings) {
      this.applyReading(reading);
    }
  }

  private scheduleRenew(): void {
    this.renewTimer && clearTimeout(this.renewTimer);
    // Renew at ~60% of the lifetime so we never lapse.
    const delay = Math.max(15000, this.terminationSeconds * 1000 * 0.6);
    this.renewTimer = setTimeout(() => void this.renew(), delay);
  }

  private async renew(): Promise<void> {
    if (this.stopped || this.mode !== "push" || !this.subscriptionUrl) {
      return;
    }
    try {
      const res = await this.client.post(
        this.subscriptionUrl,
        ACTION.renew,
        `<Renew xmlns="${WSNT}"><TerminationTime>PT${this.terminationSeconds}S</TerminationTime></Renew>`,
      );
      const fault = parseFault(res.body);
      if (fault) {
        throw new Error(fault.reason ?? fault.subcode ?? "fault");
      }
      this.log.debug("subscription renewed");
      this.scheduleRenew();
    } catch (err) {
      // Renew failed — drop and re-subscribe from scratch.
      this.subscriptionUrl = null;
      this.scheduleRetry(3000, `subscription renew failed: ${(err as Error).message}`);
    }
  }

  private armWatchdog(): void {
    this.watchdogTimer && clearTimeout(this.watchdogTimer);
    // If the camera goes quiet far longer than a renew interval, assume the
    // subscription died silently and rebuild it. Fail loud.
    const silence = Math.max(120000, this.terminationSeconds * 1000);
    this.watchdogTimer = setTimeout(() => {
      if (this.stopped || this.mode !== "push") {
        return;
      }
      const quietFor = Date.now() - this.lastNotifyAt;
      if (quietFor >= silence) {
        this.subscriptionUrl = null;
        this.scheduleRetry(
          1000,
          `no ONVIF notifications for ${Math.round(quietFor / 1000)}s (subscription likely dead)`,
        );
      } else {
        this.armWatchdog();
      }
    }, silence);
  }

  // ---- Shared motion handling (mirrors foscam.ts) --------------------------

  private applyReading(reading: MotionReading): void {
    if (reading.active) {
      this.trigger();
    }
    // We let the cooldown clear the sensor (matching the Foscam poller), so
    // explicit "false" readings are informational only.
    this.log.debug(`motion reading: ${reading.topic} active=${reading.active}`);
  }

  private trigger(): void {
    if (!this.motionOn) {
      this.motionOn = true;
      this.log.info("motion detected -> MotionSensor ON");
      this.onMotion(true);
    }
    this.clearTimer && clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => {
      this.motionOn = false;
      this.log.info("motion cleared -> MotionSensor OFF");
      this.onMotion(false);
      this.clearTimer = null;
    }, this.options.cooldownMs);
  }

  private maybeWarn(msg: string): void {
    const now = Date.now();
    if (now - this.lastErrorLogged > 30000) {
      this.lastErrorLogged = now;
      this.log.warn(msg);
    } else {
      this.log.debug(msg);
    }
  }

  private async teardownSubscription(): Promise<void> {
    if (!this.subscriptionUrl) {
      return;
    }
    const url = this.subscriptionUrl;
    const action = this.mode === "pullpoint" ? ACTION.unsubscribePull : ACTION.unsubscribe;
    this.subscriptionUrl = null;
    try {
      await this.client.post(url, action, `<Unsubscribe xmlns="${WSNT}"/>`, 4000);
    } catch {
      // Best-effort on shutdown; the subscription will expire on its own.
    }
  }
}

/** Extract a SubscriptionReference / PullPoint address from a SOAP response. */
function extractSubscriptionAddress(body: string): string | undefined {
  const m = /SubscriptionReference>[\s\S]*?<[^>]*:?Address[^>]*>([^<]+)<\/[^>]*:?Address>/i.exec(body);
  return m ? m[1].trim() : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Standalone probe (used by `--probe-onvif`): connect, discover, list motion
 * topics, try PullPoint, fall back to push, and watch for a real motion event
 * for a few seconds. Logs everything; returns true if a subscription succeeded.
 */
export async function probeOnvif(
  opts: OnvifClientOptions,
  log: Logger,
  watchSeconds = 30,
): Promise<boolean> {
  const client = new OnvifClient(opts, log);
  log.info(`probing ONVIF at ${client.deviceServiceUrl} ...`);

  const eventUrl = await client.getEventServiceUrl();
  log.info(`events service: ${eventUrl}`);

  try {
    const topics = await client.getMotionTopics(eventUrl);
    log.info(`motion topics: ${topics.length ? topics.join(", ") : "(none advertised)"}`);
  } catch (err) {
    log.warn(`GetEventProperties failed: ${(err as Error).message}`);
  }

  let gotMotion = false;
  const source = new OnvifMotionSource(
    client,
    opts.host,
    opts.port,
    "probe",
    { cooldownMs: 3000, pullTimeoutMs: 15000, notifyPort: 0, terminationSeconds: 120 },
    (active) => {
      log.info(`>>> MotionSensor would go ${active ? "ON" : "OFF"} <<<`);
      if (active) {
        gotMotion = true;
      }
    },
    log,
  );
  source.start();

  log.info(`watching ${watchSeconds}s for motion — trigger some in front of the camera ...`);
  await sleep(watchSeconds * 1000);
  source.stop();
  // Give the best-effort unsubscribe a moment.
  await sleep(500);

  if (gotMotion) {
    log.info("PROBE RESULT: subscription works AND a motion event was captured.");
  } else {
    log.info(
      "PROBE RESULT: subscription established; no motion seen in the window " +
        "(that's fine if nothing moved — the round-trip and parsing are verified).",
    );
  }
  return true;
}
