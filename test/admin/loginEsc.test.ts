// #27: on the sign-in page opened from the kiosk's Settings button, Esc goes straight back to the
// dashboard, and doesn't restart the idle wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const app = fs.readFileSync(path.join(__dirname, "..", "..", "web", "admin", "app.js"), "utf8");
const src = /function loginIdleReturn\([^]*?\r?\n}\r?\n/.exec(app);
assert.ok(src, "app.js defines loginIdleReturn");

function rig(hash = "#/login") {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const win = { addEventListener: (t: string, fn: (e: any) => void) => (listeners[t] ||= []).push(fn) };
  const loc = { hash, href: "http://10.0.1.78:8190/?next=%2Fdash-settings%3Ffrom%3Ddash#/login" };
  let tick: () => void = () => {};
  const note = { textContent: "" };
  const appEl = { querySelector: () => ({ append: () => {} }) };
  // eslint-disable-next-line no-new-func
  const make = new Function("window", "location", "app", "el", "setInterval", "NEXT",
    `let loginIdleTimer = null;\n${src![0]}\nreturn loginIdleReturn;`);
  const fn = make(win, loc, appEl, () => note, (f: () => void) => { tick = f; return 1; }, "/dash-settings?from=dash");
  fn({ url: "http://10.0.1.248/", idleSeconds: 30 });
  const key = (k: string) => {
    const e = { key: k, prevented: false, preventDefault() { this.prevented = true; } };
    for (const l of listeners.keydown || []) l(e);
    return e;
  };
  return { loc, key, tick: () => tick(), note };
}

test("Esc on the kiosk sign-in page goes straight back to the dashboard", () => {
  const r = rig();
  const e = r.key("Escape");
  assert.equal(r.loc.href, "http://10.0.1.248/");
  assert.ok(e.prevented);
});

test("other keys stay on the sign-in page", () => {
  const r = rig();
  r.key("a");
  assert.match(r.loc.href, /#\/login$/);
});

test("Esc after leaving the sign-in page does nothing", () => {
  const r = rig("#/cameras");
  r.key("Escape");
  assert.match(r.loc.href, /#\/login$/);
});
