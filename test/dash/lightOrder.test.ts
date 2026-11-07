// #116: the status lights can be reordered from the settings editor. The order is the `services` order:
// it is saved as sent, survives a reload, is what the dashboard's state (and so its screen) lists, and no id
// changes on the way (/api/pulse/<id> and scripts/deploy.sh depend on the ids).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "../helpers/tmp";
import { DEFAULTS, ServiceNode, applySettingsEdit, loadSettings, saveSettings, flatLamps } from "../../src/dash/settings";
import { DashRuntime } from "../../src/dash/runtime";
import { ServiceWatcher } from "../../src/dash/services";
import { Logger, setLogLevel } from "../../src/logger";

setLogLevel("error");
const ctx = { cameras: [], fontFiles: [] };
const bridge = { kind: "bridge" } as const;
const lamp = (id: string, children?: ServiceNode[]): ServiceNode => ({ id, name: id.toUpperCase(), check: bridge, ...(children ? { children } : {}) });
const TREE = (): ServiceNode[] => [
  lamp("nas", [lamp("smb"), lamp("web", [lamp("web-dev"), lamp("web-beta")]), lamp("hk")]),
  lamp("edge"),
];
const ids = (ns: ServiceNode[]): string[] => ns.map((n) => n.id);

test("a reordered tree is saved exactly as sent: same ids, new order, at the top and inside a group", () => {
  const edit = TREE();
  [edit[0], edit[1]] = [edit[1], edit[0]];
  const kids = edit[1].children!;
  [kids[0], kids[2]] = [kids[2], kids[0]];
  const s = applySettingsEdit(DEFAULTS, { services: edit }, ctx);
  assert.deepEqual(ids(s.services), ["edge", "nas"]);
  assert.deepEqual(ids(s.services[1].children!), ["hk", "web", "smb"]);
  assert.deepEqual(ids(s.services[1].children![1].children!), ["web-dev", "web-beta"], "an untouched group keeps its order");
  assert.deepEqual(flatLamps(s.services).map((n) => n.id).sort(), flatLamps(TREE()).map((n) => n.id).sort(), "no id was added, lost or renamed");
});

test("the new order survives save and reload", () => {
  const f = path.join(tempDir("unscr-order-"), "settings.json");
  const edit = TREE();
  edit[0].children!.reverse();
  saveSettings(f, applySettingsEdit(DEFAULTS, { services: edit }, ctx));
  const back = loadSettings(f);
  assert.equal(back.warning, null);
  assert.deepEqual(ids(back.settings.services[0].children!), ["hk", "web", "smb"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")).services[0].children.map((n: ServiceNode) => n.id), ["hk", "web", "smb"], "the file itself is in the new order");
});

test("the checker returns the lights in the saved order, so the dashboard's state lists them that way", async () => {
  const edit = TREE();
  edit[0].children!.reverse();
  const w = new ServiceWatcher(1);
  const out = await w.poll(edit, () => ({ hapEnabled: true, paired: true, go2rtc: { state: "running", lastError: null, nextRetryAt: null } } as any));
  assert.deepEqual(out[0].children.map((n) => n.id), ["hk", "web", "smb"]);

  const dir = tempDir("unscr-order-rt-");
  saveSettings(path.join(dir, "settings.json"), { ...DEFAULTS, services: edit });
  const rt = new DashRuntime({ dir, title: "t", env: "test", adminPort: 8191, log: new Logger("test") });
  rt.bridge = { hapEnabled: true, paired: true, go2rtc: { state: "running", lastError: null, nextRetryAt: null } } as any;
  await rt.pollServices();
  const st = rt.state() as any;
  assert.deepEqual(st.services[0].children.map((n: any) => n.id), ["hk", "web", "smb"]);
});

test("the dashboard page draws the lights in array order, never sorted", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "web", "dash", "app.js"), "utf8");
  assert.match(app, /tree\.map\(svcNode\)/);
  assert.match(app, /node\.children\.forEach\(\(c\) => kids\.append\(svcNode\(c\)\)\)/);
  assert.doesNotMatch(app, /services?\.sort|tree\.sort|children\.sort/);
});

// ---------- the editor itself: its move logic and wiring, read from the page like glow.test.ts does ----------

const js = fs.readFileSync(path.join(__dirname, "..", "..", "web", "admin", "dash-settings.js"), "utf8");
const grab = (name: string): string => {
  const m = new RegExp(`function ${name}\\([^]*?\\r?\\n}\\r?\\n`).exec(js);
  assert.ok(m, `dash-settings.js defines ${name}`);
  return m![0];
};

