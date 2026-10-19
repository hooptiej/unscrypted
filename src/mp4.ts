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
