/**
 * The open, watch-only dashboard server (runs in the forked dash child). GET only, with two writes
 * for the new-build pulse (#103): the open clear (POST .../clear, can only clear) and the token switch
 * (POST .../<light>, the bearer token). No cookies are set or read. Every failure is the four-part
 * plain-words error. The admin pane is the only place the dashboard's settings can be changed.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { UserError, UserErrorBody, toErrorJson } from "../shared/errors";
import { securityHeaders, sendJson, readFontFile, proxyGo2rtcFile, proxyGo2rtcSocket, STREAM_NAME } from "../shared/http";
import { Logger } from "../logger";
import { healthFields } from "../version";
import { ClientFrameFilter } from "./wsFilter";
import { PHOTO_EXT } from "./photos";
import { FONT_MIME } from "./fonts";
import { FONT_FILE, ServiceCheck, validateServiceCheck, checkBuildUrl } from "./settings";
import { PulseApi, readBuild } from "./pulse";
import { runCheckDetailed } from "./services";
import { DashBridgeInfo } from "./ipc";

export interface PublicConfig {
  title: string; env: "prod" | "test"; adminPort: number; settingsUrl: string | null;
  /** The running build stamp (#102), e.g. "unscrypted 0.1.16 - build 5a020c9 (2026-11-07)". */
  build: string;
  idleSeconds: number; pollSeconds: number; reloadMinutes: number;
  /** How long a tile may trouble-shoot quietly (holding its last picture) before it shows a banner, in seconds (#113). */
  offlineGraceSeconds?: number;
  /** `which`: the stream the tile actually plays (a "sub" pick on a camera with no sub plays main). */
  cameras: { id: string; label: string; stream: string; which: "main" | "sub" }[];
  fonts: { ui: unknown; clock: unknown };
  /** Background glow knobs (#25), percents from -100 to +100; 0 = the default look. */
  glow: { intensity: number; size: number };
  /** New-build pulse knobs (#103), percents from -100 to +100; 0 = the standard breath. */
  pulse: { speed: number; strength: number };
}

export interface DashDeps {
  webRoot: string;
  title: string;
  /** go2rtc's loopback API base, "" when go2rtc is off. */
  go2rtcApi: string;
  publicConfig: () => PublicConfig;
  state: () => unknown;
  /** Stream names the open page may play: main/sub of every camera in config.json. */
  allowedStreams: () => Set<string>;
  go2rtcInfo: () => { state: string; lastError: string | null; nextRetryAt: number | null };
  /** The slideshow list (opaque ids only) and why it's short or empty. */
  photos: () => { items: { id: string; v: number }[]; album: string; rotateSeconds: number; error: string | null };
  /** The file behind a published photo id, or null. Never a path the caller made up. */
  photoFile: (id: string) => string | null;
  fontsDir: string;
  /** Live views open at once through this server (default 16). */
  maxStreams?: number;
  /** Live views one address may hold at once (default 8, #12): one tab or bot can't starve the kiosk. */
  maxPerIp?: number;
  /** False until the bridge has sent its first camera list (#53); a video connection before that is "still starting", not "not in config.json". */
  camerasLoaded?: () => boolean;
  /** The new-build pulse (#103): the open clear and the token switch. Absent = those routes say so. */
  pulse?: PulseApi;
  /** The bridge's last status (#109): the on-demand check needs it to answer a "bridge" check. Absent = "no report yet". */
  bridge?: () => DashBridgeInfo | null;
  log?: Logger;
}

const STATIC: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
/** The only go2rtc files the open page gets: its player. Its API (streams, frames, config) never passes. */
const GO2RTC_FILES = new Set(["/video-stream.js", "/video-rtc.js"]);
/** /api/pulse (the list), /api/pulse/<light> (the token switch), /api/pulse/<light>/clear (the open clear). */
const PULSE_PATH = /^\/api\/pulse(?:\/([^/]+)(\/clear)?)?$/;
const PULSE_BODY_MAX = 4096;

