import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectFragment, videoTimescale, videoTrack } from "../src/mp4";

const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, "ascii");
  return Buffer.concat([h, body]);
};
const u32 = (...n: number[]) => { const b = Buffer.alloc(4 * n.length); n.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
const SYNC = 0x02000000, NON_SYNC = 0x01010000;

function frag(opts: { tfdt: number; firstFlags: number; cts?: number[] }) {
  const tfhd = box("tfhd", u32(0x020000, 1));                          // flags: default-base-is-moof, track 1
  const tfdt = box("tfdt", u32(0x01000000), Buffer.from([0, 0, 0, 0]), u32(opts.tfdt)); // v1, 64-bit
  const n = opts.cts ? opts.cts.length : 2;
  const flags = 0x01 | 0x04 | 0x100 | 0x200 | (opts.cts ? 0x800 : 0);
  const samples = Array.from({ length: n }, (_, i) => Buffer.concat([u32(6000, 100), ...(opts.cts ? [u32(opts.cts[i])] : [])]));
  const trun = box("trun", u32(flags, n, 0, opts.firstFlags), ...samples);
  return Buffer.concat([box("moof", box("mfhd", u32(0, 1)), box("traf", tfhd, tfdt, trun)), box("mdat", Buffer.alloc(4))]);
}

test("reads decode time, keyframe start and composition offsets from a fragment", () => {
  const ok = inspectFragment(frag({ tfdt: 0, firstFlags: SYNC }));
  assert.deepEqual(ok, { trackId: 1, baseMediaDecodeTime: 0, firstSampleIsSync: true, hasCompositionOffsets: false, sampleCount: 2 });
  assert.equal(inspectFragment(frag({ tfdt: 90000, firstFlags: NON_SYNC })).firstSampleIsSync, false);
  assert.equal(inspectFragment(frag({ tfdt: 90000, firstFlags: NON_SYNC })).baseMediaDecodeTime, 90000);
  assert.equal(inspectFragment(frag({ tfdt: 0, firstFlags: SYNC, cts: [0, 3000] })).hasCompositionOffsets, true);
  assert.equal(inspectFragment(frag({ tfdt: 0, firstFlags: SYNC, cts: [0, 0] })).hasCompositionOffsets, false);
});

test("a fragment with no first-sample flags falls back to tfhd's default flags", () => {
  const tfhd = box("tfhd", u32(0x020020, 1, NON_SYNC));                // default-sample-flags present
  const tfdt = box("tfdt", u32(0), u32(4500));                          // v0, 32-bit
  const trun = box("trun", u32(0x01 | 0x100, 1, 0), u32(6000));
  const f = Buffer.concat([box("moof", box("mfhd", u32(0, 1)), box("traf", tfhd, tfdt, trun)), box("mdat", Buffer.alloc(4))]);
  assert.deepEqual(inspectFragment(f), { trackId: 1, baseMediaDecodeTime: 4500, firstSampleIsSync: false, hasCompositionOffsets: false, sampleCount: 1 });
});

test("with a track id, reads that track's traf; an audio-only fragment reports the other track and no video facts", () => {
  const traf = (track: number, tfdt: number, first: number) => box("traf", box("tfhd", u32(0x020000, track)),
    box("tfdt", u32(0), u32(tfdt)), box("trun", u32(0x01 | 0x04 | 0x100, 1, 0, first), u32(6000)));
  const both = Buffer.concat([box("moof", box("mfhd", u32(0, 1)), traf(2, 64000, NON_SYNC), traf(1, 30720, SYNC)), box("mdat", Buffer.alloc(4))]);
  assert.deepEqual(inspectFragment(both, 1), { trackId: 1, baseMediaDecodeTime: 30720, firstSampleIsSync: true, hasCompositionOffsets: false, sampleCount: 1 });
  assert.equal(inspectFragment(both).trackId, 2);   // no id: the first traf, as before
  const audioOnly = Buffer.concat([box("moof", box("mfhd", u32(0, 1)), traf(2, 257195, SYNC)), box("mdat", Buffer.alloc(4))]);
  assert.deepEqual(inspectFragment(audioOnly, 1), { trackId: 2, baseMediaDecodeTime: null, firstSampleIsSync: null, hasCompositionOffsets: false, sampleCount: 0 });
});

test("garbage in, nulls out (never throws)", () => {
  assert.deepEqual(inspectFragment(Buffer.from("nonsense")), { trackId: null, baseMediaDecodeTime: null, firstSampleIsSync: null, hasCompositionOffsets: false, sampleCount: 0 });
  const truncated = frag({ tfdt: 0, firstFlags: SYNC }).subarray(0, 30);
  assert.doesNotThrow(() => inspectFragment(truncated));
});

test("finds the video track's timescale in the init segment", () => {
  const mdhd = box("mdhd", u32(0, 0, 0, 90000, 0));                     // v0: ctime, mtime, timescale, duration
  const hdlr = box("hdlr", u32(0, 0), Buffer.from("vide"), Buffer.alloc(12));
  const init = Buffer.concat([box("ftyp", Buffer.from("isom")), box("moov", box("trak", box("mdia", mdhd, hdlr)))]);
  assert.equal(videoTimescale(init), 90000);
  assert.equal(videoTimescale(Buffer.from("nonsense")), null);
});

test("finds the video track's id and timescale, skipping an audio track listed first", () => {
  const trak = (id: number, handler: string, scale: number) => box("trak",
    box("tkhd", u32(0x00000003, 0, 0, id, 0, 0)),                       // v0: ctime, mtime, track_ID, reserved, duration
    box("mdia", box("mdhd", u32(0, 0, 0, scale, 0)), box("hdlr", u32(0, 0), Buffer.from(handler), Buffer.alloc(12))));
  const init = Buffer.concat([box("ftyp", Buffer.from("isom")), box("moov", trak(2, "soun", 32000), trak(1, "vide", 15360))]);
  assert.deepEqual(videoTrack(init), { trackId: 1, timescale: 15360 });
  assert.equal(videoTimescale(init), 15360);
  assert.equal(videoTrack(Buffer.from("nonsense")), null);
});
