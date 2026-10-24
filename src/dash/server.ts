/**
 * The open, watch-only dashboard server (runs in the forked dash child). GET only. No cookies are
 * set or read. Every failure is the four-part plain-words error. See the plan's Global
 * Constraints for the guardrails; the admin pane is the only place anything can be changed.
 */

import * as http from "http";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { UserError, UserErrorBody, toErrorJson } from "../admin/errors";
import { securityHeaders } from "../admin/server";
import { Logger } from "../logger";
import { ClientFrameFilter } from "./wsFilter";
import { PHOTO_EXT } from "./photos";
import { FONT_MIME } from "./fonts";
import { FONT_FILE } from "./settings";

export interface PublicConfig {
  title: string; env: "prod" | "test"; adminPort: number; settingsUrl: string | null;
  idleSeconds: number; pollSeconds: number; reloadMinutes: number;
  /** `which`: the stream the tile actually plays (a "sub" pick on a camera with no sub plays main). */
  cameras: { id: string; label: string; stream: string; which: "main" | "sub" }[];
  fonts: { ui: unknown; clock: unknown };
  /** Background glow knobs (#25), percents from -100 to +100; 0 = the default look. */
  glow: { intensity: number; size: number };
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
  log?: Logger;
}

const STATIC: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
/** The only go2rtc files the open page gets: its player. Its API (streams, frames, config) never passes. */
const GO2RTC_FILES = new Set(["/video-stream.js", "/video-rtc.js"]);
const STREAM_NAME = /^[a-z0-9_]{1,64}$/;

export function createDashServer(d: DashDeps): http.Server {
  const log = d.log ?? new Logger("dash");
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

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

  /** Stream one of go2rtc's player files to the browser. 20 s timeout; failures are the four-part error. */
  const pipeGet = (target: string, res: http.ServerResponse, attempted: string) => new Promise<void>((resolve) => {
    const upstream = http.request(d.go2rtcApi + target, { method: "GET", timeout: 20_000 }, (up) => {
      res.writeHead(up.statusCode ?? 502, { "content-type": up.headers["content-type"] ?? "application/octet-stream" });
      up.pipe(res);
      up.on("end", resolve);
      up.on("error", (err) => { log.warn(`go2rtc player file broke off: ${err.message}`); res.destroy(); resolve(); });
    });
    upstream.on("timeout", () => upstream.destroy(new Error("go2rtc didn't answer within 20 s")));
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

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(securityHeaders(req))) res.setHeader(k, v);
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    let attempted = `${method} ${url.pathname}`;
    try {
      if (method !== "GET" && method !== "HEAD") {
        throw new UserError({ attempted, happened: "The dashboard is watch-only: it never changes anything.", changed: "Nothing.",
          next: "Change dashboard settings in the admin pane (needs the admin password)." }, 405);
      }
      if (url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
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
          next: "Put the file in data/dash/fonts on the NAS, or pick another font in the dashboard settings." }, 404);
        if (!FONT_FILE.test(name)) throw gone();
        let body: Buffer;
        try { body = fs.readFileSync(path.join(d.fontsDir, name)); } catch { throw gone(); }
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
        try { body = fs.readFileSync(file); } catch { throw notThere(); }
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
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const refuse = (code: string, why: string) => {
      log.warn(`refused a dashboard video connection from ${req.socket.remoteAddress}: ${why}`);
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
    if (!d.allowedStreams().has(src)) return refuse("403 Forbidden", `"${src}" isn't one of the cameras in config.json`);
    if (!go2rtcUp()) return refuse("503 Service Unavailable", go2rtcWhy());
    if (open >= maxStreams) return refuse("503 Service Unavailable", `too many live views open at once (${maxStreams}); close one and the tile retries`);
    open++;
    let counted = true;
    const done = () => { if (counted) { counted = false; open--; } };
    const target = new URL(d.go2rtcApi);
    const filter = new ClientFrameFilter();
    let upgraded = false;
    const up = net.connect(Number(target.port), target.hostname, () => {
      const lines = [`GET /api/ws?src=${encodeURIComponent(src)} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        // the admin cookie never leaves; no compression either, so the filter reads plain frames
        if (/^(host|cookie|origin|authorization|sec-websocket-extensions)$/i.test(req.rawHeaders[i])) continue;
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push(`Host: ${target.host}`, "", "");
      up.write(lines.join("\r\n"));
      const feed = (chunk: Buffer) => {
        const r = filter.push(chunk);
        if ("reject" in r) { log.warn(`closed a dashboard video connection for "${src}": the browser sent ${r.reject}`); socket.destroy(); up.destroy(); return; }
        if (r.forward.length) up.write(r.forward);
      };
      if (head.length) feed(head);
      socket.on("data", feed);
      up.once("data", () => { upgraded = true; });
      up.pipe(socket);
    });
    up.on("error", (err) => {
      log.warn(`dashboard video: couldn't reach go2rtc at ${target.host} for "${src}": ${err.message}`);
      if (!upgraded && socket.writable) socket.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nthe video server (go2rtc) didn't answer: ${err.message}\n`);
      else socket.destroy();
      done();
    });
    // http.Server sockets are half-open: a browser hanging up sends "end", and "close" only follows
    // once our side ends too. Without this the live-view slot (and go2rtc's session) would leak.
    socket.on("end", () => { up.destroy(); socket.destroy(); done(); });
    socket.on("close", () => { up.destroy(); done(); });
    up.on("close", () => { socket.destroy(); done(); });
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
      next: `Add ${host} to the NAS's network (or fix UNSCRYPTED_DASH_HOST; 0.0.0.0 means every address), then restart the container. It also starts on its own once the address appears.` };
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
