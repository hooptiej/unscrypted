/**
 * The open, watch-only dashboard server (runs in the forked dash child). GET only. No cookies are
 * set or read. Every failure is the four-part plain-words error. See the plan's Global
 * Constraints for the guardrails; the admin pane is the only place anything can be changed.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { UserError, UserErrorBody, toErrorJson } from "../admin/errors";
import { securityHeaders } from "../admin/server";
import { Logger } from "../logger";

export interface PublicConfig {
  title: string; env: "prod" | "test"; adminPort: number;
  idleSeconds: number; pollSeconds: number; reloadMinutes: number;
  cameras: { id: string; label: string; stream: string }[];
  fonts: { ui: unknown; clock: unknown };
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
  photoFile: (id: string) => string | null;
  fontsDir: string;
  /** Live views open at once through this server (default 16). */
  maxStreams?: number;
  log?: Logger;
}

const STATIC: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

export function createDashServer(d: DashDeps): http.Server {
  const log = d.log ?? new Logger("dash");
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

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
      throw new UserError({ attempted, happened: "No such page on the dashboard.", changed: "Nothing.", next: "Open the dashboard's home page." }, 404);
    } catch (e) {
      const { status, body } = toErrorJson(e, attempted);
      if (status >= 500) log.warn(`${attempted}: ${body.error.happened}`);
      if (!res.headersSent) json(res, status, body); else res.destroy();
    }
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
