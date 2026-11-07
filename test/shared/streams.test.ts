import { test } from "node:test";
import assert from "node:assert/strict";
import { streamSlug, streamNames } from "../../src/shared/streams";

const cam = (name: string, extra: any = {}) => ({ name, rtspMain: "rtsp://u:p@h/11", rtspSub: "rtsp://u:p@h/12", audio: false, ...extra });

test("slug is lowercase, safe, stable", () => {
  assert.equal(streamSlug("Couch Cam"), "couch_cam");
  assert.equal(streamSlug("Garage (ONVIF)!"), "garage_onvif");
  assert.equal(streamSlug("!!!"), "camera");
});

test("colliding slugs get numeric suffixes in config order", () => {
  const m = streamNames([cam("A b"), cam("a-b")] as any);
  assert.equal(m.get("A b")!.main, "a_b");
  assert.equal(m.get("a-b")!.main, "a_b_2");
  assert.equal(m.get("a-b")!.sub, "a_b_2_sub");
});

test("a camera's _sub stream never collides with another camera's main stream", () => {
  for (const order of [["A", "A sub"], ["A sub", "A"]]) {
    const m = streamNames(order.map((n) => cam(n)) as any);
    const all = [...m.values()].flatMap((v) => [v.main, v.sub].filter(Boolean));
    assert.equal(new Set(all).size, all.length, `duplicate stream names for order ${order}: ${all}`);
  }
});

test("no sub stream when the camera has no rtspSub", () => {
  const m = streamNames([cam("X", { rtspSub: undefined })] as any);
  assert.equal(m.get("X")!.sub, undefined);
});