function editor(services: ServiceNode[], opts: { confirm?: boolean } = {}) {
  const calls = { renders: 0, confirms: [] as string[], removed: 0 };
  const win = { confirm: (m: string) => { calls.confirms.push(m); return opts.confirm ?? true; } };
  const doc = { querySelector: () => null };
  // eslint-disable-next-line no-new-func
  const make = new Function("services", "window", "document", "renderLights", "loaded", `
    let dirty = false; let openPanelEl = null;
    ${grab("findNode")}
    ${grab("moveLight")}
    return { moveLight, dirty: () => dirty, openPanel: (el) => { openPanelEl = el; }, panelOpen: () => openPanelEl !== null };
  `);
  const api = make(services, win, doc, () => { calls.renders++; }, { lights: null }) as {
    moveLight: (id: string, dir: number) => void; dirty: () => boolean; openPanel: (el: unknown) => void; panelOpen: () => boolean;
  };
  return { ...api, calls };
}

test("editor: ↑/↓ swap a light with its neighbour in the same group, children travel with it, ids stay", () => {
  const t = TREE();
  const e = editor(t);
  e.moveLight("web", -1);
  assert.deepEqual(ids(t[0].children!), ["web", "smb", "hk"]);
  assert.deepEqual(ids(t[0].children![0].children!), ["web-dev", "web-beta"], "its nested lights moved with it");
  e.moveLight("web", 1);
  e.moveLight("web", 1);
  assert.deepEqual(ids(t[0].children!), ["smb", "hk", "web"]);
  e.moveLight("web-beta", -1);
  assert.deepEqual(ids(t[0].children![2].children!), ["web-beta", "web-dev"]);
  e.moveLight("nas", 1);
  assert.deepEqual(ids(t), ["edge", "nas"], "top-level lights reorder among themselves");
  assert.equal(e.dirty(), true, "the page counts it as an unsaved change");
  assert.equal(e.calls.renders, 5, "one redraw per move");
  assert.deepEqual(flatLamps(t).map((n) => n.id).sort(), flatLamps(TREE()).map((n) => n.id).sort());
});

test("editor: moving past an end, or an unknown id, changes nothing and doesn't pretend it did", () => {
  const t = TREE();
  const e = editor(t);
  e.moveLight("smb", -1);
  e.moveLight("hk", 1);
  e.moveLight("edge", 1);
  e.moveLight("nas", -1);
  e.moveLight("ghost", 1);
  assert.deepEqual(ids(t), ["nas", "edge"]);
  assert.deepEqual(ids(t[0].children!), ["smb", "web", "hk"]);
  assert.equal(e.dirty(), false);
  assert.equal(e.calls.renders, 0);
});

test("editor: with a light editor open, moving asks first and keeps everything if you say no", () => {
  const t = TREE();
  const no = editor(t, { confirm: false });
  no.openPanel({ remove() { throw new Error("must not close the panel when the answer is no"); } });
  no.moveLight("hk", -1);
  assert.deepEqual(ids(t[0].children!), ["smb", "web", "hk"]);
  assert.equal(no.calls.confirms.length, 1);
  assert.match(no.calls.confirms[0], /light editor is open/);
  assert.equal(no.panelOpen(), true);

  const yes = editor(t, { confirm: true });
  let closed = false;
  yes.openPanel({ remove() { closed = true; } });
  yes.moveLight("hk", -1);
  assert.equal(closed, true);
  assert.equal(yes.panelOpen(), false);
  assert.deepEqual(ids(t[0].children!), ["smb", "hk", "web"]);
});

test("editor: every light row has ↑ and ↓, greyed (never hidden) at the ends, with the reason on hover", () => {
  assert.match(js, /\["↑", -1\], \["↓", 1\]/);
  assert.match(js, /b\.disabled = atEnd/);
  assert.match(js, /is already \$\{dir < 0 \? "first" : "last"\} in \$\{where\}/);
  assert.match(js, /aria-label", `Move \$\{n\.name\} \$\{dir < 0 \? "up" : "down"\}`/);
  assert.doesNotMatch(js, /b\.hidden/);
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "web", "admin", "dash-settings.css"), "utf8");
  assert.match(css, /\.lbtns button:disabled\{opacity:\.4;cursor:not-allowed\}/);
});
