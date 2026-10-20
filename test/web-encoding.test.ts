import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

// The pages are served as UTF-8. A stray Windows-1252 byte (an editor's "smart" ellipsis or middle
// dot) shows up on the wall as a replacement character, so every web file must decode cleanly.
test("every file under web/ is valid UTF-8", () => {
  const root = path.join(__dirname, "..", "web");
  const files: string[] = [];
  const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|css|html)$/.test(e.name)) files.push(p);
  });
  walk(root);
  assert.ok(files.length >= 6, "found the web files");
  const dec = new TextDecoder("utf-8", { fatal: true });
  for (const f of files) {
    assert.doesNotThrow(() => dec.decode(fs.readFileSync(f)), `${path.relative(root, f)} isn't valid UTF-8`);
  }
});
