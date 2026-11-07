/**
 * #46: the open dashboard process must not be able to load anything from the admin pane (auth, the
 * config store with camera logins, session keys). This walks the dashboard child's static imports
 * from its entry point and fails if any file it pulls in lives under src/admin/. The shared folder
 * must stay clear of both sides, or it would drag one into the other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "..", "..", "src");

function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.[^"']*)["']|require\(\s*["'](\.[^"']*)["']\s*\)/g)) {
    const rel = m[1] ?? m[2];
    const base = path.resolve(path.dirname(file), rel);
    const hit = [base + ".ts", path.join(base, "index.ts")].find((p) => fs.existsSync(p));
    if (hit) out.push(hit);
  }
  return out;
}

function reach(entry: string): Map<string, string> {
  const seen = new Map<string, string>();   // file -> who imported it first
  const todo = [entry];
  seen.set(entry, "(entry)");
  while (todo.length) {
    const f = todo.pop()!;
    for (const dep of importsOf(f)) if (!seen.has(dep)) { seen.set(dep, f); todo.push(dep); }
  }
  return seen;
}

const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, "/");

test("the dashboard child's imports never reach src/admin/", () => {
  const seen = reach(path.join(SRC, "dash", "main.ts"));
  assert.ok(seen.size > 10, "the walk should have found the dashboard's modules");
  const bad = [...seen].filter(([f]) => rel(f).startsWith("admin/")).map(([f, by]) => `${rel(f)} (imported by ${rel(by)})`);
  assert.deepEqual(bad, [], "the dashboard process must not load admin modules");
});

test("the shared folder imports neither admin/ nor dash/", () => {
  for (const f of fs.readdirSync(path.join(SRC, "shared")).filter((n) => n.endsWith(".ts"))) {
    const seen = reach(path.join(SRC, "shared", f));
    const bad = [...seen].map(([p]) => rel(p)).filter((p) => p.startsWith("admin/") || p.startsWith("dash/"));
    assert.deepEqual(bad, [], `shared/${f} must not import ${bad.join(", ")}`);
  }
});
