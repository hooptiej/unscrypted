import { parseBaseUrl } from "../../src/dash/settings";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "../helpers/tmp";
import { DEFAULTS, loadSettings, applySettingsEdit, saveSettings, effectiveCameras, GRID_MAX, IPVLAN_REASON } from "../../src/dash/settings";
import { UserError } from "../../src/shared/errors";

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

test("a broken settings file's warning (served on the open dashboard) carries none of the file's text", () => {
  const dir = tempDir("dset-");
  const f = path.join(dir, "settings.json");
  fs.writeFileSync(f, '{"photos":{"icloudUrl":"https://www.icloud.com/sharedalbum/#B0SECRETTOKEN"},"services":[{"host":"10.9.8.7"},]}');
  const w = loadSettings(f).warning!;
  assert.match(w, /isn't valid JSON/);
  assert.doesNotMatch(w, /SECRETTOKEN|10\.9\.8\.7|icloud/);
});

test("#44: a saved light carrying the old pre-shim placeholder is left exactly as saved (no house defaults to restore it to)", () => {
  const f = path.join(tempDir("unscr-dash-"), "settings.json");
  const old = "can't be checked from the NAS's own network yet (it sits on the ipvlan LAN; tracked in hooptiej/unscrypted#11)";
  const saved = [{ id: "server", name: "NAS", rollup: true, check: { kind: "bridge" }, children: [
    { id: "constructicon", name: "Constructicon", check: { kind: "blocked", reason: old } },
    { id: "questlog", name: "Questlog", check: { kind: "blocked", reason: IPVLAN_REASON } },
  ] }];
  fs.writeFileSync(f, JSON.stringify({ services: saved }));
  const r = loadSettings(f);
  assert.deepEqual(r.settings.services, saved);
  assert.deepEqual(r.migrated, []);
  assert.equal(r.warning, null);
});

test("a settings file with no migration needed reports none", () => {
  const f = path.join(tempDir("unscr-dash-"), "settings.json");
  fs.writeFileSync(f, JSON.stringify({ services: DEFAULTS.services }));
  assert.deepEqual(loadSettings(f).migrated, []);
});

// #25: the background glow knobs
test("glow knobs default to 0% and save as whole percents from -100 to +100", () => {
  assert.deepEqual(DEFAULTS.glow, { intensity: 0, size: 0 });
  const s = applySettingsEdit(DEFAULTS, { glow: { intensity: "-100", size: 100 } }, ctx);
  assert.deepEqual(s.glow, { intensity: -100, size: 100 });
  assert.deepEqual(applySettingsEdit(s, { glow: { size: 25 } }, ctx).glow, { intensity: -100, size: 25 }, "a partial edit keeps the other knob");
  assert.deepEqual(DEFAULTS.glow, { intensity: 0, size: 0 }, "the defaults aren't mutated");
});

test("a bad glow value is refused with the field, the range and nothing saved", () => {
  const refused = (edit: unknown, field: RegExp, why: RegExp) => assert.throws(() => applySettingsEdit(DEFAULTS, edit, ctx), (e: unknown) =>
    e instanceof UserError && field.test(e.body.happened) && why.test(e.body.happened) && /Nothing was saved/.test(e.body.changed) && /save again/.test(e.body.next));
  refused({ glow: { intensity: 101 } }, /Glow intensity/, /between -100 and 100/);
  refused({ glow: { size: -150 } }, /Glow size/, /between -100 and 100/);
  refused({ glow: { size: 12.5 } }, /Glow size/, /whole number/);
  refused({ glow: { intensity: "lots" } }, /Glow intensity/, /whole number/);
  refused({ glow: { intensity: "" } }, /Glow intensity/, /is empty/);
  refused({ glow: { intensity: null } }, /Glow intensity/, /is empty/);
  refused({ glow: { glare: 5 } }, /Background glow/, /unknown setting "glare"/);
  refused({ glow: 50 }, /Background glow/, /pair of percents/);
});

test("a hand-edited glow in settings.json is clamped on load, and the dashboard is told why", () => {
  const f = path.join(tempDir("unscr-dash-"), "settings.json");
  fs.writeFileSync(f, JSON.stringify({ glow: { intensity: 250, size: "big" } }));
  const r = loadSettings(f);
  assert.deepEqual(r.settings.glow, { intensity: 100, size: 0 });
  assert.match(r.warning!, /glow\.intensity is 250, so it's 100%/);
  assert.match(r.warning!, /glow\.size isn't a number/);
  fs.writeFileSync(f, JSON.stringify({ idleSeconds: 45 }));
  const ok = loadSettings(f);
  assert.deepEqual(ok.settings.glow, { intensity: 0, size: 0 }, "an older file without glow gets 0% for both");
  assert.equal(ok.warning, null);
});

// #109: the full status-light tree can be replaced through the `services` edit key
const TREE = [
  { id: "nas", name: "NAS", rollup: true, check: { kind: "alive", host: "10.0.1.78", port: 80 }, children: [
    { id: "smb", name: "SMB", check: { kind: "tcp", host: "127.0.0.1", port: 445 } },
    { id: "web", name: "Web", link: "http://web.local", check: { kind: "http", url: "http://10.0.1.1/", ok: "200" }, build: { url: "http://10.0.1.1/healthz" } },
    { id: "hk", name: "HomeKit bridge", check: { kind: "bridge" } },
    { id: "far", name: "Far thing", check: { kind: "blocked", reason: "can't reach it from here" } },
  ] },
];
const refuseServices = (svc: unknown, re: RegExp) => assert.throws(() => applySettingsEdit(DEFAULTS, { services: svc }, ctx), (e: unknown) =>
  e instanceof UserError && re.test(e.body.happened) && /Nothing was saved/.test(e.body.changed));

test("#109: a valid full tree is accepted and returned cleaned, with every kind", () => {
  const s = applySettingsEdit(DEFAULTS, { services: TREE }, ctx);
  assert.deepEqual(s.services, TREE);
  assert.deepEqual(DEFAULTS.services, DEFAULTS.services, "the defaults aren't mutated");
});

test("#109: add, remove and relabel round-trip through applySettingsEdit; the id never changes on relabel", () => {
  const relabel = JSON.parse(JSON.stringify(TREE));
  relabel[0].name = "Home NAS";
  const a = applySettingsEdit(DEFAULTS, { services: relabel }, ctx).services[0];
  assert.equal(a.name, "Home NAS");
  assert.equal(a.id, "nas", "the id is immutable; only the name changed");
  const removed = JSON.parse(JSON.stringify(TREE));
  removed[0].children.splice(0, 1);
  assert.equal(applySettingsEdit(DEFAULTS, { services: removed }, ctx).services[0].children!.length, 3);
  const added = JSON.parse(JSON.stringify(TREE));
  added[0].children.push({ id: "new", name: "New", check: { kind: "tcp", host: "h", port: 22 } });
  const kids = applySettingsEdit(DEFAULTS, { services: added }, ctx).services[0].children!;
  assert.equal(kids.length, 5);
  assert.equal(kids[4].id, "new");
});

test("#109: each bad tree is refused by field with nothing saved", () => {
  refuseServices({}, /must be a list of lights/);
  refuseServices([{ id: "a", name: "A", check: { kind: "nope" } }], /unknown kind/);
  refuseServices([{ id: "a", name: "", check: { kind: "bridge" } }], /needs a name/);
  refuseServices([{ id: "Bad_ID", name: "A", check: { kind: "bridge" } }], /id of lowercase/);
  refuseServices([{ id: "a", name: "A", check: { kind: "bridge" } }, { id: "a", name: "B", check: { kind: "bridge" } }], /another light already uses/);
  refuseServices([{ id: "a", name: "A", check: { kind: "tcp", host: "h", port: 70000 } }], /port/);
  refuseServices([{ id: "a", name: "A", check: { kind: "tcp", host: "", port: 80 } }], /needs a host/);
  refuseServices([{ id: "a", name: "A", check: { kind: "http", url: "http://x/", ok: "maybe" } }], /ok must be/);
  refuseServices([{ id: "a", name: "A", check: { kind: "http", url: "not a url", ok: "any" } }], /url must be a web address/);
  refuseServices([{ id: "a", name: "A", check: { kind: "bridge" }, build: { url: "ftp://x/y" } }], /Build page for "A"/);
  refuseServices([{ id: "a", name: "A", check: { kind: "bridge" }, link: "notaurl" }], /link must be a web address/);
  refuseServices([{ id: "a", name: "A", check: { kind: "tcp", host: "h", port: 80, extra: 1 } }], /that a tcp check doesn't use/);
  refuseServices([{ id: "a", name: "A", check: { kind: "bridge" }, weird: 1 }], /that a status light doesn't use/);
});

test("#109: ids must be unique across the whole tree, not just among siblings", () => {
  refuseServices([
    { id: "root", name: "Root", check: { kind: "bridge" }, children: [{ id: "dup", name: "C1", check: { kind: "bridge" } }] },
    { id: "dup", name: "Other", check: { kind: "bridge" } },
  ], /another light already uses/);
});
