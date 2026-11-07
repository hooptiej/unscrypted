import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGo2rtcYaml, restreamUrl } from "../../src/admin/go2rtcConfig";

const cam = (name: string, extra: any = {}) => ({ name, rtspMain: "rtsp://u:p@h/11", rtspSub: "rtsp://u:p@h/12", audio: false, ...extra });

test("yaml: loopback API, RTSP restream on loopback only (off when null), WebRTC off when null, video-only streams", () => {
  const y = buildGo2rtcYaml({ cameras: [cam("Couch Cam")] } as any, { api: 1986, webrtc: null, rtsp: 8554 });
  assert.match(y, /listen: "127\.0\.0\.1:1986"/);
  assert.match(y, /rtsp:\n  listen: "127\.0\.0\.1:8554"/);
  assert.match(buildGo2rtcYaml({ cameras: [cam("Couch Cam")] } as any, { api: 1986, webrtc: null, rtsp: null }), /rtsp:\n  listen: ""/);
  assert.equal(restreamUrl(8554, "couch_cam"), "rtsp://127.0.0.1:8554/couch_cam");
  assert.match(y, /webrtc:\n  listen: ""/);
  assert.match(y, /couch_cam: "rtsp:\/\/u:p@h\/11#media=video"/);
  assert.match(y, /couch_cam_sub: "rtsp:\/\/u:p@h\/12#media=video"/);
});

test("audio cameras keep audio", () => {
  const y = buildGo2rtcYaml({ cameras: [cam("X", { audio: true })] } as any, { api: 1986, webrtc: null, rtsp: null });
  assert.match(y, /x: "rtsp:\/\/u:p@h\/11"\n/);
});

test("webrtc port is used when given", () => {
  const y = buildGo2rtcYaml({ cameras: [cam("X")] } as any, { api: 1987, webrtc: 8557 });
  assert.match(y, /webrtc:\n  listen: ":8557"/);
});

test("#45: go2rtc's SRTP and RTMP servers are switched off in writing, whatever the other ports are", () => {
  for (const ports of [{ api: 1986, webrtc: 8557, rtsp: 8554 }, { api: 1986, webrtc: null, rtsp: null }]) {
    const y = buildGo2rtcYaml({ cameras: [cam("X")] } as any, ports);
    assert.match(y, /\nsrtp:\n  listen: ""\n/);
    assert.match(y, /\nrtmp:\n  listen: ""\n/);
  }
});
