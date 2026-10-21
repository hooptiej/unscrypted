/**
 * A tiny UDP relay between ffmpeg and the HomeKit controller (#55 experiment, off by default).
 *
 * ffmpeg sends its RTP video and its RTCP sender reports from two different source ports (the RTP port and
 * the one above it). go2rtc, whose HomeKit streams play fine on the same cameras and phone, sends both from ONE
 * port, the one it announced in the setup response. The relay lets us test whether that difference matters:
 * ffmpeg sends everything to a loopback "ingest" socket, and the relay re-sends each datagram, byte for byte,
 * from the socket whose port the controller was told about. ffmpeg still does all the SRTP encryption, so the
 * packets on the wire are identical except for their source port.
 */
import * as dgram from "dgram";
import { Logger } from "./logger";

export interface RelayStats {
  /** Datagrams relayed to the controller (ffmpeg's RTP plus its RTCP). */
  toController: number;
  bytesToController: number;
  /** Datagrams the controller sent back to our announced port (its RTCP receiver reports). */
  fromController: number;
  /** Sends that failed; the first failure is logged, the rest are only counted. */
  sendErrors: number;
}

export class RtpRelay {
  private readonly ingest: dgram.Socket;
  private readonly stat: RelayStats = { toController: 0, bytesToController: 0, fromController: 0, sendErrors: 0 };
  private isClosed = false;

  private constructor(
    ingest: dgram.Socket,
    readonly ingestPort: number,
    private readonly out: dgram.Socket,
    private readonly targetAddress: string,
    private readonly targetPort: number,
    private readonly label: string,
    private readonly log: Logger,
  ) {
    this.ingest = ingest;
    ingest.on("message", (msg) => this.forward(msg));
    ingest.on("error", (err) => this.log.warn(`[${label}] relay ingest socket error: ${err.message}`));
    // The controller's RTCP receiver reports arrive on our announced port. ffmpeg has nothing to do with them,
    // so they are only counted (they show whether the phone is receiving).
    out.on("message", () => { this.stat.fromController++; });
  }

  /**
   * @param out    the socket bound to the port announced to the controller (all packets leave from it)
   * @param target where the controller wants the stream
   */
  static async create(opts: { out: dgram.Socket; targetAddress: string; targetPort: number; label: string; log: Logger }): Promise<RtpRelay> {
    const ingest = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      ingest.once("error", reject);
      ingest.bind(0, "127.0.0.1", () => { ingest.removeListener("error", reject); resolve(); });
    });
    return new RtpRelay(ingest, ingest.address().port, opts.out, opts.targetAddress, opts.targetPort, opts.label, opts.log);
  }

  private forward(msg: Buffer): void {
    if (this.isClosed) return;
    this.out.send(msg, this.targetPort, this.targetAddress, (err) => {
      if (err) {
        if (this.stat.sendErrors++ === 0) {
          this.log.warn(`[${this.label}] relay couldn't send to ${this.targetAddress}:${this.targetPort}: ${err.message} (further failures counted, not logged)`);
        }
        return;
      }
      this.stat.toController++;
      this.stat.bytesToController += msg.length;
    });
  }

  stats(): RelayStats {
    return { ...this.stat };
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Stops relaying and closes the ingest socket. The outbound socket belongs to the caller. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    try { this.ingest.close(); } catch { /* already closed */ }
  }
}

/** The relay is an experiment: off unless UNSCRYPTED_RTP_PROXY=on. */
export function rtpRelayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.UNSCRYPTED_RTP_PROXY === "on";
}
