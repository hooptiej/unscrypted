import { test } from "node:test";
import assert from "node:assert/strict";
import { dashCameras, checkToDash, dashFeed } from "../../src/dash/ipc";

const cams = [
  { name: "DogCamTest", rtspMain: "rtsp://admin:s3cret@10.0.1.99:554/11", rtspSub: "rtsp://admin:s3cret@10.0.1.99:554/12" },
  { name: "Couch Cam", rtspMain: "rtsp://u:pw@10.0.1.50/videoMain" },
  { name: "Broken", rtspMain: "not a url" },
] as any;

test("dashCameras carries stream names only: no credentials, URLs or addresses (#16: no probes)", () => {
  const out = dashCameras({ cameras: cams });
  assert.deepEqual(out[0], { name: "DogCamTest", main: "dogcamtest", sub: "dogcamtest_sub" });
  assert.deepEqual(out[1], { name: "Couch Cam", main: "couch_cam", sub: null });
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /s3cret|pw|rtsp:|admin/);
  assert.ok(!s.includes("10.0.1."));
});

test("dash feed reasons are plain and never carry an address", () => {
  const down = dashFeed({ state: "down", since: 5, reason: "go2rtc can't get video from the camera: dial tcp 10.0.1.3:554: connect: connection refused", lastVideoAt: null, consumers: 1 }, true);
  assert.deepEqual(down, { state: "down", up: false, reason: "Camera not sending video: go2rtc can't connect to it", since: 5 });
  assert.deepEqual(dashFeed({ state: "stalled", since: 7, reason: "x 10.0.1.3", lastVideoAt: 1, consumers: 1 }, true),
    { state: "stalled", up: false, reason: "Camera connected but stopped sending video", since: 7 });
  assert.equal(dashFeed({ state: "idle", since: 1, reason: null, lastVideoAt: null, consumers: 0 }, true).up, true, "idle tiles must start playing");
  assert.equal(dashFeed({ state: "streaming", since: 1, reason: null, lastVideoAt: 1, consumers: 1 }, false).state, "unknown", "go2rtc down: unknown");
  assert.equal(dashFeed(undefined, false).state, "unknown");
  assert.equal((checkToDash({ type: "feeds", feeds: {} }) as any).type, "feeds");
  assert.equal(typeof checkToDash({ type: "feeds", feeds: [] }), "string");
});

test("checkToDash rejects malformed messages with a reason", () => {
  assert.equal(typeof checkToDash({ type: "nope" }), "string");
  assert.equal(typeof checkToDash({ type: "cameras", cameras: "x" }), "string");
  assert.equal(typeof checkToDash(null), "string");
  assert.equal(typeof checkToDash({ type: "bridge" }), "string");
  assert.deepEqual(checkToDash({ type: "cameras", cameras: [] }), { type: "cameras", cameras: [] });
});
