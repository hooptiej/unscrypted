/**
 * Dash child entry point, forked and supervised by the bridge. Serves the open, watch-only
 * dashboard. Gets cameras and bridge status only over IPC; never reads config.json, the admin
 * password or the session key. A crash here is restarted with backoff; HomeKit is unaffected.
 */

import * as fs from "fs";
import * as path from "path";
import { createDashServer, listenDash } from "./server";
import { UserError } from "../admin/errors";
import { DashRuntime } from "./runtime";
import { checkToDash } from "./ipc";
import { Logger } from "../logger";

const log = new Logger("dash");
const hapOff = process.env.UNSCRYPTED_HAP === "off";
const port = Number(process.env.UNSCRYPTED_DASH_PORT ?? 8180);
const host = process.env.UNSCRYPTED_DASH_HOST || "0.0.0.0";
const dir = process.env.UNSCRYPTED_DASH_DIR || "/data/dash";
const title = process.env.UNSCRYPTED_DASH_TITLE || (hapOff ? "Homedash - TEST" : "Homedash");
const rt = new DashRuntime({ dir, title, env: hapOff ? "test" : "prod", adminPort: Number(process.env.UNSCRYPTED_ADMIN_PORT ?? 8190), log });

process.on("message", (raw: unknown) => {
  const m = checkToDash(raw);
  if (typeof m === "string") { log.warn(`ignored a malformed message from the bridge: ${m}`); return; }
  if (m.type === "cameras") rt.cameras = m.cameras; else rt.bridge = m.bridge;
});
process.on("disconnect", () => { log.warn("lost the connection to the bridge; exiting (the bridge restarts the dashboard)"); process.exit(0); });
process.on("unhandledRejection", (e) => log.error(`unhandled rejection in the dashboard (kept running): ${(e as Error)?.stack ?? e}`));
process.on("uncaughtException", (e) => { log.error(`dashboard crashed: ${e.stack ?? e}. The bridge will restart it.`); process.exit(1); });

setInterval(() => {
  try { rt.reloadSettingsIfChanged(fs.statSync(rt.settingsFile).mtimeMs); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") rt.reloadSettingsIfChanged(0);   // deleted: back to defaults
    else log.warn(`couldn't check ${rt.settingsFile}: ${(err as Error).message}`);
  }
}, 2000).unref();

// Camera reachability, every pollSeconds (re-read each round so a settings change takes effect).
let probing = false;
const probeLoop = async (): Promise<void> => {
  if (!probing) {
    probing = true;
    try { await rt.probeCameras(); }
    catch (err) { log.error(`camera reachability check failed (tiles keep their last state): ${(err as Error).stack ?? err}`); }
    finally { probing = false; }
  }
  setTimeout(() => void probeLoop(), Math.max(2, rt.settings.pollSeconds || 4) * 1000).unref();
};
setTimeout(() => void probeLoop(), 500).unref();   // after the bridge's first camera list

const server = createDashServer({
  webRoot: path.join(__dirname, "..", "..", "web", "dash"), title,
  go2rtcApi: process.env.UNSCRYPTED_GO2RTC_API ?? "",
  publicConfig: () => rt.publicConfig(), state: () => rt.state(), allowedStreams: () => rt.allowedStreams(),
  go2rtcInfo: () => rt.bridge?.go2rtc ?? { state: "unknown", lastError: "the bridge hasn't reported yet", nextRetryAt: null },
  photoFile: () => null, fontsDir: path.join(dir, "fonts"), log,
});
listenDash(server, host, port).then(
  () => {
    log.info(`dashboard listening on http://${host}:${port}`);
    if (process.send && process.connected) process.send({ type: "listening", host, port }, (err) => { if (err) log.warn(`couldn't tell the bridge the dashboard is up: ${err.message}`); });
  },
  (err: unknown) => {
    const body = err instanceof UserError ? err.body : null;
    const line = body ? `${body.attempted}: ${body.happened} ${body.changed} Next: ${body.next}` : `couldn't start the dashboard: ${(err as Error)?.message ?? err}`;
    log.error(line);
    // Tell the bridge why, so its Status page says it in words instead of "exited with code 1".
    const bye = () => process.exit(1);
    if (process.send && process.connected) {
      try { process.send({ type: "listen-failed", error: body ?? { attempted: "Start the dashboard", happened: String((err as Error)?.message ?? err), changed: "The dashboard isn't running; HomeKit is unaffected.", next: "Check the bridge log." } }, bye); }
      catch { bye(); }   // the bridge already went away; the log line above says why
    } else bye();
  },
);
