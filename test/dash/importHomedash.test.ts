import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { tempDir } from "../helpers/tmp";
import { importHomedash, parseMap } from "../../src/dash/importHomedash";
import { applySettingsEdit, DEFAULTS } from "../../src/dash/settings";

// Shaped like prod's data/config.json (Findings 4); the album link here is made up.
const HD = {
  idle_seconds: 30, reload_minutes: 20,
  cameras: [
    { key: "backyardcam", name: "BackyardCam", ip: "10.0.1.4", port: 554, enabled: true },
    { key: "garagecam", name: "Garagecam", ip: "10.0.1.3", port: 554, enabled: true },
    { key: "dogcam", name: "DogCam", ip: "10.0.1.99", port: 554, enabled: false },
    { key: "onvif_camera", name: "ONVIF Camera", ip: "10.0.1.9", port: 554, enabled: true },
  ],
  photos: { source: "icloud", icloud_url: "https://www.icloud.com/sharedalbum/#B0aTESTTOKEN", folder: "/app/data/photos", rotate_seconds: 25, refresh_minutes: 30, max_photos: 0, caption: "" },
  weather: { place: "Sterling, CO", lat: 40.6, lon: -103.2, unit: "fahrenheit", refresh_seconds: 600 },
  fonts: { ui: { kind: "constructicon", slug: "rMrRHh34w5nN" }, clock: { kind: "constructicon", slug: "Gone12345678" } },
};
const MAP = { dogcam: "DogCamTest", backyardcam: "BackyardCamTest", garagecam: "GarageCamTest", onvif_camera: "OnvifCamTest" };
const ctx = { cameras: ["Couch Cam", "GarageCamTest", "BackyardCamTest", "OnvifCamTest", "DogCamTest"], fontFiles: ["rMrRHh34w5nN.otf"] };

test("maps a prod-shaped Homedash config: order, labels, shown, main streams, paths, fonts", () => {
  const { settings: s, warnings } = importHomedash(HD, MAP, ctx.fontFiles);
  assert.deepEqual(s.cameras, [
    { camera: "BackyardCamTest", label: "BackyardCam", shown: true, stream: "main" },
    { camera: "GarageCamTest", label: "Garagecam", shown: true, stream: "main" },
    { camera: "DogCamTest", label: "DogCam", shown: false, stream: "main" },
    { camera: "OnvifCamTest", label: "ONVIF Camera", shown: true, stream: "main" },
  ]);
  assert.equal(s.photos.folder, "/data/dash/photos");
  assert.equal(s.photos.source, "icloud");
  assert.equal(s.photos.rotateSeconds, 25);
  assert.deepEqual([s.weather.place, s.weather.lat, s.weather.lon, s.weather.refreshSeconds], ["Sterling, CO", 40.6, -103.2, 600]);
  assert.deepEqual(s.fonts.ui, { kind: "file", file: "rMrRHh34w5nN.otf" });
  assert.deepEqual(s.fonts.clock, { kind: "system", family: "inherit" }, "a font that isn't in the folder falls back");
  assert.match(warnings.join(" "), /clock font: Constructicon font "Gone12345678" isn't in the fonts folder/);
  assert.doesNotMatch(JSON.stringify(s), /10\.0\.1\.(4|3|99|9)\b/, "camera IPs aren't carried over");
});

test("the result round-trips the settings page's own validation unchanged", () => {
  const { settings } = importHomedash(HD, MAP, ctx.fontFiles);
  assert.deepEqual(applySettingsEdit(DEFAULTS, settings, ctx).cameras, settings.cameras);
  const again = { ...applySettingsEdit(DEFAULTS, settings, ctx), weather: settings.weather, photos: settings.photos };
  assert.deepEqual(again, settings);
});

test("an unmapped camera key is refused by name", () => {
  const { dogcam: _d, ...rest } = MAP;
  assert.throws(() => importHomedash(HD, rest, []), /no --map entry for 'dogcam'/);
  assert.deepEqual(parseMap("dogcam=DogCamTest,onvif_camera=OnvifCamTest"), { dogcam: "DogCamTest", onvif_camera: "OnvifCamTest" });
  assert.throws(() => parseMap("dogcam"), /--map wants key=Camera Name pairs/);
});

test("CLI: writes the file, refuses to overwrite without --force, exits non-zero on a refusal", () => {
  const d = tempDir("unscr-import-");
  const inF = path.join(d, "hd.json"), out = path.join(d, "dash", "settings.json"), cfg = path.join(d, "config.json");
  fs.writeFileSync(inF, JSON.stringify(HD));
  fs.writeFileSync(cfg, JSON.stringify({ bridge: { name: "U", username: "CC:22:3D:E3:CE:F6", pin: "031-45-154" }, cameras: ctx.cameras.map((name) => ({ name, rtspMain: "rtsp://a:b@10.0.0.1/1" })) }));
  fs.mkdirSync(path.join(d, "dash", "fonts"), { recursive: true });
  fs.writeFileSync(path.join(d, "dash", "fonts", "rMrRHh34w5nN.otf"), "OTTO");
  const cli = path.join(__dirname, "../../src/dash/importHomedash.ts");
  const run = (...extra: string[]) => execFileSync(process.execPath, ["--import", "tsx", cli, inF, out, "--map", Object.entries(MAP).map(([k, v]) => `${k}=${v}`).join(","), "--config", cfg, ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const printed = run();
  assert.match(printed, /BackyardCam -> BackyardCamTest/);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).cameras.length, 4);
  assert.throws(() => run(), (e: any) => e.status !== 0 && /already exists[\s\S]*--force/.test(e.stderr));
  run("--force");
  assert.ok(fs.existsSync(out + ".bak"), "the overwritten file is kept");
});
