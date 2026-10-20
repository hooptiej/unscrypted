// #24: the daytime background glow is 50% more intense and 50% larger; night is unchanged.
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
const consts = ["OLIVE", "WARM", "clamp01", "lerp"].map((n) => new RegExp(`const ${n} = [^\\n]+`).exec(app)![0]).join("\n");
// eslint-disable-next-line no-new-func
const glowFor = new Function(`${consts}\n${grab("glowFor")}\nreturn glowFor;`)() as
  (min: number, rise: number, set: number) => { alpha: number; size: number; x: number };

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