/** A small JSON body (the token switch's): at most 4 KB, and a bad one is refused in plain words. */
function readJsonBody(req: http.IncomingMessage, attempted: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > PULSE_BODY_MAX) {
        if (!tooBig) reject(new UserError({ attempted, happened: `The request body is bigger than ${PULSE_BODY_MAX / 1024} KB.`, changed: "Nothing.",
          next: 'Send just {"on": true} or {"on": false}, with optional "build" and "note".' }, 413));
        tooBig = true;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      let j: unknown;
      try { j = JSON.parse(text); } catch {
        return reject(new UserError({ attempted, happened: "The request body isn't valid JSON.", changed: "Nothing.", next: 'Send {"on": true} or {"on": false} as JSON.' }, 400));
      }
      if (!j || typeof j !== "object" || Array.isArray(j)) {
        return reject(new UserError({ attempted, happened: "The request body isn't a JSON object.", changed: "Nothing.", next: 'Send {"on": true} or {"on": false} as JSON.' }, 400));
      }
      resolve(j as Record<string, unknown>);
    });
    req.on("error", (err) => reject(new UserError({ attempted, happened: `The request broke off (${err.message}).`, changed: "Nothing.", next: "Send it again." }, 400)));
  });
}

/** An optional short text field of the token switch's body: absent is undefined, too long or not text is refused by name. */
function optionalText(body: Record<string, unknown>, key: string, max: number, attempted: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.trim().length > max) {
    throw new UserError({ attempted, happened: `"${key}" must be text of at most ${max} characters.`, changed: "Nothing.", next: `Shorten "${key}" and send it again.` }, 400);
  }
  return v.trim() || undefined;
}

