import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "../helpers/tmp";
import { resolveChildEntry } from "../../src/shared/childEntry";

function tree(files: string[]): string {
  const root = tempDir("unscr-entry-");
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), ""); }
  return root;
}

test("the compiled main.js wins, for either child", () => {
  const root = tree(["admin/main.js", "admin/main.ts", "dash/main.js"]);
  assert.equal(resolveChildEntry("admin", root, true), path.join(root, "admin", "main.js"));
  assert.equal(resolveChildEntry("dash", root, false), path.join(root, "dash", "main.js"));
});

test("main.ts is used only when the bridge itself runs as TypeScript (tsx)", () => {
  const root = tree(["dash/main.ts"]);
  assert.equal(resolveChildEntry("dash", root, true), path.join(root, "dash", "main.ts"));
  assert.equal(resolveChildEntry("dash", root, false), null);
});

test("neither file there: null, so the bridge can say the build is missing its server", () => {
  assert.equal(resolveChildEntry("admin", tree([]), true), null);
});

test("by default it looks beside the shared folder: the real admin and dash entries resolve", () => {
  assert.ok(resolveChildEntry("admin")?.endsWith(path.join("admin", "main.ts")));
  assert.ok(resolveChildEntry("dash")?.endsWith(path.join("dash", "main.ts")));
});
