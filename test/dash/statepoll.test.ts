// #20: a saved setting must reach the open dashboard within a few seconds, whatever "Status
// checks every (s)" is set to. The page's /api/state poll (which carries settingsVersion and costs
// the cameras nothing) is capped at 3 s; pollSeconds only paces the server-side checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const app = fs.readFileSync(path.join(__dirname, "..", "..", "web", "dash", "app.js"), "utf8");

test("the page's state poll is capped at 3 s, so a settings save shows up quickly", () => {
  const m = /const pollMs = (.+);/.exec(app);
  assert.ok(m, "app.js defines pollMs");
  const pollMs = new Function("cfg", `return ${m![1]};`) as (cfg: { pollSeconds?: number }) => number;
  assert.equal(pollMs({ pollSeconds: 30 }), 3000, "30 s status checks don't slow the page down");
  assert.equal(pollMs({ pollSeconds: 60 }), 3000);
  assert.equal(pollMs({ pollSeconds: 2 }), 2000, "a faster setting is kept");
  assert.equal(pollMs({}), 3000, "the default is quick too");
});

test("a settingsVersion change reloads the page (or waits until full-screen closes)", () => {
  assert.match(app, /st\.settingsVersion !== seenSettingsVersion/);
  assert.match(app, /location\.reload\(\)/);
});
