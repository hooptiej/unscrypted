import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "./helpers/tmp";
import { readVersion, parseBuildFile, readBuildInfo, formatBuild } from "../src/version";

/** A throwaway app root with a package.json (and optionally a BUILD file). */
function root(version: string | null, build?: string): string {
  const d = tempDir("unscr-version-");
  if (version !== null) fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "unscrypted", version }));
  if (build !== undefined) fs.writeFileSync(path.join(d, "BUILD"), build);
  return d;
}

test("readVersion reads package.json, and falls back without throwing", () => {
  assert.equal(readVersion(root("1.2.3")), "1.2.3");
  assert.equal(readVersion(root(null)), "0.0.0");            // no package.json
  const bad = tempDir("unscr-version-");
  fs.writeFileSync(path.join(bad, "package.json"), "{ not json");
  assert.equal(readVersion(bad), "0.0.0");                   // unparseable
});

test("parseBuildFile reads '<sha> <date>', sha-only, and rejects empty", () => {
  assert.deepEqual(parseBuildFile("5a020c9 2026-11-07\n"), { build: "5a020c9", builtAt: "2026-11-07" });
  assert.deepEqual(parseBuildFile("5a020c9\n"), { build: "5a020c9", builtAt: null });   // sha, no date
  assert.deepEqual(parseBuildFile("  a1b2c3d   2026-11-07  "), { build: "a1b2c3d", builtAt: "2026-11-07" });
  assert.equal(parseBuildFile(""), null);
  assert.equal(parseBuildFile("   \n  \n"), null);           // the empty-args case (blank BUILD line)
});

test("readBuildInfo uses a baked BUILD file (sha + date), with the version from package.json", () => {
  const info = readBuildInfo(root("0.1.16", "5a020c9 2026-11-07\n"));
  assert.deepEqual(info, { version: "0.1.16", build: "5a020c9", builtAt: "2026-11-07", commit: null });
  assert.equal(formatBuild(info), "unscrypted 0.1.16 - build 5a020c9 (2026-11-07)");
});

test("readBuildInfo falls back to 'source' with no BUILD file, and never throws", () => {
  const info = readBuildInfo(root("0.1.16"));
  assert.equal(info.version, "0.1.16");
  assert.equal(info.build, "source");
  assert.equal(info.builtAt, null);
  // commit is a git short sha when available, else null (a throwaway dir usually has no repo). Either
  // way the stamp reads cleanly and nothing throws.
  assert.ok(info.commit === null || typeof info.commit === "string");
  assert.match(formatBuild(info), /^unscrypted 0\.1\.16 - build source( \([0-9a-f]+\))?$/);
});

test("readBuildInfo treats an empty/blank BUILD file as un-baked (not a crash)", () => {
  const info = readBuildInfo(root("0.1.16", " \n"));   // what empty build args write
  assert.equal(info.build, "source");
  assert.equal(info.builtAt, null);
});

test("formatBuild shows a plain-checkout git sha in place of a date when there's one", () => {
  const s = formatBuild({ version: "0.1.16", build: "source", builtAt: null, commit: "a1b2c3d" });
  assert.equal(s, "unscrypted 0.1.16 - build source (a1b2c3d)");
});
