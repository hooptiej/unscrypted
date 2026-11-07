/**
 * The running build's stamp (#102): the release version (from package.json), the git short sha the
 * image was built from, and the UTC build date. Mirrors how Groundskeeper stamps its builds.
 *
 * The sha and date are baked into the image at build time: the Dockerfile writes /app/BUILD as one
 * line "<sha> <date>" from the UNSCRYPTED_BUILD_SHA / UNSCRYPTED_BUILD_DATE build args (empty when
 * nobody passed them). At runtime this module reads that file. A plain checkout (no BUILD file, or
 * an empty one) shows "source" plus the working tree's git short sha when git is available.
 *
 * Nothing here ever throws: a missing or unreadable file, a missing git, a malformed package.json
 * all fall back to a usable stamp rather than crashing the bridge, the admin pane or the dashboard.
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

export interface BuildInfo {
  /** The release version, from package.json's "version". "0.0.0" if it can't be read. */
  version: string;
  /** The git short sha baked into the image, or "source" for a plain (un-baked) checkout. */
  build: string;
  /** The UTC build date (e.g. "2026-11-07") baked into the image, or null for a plain checkout. */
  builtAt: string | null;
  /** The working tree's git short sha for a plain checkout (null for a baked image, where `build` is the sha). */
  commit: string | null;
}

const UNKNOWN_VERSION = "0.0.0";

/** The app root: /app in the image (one level above dist/), the repo root under tsx in dev. */
const DEFAULT_ROOT = path.join(__dirname, "..");

/** The release version from <root>/package.json. Never throws. */
export function readVersion(root: string = DEFAULT_ROOT): string {
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" && v.length ? v : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/**
 * Parse a BUILD file's first non-blank line ("<sha> <date>"). Returns null when there's no usable
 * sha (an empty file, or build args that were never passed).
 */
export function parseBuildFile(text: string): { build: string; builtAt: string | null } | null {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!line) return null;
  const parts = line.trim().split(/\s+/);
  const build = parts[0];
  if (!build) return null;
  return { build, builtAt: parts[1] ?? null };
}

/** The working tree's git short sha, or null (not a repo, git missing). Never throws. */
function gitShortSha(root: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    return out.toString().trim() || null;
  } catch {
    return null;
  }
}

/** Resolve the running build's stamp. Never throws. */
export function readBuildInfo(root: string = DEFAULT_ROOT): BuildInfo {
  const version = readVersion(root);
  let baked: { build: string; builtAt: string | null } | null = null;
  try {
    baked = parseBuildFile(fs.readFileSync(path.join(root, "BUILD"), "utf8"));
  } catch {
    /* no BUILD file: a plain checkout */
  }
  if (baked) return { version, build: baked.build, builtAt: baked.builtAt, commit: null };
  return { version, build: "source", builtAt: null, commit: gitShortSha(root) };
}

/** "unscrypted 0.1.16 - build 5a020c9 (2026-11-07)", or "- build source (a1b2c3d)" / "- build source". */
export function formatBuild(info: BuildInfo): string {
  const tail = info.builtAt ? ` (${info.builtAt})` : info.commit ? ` (${info.commit})` : "";
  return `unscrypted ${info.version} - build ${info.build}${tail}`;
}

/** Computed once at startup (the stamp is static for the life of the process). */
export const BUILD_INFO: BuildInfo = readBuildInfo();
/** The formatted stamp for the footer/about lines. */
export const BUILD_STRING: string = formatBuild(BUILD_INFO);

/** The shape both /healthz endpoints add to their answer. */
export function healthFields(info: BuildInfo = BUILD_INFO): { version: string; build: string; built_at: string | null; commit: string | null } {
  return { version: info.version, build: info.build, built_at: info.builtAt, commit: info.commit };
}
