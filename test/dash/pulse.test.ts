// #103: lamps that breathe when a new build is waiting on test. The dash reads a build page and the
// owner taps the lamp (or a Claude switches it); the token switch and the open clear are both checked here.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import { AddressInfo } from "net";
import { tempDir } from "../helpers/tmp";
import { PulseStore, BuildWatch, BuildRead, readBuild, parseBuild, makePulseApi, viewOf, BUILD_CHECK_MS } from "../../src/dash/pulse";
import { createDashServer, DashDeps } from "../../src/dash/server";
import { DashRuntime } from "../../src/dash/runtime";
import { DEFAULTS, ServiceNode, applySettingsEdit, loadSettings, saveSettings } from "../../src/dash/settings";
import { UserError } from "../../src/shared/errors";
import { LightNode } from "../../src/dash/services";
import { Logger, setLogLevel } from "../../src/logger";

setLogLevel("error");
const log = new Logger("test");
/** A test value, never a real token. */
const TOKEN = "test-token-7f3a9c";
const PAGE = "http://192.0.2.10/healthz";   // TEST-NET-1, never a real address

const tree = (url: string | null = PAGE): ServiceNode[] => [
  { id: "lamp", name: "Lamp", check: { kind: "bridge" }, ...(url ? { build: { url } } : {}) },
  { id: "plain", name: "Plain", check: { kind: "bridge" } },
];

function storeIn(dir: string): PulseStore {
  return new PulseStore(path.join(dir, "pulse.json"));
}

function listen(s: http.Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}

const servers: http.Server[] = [];
after(() => servers.forEach((s) => s.close()));

/** A page server whose answers the test sets per path. */
async function pageServer(pages: Record<string, { status: number; body: string }>): Promise<string> {
  const s = http.createServer((req, res) => {
    const p = pages[req.url ?? ""] ?? { status: 404, body: "nope" };
    res.writeHead(p.status, { "content-type": "application/json" });
    res.end(p.body);
  });
  servers.push(s);
  return listen(s);
}

// ---------- the build page and the first look ----------

test("parseBuild reads the build field, and says why when it can't", () => {
  assert.deepEqual(parseBuild('{"version":"0.3.1","build":"5a020c9","built_at":"x"}'), { ok: true, build: "5a020c9" });
  assert.deepEqual(parseBuild('{"build":42}'), { ok: true, build: "42" });
  assert.deepEqual(parseBuild("{}"), { ok: false, reason: "its answer has no build field" });
  assert.deepEqual(parseBuild("<html>"), { ok: false, reason: "its answer isn't JSON" });
  assert.match((parseBuild(JSON.stringify({ build: "x".repeat(81) })) as { reason: string }).reason, /longer than 80/);
});

