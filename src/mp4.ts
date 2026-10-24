/**
 * Incremental fragmented-MP4 box parser.
 *
 * ffmpeg, told to emit `-movflags frag_keyframe+empty_moov+default_base_moof`,
 * writes a byte stream of ISO-BMFF boxes:
 *
 *   ftyp moov   <- the "initialization segment" HAP wants as its first packet
 *   moof mdat   <- a media fragment (starts on a keyframe)
 *   moof mdat   <- another fragment
 *   ...
 *
 * HAP's CameraRecordingDelegate expects the first yielded packet to be the
 * initialization segment and every following packet to be one `moof+mdat`
 * fragment. This parser consumes arbitrary chunks from ffmpeg's stdout and
 * emits those grouped units via callbacks.
 *
 * Box layout: [4-byte big-endian size][4-byte type][...payload].
 * If size === 1 the real size is a 64-bit big-endian value at offset 8.
 * If size === 0 the box runs to end of stream (not used by fragmented mp4).
 */

export interface Mp4Box {
  type: string;
  data: Buffer; // the complete box including its header
}

export class FragmentedMp4Parser {
  private buffer: Buffer = Buffer.alloc(0);
  private pendingInit: Buffer[] = []; // collecting ftyp (+ moov)
  private pendingMoof: Buffer | null = null;

  /**
   * @param onInit Called once with the concatenated ftyp+moov init segment.
   * @param onFragment Called for each moof+mdat fragment.
   */
  constructor(
    private readonly onInit: (segment: Buffer) => void,
    private readonly onFragment: (fragment: Buffer) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    // Pull out as many complete boxes as are present.
    for (;;) {
      if (this.buffer.length < 8) {
        return;
      }
      let size = this.buffer.readUInt32BE(0);
      const type = this.buffer.toString("ascii", 4, 8);
      let headerLen = 8;

      if (size === 1) {
        if (this.buffer.length < 16) {
          return; // need the 64-bit largesize
        }
        // 64-bit size. Node Buffers top out below 2^53, so this is safe.
        const high = this.buffer.readUInt32BE(8);
        const low = this.buffer.readUInt32BE(12);
        size = high * 0x100000000 + low;
        headerLen = 16;
      } else if (size === 0) {
        // Box extends to EOF — shouldn't happen with fragmented mp4. Bail out
        // rather than loop forever.
        return;
      }

      if (size < headerLen) {
        // Corrupt stream; drop a byte and resync would be fragile. Reset.
        this.buffer = Buffer.alloc(0);
        this.pendingInit = [];
        this.pendingMoof = null;
        return;
      }

      if (this.buffer.length < size) {
        return; // wait for the rest of this box
      }

      const box = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      this.handleBox({ type, data: box });
    }
  }

  private handleBox(box: Mp4Box): void {
    switch (box.type) {
      case "ftyp":
        this.pendingInit = [box.data];
        break;
      case "moov":
        this.pendingInit.push(box.data);
        this.onInit(Buffer.concat(this.pendingInit));
        this.pendingInit = [];
        break;
      case "moof":
        this.pendingMoof = box.data;
        break;
      case "mdat":
        if (this.pendingMoof) {
          this.onFragment(Buffer.concat([this.pendingMoof, box.data]));
          this.pendingMoof = null;
        }
        // An mdat with no preceding moof is malformed for frag-mp4; ignore.
        break;
      default:
        // styp/sidx/mfra/free/etc. — not needed for HKSV delivery; drop.
        break;
    }
  }
}

/**
 * What the self-test needs to know about one track in a moof+mdat fragment. trackId is the traf
 * that was read; when a wanted track isn't in the fragment (e.g. an audio-only tail fragment), it is
 * the fragment's first track and the other fields stay empty. null = nothing readable.
 */
export interface FragmentInfo { trackId: number | null; baseMediaDecodeTime: number | null; firstSampleIsSync: boolean | null; hasCompositionOffsets: boolean; sampleCount: number }

interface Span { type: string; start: number; end: number }
/** Child boxes of [start, end). Stops quietly at anything malformed. */
function children(buf: Buffer, start: number, end: number): Span[] {
  const out: Span[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    }
    if (size < header || p + size > end) break;
    out.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return out;
}

/** sample_is_non_sync_sample bit of ISO/IEC 14496-12 sample flags. */
const NON_SYNC_SAMPLE = 0x00010000;

/** track_ID of a traf (from its tfhd), or null. */
function trafTrackId(buf: Buffer, traf: Span): number | null {
  const tfhd = children(buf, traf.start, traf.end).find((b) => b.type === "tfhd");
  return tfhd && tfhd.start + 8 <= tfhd.end ? buf.readUInt32BE(tfhd.start + 4) : null;
}

