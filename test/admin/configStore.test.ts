import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  redactCamera, applyCameraEdit, writeConfigAtomic, readRawConfig, removeCameraFromConfig, keepRemovedCamera, cameraLogins,
} from "../../src/admin/configStore";
import { UserError } from "../../src/admin/errors";
import { tempDir } from "../helpers/tmp";

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
  const dir = tempDir("unscr-");
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
  const dir = tempDir("unscr-");
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg()));
  for (let i = 0; i < 5; i++) writeConfigAtomic(file, cfg() as any, { keepBackups: 3 });
  assert.equal(fs.readdirSync(path.join(dir, "backups")).length, 3);
});

test("unreadable config.json is a UserError saying what to do", () => {
  const dir = tempDir("unscr-");
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => readRawConfig(file), (e: unknown) => e instanceof UserError && e.body.next.length > 0);
});

test("#8: removing a camera takes exactly that entry out, and an unknown name is a 404 that changes nothing", () => {
  const raw = { bridge: { name: "U" }, cameras: [
    { name: "Garage", rtspMain: "rtsp://admin:s3cret@10.0.0.3:554/11" },
    { name: "Front", host: "10.0.0.5", rtspUser: "admin", rtspPassword: "pw2", hksv: true },
  ] } as any;
  const { next, removed } = removeCameraFromConfig(raw, "Garage");
  assert.deepEqual(next.cameras.map((c: any) => c.name), ["Front"]);
  assert.equal(removed.name, "Garage");
  assert.ok(removed.rtspMain!.includes("s3cret"), "the removed entry keeps its login, so it can be put back");
  assert.equal(raw.cameras.length, 2, "the input isn't mutated");
  assert.throws(() => removeCameraFromConfig(raw, "Shed"), (e: unknown) => e instanceof UserError && e.status === 404 && /No camera called "Shed"/.test(e.body.happened));
});

test("#8: the removed entry is kept as its own file, private, under removed-cameras/", () => {
  const dir = tempDir("unscr-removed-");
  const cfg = path.join(dir, "config.json");
  const file = keepRemovedCamera(cfg, { name: "Back Yard/odd:name", rtspMain: "rtsp://u:p@h/1", hksv: true } as any);
  assert.ok(file.startsWith(path.join(dir, "removed-cameras")));
  assert.match(path.basename(file), /^Back_Yard_odd_name-\d{4}-\d{2}-\d{2}T.*\.json$/);
  const kept = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(kept.camera.name, "Back Yard/odd:name");
  assert.equal(kept.camera.rtspMain, "rtsp://u:p@h/1");
  assert.ok(kept.removedAt);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("logins: host + parts gives the RTSP login and http://<host>", () => {
  const l = cameraLogins({ name: "Parts", host: "10.0.0.9", rtspUser: "viewer", rtspPassword: "p@rts!" });
  assert.deepEqual(l, { name: "Parts", rtsp: { user: "viewer", password: "p@rts!" }, foscam: null, onvif: null, webUi: "http://10.0.0.9" });
});

test("logins: a full URL is parsed (percent-decoded), sub used when main has none", () => {
  assert.deepEqual(cameraLogins({ name: "Url", rtspMain: "rtsp://admin:s%40cret@10.0.0.3:554/11" }).rtsp, { user: "admin", password: "s@cret" });
  assert.deepEqual(cameraLogins({ name: "Sub", rtspMain: "rtsp://10.0.0.3/11", rtspSub: "rtsp://u:p@10.0.0.3/12" }).rtsp, { user: "u", password: "p" });
  const none = cameraLogins({ name: "Open", rtspMain: "rtsp://10.0.0.3/11" });
  assert.equal(none.rtsp, null);
  assert.equal(none.webUi, null);
});

test("logins: foscam block gives its login and its cgiBase as the web UI", () => {
  const l = cameraLogins({ name: "Fos", host: "10.0.0.5", rtspUser: "admin", rtspPassword: "pw2",
    foscam: { cgiBase: "http://10.0.0.5:88", username: "cgi", password: "cgipw" } });
  assert.deepEqual(l.foscam, { user: "cgi", password: "cgipw" });
  assert.equal(l.webUi, "http://10.0.0.5:88");
});

test("logins: onvif block gives its login and http://<onvif.host>:<port> when there's no host", () => {
  const l = cameraLogins({ name: "Xm", rtspMain: "rtsp://admin:x@10.0.0.7:554/s0",
    onvif: { host: "10.0.0.7", port: 8080, username: "ov", password: "ovpw" } });
  assert.deepEqual(l.onvif, { user: "ov", password: "ovpw" });
  assert.equal(l.webUi, "http://10.0.0.7:8080");
  assert.equal(cameraLogins({ name: "Xm80", onvif: { host: "10.0.0.8", username: "a", password: "b" } }).webUi, "http://10.0.0.8:80");
});
