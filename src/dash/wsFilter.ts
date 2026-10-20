/**
 * Browser -> go2rtc WebSocket filter for the open dashboard. Parses the client's frames (always
 * masked, RFC 6455), unmasks each text message to read its JSON "type", and forwards the ORIGINAL
 * bytes only when every message is WebRTC signalling. Anything else ends the connection with a
 * reason the server logs. Server -> browser traffic isn't touched.
 */

/** The only messages go2rtc 1.9.14's player sends in webrtc mode (checked against its video-rtc.js). */
export const ALLOWED_TYPES = new Set(["webrtc/offer", "webrtc/candidate"]);
const MAX_MESSAGE = 64 * 1024;

export class ClientFrameFilter {
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];     // unmasked payloads of the text message being assembled
  private held: Buffer[] = [];      // its raw frames, forwarded once the whole message checks out
  private inText = false;

  push(chunk: Buffer): { forward: Buffer } | { reject: string } {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f;
      if ((b1 & 0x80) === 0) return { reject: "an unmasked frame (not sent by a browser)" };
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return { reject: "a message over 64 KB" };
        len = Number(big); off = 10;
      }
      if (len > MAX_MESSAGE) return { reject: "a message over 64 KB" };
      const total = off + 4 + len;
      if (this.buf.length < total) break;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, total));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      const raw = Buffer.from(this.buf.subarray(0, total));
      this.buf = this.buf.subarray(total);

      if (op === 0x8 || op === 0x9 || op === 0xa) { out.push(raw); continue; }   // close / ping / pong
      if (op === 0x2) return { reject: "a binary message (the dashboard only sends WebRTC signalling)" };
      if (op === 0x1) { if (this.inText) return { reject: "a malformed message sequence" }; this.inText = true; this.parts = []; this.held = []; }
      else if (op === 0x0) { if (!this.inText) return { reject: "a malformed message sequence" }; }
      else return { reject: `an unknown frame type (${op})` };
      this.parts.push(payload);
      this.held.push(raw);
      if (this.parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) return { reject: "a message over 64 KB" };
      if (!fin) continue;
      this.inText = false;
      let type: unknown;
      try { type = JSON.parse(Buffer.concat(this.parts).toString("utf8"))?.type; }
      catch { return { reject: "a message that isn't JSON" }; }
      if (typeof type !== "string" || !ALLOWED_TYPES.has(type)) return { reject: `a "${String(type)}" request (only WebRTC is allowed on the open dashboard)` };
      out.push(...this.held);
      this.held = [];
    }
    return { forward: Buffer.concat(out) };
  }
}
