import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLiveInputArgs, buildSnapshotArgs, LOW_LATENCY_INPUT } from "../src/streamingDelegate";
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