export function createDashServer(d: DashDeps): http.Server {
  const log = d.log ?? new Logger("dash");
  const json = sendJson;

  /** go2rtc's state in words, for the 503s. */
  const go2rtcWhy = (): string => {
    const g = d.go2rtcInfo();
    const when = g.nextRetryAt ? `, restarting in ${Math.max(0, Math.round((g.nextRetryAt - Date.now()) / 1000))} s` : "";
    return `The video server (go2rtc) isn't running (state: ${d.go2rtcApi ? g.state : "switched off in this instance"}${when}). Last error: ${g.lastError ?? "none recorded"}.`;
  };
  const go2rtcDown = (attempted: string) => new UserError({ attempted, happened: go2rtcWhy(), changed: "Nothing; HomeKit is unaffected.",
    next: "The tiles retry on their own; if it stays down, check `docker logs unscrypted` for go2rtc lines." }, 503);
  // "unknown" = the bridge hasn't reported yet (first 2 s after a start): try go2rtc anyway.
  const go2rtcUp = () => Boolean(d.go2rtcApi) && ["running", "unknown"].includes(d.go2rtcInfo().state);

  /** Stream one of go2rtc's player files to the browser. */
  const pipeGet = (target: string, res: http.ServerResponse, attempted: string) =>
    proxyGo2rtcFile({ go2rtcApi: d.go2rtcApi, target, res, attempted, log, label: "player file", down: go2rtcDown });

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(securityHeaders(req))) res.setHeader(k, v);
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    let attempted = `${method} ${url.pathname}`;
    try {
      const pulsePath = PULSE_PATH.exec(url.pathname);
      // The only writes here are the two pulse calls (a POST to a light, or to a light's clear).
      const pulseWrite = Boolean(pulsePath?.[1]) && method === "POST";
      // #109: the on-demand check is a POST too (it changes nothing, but runs a probe the settings page asked for).
      const checkPost = url.pathname === "/api/check" && method === "POST";
      if (method !== "GET" && method !== "HEAD" && !pulseWrite && !checkPost) {
        throw new UserError({ attempted, happened: "The dashboard is watch-only: it never changes anything.", changed: "Nothing.",
          next: "Change dashboard settings in the admin pane (needs the admin password)." }, 405);
      }
      if (url.pathname === "/healthz") return json(res, 200, { ok: true, ...healthFields() });
      if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
      if (pulsePath) {
        if (!d.pulse) throw new UserError({ attempted, happened: "The new-build switch isn't running in this dashboard.", changed: "Nothing.",
          next: "Update the dashboard container to a build that has it." }, 503);
        const api = d.pulse;
        if (pulsePath[1] === undefined) {
          attempted = "List the new-build lights";
          if (method !== "GET") throw new UserError({ attempted, happened: "The list is a GET.", changed: "Nothing.", next: "Send GET /api/pulse with the token." }, 405);
          api.checkToken(req.headers.authorization, attempted);
          return json(res, 200, { lights: api.list() });
        }
        let lamp: string;
        try { lamp = decodeURIComponent(pulsePath[1]); } catch {
          throw new UserError({ attempted, happened: "That light name isn't valid (it has a broken % escape).", changed: "Nothing.", next: "Use a light id from GET /api/pulse." }, 400);
        }
        if (pulsePath[2]) {
          // The open clear: it can only clear, and only from the dashboard's own page (the header a cross-site form can't send).
          attempted = `Clear the new-build pulse for "${lamp}"`;
          if (method !== "POST") throw new UserError({ attempted, happened: "Clearing a pulse is a POST.", changed: "Nothing.", next: "Tap the light on the dashboard." }, 405);
          if (req.headers["x-dash-action"] !== "clear") {
            throw new UserError({ attempted, happened: "This address only clears a pulse, and it's sent by the dashboard's own page (the x-dash-action: clear header is missing).",
              changed: "Nothing.", next: "Tap the light on the dashboard. A Claude switches a pulse on with the token (see the README)." }, 400);
          }
          return json(res, 200, { ok: true, lamp, ...api.clear(lamp) });
        }
        // The token switch: POST /api/pulse/<light> with {"on": true|false}, and the token as a bearer header.
        attempted = `Switch the new-build pulse for "${lamp}"`;
        if (method !== "POST") throw new UserError({ attempted, happened: "The switch is a POST with a JSON body.", changed: "Nothing.", next: "See the README for the curl." }, 405);
        api.checkToken(req.headers.authorization, attempted);
        const body = await readJsonBody(req, attempted);
        if (typeof body.on !== "boolean") {
          throw new UserError({ attempted, happened: 'The body needs "on": true or "on": false.', changed: "Nothing.", next: 'Send {"on": true} to turn the pulse on, or {"on": false} to turn it off.' }, 400);
        }
        const build = optionalText(body, "build", 80, attempted);
        const note = optionalText(body, "note", 200, attempted);
        return json(res, 200, { ok: true, lamp, ...api.set(lamp, body.on, { build, note }) });
      }
      if (url.pathname === "/api/check") {
        // #109: run one status-light check as entered on the admin settings page's Test button, and
        // (optionally) read a build page, so the owner sees reachable/state/reason before saving. It
        // is reached only through the admin proxy, which sets the header below; a cross-site form can't.
        attempted = "Check a status light";
        if (method !== "POST") throw new UserError({ attempted, happened: "A check is a POST with a JSON body.", changed: "Nothing.", next: "Use the Test button on the dashboard settings page." }, 405);
        if (req.headers["x-dash-action"] !== "check") {
          throw new UserError({ attempted, happened: "This address only runs a check asked for by the admin settings page (the x-dash-action: check header is missing).",
            changed: "Nothing.", next: "Use the Test button on the dashboard settings page; the admin pane sends it." }, 400);
        }
        const body = await readJsonBody(req, attempted);
        const bad = (field: string, msg: string) => new UserError({ attempted, happened: `${field}: ${msg}`, changed: "Nothing was checked.", next: "Fix the check and try again." }, 400);
        const check: ServiceCheck = validateServiceCheck(body.check, bad, "The");
        const reason = await runCheckDetailed(check, d.bridge ?? (() => null), 3000);
        const out: Record<string, unknown> = {
          reachable: reason === null, state: reason === null ? "ok" : "down",
          reason: reason?.full ?? null, short: reason?.short ?? null,
        };
        if (body.build !== undefined && body.build !== null) {
          if (typeof body.build !== "object" || Array.isArray(body.build) || typeof (body.build as Record<string, unknown>).url !== "string") {
            throw bad("Build page", "must be an object with a url");
          }
          const bu = String((body.build as Record<string, unknown>).url).trim();
          if (bu) {
            const why = checkBuildUrl(bu);
            if (why) { out.build = null; out.buildError = `the build page address ${why}`; }
            else {
              const got = await readBuild(bu);
              if (got.ok) { out.build = got.build; out.buildError = null; }
              else { out.build = null; out.buildError = `couldn't read its build page (${got.reason})`; }
            }
          }
        }
        return json(res, 200, out);
      }
      if (STATIC[url.pathname]) {
        attempted = "Load the dashboard";
        const file = path.join(d.webRoot, STATIC[url.pathname]);
        let body: string;
        try { body = fs.readFileSync(file, "utf8"); } catch (err) {
          throw new UserError({ attempted, happened: `The dashboard's web files are missing from this build (${(err as Error).message}).`,
            changed: "Nothing; the HomeKit bridge is unaffected.", next: "Rebuild the image (the Dockerfile must copy web/ into it)." }, 500);
        }
        if (file.endsWith(".html")) body = body.replace(/__TITLE__/g, d.title);
        res.writeHead(200, { "content-type": MIME[path.extname(file)] });
        return res.end(body);
      }
      if (url.pathname === "/api/config") return json(res, 200, d.publicConfig());
      if (url.pathname === "/api/state") return json(res, 200, d.state());
      if (url.pathname === "/api/photos") return json(res, 200, d.photos());
      if (url.pathname.startsWith("/fonts/")) {
        attempted = "Load a dashboard font";
        const name = url.pathname.slice("/fonts/".length);   // not decoded: a real font name has no % in it
        const gone = () => new UserError({ attempted, happened: `The font file "${name}" isn't in the dashboard's fonts folder.`, changed: "Nothing; the page uses a system font instead.",
          next: "Put the file in data/dash/fonts on the host, or pick another font in the dashboard settings." }, 404);
        if (!FONT_FILE.test(name)) throw gone();
        const body = readFontFile(d.fontsDir, name, { attempted, log, notThere: gone, changed: "Nothing; the page uses a system font instead.",
          unreadableNext: "Check the file's permissions in data/dash/fonts on the host (the container must be able to read it), or pick another font in the dashboard settings." });
        // Fonts never change under the same name; a day's cache keeps the kiosk's reloads light.
        res.writeHead(200, { "content-type": FONT_MIME[path.extname(name).toLowerCase()], "content-length": String(body.length), "cache-control": "public, max-age=86400" });
        return res.end(body);
      }
      if (url.pathname.startsWith("/api/photo/")) {
        attempted = "Load a slideshow photo";
        const id = url.pathname.slice("/api/photo/".length);
        const file = /^[0-9a-f]{12}$/.test(id) ? d.photoFile(id) : null;
        const notThere = () => new UserError({ attempted, happened: "That photo isn't in the slideshow any more (the album or folder changed).", changed: "Nothing.", next: "Nothing to do; the slideshow moves on to the next photo." }, 404);
        if (!file) throw notThere();
        let body: Buffer;
        try { body = fs.readFileSync(file); } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
          if (code === "ENOENT") throw notThere();
          log.warn(`slideshow photo ${id} couldn't be read (${code})`);
          throw new UserError({ attempted, happened: `That photo is in the slideshow but couldn't be read (${code}).`, changed: "Nothing.", next: "Check the photo folder's permissions on the host; the slideshow moves on to the next photo." }, 500);
        }
        res.writeHead(200, { "content-type": PHOTO_EXT[path.extname(file).toLowerCase()] ?? "image/jpeg", "content-length": String(body.length) });
        return res.end(body);
      }
      if (url.pathname.startsWith("/go2rtc/")) {
        attempted = "Load the camera player";
        const sub = url.pathname.slice("/go2rtc".length);
        if (!GO2RTC_FILES.has(sub)) throw new UserError({ attempted, happened: "That go2rtc address isn't passed through by the dashboard.", changed: "Nothing.", next: "Open the dashboard's home page." }, 404);
        if (!go2rtcUp()) throw go2rtcDown(attempted);
        await pipeGet(sub, res, attempted);
        return;
      }
      throw new UserError({ attempted, happened: "No such page on the dashboard.", changed: "Nothing.", next: "Open the dashboard's home page." }, 404);
    } catch (e) {
      const { status, body } = toErrorJson(e, attempted);
      if (status >= 500) log.warn(`${attempted}: ${body.error.happened}`);
      if (!res.headersSent) json(res, status, body); else res.destroy();
    }
  });

  // The open video path: go2rtc's signalling socket, for configured cameras only, WebRTC messages
  // only, at most maxStreams at once. The video itself flows from go2rtc's WebRTC port directly.
  let open = 0;
  const maxStreams = d.maxStreams ?? 16;
  const maxPerIp = d.maxPerIp ?? 8;
  const openByIp = new Map<string, number>();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const ip = req.socket.remoteAddress ?? "unknown";
    const refuse = (code: string, why: string, level: "warn" | "info" = "warn") => {
      log[level](`refused a dashboard video connection from ${ip}: ${why}`);
      socket.end(`HTTP/1.1 ${code}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${why}\n`);
    };
    socket.on("error", () => socket.destroy());   // a browser that vanished mid-handshake
    // Node hands any method carrying "Upgrade" here, past the request handler's 405: watch-only here too.
    if (req.method !== "GET") return refuse("405 Method Not Allowed", "the dashboard is watch-only: a live view is a GET");
    const src = url.searchParams.get("src") ?? "";
    if (url.pathname !== "/go2rtc/api/ws") return refuse("404 Not Found", "only /go2rtc/api/ws is a WebSocket here");
    if (!STREAM_NAME.test(src)) return refuse("400 Bad Request", `${JSON.stringify(src.slice(0, 80))} isn't a stream name`);
    // The admin pane's feed-check streams are never the dashboard's, whatever a camera is called.
    if (src.startsWith("check_")) return refuse("403 Forbidden", `"${src}" is an admin feed check, not a dashboard camera`);
    // #53: in the first second after a restart the camera list hasn't arrived yet; that's "starting", not a config.json problem.
    if (d.camerasLoaded && !d.camerasLoaded()) return refuse("503 Service Unavailable", "the dashboard is still starting (the bridge hasn't sent its camera list yet); the tile retries in a moment", "info");
    if (!d.allowedStreams().has(src)) return refuse("403 Forbidden", `"${src}" isn't one of the cameras in config.json`);
    if (!go2rtcUp()) return refuse("503 Service Unavailable", go2rtcWhy());
    if (open >= maxStreams) return refuse("503 Service Unavailable", `too many live views open at once (${maxStreams}); close one and the tile retries`);
    const mine = openByIp.get(ip) ?? 0;
    if (mine >= maxPerIp) return refuse("503 Service Unavailable", `too many live views open from this device at once (${maxPerIp} of the ${maxStreams} total); close one and the tile retries`);
    open++;
    openByIp.set(ip, mine + 1);
    let counted = true;
    const done = () => {
      if (!counted) return;
      counted = false; open--;
      const left = (openByIp.get(ip) ?? 1) - 1;
      if (left > 0) openByIp.set(ip, left); else openByIp.delete(ip);
    };
    // The browser's frames are checked against the WebRTC-only filter; its cookie never leaves.
    proxyGo2rtcSocket({ req, socket, head, go2rtcApi: d.go2rtcApi, src, log, label: "dashboard video", filter: new ClientFrameFilter(), onGone: done });
  });
  return server;
}

