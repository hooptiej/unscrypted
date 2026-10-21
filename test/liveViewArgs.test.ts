// #55: HomeKit live view must not open with ffmpeg's probe burst (frames whose RTP timestamps run seconds
// ahead of real time), so the live-view input probes only the first packet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveViewInputArgs } from "../src/ffmpeg";

test("live view input skips the stream probe and reads RTSP over TCP", () => {
  const args = liveViewInputArgs("rtsp://cam/11");
  assert.deepEqual(args, [
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-rtsp_transport",
    "tcp",
    "-i",
    "rtsp://cam/11",
  ]);
});

test("probe options come before -i, so they apply to the camera input", () => {
  const args = liveViewInputArgs("rtsp://cam/11");
  const i = args.indexOf("-i");
  assert.ok(args.indexOf("-probesize") < i);
  assert.ok(args.indexOf("-analyzeduration") < i);
  assert.equal(args[i + 1], "rtsp://cam/11");
});

test("no wall-clock restamping (it only added arrival jitter in the #55 harness)", () => {
  assert.ok(!liveViewInputArgs("rtsp://cam/11").includes("-use_wallclock_as_timestamps"));
});
