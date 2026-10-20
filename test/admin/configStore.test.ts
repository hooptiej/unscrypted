import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  redactCamera, applyCameraEdit, writeConfigAtomic, readRawConfig,
} from "../../src/admin/configStore";
import { UserError } from "../../src/admin/errors";

const cfg = () => ({
  bridge: { name: "Unscrypted", username: "CC:22:3D:E3:CE:F6", pin: "031-45-154" },
  cameras: [
    { name: "Garage", rtspMain: "rtsp://admin:s3cret@10.0.0.3:554/11",
      onvif: { host: "10.0.0.3", port: 8080, username: "admin", password: "s3cret" } },
    { name: "Front", host: "10.0.0.5", rtspUser: "admin", rtspPassword: "pw2",
      foscam: { cgiBase: "http://10.0.0.5:88", username: "admin", password: "pw2" } },
  ],
});

test("redaction hides every password, keeps 'set' markers", () => {
  const out = JSON.stringify([redactCamera(cfg().cameras[0] as any), redactCamera(cfg().cameras[1] as any)]);
  assert.ok(!out.includes("s3cret"));
  assert.ok(!out.includes("pw2"));
  assert.ok(out.includes("rtsp://admin:***@10.0.0.3:554/11"));
  assert.ok(out.includes('"password":{"set":true}'));
  assert.ok(out.includes('"rtspPassword":{"set":true}'));
});

test("rename of an existing camera is refused, nothing changes", () => {
  const raw = cfg();
  assert.throws(
    () => applyCameraEdit(raw as any, "Garage", { name: "Garage 2" }),
    (e: unknown) => e instanceof UserError && /new camera/i.test(e.body.happened + e.body.next),
  );
  assert.equal(raw.cameras[0].name, "Garage");
});

test("absent password keeps stored one; masked URL keeps stored password", () => {
  const next = applyCameraEdit(cfg() as any, "Garage", {
    rtspMain: "rtsp://admin:***@10.0.0.3:554/12",
    onvif: { port: 80 },
  });
  const g = next.cameras[0];
  assert.equal(g.rtspMain, "rtsp://admin:s3cret@10.0.0.3:554/12");
  assert.equal(g.onvif!.password, "s3cret");
  assert.equal(g.onvif!.port, 80);
});

test("new password string replaces stored one", () => {
  const next = applyCameraEdit(cfg() as any, "Front", { rtspPassword: "newpw" });
  assert.equal(next.cameras[1].rtspPassword, "newpw");
});

test("a redacted {set:true} marker sent back keeps the stored password", () => {
  const next = applyCameraEdit(cfg() as any, "Front", {
    rtspPassword: { set: true } as any,
    foscam: { password: { set: true } as any, pollIntervalMs: 2000 },
  });
  assert.equal(next.cameras[1].rtspPassword, "pw2");
  assert.equal(next.cameras[1].foscam!.password, "pw2");
  assert.equal(next.cameras[1].foscam!.pollIntervalMs, 2000);
});

test("unknown fields are refused, not silently written", () => {
  assert.throws(
    () => applyCameraEdit(cfg() as any, "Garage", { bogus: 1 } as any),
    (e: unknown) => e instanceof UserError && /bogus/.test(e.body.happened),
  );
});

test("adding a camera with a duplicate name is refused", () => {
  assert.throws(() => applyCameraEdit(cfg() as any, null, { name: "Garage", rtspMain: "rtsp://x/1" }), UserError);
});

test("adding a camera works and leaves the input untouched", () => {
  const raw = cfg();
  const next = applyCameraEdit(raw as any, null, { name: "Side", rtspMain: "rtsp://x/1" });
  assert.equal(next.cameras.length, 3);
  assert.equal(next.cameras[2].name, "Side");
  assert.equal(raw.cameras.length, 2);
});

test("invalid result is refused by the existing validator before any write", () => {
  assert.throws(
    () => applyCameraEdit(cfg() as any, "Garage", { foscam: { cgiBase: "http://x", username: "a", password: "b" } }),
    (e: unknown) => e instanceof UserError && /motion source/i.test(e.body.happened),
  );
});

test("atomic write: backup of previous version, new content readable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unscr-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg()));
  const next = applyCameraEdit(cfg() as any, "Front", { prebufferSeconds: 6 });
  const { backupPath } = writeConfigAtomic(file, next);
  assert.ok(backupPath && fs.existsSync(backupPath));
  assert.equal(readRawConfig(file).cameras[1].prebufferSeconds, 6);
  assert.equal(JSON.parse(fs.readFileSync(backupPath!, "utf8")).cameras[1].prebufferSeconds, undefined);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
});

test("backups are pruned to keepBackups", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unscr-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg()));
  for (let i = 0; i < 5; i++) writeConfigAtomic(file, cfg() as any, { keepBackups: 3 });
  assert.equal(fs.readdirSync(path.join(dir, "backups")).length, 3);
});

test("unreadable config.json is a UserError saying what to do", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unscr-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => readRawConfig(file), (e: unknown) => e instanceof UserError && e.body.next.length > 0);
});
