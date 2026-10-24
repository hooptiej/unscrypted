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
import { parseBaseUrl } from "./settings";

const log = new Logger("dash");
const hapOff = process.env.UNSCRYPTED_HAP === "off";
const port = Number(process.env.UNSCRYPTED_DASH_PORT ?? 8180);
const host = process.env.UNSCRYPTED_DASH_HOST || "0.0.0.0";
const dir = process.env.UNSCRYPTED_DASH_DIR || "/data/dash";
const title = process.env.UNSCRYPTED_DASH_TITLE || (hapOff ? "Homedash - TEST" : "Homedash");
const adminUrl = parseBaseUrl("UNSCRYPTED_ADMIN_URL", process.env.UNSCRYPTED_ADMIN_URL);
if (adminUrl.error) log.warn(adminUrl.error);
const rt = new DashRuntime({ dir, title, env: hapOff ? "test" : "prod", adminPort: Number(process.env.UNSCRYPTED_ADMIN_PORT ?? 8190), log,
  adminUrl: adminUrl.url, adminUrlError: adminUrl.error });

process.on("message", (raw: unknown) => {
  const m = checkToDash(raw);
  if (typeof m === "string") { log.warn(`ignored a malformed message from the bridge: ${m}`); return; }
  if (m.type === "cameras") { rt.cameras = m.cameras; rt.camerasLoaded = true; } else rt.bridge = m.bridge;
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

// Service lights, on the same interval; a round that's still running is never doubled up.
let checking = false;
const serviceLoop = async (): Promise<void> => {
  if (!checking) {
    checking = true;
    try { await rt.pollServices(); }
    catch (err) { log.error(`service-light round failed (the lights keep their last state, and the page shows how old it is): ${(err as Error).stack ?? err}`); }
    finally { checking = false; }
  }
  setTimeout(() => void serviceLoop(), Math.max(2, rt.settings.pollSeconds || 4) * 1000).unref();
};
setTimeout(() => void serviceLoop(), 700).unref();

// Weather: refreshSeconds after a good round, a minute after an error or with no place. A place
// change shows up within 5 s (refreshWeather re-geocodes when place/lat/lon differ).
let wxKey = "";
let wxTimer: NodeJS.Timeout | null = null;
const weatherLoop = async (): Promise<void> => {
  wxTimer = null;   // null while a round runs, so the change watcher below can't start a second one
  const w = rt.settings.weather;
  wxKey = JSON.stringify([w.place, w.lat, w.lon, w.unit]);
  let next = 60;
  try { next = await rt.refreshWeather(); }
  catch (err) { log.error(`weather round failed unexpectedly (retrying in 60 s): ${(err as Error).stack ?? err}`); }
  wxTimer = setTimeout(() => void weatherLoop(), next * 1000);
  wxTimer.unref();
};
setInterval(() => {
  const w = rt.settings.weather;
  if (wxTimer && JSON.stringify([w.place, w.lat, w.lon, w.unit]) !== wxKey) { clearTimeout(wxTimer); wxTimer = null; void weatherLoop(); }
}, 5000).unref();
setTimeout(() => void weatherLoop(), 1000).unref();

// Photos: every refreshMinutes, a minute after an error, and at once when the photo settings change.
let phKey = "";
let phTimer: NodeJS.Timeout | null = null;
const photoKey = () => { const p = rt.settings.photos; return JSON.stringify([p.source, p.folder, p.icloudUrl, p.maxPhotos, p.caption]); };
const photoLoop = async (): Promise<void> => {
  phTimer = null;
  phKey = photoKey();
  try { await rt.photos.refresh(rt.settings.photos, rt.photoCacheDir); }
  catch (err) { log.error(`photo refresh failed unexpectedly: ${(err as Error).stack ?? err}`); }
  const e = rt.photos.list().error;
  if (e) log.warn(e);
  phTimer = setTimeout(() => void photoLoop(), rt.photos.retrySoon ? 60_000 : Math.max(1, rt.settings.photos.refreshMinutes || 30) * 60_000);
  phTimer.unref();
};
setInterval(() => { if (phTimer && photoKey() !== phKey) { clearTimeout(phTimer); void photoLoop(); } }, 5000).unref();
setTimeout(() => void photoLoop(), 1500).unref();

const server = createDashServer({
  webRoot: path.join(__dirname, "..", "..", "web", "dash"), title,
  go2rtcApi: process.env.UNSCRYPTED_GO2RTC_API ?? "",
  publicConfig: () => rt.publicConfig(), state: () => rt.state(), allowedStreams: () => rt.allowedStreams(), camerasLoaded: () => rt.camerasLoaded,
  go2rtcInfo: () => rt.bridge?.go2rtc ?? { state: "unknown", lastError: "the bridge hasn't reported yet", nextRetryAt: null },
  photos: () => rt.photoList(), photoFile: (id) => rt.photos.file(id), fontsDir: path.join(dir, "fonts"), log,
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
