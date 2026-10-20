import { test } from "node:test";
import assert from "node:assert/strict";
import { dashCameras, checkToDash } from "../../src/dash/ipc";

const cams = [
  { name: "DogCamTest", rtspMain: "rtsp://admin:s3cret@10.0.1.99:554/11", rtspSub: "rtsp://admin:s3cret@10.0.1.99:554/12" },
  { name: "Couch Cam", rtspMain: "rtsp://u:pw@10.0.1.50/videoMain" },
  { name: "Broken", rtspMain: "not a url" },
] as any;

test("dashCameras carries stream names and probe host/port, never credentials or URLs", () => {
  const out = dashCameras({ cameras: cams });
  assert.deepEqual(out[0], { name: "DogCamTest", main: "dogcamtest", sub: "dogcamtest_sub", probe: { host: "10.0.1.99", port: 554 } });
  assert.deepEqual(out[1], { name: "Couch Cam", main: "couch_cam", sub: null, probe: { host: "10.0.1.50", port: 554 } });
  assert.equal(out[2].probe, null);
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /s3cret|pw|rtsp:|admin/);
});

test("checkToDash rejects malformed messages with a reason", () => {
  assert.equal(typeof checkToDash({ type: "nope" }), "string");
  assert.equal(typeof checkToDash({ type: "cameras", cameras: "x" }), "string");
  assert.equal(typeof checkToDash(null), "string");
  assert.equal(typeof checkToDash({ type: "bridge" }), "string");
  assert.deepEqual(checkToDash({ type: "cameras", cameras: [] }), { type: "cameras", cameras: [] });
});
