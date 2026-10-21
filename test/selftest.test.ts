import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFragments } from "../src/selftest";
import { FragmentInfo } from "../src/mp4";

const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, "ascii");
  return Buffer.concat([h, body]);
};
const u32 = (...n: number[]) => { const b = Buffer.alloc(4 * n.length); n.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
const init = Buffer.concat([
  box("ftyp", Buffer.from("isom")),
  box("moov", box("trak", box("tkhd", u32(3, 0, 0, 1, 0, 0)),
    box("mdia", box("mdhd", u32(0, 0, 0, 90000, 0)), box("hdlr", u32(0, 0), Buffer.from("vide"), Buffer.alloc(12)))),
    Buffer.from("avcC")),
]);
const f = (t: number, extra: Partial<FragmentInfo> = {}): FragmentInfo =>
  ({ trackId: 1, baseMediaDecodeTime: t, firstSampleIsSync: true, hasCompositionOffsets: false, sampleCount: 30, ...extra });
const audioOnly: FragmentInfo = { trackId: 2, baseMediaDecodeTime: null, firstSampleIsSync: null, hasCompositionOffsets: false, sampleCount: 0 };
const unreadable: FragmentInfo = { trackId: null, baseMediaDecodeTime: null, firstSampleIsSync: null, hasCompositionOffsets: false, sampleCount: 0 };

test("an audio-only fragment (the tail when ffmpeg stops) is counted, not judged as video", () => {
  const r = checkFragments(init, [f(0), f(180000), audioOnly], 8);
  assert.deepEqual(r.problems, []);
  assert.equal(r.videoFragments, 2);
  assert.equal(r.otherTrackFragments, 1);
  assert.equal(r.longestSeconds, 2);
});

test("an unreadable fragment is a failure, by number", () => {
  assert.match(checkFragments(init, [f(0), unreadable, f(180000)], 8).problems.join("\n"), /fragment #2 couldn't be read/);
});

test("a clean 2 s GOP stream passes, longest fragment reported", () => {
  const r = checkFragments(init, [f(0), f(180000), f(360000), f(540000)], 8);
  assert.deepEqual(r.problems, []);
  assert.equal(r.longestSeconds, 2);
  assert.equal(r.timescale, 90000);
});

test("each HKSV problem is named in plain words", () => {
  assert.match(checkFragments(null, [], 8).problems.join("\n"), /no init segment/);
  assert.match(checkFragments(init, [f(0)], 8).problems.join("\n"), /only 1 video fragment/);
  assert.match(checkFragments(init, [f(0), f(180000, { firstSampleIsSync: false })], 8).problems.join("\n"), /fragment #2 doesn't start on a keyframe/);
  assert.match(checkFragments(init, [f(0), f(180000, { firstSampleIsSync: null })], 8).problems.join("\n"), /fragment #2 doesn't start on a keyframe/);
  assert.match(checkFragments(init, [f(0), f(180000, { hasCompositionOffsets: true })], 8).problems.join("\n"), /B-frames/);
  assert.match(checkFragments(init, [f(90000), f(270000)], 8).problems.join("\n"), /don't start at zero/);
  assert.match(checkFragments(init, [f(0), f(180000), f(90000)], 8).problems.join("\n"), /backwards at fragment #3/);
  assert.match(checkFragments(init, [audioOnly, audioOnly], 8).problems.join("\n"), /only 0 video fragment/);
  const noAvc = Buffer.from(init.toString("latin1").replace("avcC", "xxxx"), "latin1");
  assert.match(checkFragments(noAvc, [f(0), f(180000)], 8).problems.join("\n"), /no avcC/);
});

test("a long GOP is reported as longest, not a failure (a camera setting)", () => {
  const r = checkFragments(init, [f(0), f(540000), f(1080000)], 12);
  assert.deepEqual(r.problems, []);
  assert.equal(r.longestSeconds, 6);
});
