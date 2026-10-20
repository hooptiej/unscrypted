import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "../helpers/tmp";
import { listFonts, fontOut, SYSTEM_FONTS } from "../../src/dash/fonts";

test("listFonts: only font files, names from names.json, sorted by name", () => {
  const d = tempDir("unscr-fonts-");
  for (const f of ["rMrRHh34w5nN.otf", "abcdEFGH.woff2", "notes.txt", "bad name.otf"]) fs.writeFileSync(path.join(d, f), "x");
  fs.writeFileSync(path.join(d, "names.json"), JSON.stringify({ "rMrRHh34w5nN.otf": "AlbertusMT", "abcdEFGH.woff2": "Zed Sans" }));
  const r = listFonts(d);
  assert.deepEqual(r, { fonts: [{ file: "rMrRHh34w5nN.otf", name: "AlbertusMT" }, { file: "abcdEFGH.woff2", name: "Zed Sans" }], warning: null });
});

test("listFonts: a broken names.json falls back to file names and says so; no folder is just empty", () => {
  const d = tempDir("unscr-fonts-");
  fs.writeFileSync(path.join(d, "Foo.ttf"), "x");
  fs.writeFileSync(path.join(d, "names.json"), "{nope");
  const r = listFonts(d);
  assert.deepEqual(r.fonts, [{ file: "Foo.ttf", name: "Foo" }]);
  assert.match(r.warning!, /names\.json couldn't be read .*file names instead/);
  assert.deepEqual(listFonts(path.join(d, "missing")), { fonts: [], warning: null });
});

test("fontOut: a file, a gone file (system sans plus a warning), inherit for the clock only", () => {
  const fonts = [{ file: "rMrRHh34w5nN.otf", name: "AlbertusMT" }];
  assert.deepEqual(fontOut({ kind: "file", file: "rMrRHh34w5nN.otf" }, "ui", fonts), { out: { file: "/fonts/rMrRHh34w5nN.otf", name: "AlbertusMT" }, warning: null });
  const gone = fontOut({ kind: "file", file: "Gone.otf" }, "clock", fonts);
  assert.deepEqual(gone.out, { family: SYSTEM_FONTS.sans });
  assert.match(gone.warning!, /clock font "Gone\.otf" isn't in the fonts folder .*system font/);
  assert.deepEqual(fontOut({ kind: "system", family: "inherit" }, "clock", fonts).out, { inherit: true });
  assert.deepEqual(fontOut({ kind: "system", family: "inherit" }, "ui", fonts).out, { family: SYSTEM_FONTS.sans });
  assert.deepEqual(fontOut({ kind: "system", family: "serif" }, "ui", fonts).out, { family: SYSTEM_FONTS.serif });
});
