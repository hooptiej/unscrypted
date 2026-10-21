/**
 * The dash child's state: the bridge's public camera list, status and go2rtc feed states, the
 * settings file, and the service-light, weather and photo loops. Builds /api/config and /api/state.
 */

import * as path from "path";
import { DashBridgeInfo, DashCamera, DashFeed } from "./ipc";
import { DashSettings, loadSettings, effectiveCameras } from "./settings";
import { PublicConfig } from "./server";
import { Logger } from "../logger";
import { ServiceWatcher, LightNode } from "./services";
import { PhotoLibrary } from "./photos";
import { listFonts, fontOut } from "./fonts";
import { Weather, FetchJson, defaultFetchJson, resolveLocation, fetchWeather } from "./weather";

export interface DashRuntimeOptions {
  dir: string; title: string; env: "prod" | "test"; adminPort: number; log: Logger;
  /** The admin pane's base URL when it isn't this host (UNSCRYPTED_ADMIN_URL), else null; plus why a bad one was ignored. */
  adminUrl?: string | null; adminUrlError?: string | null;
}

export class DashRuntime {
  cameras: DashCamera[] = [];
  bridge: DashBridgeInfo | null = null;
  settings: DashSettings;
  settingsWarning: string | null;
  settingsMtime: number;
  readonly settingsFile: string;
  /** go2rtc's feed state per stream name, pushed by the bridge every 2 s (never a probe of the camera). */
  private feeds: Record<string, DashFeed> = {};
  /** The service-light tree from the last status round, and when it finished (null = not yet). */
  services: LightNode[] = [];
  servicesAt: number | null = null;
  private watcher = new ServiceWatcher();
  /** The last good forecast stays up through a failure; the error line says how old it is. */
  weather: Weather | null = null;
  weatherError: string | null = null;
  weatherErrorSince: number | null = null;
  readonly photos = new PhotoLibrary();
  get photoCacheDir(): string { return path.join(this.o.dir, "cache", "icloud"); }
  private wxLoc: { key: string; loc: { lat: number; lon: number; label: string } | null } | null = null;

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

  shown(): { cam: DashCamera; label: string; stream: string; which: "main" | "sub" }[] {
    return effectiveCameras(this.settings, this.cameras.map((c) => c.name))
      .filter((p) => p.shown && !p.missing)
      .map((p) => {
        const cam = this.cameras.find((c) => c.name === p.camera)!;
        const sub = p.stream === "sub" && cam.sub !== null;
        return { cam, label: p.label, stream: sub ? cam.sub! : cam.main, which: sub ? "sub" : "main" };
      });
  }

  setFeeds(f: Record<string, DashFeed>): void { this.feeds = f; }

  /** Each shown tile's state (keyed by the camera's main stream name), from the stream the tile plays. */
  private tileStates(): Record<string, DashFeed> {
    return Object.fromEntries(this.shown().map((x) => [x.cam.main,
      this.feeds[x.stream] ?? { state: "unknown", up: true, reason: null, since: Date.now() }]));
  }

  /** One round of service checks. Never throws (every check turns its failure into a reason). */
  async pollServices(): Promise<void> {
    this.services = await this.watcher.poll(this.settings.services, () => this.bridge);
    this.servicesAt = Date.now();
  }

  /** One weather round. Returns the seconds until the next one (60 after an error or with no place). Never throws. */
  async refreshWeather(fetchJson: FetchJson = defaultFetchJson): Promise<number> {
    const w = this.settings.weather;
    const key = JSON.stringify([w.place, w.lat, w.lon]);
    const fail = (msg: string) => {
      if (this.weatherError === null || this.weatherErrorSince === null) this.weatherErrorSince = Date.now();
      this.weatherError = msg;
    };
    try {
      if (!this.wxLoc || this.wxLoc.key !== key) {
        this.wxLoc = null;
        if (this.weather && this.weather.place !== w.place) this.weather = null;   // don't show the old town's weather
        this.wxLoc = { key, loc: await resolveLocation(w, fetchJson) };
      }
      const loc = this.wxLoc.loc;
      if (!loc) {
        this.weather = null; this.weatherErrorSince = null;
        this.weatherError = "No weather place is set. Add one in the dashboard settings (admin password needed).";
        return 60;
      }
      this.weather = { ...(await fetchWeather(loc.lat, loc.lon, w.unit, fetchJson)), place: loc.label };
      this.weatherError = null; this.weatherErrorSince = null;
      return Math.max(60, w.refreshSeconds || 600);
    } catch (err) {
      const msg = (err as Error).message;
      fail(`${msg}. Retrying every minute.`);
      this.o.log.warn(`weather: ${msg} (retrying in 60 s)`);
      return 60;
    }
  }

  photoList(): { items: { id: string; v: number }[]; album: string; rotateSeconds: number; error: string | null } {
    return { ...this.photos.list(), rotateSeconds: this.settings.photos.rotateSeconds };
  }

  allowedStreams(): Set<string> {
    const s = new Set<string>();
    for (const c of this.cameras) { s.add(c.main); if (c.sub) s.add(c.sub); }
    return s;
  }

  /** Font output for the page, plus a plain warning for each font that couldn't be used. */
  private fonts(): { ui: unknown; clock: unknown; notices: string[] } {
    const l = listFonts(path.join(this.o.dir, "fonts"));
    const ui = fontOut(this.settings.fonts.ui, "ui", l.fonts);
    const clock = fontOut(this.settings.fonts.clock, "clock", l.fonts);
    return { ui: ui.out, clock: clock.out, notices: [l.warning, ui.warning, clock.warning].filter((x): x is string => Boolean(x)) };
  }

  publicConfig(): PublicConfig {
    const s = this.settings;
    const f = this.fonts();
    return {
      title: this.o.title, env: this.o.env, adminPort: this.o.adminPort,
      // The kiosk's Settings button. null = the page works it out (this host, the admin port).
      settingsUrl: this.o.adminUrl ? `${this.o.adminUrl}/dash-settings?from=dash` : null,
      idleSeconds: s.idleSeconds, pollSeconds: s.pollSeconds, reloadMinutes: s.reloadMinutes,
      cameras: this.shown().map((x) => ({ id: x.cam.main, label: x.label, stream: x.stream, which: x.which })),
      fonts: { ui: f.ui, clock: f.clock },
      glow: { intensity: s.glow.intensity, size: s.glow.size },
    };
  }

  state(): Record<string, unknown> {
    return { updated: Date.now(), settingsVersion: this.settingsMtime, settingsWarning: this.settingsWarning,
      bridgeKnown: this.bridge !== null, go2rtc: this.bridge?.go2rtc ?? null, cameras: this.tileStates(),
      services: this.services, servicesAt: this.servicesAt,
      weather: this.weather, weatherError: this.weatherError, weatherErrorSince: this.weatherErrorSince,
      notices: [...(this.o.adminUrlError ? [this.o.adminUrlError] : []), ...this.fonts().notices] };
  }
}
