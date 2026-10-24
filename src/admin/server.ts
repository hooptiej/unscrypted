/**
 * The admin pane's HTTP server (runs in the forked admin child, never in the bridge process).
 * Plain Node `http`, no framework. Every handler runs inside one error boundary that turns any
 * failure into the four-part plain-words error (attempted / happened / changed / next).
 *
 * Security: signed session cookie (HttpOnly, SameSite=Strict, 30 days), a per-session CSRF token
 * plus an Origin check on every state-changing request, login lockout, CSP / no framing /
 * nosniff on every response. Secrets never leave this process: the camera list is redacted, and
 * the go2rtc proxy only passes the three read-only things the pane needs.
 */

import * as http from "http";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import QRCode from "qrcode";
import { BridgeStatus, ToAdmin, ToBridge } from "./ipc";
import { UserError, toErrorJson } from "./errors";
import { readRawConfig, redactConfig, applyCameraEdit, writeConfigAtomic, CameraEdit } from "./configStore";
import { Config, ResolvedCamera, resolveConfig } from "../config";
import { Go2rtcClient, explainGo2rtcFailure } from "./go2rtc";
import {
  loadAdminPassword, loadOrCreateSessionKey, checkPassword, issueSession, verifySession, csrfToken, checkCsrf, LoginLimiter, SESSION_DAYS,
} from "./auth";
import { Logger } from "../logger";
import { streamNames } from "./go2rtcConfig";
import { loadSettings, saveSettings, applySettingsEdit, effectiveCameras, GRID_MAX, FONT_FILE } from "../dash/settings";
import { listFonts, FONT_MIME, SYSTEM_FONTS } from "../dash/fonts";
import { ConstructiconFonts, cachedFontFile } from "./constructicon";

type Applied = Extract<ToAdmin, { type: "applied" }>;
type BridgeRequest = { type: "apply"; name: string; isNew: boolean } | { type: "restart-bridge" } | { type: "reload-go2rtc" };

export interface AdminDeps {
  configPath: string;
  passwordFile: string;
  /** Where the session-signing key is kept (made on first start), e.g. /data/admin-session.key. */
  sessionKeyFile: string;
  /** go2rtc's loopback API base, e.g. "http://127.0.0.1:1986"; "" when go2rtc is disabled. */
  go2rtcApi: string;
  /** Folder holding index.html, app.js, style.css. */
  webRoot: string;
  /** "unscrypted admin", or "unscrypted admin - TEST" on the test instance. */
  title: string;
  bridge: {
    status(): BridgeStatus | null;
    /** Resolves with the bridge's answer, or null if it didn't answer in time. Rejects if it can't be sent. */
    request(m: BridgeRequest, timeoutMs: number): Promise<Applied | null>;
  };
  /**
   * The dashboard's settings folder, its port, and its public base URL when it isn't this host
   * (UNSCRYPTED_DASH_URL, e.g. http://10.0.1.248/ once it has its own address). Defaults: /data/dash, 8180, derived.
   */
  dash?: { dir: string; port: number; url: string | null; host?: string };
  /** The Constructicon font list (#14): where the read-only token file is. Default /run/secrets/constructicon_token. */
  constructicon?: { tokenFile: string; fetchImpl?: typeof fetch };
  log?: Logger;
}

/** Shown before and after saving a change that restarts the camera's prebuffer. Easy to change. */
export const PREBUFFER_RESTART_WARNING =
  "Saving a new stream address restarts this camera's recording buffer; a clip being recorded right now will be cut short.";
/** Fields whose change restarts the prebuffer on a live apply (see UnscryptedCamera.reconfigure). */
export const PREBUFFER_FIELDS = ["rtspMain", "host", "rtspPort", "rtspUser", "rtspPassword", "rtspMainPath", "audio", "copyVideo"];

const COOKIE = "unscrypted_admin";
const APPLY_TIMEOUT_MS = 10_000;
const STATIC: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css",
  "/dash-settings.js": "dash-settings.js", "/dash-settings.css": "dash-settings.css" };
/** Homedash's one-screen settings page (owner Q8 = b), its own page behind the admin sign-in. */
export const DASH_SETTINGS_PATH = "/dash-settings";
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const STREAM_NAME = /^[a-z0-9_]{1,64}$/;
/** The only go2rtc paths the proxy passes (all read-only). Its stream-editing API stays loopback-only. */
const GO2RTC_FILES = new Set(["/video-rtc.js", "/video-stream.js"]);
const FEEDCHECK_NAME = "__feedcheck__";