test("readBuild: a 200 page gives its build; a 404, a refusal and a silent page each say why, with no address in the reason", async () => {
  const base = await pageServer({ "/ok": { status: 200, body: '{"build":"5a020c9"}' }, "/gone": { status: 404, body: "" }, "/bad": { status: 200, body: "{" } });
  assert.deepEqual(await readBuild(`${base}/ok`), { ok: true, build: "5a020c9" });
  const gone = await readBuild(`${base}/gone`);
  assert.deepEqual(gone, { ok: false, reason: "answered 404, expected 200" });
  assert.match((await readBuild(`${base}/bad`) as { reason: string }).reason, /isn't JSON/);

  const closed = net.createServer();
  const port = await new Promise<number>((r) => closed.listen(0, "127.0.0.1", () => { const p = (closed.address() as net.AddressInfo).port; closed.close(() => r(p)); }));
  const refused = await readBuild(`http://127.0.0.1:${port}/healthz`);
  assert.deepEqual(refused, { ok: false, reason: "connection refused (nothing listening)" });

  const silent = http.createServer(() => { /* never answers */ });
  servers.push(silent);
  const silentBase = await listen(silent);
  const slow = await readBuild(`${silentBase}/healthz`, 200);
  assert.deepEqual(slow, { ok: false, reason: "no answer within 0.2 s" });
  assert.doesNotMatch(JSON.stringify([gone, refused, slow]), /127\.0\.0\.1|192\.0\.2/, "no address in any reason");
});

test("the first build seen is recorded without a pulse", async () => {
  const dir = tempDir("unscr-pulse-first-");
  const store = storeIn(dir);
  const watch = new BuildWatch(store, log, async () => ({ ok: true, build: "5a020c9" }));
  await watch.round(tree(), 0);
  const rec = store.get("lamp")!;
  assert.equal(rec.seen, "5a020c9");
  assert.equal(rec.url, PAGE);
  assert.equal(rec.on, false);
  assert.equal(viewOf(rec), null, "no pulse on the first look");
  assert.equal(store.get("plain"), undefined, "a light with no build page is never read");
});

test("a new build starts the pulse; the same build doesn't; the pulse survives a restart", async () => {
  const dir = tempDir("unscr-pulse-new-");
  const store = storeIn(dir);
  let build = "5a020c9";
  const watch = new BuildWatch(store, log, async (): Promise<BuildRead> => ({ ok: true, build }));
  await watch.round(tree(), 0);
  build = "7c1d4e0";
  await watch.round(tree(), BUILD_CHECK_MS);
  const view = viewOf(store.get("lamp"));
  assert.ok(view, "the pulse is on");
  assert.equal(view.build, "7c1d4e0");
  assert.equal(view.by, "dash");
  assert.match(view.reason, /New build 7c1d4e0 is waiting for you to try on test/);
  await watch.round(tree(), 2 * BUILD_CHECK_MS);
  assert.equal(store.get("lamp")!.since, BUILD_CHECK_MS, "the same build again changes nothing");
  assert.equal(viewOf(new PulseStore(path.join(dir, "pulse.json")).get("lamp"))?.build, "7c1d4e0", "it survives a restart");
});

test("each build page is read at most once a minute", async () => {
  const dir = tempDir("unscr-pulse-cadence-");
  let calls = 0;
  const watch = new BuildWatch(storeIn(dir), log, async () => { calls++; return { ok: true, build: "a" }; });
  await watch.round(tree(), 0);
  await watch.round(tree(), 30_000);
  assert.equal(calls, 1);
  await watch.round(tree(), BUILD_CHECK_MS);
  assert.equal(calls, 2);
});

test("a failed read changes nothing, says why, and clears once the page answers again", async () => {
  const dir = tempDir("unscr-pulse-fail-");
  const store = storeIn(dir);
  let next: BuildRead = { ok: true, build: "a1" };
  const watch = new BuildWatch(store, log, async () => next);
  await watch.round(tree(), 0);
  const before = JSON.stringify(store.get("lamp"));
  next = { ok: false, reason: "connection refused (nothing listening)" };
  await watch.round(tree(), BUILD_CHECK_MS);
  assert.equal(JSON.stringify(store.get("lamp")), before, "the record is untouched");
  assert.match(watch.errorFor("lamp")!, /connection refused/);
  assert.doesNotMatch(watch.errorFor("lamp")!, /192\.0\.2/, "no address in the reason");
  next = { ok: true, build: "b2" };
  await watch.round(tree(), 2 * BUILD_CHECK_MS);
  assert.equal(watch.errorFor("lamp"), null);
  assert.equal(viewOf(store.get("lamp"))?.build, "b2");
});

test("a failed read doesn't put out a pulse that is already on", async () => {
  const dir = tempDir("unscr-pulse-hold-");
  const store = storeIn(dir);
  let next: BuildRead = { ok: true, build: "a1" };
  const watch = new BuildWatch(store, log, async () => next);
  await watch.round(tree(), 0);
  next = { ok: true, build: "b2" };
  await watch.round(tree(), BUILD_CHECK_MS);
  next = { ok: false, reason: "no answer within 5 s" };
  await watch.round(tree(), 2 * BUILD_CHECK_MS);
  assert.equal(viewOf(store.get("lamp"))?.build, "b2");
});

test("a save that fails is said on the light, and the pulse stays as it was", async () => {
  const dir = tempDir("unscr-pulse-save-");
  const blocked = path.join(dir, "pulse.json");
  fs.mkdirSync(blocked);   // a folder where the file should be: the write can't succeed
  const store = new PulseStore(blocked);
  const watch = new BuildWatch(store, log, async () => ({ ok: true, build: "a1" }));
  await watch.round(tree(), 0);
  assert.equal(store.get("lamp"), undefined);
  assert.match(watch.errorFor("lamp")!, /couldn't be written/);
});

// ---------- the token switch and the open clear ----------

function apiFixture(token: string | null = TOKEN) {
  const dir = tempDir("unscr-pulse-api-");
  const tokenFile = path.join(dir, "dash_pulse_token");
  if (token !== null) fs.writeFileSync(tokenFile, token + "\n");
  const store = storeIn(dir);
  let changes = 0;
  const api = makePulseApi({ store, tree: () => tree(), tokenFile, log, changed: () => { changes++; }, now: () => 1_000 });
  return { api, store, tokenFile, dir, changes: () => changes };
}

/** The four-part error a refusal throws, checked by status and the words it says. */
function refusal(status: number, words: RegExp) {
  return (e: unknown) => e instanceof UserError && e.status === status && words.test(e.body.happened);
}

test("the token switch refuses a missing, wrong or misplaced token, in plain words, and never echoes the token", () => {
  const { api } = apiFixture();
  assert.throws(() => api.checkToken(undefined, "t"), refusal(401, /No token was sent/));
  assert.throws(() => api.checkToken("Basic abc", "t"), refusal(401, /isn't Bearer/));
  assert.throws(() => api.checkToken("Bearer nope-not-it", "t"), (e: unknown) => refusal(403, /doesn't match/)(e) && !JSON.stringify((e as UserError).body).includes(TOKEN));
  assert.doesNotThrow(() => api.checkToken(`Bearer ${TOKEN}`, "t"));
});

test("with no token file, or an empty one, the switch is off and says where the file should be", () => {
  const none = apiFixture(null);
  assert.throws(() => none.api.checkToken(`Bearer ${TOKEN}`, "t"), refusal(503, /no token file/));
  const empty = apiFixture("");
  assert.throws(() => empty.api.checkToken(`Bearer ${TOKEN}`, "t"), refusal(503, /is empty/));
});

test("the token switch turns a light's pulse on and off, and lists the lights", () => {
  const { api, store, changes } = apiFixture();
  const on = api.set("lamp", true, { build: "7c1d4e0", note: "Try the new menu" });
  assert.equal(on.on, true);
  const rec = store.get("lamp")!;
  assert.equal(rec.by, "claude");
  assert.equal(rec.seen, "7c1d4e0", "a build set by Claude is the one seen, so the dash doesn't pulse it again");
  assert.equal(viewOf(rec)?.reason, "Try the new menu. Tap the dot once you've seen it.");
  assert.deepEqual(api.list().map((l) => [l.id, l.on, l.watched]), [["lamp", true, true], ["plain", false, false]]);
  const off = api.set("lamp", false, {});
  assert.equal(off.changed, true);
  assert.equal(viewOf(store.get("lamp")), null);
  assert.equal(api.set("lamp", false, {}).changed, false, "switching off an off light changes nothing");
  assert.equal(changes(), 2, "each real change is told to the wall");
});

test("an unknown light is refused by name, with the ids that exist", () => {
  const { api } = apiFixture();
  assert.throws(() => api.set("nope", true, {}), (e: unknown) => e instanceof UserError && e.status === 404
    && /no status light called "nope"/.test(e.body.happened) && /lamp, plain/.test(e.body.next));
});

test("the open clear can only clear: it clears a pulse that is on, and says so when none is", () => {
  const { api, store } = apiFixture();
  assert.equal(api.clear("lamp").changed, false, "nothing on, nothing to clear");
  api.set("lamp", true, { build: "x1" });
  const out = api.clear("lamp");
  assert.equal(out.changed, true);
  assert.equal(out.on, false);
  assert.equal(store.get("lamp")!.by, "tap");
});

// ---------- the routes, over HTTP ----------

function deps(over: Partial<DashDeps> = {}): DashDeps {
  return {
    webRoot: tempDir("unscr-pulseweb-"), title: "Homedash - TEST", go2rtcApi: "",
    publicConfig: () => ({ title: "x", env: "test", adminPort: 8191, settingsUrl: null, idleSeconds: 30, pollSeconds: 4, reloadMinutes: 20,
      cameras: [], fonts: { ui: {}, clock: {} }, glow: { intensity: 0, size: 0 }, pulse: { speed: 0, strength: 0 } }),
    state: () => ({ updated: 1 }),
    allowedStreams: () => new Set<string>(),
    go2rtcInfo: () => ({ state: "running", lastError: null, nextRetryAt: null }),
    photos: () => ({ items: [], album: "", rotateSeconds: 20, error: null }),
    photoFile: () => null, fontsDir: tempDir("unscr-pulsefonts-"),
    ...over,
  };
}

async function serve(over: Partial<DashDeps> = {}): Promise<string> {
  const s = createDashServer(deps(over));
  servers.push(s);
  return listen(s);
}

test("the open address can't switch a pulse on: a POST to a light without the token is a 401 and changes nothing", async () => {
  const f = apiFixture();
  const base = await serve({ pulse: f.api });
  const r = await fetch(`${base}/api/pulse/lamp`, { method: "POST", body: JSON.stringify({ on: true }), headers: { "content-type": "application/json" } });
  assert.equal(r.status, 401);
  const body = await r.json() as { error: { happened: string } };
  assert.match(body.error.happened, /No token was sent/);
  assert.equal(f.store.get("lamp"), undefined);
});

test("the token switch over HTTP: on, then a refusal for a bad token, a bad body and an unknown light", async () => {
  const f = apiFixture();
  const base = await serve({ pulse: f.api });
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const on = await fetch(`${base}/api/pulse/lamp`, { method: "POST", headers: auth, body: JSON.stringify({ on: true, build: "7c1d4e0", note: "Try it" }) });
  assert.equal(on.status, 200);
  assert.equal((await on.json() as { on: boolean }).on, true);
  assert.equal(viewOf(f.store.get("lamp"))?.build, "7c1d4e0");

  const wrong = await fetch(`${base}/api/pulse/lamp`, { method: "POST", headers: { ...auth, authorization: "Bearer nope" }, body: JSON.stringify({ on: false }) });
  assert.equal(wrong.status, 403);
  const badBody = await fetch(`${base}/api/pulse/lamp`, { method: "POST", headers: auth, body: JSON.stringify({ on: "yes" }) });
  assert.equal(badBody.status, 400);
  assert.match((await badBody.json() as { error: { happened: string } }).error.happened, /"on": true or "on": false/);
  const unknown = await fetch(`${base}/api/pulse/ghost`, { method: "POST", headers: auth, body: JSON.stringify({ on: true }) });
  assert.equal(unknown.status, 404);
  assert.equal(viewOf(f.store.get("lamp"))?.build, "7c1d4e0", "the refusals changed nothing");
});

test("the open clear is refused without the dashboard's own header, and clears with it", async () => {
  const f = apiFixture();
  f.api.set("lamp", true, { build: "7c1d4e0" });
  const base = await serve({ pulse: f.api });
  const noHeader = await fetch(`${base}/api/pulse/lamp/clear`, { method: "POST" });
  assert.equal(noHeader.status, 400);
  assert.equal(viewOf(f.store.get("lamp"))?.build, "7c1d4e0");
  const ok = await fetch(`${base}/api/pulse/lamp/clear`, { method: "POST", headers: { "x-dash-action": "clear" } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { changed: boolean }).changed, true);
  assert.equal(viewOf(f.store.get("lamp")), null);
});

test("the list is token-only; the token never appears in any reply; the wrong verbs are 405", async () => {
  const f = apiFixture();
  const base = await serve({ pulse: f.api });
  const anon = await fetch(`${base}/api/pulse`);
  assert.equal(anon.status, 401);
  const listed = await fetch(`${base}/api/pulse`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(listed.status, 200);
  const text = await listed.text();
  assert.match(text, /"lamp"/);
  assert.doesNotMatch(text, new RegExp(TOKEN));
  assert.equal((await fetch(`${base}/api/pulse/lamp/clear`)).status, 405, "a GET can't clear");
  assert.equal((await fetch(`${base}/api/pulse/lamp`, { method: "PUT", body: "{}" })).status, 405);
});

test("with no pulse switch in this build, the routes say so rather than failing quietly", async () => {
  const base = await serve({});
  const r = await fetch(`${base}/api/pulse/lamp/clear`, { method: "POST", headers: { "x-dash-action": "clear" } });
  assert.equal(r.status, 503);
  assert.match(JSON.stringify(await r.json()), /isn't running in this dashboard/);
});

// ---------- the dashboard's state, and the settings ----------

test("a pulse set through the switch reaches the wall's state at once, and a tap clears it there", async () => {
  const dir = tempDir("unscr-pulse-rt-");
  const services: ServiceNode[] = [{ id: "lamp", name: "Lamp", check: { kind: "bridge" } }];
  saveSettings(path.join(dir, "settings.json"), { ...DEFAULTS, services });
  fs.writeFileSync(path.join(dir, "dash_pulse_token"), TOKEN);
  const rt = new DashRuntime({ dir, title: "t", env: "test", adminPort: 8191, log, pulseTokenFile: path.join(dir, "dash_pulse_token") });
  await rt.pollServices();
  const lamp = () => (rt.state().services as LightNode[])[0];
  assert.equal(lamp().pulse, null);
  rt.pulseApi().set("lamp", true, { build: "1.2.3" });
  assert.match(lamp().pulse!.reason, /Build 1\.2\.3 is waiting for you to try on test\./);
  await rt.pollServices();
  assert.equal(lamp().pulse!.build, "1.2.3", "still on after a status round");
  rt.pulseApi().clear("lamp");
  assert.equal(lamp().pulse, null);
  assert.deepEqual(rt.publicConfig().pulse, { speed: 0, strength: 0 });
});

test("the pulse knobs default to 0% and save as whole percents from -100 to +100", () => {
  assert.deepEqual(DEFAULTS.pulse, { speed: 0, strength: 0 });
  const next = applySettingsEdit(DEFAULTS, { pulse: { speed: 40, strength: -100 } }, { cameras: [], fontFiles: [] });
  assert.deepEqual(next.pulse, { speed: 40, strength: -100 });
  assert.throws(() => applySettingsEdit(DEFAULTS, { pulse: { speed: 101 } }, { cameras: [], fontFiles: [] }), /Pulse speed \(%\): must be between -100 and 100/);
  assert.throws(() => applySettingsEdit(DEFAULTS, { pulse: { colour: 5 } }, { cameras: [], fontFiles: [] }), /unknown setting "colour"/);
});

test("a hand-edited pulse in settings.json is clamped on load, and the dashboard is told why", () => {
  const dir = tempDir("unscr-pulse-settings-");
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ pulse: { speed: 500, strength: "lots" } }));
  const loaded = loadSettings(file);
  assert.deepEqual(loaded.settings.pulse, { speed: 100, strength: 0 });
  assert.match(loaded.warning!, /pulse\.speed is 500, so it's 100%/);
  assert.match(loaded.warning!, /pulse\.strength isn't a number/);
});

test("a light's build page is set, taken off, and refused by name when it's not a light or not an address", () => {
  const ctx = { cameras: [], fontFiles: [] };
  const set = applySettingsEdit(DEFAULTS, { lampBuilds: { homekit: PAGE } }, ctx);
  assert.deepEqual(set.services[0].build, { url: PAGE });
  const cleared = applySettingsEdit(set, { lampBuilds: { homekit: "" } }, ctx);
  assert.equal(cleared.services[0].build, undefined);
  assert.throws(() => applySettingsEdit(DEFAULTS, { lampBuilds: { ghost: PAGE } }, ctx), /there's no status light called "ghost"/);
  assert.throws(() => applySettingsEdit(DEFAULTS, { lampBuilds: { homekit: "ftp://192.0.2.10/x" } }, ctx), /Build page for HomeKit bridge/);
  assert.equal(DEFAULTS.services[0].build, undefined, "the defaults never carry a build page");
});

// ---------- the wall's rules, read from the page the way glow.test.ts reads it ----------

const app = fs.readFileSync(path.join(__dirname, "..", "..", "web", "dash", "app.js"), "utf8");
const grab = (name: string) => {
  const m = new RegExp(`function ${name}\\([^]*?\\r?\\n}\\r?\\n`).exec(app);
  assert.ok(m, `app.js defines ${name}`);
  return m![0];
};
// eslint-disable-next-line no-new-func
const showsPulse = new Function(`${grab("showsPulse")}\nreturn showsPulse;`)() as (n: { pulse?: unknown; state: string }) => boolean;
// eslint-disable-next-line no-new-func
const pulseVars = new Function(`${grab("pulseVars")}\nreturn pulseVars;`)() as
  (k: { speed?: number; strength?: number }) => { period: string; alpha: string; blur: string; spread: string };

test("red never pulses; a green or amber light with a pulse does", () => {
  const p = { build: "1", reason: "r", since: 0, by: "dash" };
  assert.equal(showsPulse({ pulse: p, state: "ok" }), true);
  assert.equal(showsPulse({ pulse: p, state: "warn" }), true);
  assert.equal(showsPulse({ pulse: p, state: "down" }), false);
  assert.equal(showsPulse({ pulse: null, state: "ok" }), false);
});

test("the pulse knobs: 0% is the standard breath, and each slider moves it the way its help text says", () => {
  assert.deepEqual(pulseVars({}), { period: "2.00s", alpha: "100%", blur: "8", spread: "2" });
  assert.equal(pulseVars({ speed: -100 }).period, "3.33s", "slower");
  assert.equal(pulseVars({ speed: 100 }).period, "0.67s", "faster");
  assert.deepEqual(pulseVars({ strength: -100 }), { period: "2.00s", alpha: "0%", blur: "0", spread: "0" }, "no halo");
  assert.deepEqual(pulseVars({ strength: 100 }), { period: "2.00s", alpha: "100%", blur: "16", spread: "4" }, "doubled");
});

test("reduced motion: the halo is steady, with no animation", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "web", "dash", "style.css"), "utf8");
  assert.match(css, /prefers-reduced-motion:reduce\)\{\s*\.svc \.dot\.pulse\{animation:none/);
});
