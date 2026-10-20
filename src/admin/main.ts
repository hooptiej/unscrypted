/**
 * Admin child entry point, forked and supervised by the bridge (src/bridgeRuntime.ts). It serves
 * the admin pane and talks to the bridge only over the IPC channel. If it crashes, the bridge logs
 * it and restarts it with backoff; HomeKit keeps running either way.
 */

import * as path from "path";
import { randomUUID } from "crypto";
import { createAdminServer } from "./server";
import { BridgeStatus, ToAdmin, ToBridge } from "./ipc";
import { Logger } from "../logger";
import { parseBaseUrl } from "../dash/settings";

const log = new Logger("admin");
let latest: BridgeStatus | null = null;
const waiting = new Map<string, (m: Extract<ToAdmin, { type: "applied" }> | null) => void>();

process.on("message", (m: ToAdmin) => {
  if (m?.type === "status") latest = m.status;
  else if (m?.type === "applied") {
    const done = waiting.get(m.reqId);
    if (done) { waiting.delete(m.reqId); done(m); }
    else log.warn(`bridge answered request ${m.reqId}, but nothing was waiting for it (it had already timed out)`);
  } else log.warn(`ignored an unknown message from the bridge: ${JSON.stringify(m)?.slice(0, 200)}`);
});
// Bridge went away: don't linger as an orphan holding the port.
process.on("disconnect", () => {
  log.warn("lost the connection to the bridge; exiting (the bridge restarts the pane when it comes back)");
  process.exit(0);
});
process.on("unhandledRejection", (e) => log.error(`unhandled rejection in the admin pane (kept running): ${(e as Error)?.stack ?? e}`));
process.on("uncaughtException", (e) => {
  log.error(`admin pane crashed: ${e.stack ?? e}. The bridge will restart it.`);
  process.exit(1);
});

const hapOff = process.env.UNSCRYPTED_HAP === "off";
const dashUrl = parseBaseUrl("UNSCRYPTED_DASH_URL", process.env.UNSCRYPTED_DASH_URL);
if (dashUrl.error) log.warn(dashUrl.error);
const port = Number(process.env.UNSCRYPTED_ADMIN_PORT ?? 8190);
const host = process.env.UNSCRYPTED_ADMIN_HOST || "0.0.0.0";
const server = createAdminServer({
  configPath: process.env.UNSCRYPTED_CONFIG ?? "/config/config.json",
  passwordFile: process.env.UNSCRYPTED_ADMIN_PASSWORD_FILE ?? "/run/secrets/unscrypted_admin_password",
  // The bridge sets this next to the HAP pairing state (persistDir's parent, /data in Docker).
  sessionKeyFile: process.env.UNSCRYPTED_ADMIN_KEY_FILE || "/data/admin-session.key",
  go2rtcApi: process.env.UNSCRYPTED_GO2RTC_API ?? "",
  webRoot: path.join(__dirname, "..", "..", "web", "admin"),
  // The test instance runs with HAP off, so it gets the " - TEST" tab label even if the title env is unset.
  title: process.env.UNSCRYPTED_ADMIN_TITLE || (hapOff ? "unscrypted admin - TEST" : "unscrypted admin"),
  // The bridge passes the dashboard's folder and port; UNSCRYPTED_DASH_URL only when it lives elsewhere.
  dash: { dir: process.env.UNSCRYPTED_DASH_DIR || "/data/dash", port: Number(process.env.UNSCRYPTED_DASH_PORT ?? 8180), url: dashUrl.url },
  log,
  bridge: {
    status: () => latest,
    request: (m, timeoutMs) => new Promise((resolve, reject) => {
      if (!process.send || !process.connected) {
        reject(new Error("the admin pane isn't connected to the bridge (it was started on its own, or the bridge is restarting)"));
        return;
      }
      const reqId = randomUUID();
      const timer = setTimeout(() => { waiting.delete(reqId); resolve(null); }, timeoutMs);
      waiting.set(reqId, (reply) => { clearTimeout(timer); resolve(reply); });
      process.send({ ...m, reqId } as ToBridge, (err: Error | null) => {
        if (err) { clearTimeout(timer); waiting.delete(reqId); reject(new Error(`couldn't send to the bridge: ${err.message}`)); }
      });
    }),
  },
});
server.on("error", (e: NodeJS.ErrnoException) => {
  log.error(`could not listen on ${host}:${port}: ${e.message}${e.code === "EADDRINUSE" ? " (something else is using it; set UNSCRYPTED_ADMIN_PORT)" : ""}`);
  process.exit(1);   // the supervisor logs it and retries with backoff
});
server.listen(port, host, () => log.info(`admin pane listening on http://${host}:${port}`));
