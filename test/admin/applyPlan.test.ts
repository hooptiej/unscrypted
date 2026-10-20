import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyChange } from "../../src/admin/ipc";

const base: any = { name: "G", rtspMain: "rtsp://a", hksv: true, prebufferSeconds: 4, audio: false, copyVideo: true,
  maxRecordingSeconds: 170, manufacturer: "M", model: "X", serialNumber: "s",
  onvif: { host: "h", port: 8080, username: "u", password: "p", pollIntervalMs: 60000, motionCooldownMs: 8000, notifyPort: 0 } };

test("new camera", () => assert.equal(classifyChange(undefined, base), "added"));

test("password/URL change is live", () => {
  assert.equal(classifyChange(base, { ...base, rtspMain: "rtsp://b" }), "live");
  assert.equal(classifyChange(base, { ...base, onvif: { ...base.onvif, password: "q" } }), "live");
  assert.equal(classifyChange(base, { ...base, audio: true, maxRecordingSeconds: 120 }), "live");
});

test("HKSV toggle / prebuffer / motion source added or removed needs restart", () => {
  assert.equal(classifyChange(base, { ...base, hksv: false }), "restart-needed");
  assert.equal(classifyChange(base, { ...base, prebufferSeconds: 6 }), "restart-needed");
  assert.equal(classifyChange(base, { ...base, onvif: undefined }), "restart-needed");
  assert.equal(classifyChange(base, { ...base, model: "Y" }), "restart-needed");
});

test("switching motion source kind needs restart", () => {
  const foscam = { cgiBase: "http://h:88", username: "u", password: "p" };
  assert.equal(classifyChange(base, { ...base, onvif: undefined, foscam }), "restart-needed");
});

test("no change at all is still 'live' (a harmless re-apply)", () => {
  assert.equal(classifyChange(base, { ...base }), "live");
});
