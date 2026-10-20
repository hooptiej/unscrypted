// Where HAP pairing state lives (#4). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveConfig, Config } from "../src/config";
import { hasPairingState } from "../src/util";

const base: Config = {
  bridge: {},
  cameras: [{ name: "Cam", rtspMain: "rtsp://h/1" }],
} as Config;
const baseDir = path.resolve("/config");

function withEnv(value: string | undefined, fn: () => void): void {
  const saved = process.env.UNSCRYPTED_PERSIST_DIR;
  if (value === undefined) delete process.env.UNSCRYPTED_PERSIST_DIR;
  else process.env.UNSCRYPTED_PERSIST_DIR = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.UNSCRYPTED_PERSIST_DIR;
    else process.env.UNSCRYPTED_PERSIST_DIR = saved;
  }
}

test("UNSCRYPTED_PERSIST_DIR beats config.persistDir, and the ignored one is reported", () => {
  withEnv("/data/persist", () => {
    const r = resolveConfig({ ...base, persistDir: "persist" }, baseDir);
    assert.equal(r.persistDir, path.resolve("/data/persist"));
    assert.equal(r.persistDirOverridden, path.resolve(baseDir, "persist"));
  });
});

test("config.persistDir is used, next to the config, when the env var is unset", () => {
  withEnv(undefined, () => {
    const r = resolveConfig({ ...base, persistDir: "persist" }, baseDir);
    assert.equal(r.persistDir, path.resolve(baseDir, "persist"));
    assert.equal(r.persistDirOverridden, undefined);
  });
});

test("no override reported when env and config agree, or config has no persistDir", () => {
  withEnv("/data/persist", () => {
    assert.equal(
      resolveConfig({ ...base, persistDir: "/data/persist" }, baseDir).persistDirOverridden,
      undefined,
    );
    assert.equal(resolveConfig(base, baseDir).persistDirOverridden, undefined);
  });
});

test("hasPairingState finds AccessoryInfo.*.json and nothing else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unscrypted-persist-"));
  try {
    assert.equal(hasPairingState(path.join(dir, "missing")), false);
    assert.equal(hasPairingState(dir), false);
    fs.writeFileSync(path.join(dir, "IdentifierCache.CC223DE3CEF7.json"), "{}");
    assert.equal(hasPairingState(dir), false);
    fs.writeFileSync(path.join(dir, "AccessoryInfo.CC223DE3CEF7.json"), "{}");
    assert.equal(hasPairingState(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
