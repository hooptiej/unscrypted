// #24: the daytime background glow is 50% more intense and 50% larger; night is unchanged.
// #25: the admin knobs (intensity, size; -100..+100 %) scale it, 0% = the #24 look exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const app = fs.readFileSync(path.join(__dirname, "..", "..", "web", "dash", "app.js"), "utf8");
const grab = (name: string) => {
  const m = new RegExp(`function ${name}\\([^]*?\\r?\\n}\\r?\\n`).exec(app);
  assert.ok(m, `app.js defines ${name}`);
  return m![0];
};
const consts = ["OLIVE", "WARM", "clamp01", "lerp", "KNOBS_AT_NIGHT", "SIZE_MIN", "knobPct"].map((n) => new RegExp(`const ${n} = [^\\n]+`).exec(app)![0]).join("\n");
// eslint-disable-next-line no-new-func
const glowFor = new Function(`${consts}\n${grab("glowFor")}\nreturn glowFor;`)() as
  (min: number, rise: number, set: number, knobs?: { intensity?: number; size?: number }) => { alpha: number; size: number; x: number };

const RISE = 7 * 60, SET = 18 * 60;

test("midday glow is 50% stronger and 50% bigger than before (0.16 -> 0.24, 60% -> 90%)", () => {
  const noon = glowFor(13 * 60, RISE, SET);
  assert.equal(Number(noon.alpha.toFixed(3)), 0.24);
  assert.equal(noon.size, 90);
});

test("sunrise/sunset warm peaks are 50% stronger (0.20 -> 0.30)", () => {
  assert.equal(Number(glowFor(RISE, RISE, SET).alpha.toFixed(3)), 0.3);
  assert.equal(Number(glowFor(SET, RISE, SET).alpha.toFixed(3)), 0.3);
});

test("night is unchanged: 0.07 strength, 60% size", () => {
  for (const m of [2 * 60, 23 * 60]) {
    const n = glowFor(m, RISE, SET);
    assert.equal(Number(n.alpha.toFixed(3)), 0.07);
    assert.equal(n.size, 60);
  }
});

const TIMES = [2 * 60, RISE - 50, RISE - 20, RISE, 10 * 60, 13 * 60, SET - 30, SET, SET + 30, 23 * 60];
const a3 = (v: number) => Number(v.toFixed(3));

test("knobs at 0% give exactly the #24 look, at every time of day", () => {
  for (const m of TIMES) {
    assert.deepEqual(glowFor(m, RISE, SET, { intensity: 0, size: 0 }), glowFor(m, RISE, SET), `minute ${m}`);
    assert.deepEqual(glowFor(m, RISE, SET, {}), glowFor(m, RISE, SET), `minute ${m}, knobs missing`);
  }
});

test("intensity +100% doubles the glow's strength", () => {
  assert.equal(a3(glowFor(13 * 60, RISE, SET, { intensity: 100 }).alpha), 0.48);
  assert.equal(a3(glowFor(RISE, RISE, SET, { intensity: 100 }).alpha), 0.6);
  for (const m of TIMES) assert.equal(a3(glowFor(m, RISE, SET, { intensity: 100 }).alpha), a3(glowFor(m, RISE, SET).alpha * 2), `minute ${m}`);
});

test("intensity -100% means no glow at all", () => {
  for (const m of TIMES) assert.equal(glowFor(m, RISE, SET, { intensity: -100 }).alpha, 0, `minute ${m}`);
});

test("intensity +50% is 1.5x; the night glow is scaled too (KNOBS_AT_NIGHT)", () => {
  assert.equal(a3(glowFor(13 * 60, RISE, SET, { intensity: 50 }).alpha), 0.36);
  assert.equal(a3(glowFor(2 * 60, RISE, SET, { intensity: 50 }).alpha), 0.105);
});

test("size scales the ellipse by 1 + pct/100, clamped so -100% never collapses it", () => {
  assert.equal(glowFor(13 * 60, RISE, SET, { size: 100 }).size, 180);
  assert.equal(glowFor(13 * 60, RISE, SET, { size: 50 }).size, 135);
  assert.equal(glowFor(13 * 60, RISE, SET, { size: -50 }).size, 45);
  assert.equal(glowFor(13 * 60, RISE, SET, { size: -100 }).size, 10);
  assert.equal(glowFor(2 * 60, RISE, SET, { size: 100 }).size, 120);
  // size leaves the strength alone
  assert.equal(a3(glowFor(13 * 60, RISE, SET, { size: 100 }).alpha), 0.24);
});

test("out-of-range or junk knob values are clamped or ignored, never break the page", () => {
  assert.equal(glowFor(13 * 60, RISE, SET, { intensity: 500 }).alpha, glowFor(13 * 60, RISE, SET, { intensity: 100 }).alpha);
  assert.equal(glowFor(13 * 60, RISE, SET, { intensity: NaN, size: NaN }).size, 90);
  assert.equal(glowFor(13 * 60, RISE, SET, { intensity: "x" as any }).alpha, glowFor(13 * 60, RISE, SET).alpha);
});