/**
 * Decode time, keyframe start and B-frame evidence of one track in a moof+mdat fragment: the track
 * with id `trackId` (see videoTrack), or the first track when no id is given. Never throws.
 */
export function inspectFragment(fragment: Buffer, trackId?: number): FragmentInfo {
  const info: FragmentInfo = { trackId: null, baseMediaDecodeTime: null, firstSampleIsSync: null, hasCompositionOffsets: false, sampleCount: 0 };
  try {
    const moof = children(fragment, 0, fragment.length).find((b) => b.type === "moof");
    const trafs = moof ? children(fragment, moof.start, moof.end).filter((b) => b.type === "traf") : [];
    if (trafs.length === 0) return info;
    const traf = trackId === undefined ? trafs[0] : trafs.find((t) => trafTrackId(fragment, t) === trackId);
    if (!traf) { info.trackId = trafTrackId(fragment, trafs[0]); return info; }
    info.trackId = trafTrackId(fragment, traf);
    let defaultFlags: number | null = null;
    for (const b of children(fragment, traf.start, traf.end)) {
      const vf = fragment.readUInt32BE(b.start);
      const version = vf >>> 24;
      const flags = vf & 0xffffff;
      let p = b.start + 4;
      if (b.type === "tfhd") {
        p += 4;                       // track_ID
        if (flags & 0x01) p += 8;     // base_data_offset
        if (flags & 0x02) p += 4;     // sample_description_index
        if (flags & 0x08) p += 4;     // default_sample_duration
        if (flags & 0x10) p += 4;     // default_sample_size
        if (flags & 0x20) defaultFlags = fragment.readUInt32BE(p);
      } else if (b.type === "tfdt") {
        info.baseMediaDecodeTime = version === 1 ? Number(fragment.readBigUInt64BE(p)) : fragment.readUInt32BE(p);
      } else if (b.type === "trun") {
        const count = fragment.readUInt32BE(p); p += 4;
        info.sampleCount = count;
        if (flags & 0x01) p += 4;     // data_offset
        let first: number | null = null;
        if (flags & 0x04) { first = fragment.readUInt32BE(p); p += 4; }
        for (let i = 0; i < count; i++) {
          if (flags & 0x100) p += 4;  // sample_duration
          if (flags & 0x200) p += 4;  // sample_size
          let sf: number | null = null;
          if (flags & 0x400) { sf = fragment.readUInt32BE(p); p += 4; }
          if (flags & 0x800) { if (fragment.readInt32BE(p) !== 0) info.hasCompositionOffsets = true; p += 4; }
          if (i === 0 && first === null) first = sf;
        }
        const f0 = first ?? defaultFlags;
        info.firstSampleIsSync = f0 === null ? null : (f0 & NON_SYNC_SAMPLE) === 0;
      }
    }
  } catch {
    // A truncated box: report what was read so far. The selftest treats nulls as failures, loudly.
  }
  return info;
}

/** The first video track of an ftyp+moov init segment: its id (null without a tkhd) and timescale. Never throws. */
function findVideo(init: Buffer): { trackId: number | null; timescale: number } | null {
  try {
    const moov = children(init, 0, init.length).find((b) => b.type === "moov");
    if (!moov) return null;
    for (const trak of children(init, moov.start, moov.end).filter((b) => b.type === "trak")) {
      const tk = children(init, trak.start, trak.end);
      const mdia = tk.find((b) => b.type === "mdia");
      if (!mdia) continue;
      const kids = children(init, mdia.start, mdia.end);
      const hdlr = kids.find((b) => b.type === "hdlr");
      const mdhd = kids.find((b) => b.type === "mdhd");
      if (!hdlr || !mdhd || init.toString("ascii", hdlr.start + 8, hdlr.start + 12) !== "vide") continue;
      const v = init.readUInt8(mdhd.start);
      const timescale = init.readUInt32BE(mdhd.start + (v === 1 ? 20 : 12));
      const tkhd = tk.find((b) => b.type === "tkhd");
      // tkhd: version/flags, then ctime+mtime (4+4 bytes in v0, 8+8 in v1), then track_ID.
      const trackId = tkhd ? init.readUInt32BE(tkhd.start + (init.readUInt8(tkhd.start) === 1 ? 20 : 12)) : null;
      return { trackId, timescale };
    }
  } catch {
    // Malformed init: null makes the selftest fail with "no video timescale".
  }
  return null;
}

/** Timescale (ticks per second) of the first video track in an ftyp+moov init segment. Never throws. */
export function videoTimescale(init: Buffer): number | null {
  return findVideo(init)?.timescale ?? null;
}

/** Track id + timescale of the first video track (null when there's none, or no tkhd). Never throws. */
export function videoTrack(init: Buffer): { trackId: number; timescale: number } | null {
  const v = findVideo(init);
  return v && v.trackId !== null ? { trackId: v.trackId, timescale: v.timescale } : null;
}