/** A failed listen in plain words: what was tried, what happened, what changed, what to do. */
export function describeListenError(host: string, port: number, err: NodeJS.ErrnoException): UserErrorBody {
  const where = `${host}:${port}`;
  const attempted = `Start the dashboard on ${where}`;
  const changed = "The dashboard isn't running; the HomeKit bridge and the admin pane are unaffected. The bridge retries it with backoff (up to once a minute).";
  if (err.code === "EADDRNOTAVAIL") {
    return { attempted, changed, happened: `The address ${host} isn't on this machine (EADDRNOTAVAIL), so nothing can listen on it.`,
      next: `Add ${host} to the host's network (or fix UNSCRYPTED_DASH_HOST; 0.0.0.0 means every address), then restart the container. It also starts on its own once the address appears.` };
  }
  if (err.code === "EADDRINUSE") {
    return { attempted, changed, happened: `Something else is already listening on ${where} (EADDRINUSE).`,
      next: `Find it with "sudo ss -lntp | grep :${port}" and stop it, or set UNSCRYPTED_DASH_PORT to a free port. The dashboard starts on its own once the port is free.` };
  }
  if (err.code === "EACCES") {
    return { attempted, changed, happened: `Not allowed to listen on ${where} (EACCES; ports below 1024 need extra permission).`,
      next: "Use a port of 1024 or above in UNSCRYPTED_DASH_PORT, or give the container permission for low ports." };
  }
  return { attempted, changed, happened: `Listening on ${where} failed: ${err.message}${err.code ? ` (${err.code})` : ""}.`,
    next: "Check UNSCRYPTED_DASH_HOST and UNSCRYPTED_DASH_PORT, then restart the container." };
}

/** Listen, or reject with the plain-words reason. Never throws synchronously. */
export function listenDash(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => reject(new UserError(describeListenError(host, port, err), 503));
    server.once("error", onError);
    server.listen(port, host, () => { server.off("error", onError); resolve(); });
  });
}
