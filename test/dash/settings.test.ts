import { parseBaseUrl } from "../../src/dash/settings";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "../helpers/tmp";
import { DEFAULTS, loadSettings, applySettingsEdit, saveSettings, effectiveCameras, GRID_MAX } from "../../src/dash/settings";
import { UserError } from "../../src/admin/errors";

const ctx = { cameras: ["DogCamTest", "BackyardCamTest", "GarageCamTest", "OnvifCamTest", "Couch Cam"], fontFiles: ["rMrRHh34w5nN.otf"] };

test("missing file gives defaults and no warning", () => {
  const r = loadSettings(path.join(tempDir("unscr-dash-"), "settings.json"));
  assert.deepEqual(r.settings, DEFAULTS);
  assert.equal(r.warning, null);
});

test("broken file gives defaults plus a warning, and is not overwritten", () => {
  const f = path.join(tempDir("unscr-dash-"), "settings.json");
  fs.writeFileSync(f, "{not json");
  const r = loadSettings(f);
  assert.deepEqual(r.settings, DEFAULTS);
  assert.match(r.warning!, /settings\.json.*couldn't be read/i);
  assert.equal(fs.readFileSync(f, "utf8"), "{not json");
});

test("partial file is merged over defaults", () => {
  const f = path.join(tempDir("unscr-dash-"), "settings.json");
  fs.writeFileSync(f, JSON.stringify({ idleSeconds: 45, weather: { place: "Sterling, CO" } }));
  const s = loadSettings(f).settings;
  assert.equal(s.idleSeconds, 45);
  assert.equal(s.weather.place, "Sterling, CO");
  assert.equal(s.weather.unit, "fahrenheit");
});

test("edit validates ranges with the field name and changes nothing", () => {
  assert.throws(() => applySettingsEdit(DEFAULTS, { idleSeconds: 2 }, ctx), (e: unknown) =>
    e instanceof UserError && /Fullscreen timeout/.test(e.body.happened) && /Nothing was saved/.test(e.body.changed));
});

test("edit refuses an unknown camera and more than GRID_MAX shown", () => {
  assert.throws(() => applySettingsEdit(DEFAULTS, { cameras: [{ camera: "Nope", label: "x", shown: true, stream: "main" }] }, ctx), /isn't in config\.json/);
  const five = ctx.cameras.map((c) => ({ camera: c, label: c, shown: true, stream: "main" }));
  assert.throws(() => applySettingsEdit(DEFAULTS, { cameras: five }, ctx), new RegExp(`at most ${GRID_MAX}`));
});

test("labels are dashboard-only and never touch camera names", () => {
  const s = applySettingsEdit(DEFAULTS, { cameras: [{ camera: "DogCamTest", label: "DogCam", shown: true, stream: "main" }] }, ctx);
  assert.deepEqual(s.cameras, [{ camera: "DogCamTest", label: "DogCam", shown: true, stream: "main" }]);
});

test("a font must be a file in the fonts folder", () => {
  assert.throws(() => applySettingsEdit(DEFAULTS, { fonts: { ui: { kind: "file", file: "../etc/passwd" } } }, ctx), /isn't in the fonts folder/);
  const s = applySettingsEdit(DEFAULTS, { fonts: { clock: { kind: "file", file: "rMrRHh34w5nN.otf" } } }, ctx);
  assert.deepEqual(s.fonts.clock, { kind: "file", file: "rMrRHh34w5nN.otf" });
});

test("a new place clears pinned coordinates unless new ones are given", () => {
  const pinned = { ...DEFAULTS, weather: { ...DEFAULTS.weather, place: "A", lat: 1, lon: 2 } };
  const s = applySettingsEdit(pinned, { weather: { place: "B" } }, ctx);
  assert.equal(s.weather.lat, null);
  assert.equal(s.weather.lon, null);
});

test("iCloud link must be a shared-album link", () => {
  assert.throws(() => applySettingsEdit(DEFAULTS, { photos: { icloudUrl: "https://evil.example/x" } }, ctx), /shared-album link/);
});

test("save is atomic and keeps the previous file as .bak", () => {
  const f = path.join(tempDir("unscr-dash-"), "settings.json");
  saveSettings(f, DEFAULTS);
  const r = saveSettings(f, { ...DEFAULTS, idleSeconds: 60 });
  assert.equal(r.backupPath, f + ".bak");
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).idleSeconds, 60);
  assert.equal(JSON.parse(fs.readFileSync(f + ".bak", "utf8")).idleSeconds, DEFAULTS.idleSeconds);
  assert.equal(fs.existsSync(f + ".tmp"), false);
});

test("effectiveCameras: prefs in order, unknown new cameras appended hidden, missing ones flagged", () => {
  const s = { ...DEFAULTS, cameras: [{ camera: "Gone", label: "Old", shown: true, stream: "main" as const }, { camera: "DogCamTest", label: "DogCam", shown: true, stream: "main" as const }] };
  const e = effectiveCameras(s, ["DogCamTest", "Couch Cam"]);
  assert.deepEqual(e.map((c) => [c.camera, c.shown, c.missing]), [["Gone", true, true], ["DogCamTest", true, false], ["Couch Cam", false, false]]);
});

test("base URLs from the environment: unset is null, a bad one says why, a good one loses its trailing slash", () => {
  assert.deepEqual(parseBaseUrl("UNSCRYPTED_ADMIN_URL", undefined), { url: null, error: null });
  assert.deepEqual(parseBaseUrl("UNSCRYPTED_ADMIN_URL", "  "), { url: null, error: null });
  assert.deepEqual(parseBaseUrl("UNSCRYPTED_ADMIN_URL", "http://10.0.1.78:8190/"), { url: "http://10.0.1.78:8190", error: null });
  assert.deepEqual(parseBaseUrl("UNSCRYPTED_DASH_URL", "https://homedash.local"), { url: "https://homedash.local", error: null });
  for (const bad of ["10.0.1.78:8190", "javascript:alert(1)", "http://", "http://a b"]) {
    const r = parseBaseUrl("UNSCRYPTED_ADMIN_URL", bad);
    assert.equal(r.url, null, bad);
    assert.match(r.error!, /UNSCRYPTED_ADMIN_URL .* isn't a web address .*ignored/, bad);
  }
});
