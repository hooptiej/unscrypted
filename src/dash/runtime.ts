/**
 * The dash child's state: the bridge's public camera list and status, the settings file, and
 * (later tasks) the probe, status, weather and photo loops. Builds /api/config and /api/state.
 */

import * as path from "path";
import { DashBridgeInfo, DashCamera } from "./ipc";
import { DashSettings, loadSettings, effectiveCameras } from "./settings";
import { PublicConfig } from "./server";
import { Logger } from "../logger";

export interface DashRuntimeOptions { dir: string; title: string; env: "prod" | "test"; adminPort: number; log: Logger }

export class DashRuntime {
  cameras: DashCamera[] = [];
  bridge: DashBridgeInfo | null = null;
  settings: DashSettings;
  settingsWarning: string | null;
  settingsMtime: number;
  readonly settingsFile: string;

  constructor(private readonly o: DashRuntimeOptions) {
    this.settingsFile = path.join(o.dir, "settings.json");
    const s = loadSettings(this.settingsFile);
    this.settings = s.settings; this.settingsWarning = s.warning; this.settingsMtime = s.mtimeMs;
    if (s.warning) o.log.warn(s.warning);
  }

  /** Re-reads settings.json if its mtime changed. Returns true when it changed. */
  reloadSettingsIfChanged(statMtime: number): boolean {
    if (statMtime === this.settingsMtime) return false;
    const s = loadSettings(this.settingsFile);
    this.settings = s.settings; this.settingsWarning = s.warning; this.settingsMtime = s.mtimeMs;
    if (s.warning) this.o.log.warn(s.warning); else this.o.log.info("dashboard settings changed; reloaded");
    return true;
  }

  shown(): { cam: DashCamera; label: string; stream: string }[] {
    return effectiveCameras(this.settings, this.cameras.map((c) => c.name))
      .filter((p) => p.shown && !p.missing)
      .map((p) => {
        const cam = this.cameras.find((c) => c.name === p.camera)!;
        return { cam, label: p.label, stream: p.stream === "sub" && cam.sub ? cam.sub : cam.main };
      });
  }

  allowedStreams(): Set<string> {
    const s = new Set<string>();
    for (const c of this.cameras) { s.add(c.main); if (c.sub) s.add(c.sub); }
    return s;
  }

  publicConfig(): PublicConfig {
    const s = this.settings;
    return {
      title: this.o.title, env: this.o.env, adminPort: this.o.adminPort,
      idleSeconds: s.idleSeconds, pollSeconds: s.pollSeconds, reloadMinutes: s.reloadMinutes,
      cameras: this.shown().map((x) => ({ id: x.cam.main, label: x.label, stream: x.stream })),
      fonts: { ui: { family: null }, clock: { inherit: true } },   // Task 9 fills this in
    };
  }

  state(): Record<string, unknown> {
    return { updated: Date.now(), settingsVersion: this.settingsMtime, settingsWarning: this.settingsWarning,
      bridgeKnown: this.bridge !== null, go2rtc: this.bridge?.go2rtc ?? null };
  }
}
