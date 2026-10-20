import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrebufferArgs, prebufferExitReason } from "../src/prebuffer";

test("prebuffer args: the input URL is the only per-source change, with a socket timeout", () => {
  const a = buildPrebufferArgs({ copyVideo: true, audio: false }, "rtsp://127.0.0.1:8554/garagecamtest");
  const i = a.indexOf("-i");
  assert.equal(a[i + 1], "rtsp://127.0.0.1:8554/garagecamtest");
  assert.deepEqual(a.slice(i - 4, i), ["-rtsp_transport", "tcp", "-timeout", "10000000"]);
  assert.ok(a.includes("frag_keyframe+empty_moov+default_base_moof"));
  assert.deepEqual(a.slice(a.indexOf("-c:v"), a.indexOf("-c:v") + 2), ["-c:v", "copy"]);
  assert.ok(a.includes("-an"));
  assert.equal(a[a.length - 1], "pipe:1");
  const direct = buildPrebufferArgs({ copyVideo: true, audio: false }, "rtsp://u:p@10.0.1.3:554/11");
  assert.deepEqual(direct.filter((x) => !x.startsWith("rtsp://")), a.filter((x) => !x.startsWith("rtsp://")));
});

test("prebuffer args: everything but -timeout matches 0.3.x byte for byte", () => {
  // The 0.3.x args for a copy-video camera with audio, input "IN".
  const v03 = ["-hide_banner", "-loglevel", "warning", "-fflags", "+genpts", "-rtsp_transport", "tcp", "-i", "IN",
    "-c:v", "copy", "-af", "aresample=async=1:first_pts=0", "-c:a", "aac", "-ar", "32000", "-b:a", "32k", "-ac", "1",
    "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "4000000", "pipe:1"];
  const now = buildPrebufferArgs({ copyVideo: true, audio: true }, "IN");
  const t = now.indexOf("-timeout");
  assert.deepEqual([...now.slice(0, t), ...now.slice(t + 2)], v03);
  const transcode = buildPrebufferArgs({ copyVideo: false, audio: false }, "IN");
  assert.deepEqual(transcode.slice(transcode.indexOf("-c:v"), transcode.indexOf("-c:v") + 2), ["-c:v", "libx264"]);
});

test("audio camera (Couch Cam): the restream keeps the AAC chain, and only the input differs from direct", () => {
  const go = buildPrebufferArgs({ copyVideo: true, audio: true }, "rtsp://127.0.0.1:8554/couch_cam");
  const direct = buildPrebufferArgs({ copyVideo: true, audio: true }, "rtsp://admin:x@10.0.1.189:554/videoMain");
  assert.ok(!go.includes("-an"));
  assert.deepEqual(go.slice(go.indexOf("-af"), go.indexOf("-af") + 4), ["-af", "aresample=async=1:first_pts=0", "-c:a", "aac"]);
  assert.deepEqual(go.filter((x) => !x.startsWith("rtsp://")), direct.filter((x) => !x.startsWith("rtsp://")));
});

test("prebuffer exit reasons say what happened even when ffmpeg's stderr is empty (its -timeout exit)", () => {
  const go = { url: "rtsp://127.0.0.1:8554/cam", via: "go2rtc" as const };
  const cam = { url: "rtsp://u:p@h/11", via: "camera" as const };
  assert.match(prebufferExitReason(1, go, 10_500, null), /no video arrived from go2rtc's restream in 11 s, so ffmpeg's 10 s timeout ended it \(go2rtc can't get video/);
  assert.match(prebufferExitReason(1, cam, 10_500, null), /from the camera in 11 s.*camera is down/);
  assert.match(prebufferExitReason(1, go, 300, null), /couldn't open the stream/);
  assert.match(prebufferExitReason(1, go, 600_000, 10_200), /video from go2rtc's restream stopped for 10 s/);
  assert.match(prebufferExitReason(0, go, 600_000, 200), /ended the stream/);
  assert.match(prebufferExitReason(255, cam, 600_000, 200), /failed with exit code 255/);
  assert.match(prebufferExitReason(null, cam, 1, null), /killed or couldn't run/);
});
