/**
 * Where a supervised child's entry file is (#46). The bridge forks the admin pane and the dashboard
 * from the same place with the same rule, so there is one function for it.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * `<root>/<name>/main.js` (the compiled build), or `main.ts` when running under tsx (npm run dev).
 * Null when neither exists. `root` is the folder holding the admin/ and dash/ folders (dist/ in the
 * image, src/ under tsx); it defaults to this file's parent. `viaTsx` says whether the bridge itself
 * is running as TypeScript, which is the only case a .ts entry may be forked.
 */
export function resolveChildEntry(name: "admin" | "dash", root = path.join(__dirname, ".."), viaTsx = __filename.endsWith(".ts")): string | null {
  const js = path.join(root, name, "main.js");
  if (fs.existsSync(js)) return js;
  const ts = path.join(root, name, "main.ts");
  if (viaTsx && fs.existsSync(ts)) return ts;
  return null;
}