export function securityHeaders(req: http.IncomingMessage): Record<string, string> {
  const host = /^[A-Za-z0-9.\-:[\]]+$/.test(req.headers.host ?? "") ? req.headers.host! : "";
  const ws = host ? ` ws://${host} wss://${host}` : "";
  return {
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
      `connect-src 'self'${ws}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
}

/** A cross-site request (another site's page making the browser call us) is never allowed to change anything. */
function crossSite(req: http.IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let host = "";
    try { host = new URL(origin).host; } catch { return `unreadable Origin header "${origin}"`; }
    if (host !== req.headers.host) return `it came from another site (${origin})`;
  }
  if (req.headers["sec-fetch-site"] === "cross-site") return "the browser marked it as coming from another site";
  return null;
}

function resolvedCamera(raw: Config, name: string): ResolvedCamera | undefined {
  return resolveConfig(raw, "/").cameras.find((c) => c.name === name);
}

export function createAdminServer(d: AdminDeps): http.Server {
  const log = d.log ?? new Logger("admin");
  const dash = d.dash ?? { dir: "/data/dash", port: 8180, url: null };
  const dashSettingsFile = path.join(dash.dir, "settings.json");
  /** Where the dashboard is, as the browser should reach it. */
  const dashUrlFor = (req: http.IncomingMessage): string => {
    if (dash.url) return dash.url.endsWith("/") ? dash.url : dash.url + "/";
    const host = /^(\[[^\]]+\]|[A-Za-z0-9.-]+)/.exec(req.headers.host ?? "")?.[1] ?? "localhost";
    return `http://${host}:${dash.port}/`;
  };
  /**
   * The dashboard's own status lights (open data: names, states and reasons, no addresses), read
   * from the dashboard over the loopback or its own address, so the settings page shows the full
   * reasons. Never throws: a failure is the error text the page shows in their place.
   */
  const dashLights = (): Promise<{ services: unknown[] | null; at: number | null; error: string | null }> => new Promise((resolve) => {
    const host = !dash.host || dash.host === "0.0.0.0" || dash.host === "::" ? "127.0.0.1" : dash.host;
    const fail = (why: string) => resolve({ services: null, at: null,
      error: `Couldn't read the status lights from the dashboard (${why}). Their reasons show on the dashboard itself; if it's down, the admin pane's Status tab says why.` });
    const r = http.get({ host, port: dash.port, path: "/api/state", timeout: 1500, headers: { accept: "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { body += c; if (body.length > 1_000_000) r.destroy(new Error("its answer was too big")); });
      res.on("end", () => {
        if (res.statusCode !== 200) return fail(`it answered ${res.statusCode}`);
        try {
          const j = JSON.parse(body) as { services?: unknown; servicesAt?: unknown };
          if (!Array.isArray(j.services)) return fail("its answer had no status lights");
          resolve({ services: j.services, at: typeof j.servicesAt === "number" ? j.servicesAt : null, error: null });
        } catch (err) { fail(`its answer wasn't JSON: ${(err as Error).message}`); }
      });
    });
    r.on("timeout", () => r.destroy(new Error("no answer within 1.5 s")));
    r.on("error", (err: NodeJS.ErrnoException) => fail(err.code === "ECONNREFUSED" ? "connection refused: it isn't running" : err.message));
  });
  // Read once at start. A bad key file disables sign-in (every request gets its 503) rather than
  // being replaced; the bridge and /healthz carry on.
  let secret: Buffer = Buffer.alloc(0);
  let keyError: UserError | null = null;
  try {
    const k = loadOrCreateSessionKey(d.sessionKeyFile);
    secret = k.key;
    log.info(k.created ? `made a new sign-in key at ${d.sessionKeyFile}` : `using the sign-in key at ${d.sessionKeyFile}`);
  } catch (err) {
    keyError = err instanceof UserError ? err
      : new UserError({ attempted: "Load the admin pane's sign-in key", happened: `Unexpected error: ${(err as Error).message}`,
        changed: "The admin pane is refusing every request; the HomeKit bridge is running normally.", next: "Check the container log, then restart the container." }, 503);
    log.error(`admin sign-in disabled: ${keyError.body.happened} ${keyError.body.next}`);
  }
  const limiter = new LoginLimiter();
  const tempStreams = new Map<string, NodeJS.Timeout>();
  const g2 = d.go2rtcApi ? new Go2rtcClient(d.go2rtcApi) : null;

  // Signed-out sessions. A session is a signed, stateless cookie, so clearing the cookie alone left a
  // copied one working for 30 days; signing out (the kiosk's idle return does) now kills it on the
  // server too. Kept beside the key (hashes and expiry times only), so it survives a restart.
  const revokedFile = d.sessionKeyFile + ".revoked";
  const revoked = new Map<string, number>();
  const sessionHash = (c: string) => crypto.createHash("sha256").update(c).digest("base64url");
  try {
    const raw = JSON.parse(fs.readFileSync(revokedFile, "utf8")) as Record<string, unknown>;
    for (const [h, exp] of Object.entries(raw)) if (typeof exp === "number" && exp > Date.now()) revoked.set(h, exp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`couldn't read the signed-out sessions list ${revokedFile} (${(err as Error).message}); sessions signed out before this restart work again until they expire. Signing out still works from now on.`);
    }
  }
  /** Returns an error message when the list couldn't be saved (the session is still revoked until a restart). */
  const revoke = (c: string): string | null => {
    const now = Date.now();
    for (const [h, exp] of revoked) if (exp <= now) revoked.delete(h);
    revoked.set(sessionHash(c), Number(c.split(".")[0]) || now + SESSION_DAYS * 864e5);
    try {
      const tmp = `${revokedFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(revoked)), { mode: 0o600 });
      fs.renameSync(tmp, revokedFile);
      return null;
    } catch (err) {
      log.warn(`signed out, but couldn't save ${revokedFile} (${(err as Error).message}); that session would work again after a restart.`);
      return (err as Error).message;
    }
  };

  const cookieOf = (req: http.IncomingMessage) =>
    (req.headers.cookie ?? "").split(";").map((s) => s.trim()).find((s) => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  const sessionOf = (req: http.IncomingMessage): string | null => {
    const c = cookieOf(req);
    return c && !keyError && verifySession(c, secret) && !revoked.has(sessionHash(c)) ? c : null;
  };
  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(body));
  };
  const readJson = (req: http.IncomingMessage, attempted: string) => new Promise<any>((resolve, reject) => {
    let s = "";
    let tooBig = false;
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      if (tooBig) return;
      s += c;
      if (s.length > 1e6) {
        tooBig = true;
        reject(new UserError({ attempted, happened: "The request was over 1 MB, far bigger than any camera edit.", changed: "Nothing.", next: "Reload the page and try again." }, 413));
      }
    });
    req.on("end", () => {
      if (tooBig) return;
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (err) {
        reject(new UserError({ attempted, happened: `The request body wasn't valid JSON (${(err as Error).message}).`, changed: "Nothing.", next: "Reload the page and try again." }));
      }
    });
    req.on("error", (err) => reject(new UserError({ attempted, happened: `The request was cut off: ${err.message}`, changed: "Nothing.", next: "Try again." })));
  });
  const go2rtcDown = (attempted: string) => {
    const g = d.bridge.status()?.go2rtc;
    const when = g?.nextRetryAt ? `, restarting in ${Math.max(0, Math.round((g.nextRetryAt - Date.now()) / 1000))}s` : "";
    const state = d.go2rtcApi ? (g?.state ?? "unknown") : "disabled";
    return new UserError({ attempted,
      happened: `Feed check unavailable: go2rtc isn't running (state: ${state}${when}). Last error: ${g?.lastError ?? "none recorded"}.`,
      changed: "Nothing.",
      next: d.go2rtcApi
        ? "Wait for go2rtc to restart and try again. If it stays down, check `docker logs unscrypted` for go2rtc lines."
        : "go2rtc is switched off or missing in this instance; the Status page says why." }, 503);
  };
  const needAuth = () => new UserError({ attempted: "Use the admin pane", happened: "You're not signed in (or your session expired, or the pane restarted, which signs everyone out).", changed: "Nothing.", next: "Sign in again." }, 401);

  const askBridge = async (m: BridgeRequest): Promise<Applied | null> => d.bridge.request(m, APPLY_TIMEOUT_MS);
  const cx = new ConstructiconFonts({ tokenFile: d.constructicon?.tokenFile ?? "/run/secrets/constructicon_token", fetchImpl: d.constructicon?.fetchImpl });

  const statusNotices = (s: BridgeStatus): string[] => {
    const notes: string[] = [];
    if (!s.hapEnabled) {
      notes.push("HomeKit is off on this instance (UNSCRYPTED_HAP=off): it isn't visible in Home, and motion sources aren't started, so \"last motion\" stays at \"never\" and nothing records. That's expected for a test instance.");
    }
    if (s.go2rtc.state !== "running") {
      notes.push(`go2rtc is ${s.go2rtc.state}${s.go2rtc.lastError ? ` (${s.go2rtc.lastError})` : ""}: snapshots, feed checks and live previews are unavailable. HomeKit is unaffected.`);
    }
    if (s.dash && s.dash.state !== "running") {
      notes.push(`The dashboard is ${s.dash.state}${s.dash.lastError ? ` (${s.dash.lastError})` : ""}: the living-room display can't load until it's back. HomeKit is unaffected.`);
    }
    try {
      const ports = [...new Set(readRawConfig(d.configPath).cameras.filter((c) => c.onvif).map((c) => c.onvif!.notifyPort ?? 0))];
      if (ports.length === 1) {
        notes.push(`ONVIF push receiver: ${ports[0] ? `port ${ports[0]}` : "a random port each start (notifyPort 0)"}, shared by all ONVIF cameras.`);
      } else if (ports.length > 1) {
        notes.push(`ONVIF push receiver: only one runs, shared by all ONVIF cameras, on the notifyPort of whichever ONVIF camera starts first. The cameras list ${ports.join(", ")}; the others are ignored (the bridge log warns about this). Set the same notifyPort on every ONVIF camera to make it predictable.`);
      }
    } catch (err) {
      notes.push(`Couldn't read config.json for the ONVIF receiver note: ${(err as Error).message}`);
    }
    return notes;
  };

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(securityHeaders(req))) res.setHeader(k, v);
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    let attempted = `${method} ${url.pathname}`;
    try {
      if (url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
      if (method === "GET" && url.pathname.startsWith("/dash-fonts/")) {
        // The same font files the open dashboard serves, for the settings page's live preview.
        attempted = "Load a dashboard font for the preview";
        const name = url.pathname.slice("/dash-fonts/".length);
        const gone = () => new UserError({ attempted, happened: `The font file "${name}" isn't in the dashboard's fonts folder.`, changed: "Nothing.", next: "Put the file in data/dash/fonts on the NAS, then reload." }, 404);
        if (!FONT_FILE.test(name)) throw gone();
        let body: Buffer;
        try { body = fs.readFileSync(path.join(dash.dir, "fonts", name)); } catch { throw gone(); }
        res.writeHead(200, { "content-type": FONT_MIME[path.extname(name).toLowerCase()], "content-length": String(body.length) });
        return res.end(body);
      }
      if (method === "GET" && url.pathname === DASH_SETTINGS_PATH) {
        attempted = "Open the dashboard settings";
        if (!sessionOf(req)) {
          // Sign in first, then come straight back here (the pane's sign-in honours ?next=).
          const next = encodeURIComponent(DASH_SETTINGS_PATH + (url.searchParams.get("from") === "dash" ? "?from=dash" : ""));
          return json(res, 302, { error: { attempted, happened: "The dashboard settings need the admin password, and you're not signed in.", changed: "Nothing.", next: "Sign in; you'll come straight back here." } },
            { location: `/?next=${next}#/login` });
        }
        let body: string;
        try { body = fs.readFileSync(path.join(d.webRoot, "dash-settings.html"), "utf8"); } catch (err) {
          throw new UserError({ attempted, happened: `The settings page is missing from this build (${(err as Error).message}).`, changed: "Nothing; the dashboard and HomeKit are unaffected.", next: "Rebuild the image (the Dockerfile must copy web/ into it)." }, 500);
        }
        res.writeHead(200, { "content-type": MIME[".html"] });
        return res.end(body.replace(/__TITLE__/g, d.title.replace(/^unscrypted admin/, "Homedash settings")));
      }
      if (method === "GET" && STATIC[url.pathname]) {
        attempted = "Load the admin pane";
        const file = path.join(d.webRoot, STATIC[url.pathname]);
        let body: string;
        try {
          body = fs.readFileSync(file, "utf8");
        } catch (err) {
          throw new UserError({ attempted, happened: `The pane's web files are missing from this build (${(err as Error).message}).`,
            changed: "Nothing; the HomeKit bridge is unaffected.", next: "Rebuild the image (the Dockerfile must copy web/ into it)." }, 500);
        }
        if (file.endsWith(".html")) body = body.replace(/__TITLE__/g, d.title);
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        return res.end(body);
      }

      if (url.pathname === "/api/session" && method === "GET") {
        const s = sessionOf(req);
        let setupError = null;
        if (keyError) setupError = keyError.body;
        else try { loadAdminPassword(d.passwordFile); } catch (err) { setupError = toErrorJson(err, "Start the admin pane's sign-in").body.error; }
        // Where the dashboard is and its idle time: the kiosk's sign-in page idles back there. Nothing secret.
        return json(res, 200, { signedIn: Boolean(s), csrf: s ? csrfToken(secret, s) : null, title: d.title, setupError,
          dash: { url: dashUrlFor(req), idleSeconds: loadSettings(dashSettingsFile).settings.idleSeconds } });
      }

      if (keyError) throw keyError;   // 503: the sign-in key file is unreadable or the wrong length
      const password = loadAdminPassword(d.passwordFile);   // a 503 UserError with setup instructions
      const ip = req.socket.remoteAddress ?? "unknown";

      if (url.pathname === "/api/login" && method === "POST") {
        attempted = "Sign in";
        if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
          throw new UserError({ attempted, happened: "The sign-in request wasn't sent by the admin pane (it wasn't JSON).", changed: "Nothing.", next: "Sign in from the admin pane's own page." }, 415);
        }
        const why = crossSite(req);
        if (why) throw new UserError({ attempted, happened: `Refused because ${why}.`, changed: "Nothing.", next: "Open the admin pane directly and sign in there." }, 403);
        if (!limiter.allow(ip)) {
          const mins = Math.max(1, Math.ceil(limiter.retryInMs(ip) / 60_000));
          throw new UserError({ attempted, happened: "Too many wrong passwords from this computer (5 within 5 minutes).", changed: "Nothing; sign-in is paused for this computer only.",
            next: `Wait about ${mins} minute${mins > 1 ? "s" : ""}, then try again.` }, 429);
        }
        const body = await readJson(req, attempted);
        if (!checkPassword(String(body?.password ?? ""), password)) {
          limiter.fail(ip);
          throw new UserError({ attempted, happened: "Wrong password.", changed: "Nothing.", next: "Check ~/unscrypted/secrets/admin_password on the NAS if you've forgotten it. 5 wrong tries pause sign-in for 5 minutes." }, 401);
        }
        limiter.reset(ip);
        const session = issueSession(secret);
        return json(res, 200, { ok: true, csrf: csrfToken(secret, session) },
          { "set-cookie": `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}` });
      }

      const session = sessionOf(req);
      const stateChanging = !["GET", "HEAD"].includes(method);
      if (url.pathname === "/api/logout" && method === "POST" && !session) {
        return json(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (!session) throw needAuth();
      if (stateChanging) {
        const why = crossSite(req);
        if (why) throw new UserError({ attempted, happened: `Refused because ${why}.`, changed: "Nothing.", next: "Make the change from the admin pane itself." }, 403);
        const tok = req.headers["x-csrf-token"];
        if (!checkCsrf(Array.isArray(tok) ? tok[0] : tok, secret, session)) {
          throw new UserError({ attempted, happened: "The request didn't carry this session's security token (the page may be out of date).", changed: "Nothing.", next: "Reload the page and try again." }, 403);
        }
      }

      if (url.pathname === "/api/logout" && method === "POST") {
        const saveErr = revoke(session);
        return json(res, 200, { ok: true, ...(saveErr ? { warning: `Signed out. The sign-out couldn't be saved to disk (${saveErr}), so this session would work again after the admin pane restarts.` } : {}) },
          { "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }

      if (url.pathname === "/api/dash/settings" && (method === "GET" || method === "PUT")) {
        attempted = method === "GET" ? "Load the dashboard settings" : "Save the dashboard settings";
        const raw = readRawConfig(d.configPath);
        const names = raw.cameras.map((c) => c.name);
        let withSub: string[] | undefined;
        try {
          const sn = streamNames(resolveConfig(raw, "/").cameras);
          withSub = names.filter((n) => sn.get(n)?.sub);
        } catch (err) {
          withSub = undefined;   // config.json doesn't resolve right now: sub can't be checked, the dash falls back to main
          log.warn(`dashboard settings: couldn't work out which cameras have a sub stream: ${(err as Error).message}`);
        }
        const fonts = listFonts(path.join(dash.dir, "fonts"));
        if (method === "PUT") {
          const edit = await readJson(req, attempted);
          const cur = loadSettings(dashSettingsFile);
          const next = applySettingsEdit(cur.settings, edit, { cameras: names, fontFiles: fonts.fonts.map((f) => f.file), withSub });
          let backupPath: string | null;
          try { ({ backupPath } = saveSettings(dashSettingsFile, next)); } catch (err) {
            throw new UserError({ attempted, happened: `${dashSettingsFile} couldn't be written (${(err as Error).message}).`, changed: "Nothing was saved; the dashboard keeps its current settings.",
              next: "Check that ./data/dash on the NAS exists and is writable by the container, then save again." }, 500);
          }
          log.info(`dashboard settings saved (${Object.keys(edit).join(", ")})`);
          return json(res, 200, { saved: true, backupPath, settings: next, message: "Saved. The dashboard reloads with it within a few seconds." });
        }
        const cur = loadSettings(dashSettingsFile);
        // #14: Constructicon's fonts, with a reason when the list can't be had. Never blocks the page: a
        // Constructicon that's down just means this part says so and the folder fonts stand.
        const cxUrl = cur.settings.constructicon.url;
        const cxList = await cx.list(cxUrl);
        const inFolder = new Set(fonts.fonts.map((f) => f.file));
        const constructicon = {
          url: cxUrl, available: cx.availability(cxUrl).available && !cxList.error, reason: cxList.error,
          fonts: cxList.fonts.map((f) => ({ ...f, file: inFolder.has(cachedFontFile(f.slug, f.ext)) ? cachedFontFile(f.slug, f.ext) : null })),
        };
        return json(res, 200, {
          settings: cur.settings, warning: [cur.warning, fonts.warning].filter(Boolean).join(" ") || null,
          cameras: effectiveCameras(cur.settings, names).map((c) => ({ ...c, hasSub: withSub ? withSub.includes(c.camera) : null })),
          fonts: fonts.fonts, systemFonts: Object.keys(SYSTEM_FONTS), gridMax: GRID_MAX, dashUrl: dashUrlFor(req),
          lights: await dashLights(), constructicon,
        });
      }

      // #14: copy one Constructicon font into the fonts folder, so it becomes an ordinary folder font
      // (the dashboard serves it offline). The page then picks it like any other file.
      if (url.pathname === "/api/dash/fonts/constructicon" && method === "POST") {
        attempted = "Fetch a font from Constructicon";
        const body = (await readJson(req, attempted)) as { slug?: unknown } | null;
        const slug = typeof body?.slug === "string" ? body.slug : "";
        if (!slug) throw new UserError({ attempted, happened: "No font was named.", changed: "Nothing.", next: "Pick a font under \"From Constructicon\" and try again." }, 400);
        const cxUrl2 = loadSettings(dashSettingsFile).settings.constructicon.url;
        const avail = cx.availability(cxUrl2);
        if (!avail.available) throw new UserError({ attempted, happened: `The Constructicon font list isn't available: ${avail.reason}.`, changed: "Nothing; the folder and system fonts still work.", next: "Fix that, save, and reload this page." }, 409);
        const fontsDir = path.join(dash.dir, "fonts");
        let got: { file: string; name: string };
        try { got = await cx.fetchInto(cxUrl2, slug, fontsDir); } catch (err) {
          throw new UserError({ attempted, happened: `${(err as Error).message}.`, changed: "Nothing was saved; the folder and system fonts still work.",
            next: "Check that Constructicon is up and the token is current, then try again." }, 502);
        }
        log.info(`dashboard font "${got.name}" fetched from Constructicon into ${fontsDir}/${got.file}`);
        return json(res, 200, { ...got, fonts: listFonts(fontsDir).fonts, message: `"${got.name}" is in the fonts folder now; pick it and save.` });
      }

      if (url.pathname === "/api/status" && method === "GET") {
        attempted = "Read bridge status";
        const s = d.bridge.status();
        if (!s) throw new UserError({ attempted, happened: "The bridge hasn't reported its status yet.", changed: "Nothing.", next: "Wait a few seconds; the page retries on its own." }, 503);
        const { pin: _p, setupURI: _u, ...pub } = s;
        return json(res, 200, { ...pub, notices: statusNotices(s) });
      }

      if (url.pathname === "/api/pairing" && method === "GET") {
        attempted = "Show the pairing code";
        const s = d.bridge.status();
        if (!s) throw new UserError({ attempted, happened: "The bridge hasn't reported its status yet.", changed: "Nothing.", next: "Wait a few seconds and press Refresh." }, 503);
        if (!s.hapEnabled) throw new UserError({ attempted, happened: "HomeKit is switched off in this instance (UNSCRYPTED_HAP=off), so there's nothing to pair.", changed: "Nothing.", next: "Use the production pane for pairing." }, 409);
        const svg = await QRCode.toString(s.setupURI, { type: "svg", margin: 1 });
        return json(res, 200, {
          pin: s.pin, setupURI: s.setupURI, paired: s.paired,
          qrImage: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
          note: s.paired
            ? "Already paired with a Home. This code only works again after the bridge is removed from Home."
            : "Not paired yet: in the Home app choose Add Accessory and scan this code, or type the setup code.",
        });
      }

      if (url.pathname === "/api/cameras" && method === "GET") {
        attempted = "List cameras";
        return json(res, 200, {
          ...redactConfig(readRawConfig(d.configPath)),
          status: d.bridge.status()?.cameras ?? [],
          notices: { prebufferRestart: PREBUFFER_RESTART_WARNING, prebufferFields: PREBUFFER_FIELDS },
        });
      }

      const checkDel = /^\/api\/cameras\/check\/([^/]+)$/.exec(url.pathname);
      if (checkDel && method === "DELETE") {
        attempted = "Stop the feed-check preview";
        const stream = decodeURIComponent(checkDel[1]);
        const t = tempStreams.get(stream);
        if (!t || !g2) return json(res, 200, { ok: true, message: "That preview had already been cleaned up." });
        clearTimeout(t);
        tempStreams.delete(stream);
        try {
          await g2.removeStream(stream);
        } catch (err) {
          throw new UserError({ attempted, happened: `go2rtc didn't remove the test stream: ${(err as Error).message}`, changed: "The test stream may still be open in go2rtc (one extra camera viewer) until go2rtc restarts.", next: "Nothing urgent; it's harmless. Restarting the container clears it." }, 502);
        }
        return json(res, 200, { ok: true });
      }

      if (url.pathname === "/api/cameras/check" && method === "POST") {
        attempted = "Check the feed";
        if (!g2 || d.bridge.status()?.go2rtc.state !== "running") throw go2rtcDown(attempted);
        const body = await readJson(req, attempted);
        const name: string | null = typeof body?.name === "string" && body.name ? body.name : null;
        const edit: CameraEdit = { ...(body?.edit ?? {}) };
        if (name) delete edit.name; else edit.name = FEEDCHECK_NAME;
        const label = name ? `"${name}"` : "the new camera";
        attempted = `Check the feed for ${label}`;
        let cam: ResolvedCamera;
        try {
          const candidate = applyCameraEdit(readRawConfig(d.configPath), name, edit);
          cam = resolvedCamera(candidate, name ?? FEEDCHECK_NAME)!;
        } catch (err) {
          if (err instanceof UserError) throw new UserError({ ...err.body, attempted, changed: "Nothing was saved; this was only a test." }, err.status);
          throw err;
        }
        const stream = `check_${crypto.randomBytes(4).toString("hex")}`;
        try {
          await g2.addTempStream(stream, cam.rtspMain + (cam.audio ? "" : "#media=video"));
        } catch (err) {
          throw new UserError({ attempted, happened: `go2rtc wouldn't take the test stream: ${(err as Error).message}`, changed: "Nothing was saved; this was only a test.", next: "Try again; if it repeats, check `docker logs unscrypted` for go2rtc lines." }, 502);
        }
        const t = setTimeout(() => {
          tempStreams.delete(stream);
          g2.removeStream(stream).catch((err) => log.warn(`couldn't remove expired feed-check stream ${stream} from go2rtc: ${(err as Error).message}`));
        }, 5 * 60_000);
        t.unref();
        tempStreams.set(stream, t);
        try {
          await g2.frame(stream);
        } catch (err) {
          const ex = explainGo2rtcFailure((err as Error).message);
          throw new UserError({ attempted, happened: ex.happened, changed: "Nothing was saved; this was only a test.", next: ex.next }, 502);
        }
        return json(res, 200, { ok: true, stream, frameUrl: `/go2rtc/api/frame.jpeg?src=${stream}`, wsUrl: `/go2rtc/api/ws?src=${stream}` });
      }

      const camMatch = /^\/api\/cameras\/([^/]+)$/.exec(url.pathname);
      if ((url.pathname === "/api/cameras" && method === "POST") || (camMatch && method === "PUT")) {
        const original = camMatch ? decodeURIComponent(camMatch[1]) : null;
        attempted = original ? `Save camera "${original}"` : "Add a camera";
        const edit = (await readJson(req, attempted)) as CameraEdit;
        if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
          throw new UserError({ attempted, happened: "The request body wasn't a camera's settings.", changed: "Nothing was saved.", next: "Reload the page and try again." });
        }
        const raw = readRawConfig(d.configPath);
        const next = applyCameraEdit(raw, original, edit);
        const name = original ?? String(edit.name).trim();
        const notes: string[] = [];
        if (original) {
          let beforeCam: ResolvedCamera | undefined;
          try { beforeCam = resolvedCamera(raw, original); } catch { beforeCam = undefined; /* stored config already invalid: no comparison possible */ }
          const afterCam = resolvedCamera(next, original)!;
          if (beforeCam && (beforeCam.rtspMain !== afterCam.rtspMain || beforeCam.audio !== afterCam.audio || beforeCam.copyVideo !== afterCam.copyVideo)) {
            notes.push(PREBUFFER_RESTART_WARNING);
          }
        }
        const { backupPath, warning } = writeConfigAtomic(d.configPath, next);
        const extra = { saved: true, backupPath, notes, ...(warning ? { warning } : {}) };
        const savedChanged = `config.json WAS saved${backupPath ? ` (previous version kept at ${backupPath})` : ""}; the running bridge did not apply it.`;
        let reply: Applied | null;
        try {
          reply = await askBridge({ type: "apply", name, isNew: original === null });
        } catch (err) {
          return json(res, 500, { ...extra, error: { attempted, happened: `Saved, but the bridge couldn't be told about it: ${(err as Error).message}`, changed: savedChanged, next: "Use \"Restart bridge\" to apply it." } });
        }
        if (!reply) {
          return json(res, 202, { ...extra, message: `Saved to config.json, but the bridge didn't confirm applying it within ${APPLY_TIMEOUT_MS / 1000}s. The change is NOT live yet. Use "Restart bridge" to apply it.` });
        }
        if (!reply.ok) return json(res, 500, { ...extra, error: { ...reply.error, changed: `${savedChanged} ${reply.error.changed}` } });
        return json(res, 200, { ...extra, mode: reply.mode, message: reply.message });
      }

      if (url.pathname === "/api/bridge/restart" && method === "POST") {
        attempted = "Restart the bridge";
        const reply = await askBridge({ type: "restart-bridge" });
        if (!reply) {
          throw new UserError({ attempted, happened: `The bridge didn't answer within ${APPLY_TIMEOUT_MS / 1000}s.`, changed: "Probably nothing; the bridge may be busy or stuck.", next: "Restart the container on the NAS: sudo docker restart unscrypted." }, 504);
        }
        return reply.ok ? json(res, 200, { message: reply.message }) : json(res, 500, { error: reply.error });
      }

      if (url.pathname.startsWith("/go2rtc/") && method === "GET") {
        attempted = "Load the camera preview";
        const sub = url.pathname.slice("/go2rtc".length);
        let target: string;
        if (sub === "/api/frame.jpeg") {
          const src = url.searchParams.get("src") ?? "";
          if (!STREAM_NAME.test(src)) throw new UserError({ attempted, happened: `"${src}" isn't a stream name this pane knows.`, changed: "Nothing.", next: "Reload the page." }, 400);
          target = `${sub}?src=${encodeURIComponent(src)}`;
        } else if (GO2RTC_FILES.has(sub)) {
          target = sub;
        } else {
          throw new UserError({ attempted, happened: "That go2rtc address isn't passed through by the admin pane.", changed: "Nothing.", next: "Go back to the admin home page." }, 404);
        }
        if (!d.go2rtcApi) throw go2rtcDown(attempted);
        await new Promise<void>((resolve) => {
          const upstream = http.request(d.go2rtcApi + target, { method: "GET", timeout: 20_000 }, (up) => {
            res.writeHead(up.statusCode ?? 502, { "content-type": up.headers["content-type"] ?? "application/octet-stream" });
            up.pipe(res);
            up.on("end", resolve);
            up.on("error", (err) => { log.warn(`go2rtc preview stream broke off: ${err.message}`); res.destroy(); resolve(); });
          });
          upstream.on("timeout", () => upstream.destroy(new Error("go2rtc didn't answer within 20s")));
          upstream.on("error", (err) => {
            if (!res.headersSent) {
              const down = go2rtcDown(attempted);
              json(res, 503, { error: { ...down.body, happened: `${down.body.happened} (${err.message})` } });
            } else {
              res.destroy();
            }
            resolve();
          });
          upstream.end();
        });
        return;
      }

      throw new UserError({ attempted, happened: "No such page or API.", changed: "Nothing.", next: "Go back to the admin home page." }, 404);
    } catch (e) {
      const { status, body } = toErrorJson(e, attempted);
      if (status >= 500) {
        if (e instanceof UserError) log.warn(`${attempted}: ${e.body.happened}`);
        else log.error(`${attempted} failed: ${(e as Error)?.stack ?? e}`);
      }
      if (!res.headersSent) json(res, status, body);
      else res.destroy();
    }
  });

  // WebSocket proxy for go2rtc's MSE player (/go2rtc/api/ws?src=...). Auth and Origin are checked on the upgrade.
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const refuse = (code: string, why: string) => {
      log.warn(`refused a live-preview connection: ${why}`);
      socket.end(`HTTP/1.1 ${code}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${why}\n`);
    };
    const src = url.searchParams.get("src") ?? "";
    if (url.pathname !== "/go2rtc/api/ws") return refuse("404 Not Found", "only /go2rtc/api/ws is a WebSocket here");
    if (!sessionOf(req)) return refuse("401 Unauthorized", "not signed in");
    const why = crossSite(req);
    if (why) return refuse("403 Forbidden", `cross-site: ${why}`);
    if (!STREAM_NAME.test(src)) return refuse("400 Bad Request", `"${src}" isn't a stream name`);
    if (!d.go2rtcApi) return refuse("503 Service Unavailable", "go2rtc is disabled in this instance");
    const target = new URL(d.go2rtcApi);
    const up = net.connect(Number(target.port), target.hostname, () => {
      const lines = [`GET /api/ws?src=${encodeURIComponent(src)} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        if (/^(host|cookie|origin)$/i.test(k)) continue;
        lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push(`Host: ${target.host}`, "", "");
      up.write(lines.join("\r\n"));
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", (err) => {
      log.warn(`live preview: couldn't reach go2rtc at ${target.host}: ${err.message}`);
      if (socket.writable && !up.readable) socket.end("HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\ngo2rtc isn't reachable\n");
      socket.destroy();
    });
    socket.on("error", () => up.destroy());   // browser went away: just drop the upstream side
    socket.on("close", () => up.destroy());
  });

  server.on("close", () => {
    for (const t of tempStreams.values()) clearTimeout(t);
    tempStreams.clear();
  });

  return server;
}
