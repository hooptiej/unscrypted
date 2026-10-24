import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLiveInputArgs, buildSnapshotArgs, LOW_LATENCY_INPUT, isProbeMiss, FfmpegRunError } from "../src/streamingDelegate";
import { buildPrebufferArgs } from "../src/prebuffer";

// #33: every live start used to pay ffmpeg's default probing (~2.7 s measured on a Boavision).
test("live and snapshot inputs start on the first decodable frame and time out instead of hanging", () => {
  const feed = { url: "rtsp://127.0.0.1:8554/garage", via: "go2rtc" as const };
  const live = buildLiveInputArgs(feed);
  for (const f of LOW_LATENCY_INPUT) assert.ok(live.includes(f), `live input lacks ${f}`);
  assert.equal(live[live.indexOf("-timeout") + 1], "10000000");
  assert.equal(live[live.length - 1], feed.url);
  const snap = buildSnapshotArgs(feed, 640, 360);
  assert.ok(snap.includes("-probesize"));
  assert.ok(snap.join(" ").includes("scale=640:360"));
  assert.equal(snap[snap.indexOf("-i") + 1], feed.url);
});

test("the recording buffer keeps its probing (fragments need the full stream analysis) but gets the socket timeout", () => {
  const args = buildPrebufferArgs({ copyVideo: true, audio: false }, "rtsp://127.0.0.1:8554/garage");
  assert.ok(!args.includes("-probesize"));
  assert.equal(args[args.indexOf("-timeout") + 1], "10000000");
  assert.ok(args.includes("frag_keyframe+empty_moov+default_base_moof"));
  assert.equal(args[args.length - 1], "pipe:1");
});

// #78: a Foscam FI9803P sends its video late; the fast probe misses it. Full probing is the retry, and a miss is not a feed failure.
test("#78: full probing drops the low-latency flags, keeps the timeout; fast is the default", () => {
  const feed = { url: "rtsp://127.0.0.1:8554/couch", via: "go2rtc" as const };
  const full = buildLiveInputArgs(feed, "full");
  for (const f of ["-probesize", "-analyzeduration", "nobuffer", "low_delay"]) assert.ok(!full.includes(f), `full probing still has ${f}`);
  assert.equal(full[full.indexOf("-timeout") + 1], "10000000");
  assert.deepEqual(buildLiveInputArgs(feed), buildLiveInputArgs(feed, "fast"));
  const snap = buildSnapshotArgs(feed, 640, 360, "full");
  assert.ok(!snap.includes("-probesize"));
  assert.ok(snap.join(" ").includes("scale=640:360"));
});

test("#78: only ffmpeg's 'does not contain any stream' after a non-zero exit is a probe miss", () => {
  const foscam = "Output file #0 does not contain any stream\n";
  assert.equal(isProbeMiss(1, foscam), true);
  assert.equal(isProbeMiss(0, foscam), false, "a clean exit isn't a miss");
  assert.equal(isProbeMiss(1, "Connection to tcp://10.0.1.189:88 failed: No route to host"), false, "an unreachable camera is a real failure");
  assert.equal(isProbeMiss(null, foscam), true, "killed after the message still counts");
  const e = new FfmpegRunError("snapshot produced no output (exit 1)", 1, foscam);
  assert.equal(e.probeMiss, true);
  assert.equal(new FfmpegRunError("snapshot timed out", null, "").probeMiss, false);
});
