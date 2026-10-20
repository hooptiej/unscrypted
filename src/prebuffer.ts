/**
 * Rolling prebuffer.
 *
 * HAP-NodeJS does NOT provide a prebuffer — it only tells us, when recording
 * starts, to begin yielding fragments "starting with the content of the
 * prebuffer". So we must continuously keep the last few seconds of video ready.
 *
 * Approach (single continuous pipeline, one init segment):
 *   - When recording is enabled (HAP's updateRecordingActive(true)) we spawn ONE
 *     long-lived ffmpeg that pulls the camera's main RTSP stream and emits a
 *     fragmented MP4 to stdout (video copied by default, audio -> AAC).
 *   - We parse that byte stream into the initialization segment (ftyp+moov) and a
 *     sequence of moof+mdat fragments (each starts on a keyframe).
 *   - We keep a ring buffer of recent fragments (prebuffer window + a margin).
 *   - When a recording stream is requested, the RecordingDelegate takes the init
 *     segment, the buffered fragments inside the window, and then live fragments.
 *
 * Because it is ONE ffmpeg / ONE init segment, the pre-event and post-event
 * fragments are mutually compatible — no stitching of mismatched moov boxes.
 *
 * CAVEAT (must be verified on a real device): with `-c:v copy`, fragment length
 * equals the camera's own keyframe interval (GOP). HKSV wants fragments that
 * start on a keyframe AND are no longer than the selected fragmentLength (~4s).
 * If the Foscam GOP is longer than ~4s this can break recording. Fixes: shorten
 * the camera's I-frame interval, or set `copyVideo: false` to transcode with a
 * forced 4s GOP (costs CPU). See README.
 */

import { Logger } from "./logger";
import { resolveFfmpeg, spawnFfmpeg, SpawnedFfmpeg } from "./ffmpeg";
import { FragmentedMp4Parser } from "./mp4";
import { ResolvedCamera } from "./config";
import { directPicker, FeedChoice, FeedFailure, FeedPicker, FeedVia } from "./source";

export interface PrebufferStatus { running: boolean; via: FeedVia | null; lastFragmentAt: number | null }

const readsFrom = (via: FeedVia) => (via === "go2rtc" ? "through go2rtc" : "the camera directly");

/**
 * Why the buffer's ffmpeg stopped, in plain words. ffmpeg's own stderr is often empty here: when
 * its -timeout (10 s without data) fires it just exits 1, so the reason has to come from what we saw.
 */
export function prebufferExitReason(code: number | null, feed: FeedChoice, ranMs: number, lastFragmentAgoMs: number | null): string {
  const src = feed.via === "go2rtc" ? "go2rtc's restream" : "the camera";
  if (code === null) return `ffmpeg was killed or couldn't run (reading ${readsFrom(feed.via)})`;
  if (lastFragmentAgoMs === null) {
    return ranMs >= 9000
      ? `no video arrived from ${src} in ${Math.round(ranMs / 1000)} s, so ffmpeg's 10 s timeout ended it` +
        (feed.via === "go2rtc" ? " (go2rtc can't get video from the camera, or the camera is down)" : " (the camera is down or not sending)")
      : `ffmpeg stopped after ${Math.round(ranMs / 1000)} s without any video from ${src} (exit code ${code}; it couldn't open the stream)`;
  }
  if (lastFragmentAgoMs >= 9000) return `video from ${src} stopped for ${Math.round(lastFragmentAgoMs / 1000)} s, so ffmpeg's 10 s timeout ended it (exit code ${code})`;
  if (code === 0) return `${src} ended the stream (it closed the connection)`;
  return `reading ${src} failed with exit code ${code} (ffmpeg's last lines, if any, are above)`;
}

/**
 * The continuous fragmented-MP4 pipeline's ffmpeg args. The input URL is the only per-source
 * difference: go2rtc's loopback restream or the camera itself (fallback), the same args either way.
 * The self-test (`--selftest --source`) runs exactly these args, so it proves what HomeKit gets.
 */
export function buildPrebufferArgs(cam: Pick<ResolvedCamera, "copyVideo" | "audio">, inputUrl: string): string[] {
  const args: string[] = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "+genpts",
    "-rtsp_transport",
    "tcp",
    // Socket I/O timeout (µs): a wedged go2rtc or camera makes ffmpeg exit, so the prebuffer restarts instead of hanging.
    "-timeout",
    "10000000",
    "-i",
    inputUrl,
  ];

  // Video
  if (cam.copyVideo) {
    args.push("-c:v", "copy");
  } else {
    // Transcode and force a 4s keyframe cadence so fragments stay short.
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-profile:v",
      "main",
      "-pix_fmt",
      "yuv420p",
      "-force_key_frames",
      "expr:gte(t,n_forced*4)",
      "-g",
      "60",
    );
  }

  // Audio -> AAC for recording (HKSV accepts AAC-LC), only when the camera has
  // an audio track. aresample=async fixes non-monotonic/backward audio
  // timestamps (e.g. G.711 sources) so the muxer DTS stays monotonic.
  if (cam.audio) {
    args.push(
      "-af",
      "aresample=async=1:first_pts=0",
      "-c:a",
      "aac",
      "-ar",
      "32000",
      "-b:a",
      "32k",
      "-ac",
      "1",
    );
  } else {
    args.push("-an");
  }
  args.push(
    // Fragmented MP4 to stdout. empty_moov+default_base_moof gives us a clean
    // init segment; frag_keyframe forces a new fragment on each keyframe.
    "-f",
    "mp4",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    // Also cap fragment duration so a long GOP still yields bounded fragments
    // when transcoding (ignored meaningfully for pure copy, harmless).
    "-frag_duration",
    "4000000",
    "pipe:1",
  );
  return args;
}

interface StoredFragment {
  data: Buffer;
  ts: number; // Date.now() when captured
}

type LiveSubscriber = (fragment: Buffer) => void;

export interface PrebufferSession {
  /** The ftyp+moov initialization segment. */
  initSegment: Buffer;
  /** Fragments currently inside the prebuffer window, oldest first. */
  prebufferedFragments: Buffer[];
  /** Subscribe to live fragments produced from now on. Returns an unsubscribe fn. */
  subscribeLive: (cb: LiveSubscriber) => () => void;
}

export class Prebuffer {
  private ffmpeg: SpawnedFfmpeg | null = null;
  private parser: FragmentedMp4Parser | null = null;
  private initSegment: Buffer | null = null;
  private ring: StoredFragment[] = [];
  private readonly windowMs: number;
  private readonly keepMs: number;
  private readonly liveSubscribers = new Set<LiveSubscriber>();
  private starting = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private wantRunning = false;
  private feed: FeedChoice | null = null;
  private lastFragmentAt: number | null = null;

  constructor(
    private readonly camera: ResolvedCamera,
    private readonly ffmpegPath: string,
    private readonly log: Logger,
    /** Where to read the camera from at each spawn (go2rtc's restream or the camera, #16). */
    private readonly pick: FeedPicker = directPicker(camera),
    /** Told when a read fails, so a camera go2rtc keeps failing on can go direct (Q3). */
    private readonly onFailure?: FeedFailure,
  ) {
    this.windowMs = camera.prebufferSeconds * 1000;
    // Keep a little more than the window so a fragment that straddles the
    // boundary is still available.
    this.keepMs = this.windowMs + 2000;
  }

  isRunning(): boolean {
    return this.ffmpeg !== null;
  }

  hasInit(): boolean {
    return this.initSegment !== null;
  }

  /**
   * Wait up to timeoutMs for the init segment to be ready (ffmpeg connected and
   * emitted ftyp+moov). Lets a recording request that arrives right after
   * recording is enabled ride out the ffmpeg warm-up instead of aborting cold.
   */
  async waitForInit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.initSegment && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    return this.initSegment !== null;
  }

  async start(): Promise<void> {
    this.wantRunning = true;
    if (this.ffmpeg || this.starting) {
      return;
    }
    this.starting = true;
    try {
      const ff = await resolveFfmpeg(this.ffmpegPath, this.log);
      if (!ff) {
        this.log.warn(
          "prebuffer cannot start: ffmpeg unavailable. Recording will not work.",
        );
        return;
      }
      this.spawn(ff);
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.wantRunning = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.ffmpeg) {
      this.log.info("stopping prebuffer");
      this.ffmpeg.kill();
      this.ffmpeg = null;
    }
    this.feed = null;
    this.parser = null;
    this.initSegment = null;
    this.ring = [];
  }

  /** Where the running buffer reads from (null when it isn't running). */
  currentVia(): FeedVia | null {
    return this.ffmpeg ? this.feed?.via ?? null : null;
  }

  status(): PrebufferStatus {
    return { running: this.ffmpeg !== null, via: this.currentVia(), lastFragmentAt: this.lastFragmentAt };
  }

  /** Stop and start again now, reading from the current source. No-op unless it should be running. */
  restart(): void {
    if (!this.wantRunning) return;
    this.stop();
    void this.start();
  }

  private spawn(ffmpegPath: string): void {
    const feed = this.pick("main");
    if (!feed) {
      this.log.error("prebuffer has no main stream URL; recording won't work for this camera until config.json gives one");
      return;
    }
    const args = buildPrebufferArgs(this.camera, feed.url);
    this.feed = feed;
    const startedAt = Date.now();
    let lastAt: number | null = null;   // this spawn's last fragment
    this.initSegment = null;
    this.ring = [];
    this.parser = new FragmentedMp4Parser(
      (segment) => {
        this.initSegment = segment;
        this.log.debug(`prebuffer init segment ready (${segment.length} bytes)`);
      },
      (fragment) => { lastAt = Date.now(); this.onFragment(fragment); },
    );

    const ff = spawnFfmpeg(ffmpegPath, args, this.log, {
      label: `prebuffer:${this.camera.name}`,
    });
    this.ffmpeg = ff;
    this.log.info(
      `prebuffer running (${this.camera.prebufferSeconds}s window, video ${
        this.camera.copyVideo ? "copy" : "transcode"
      }, reading ${readsFrom(feed.via)})`,
    );

    ff.proc.stdout.on("data", (chunk: Buffer) => {
      try {
        this.parser?.push(chunk);
      } catch (err) {
        this.log.error(`prebuffer parse error: ${(err as Error).message}`);
      }
    });

    void ff.done.then((code) => {
      if (this.ffmpeg === ff) {
        this.ffmpeg = null;
        this.initSegment = null;
        // Restart if we still want to be running (camera dropped, network blip).
        if (this.wantRunning) {
          const now = Date.now();
          const why = prebufferExitReason(code, feed, now - startedAt, lastAt === null ? null : now - lastAt);
          this.log.warn(`prebuffer ffmpeg exited (code ${code}) while reading ${readsFrom(feed.via)}: ${why}; restarting in 5s`);
          try { this.onFailure?.(feed, why); }
          catch (err) { this.log.error(`couldn't report the prebuffer failure to the source selector (the restart still happens): ${(err as Error).message}`); }
          this.scheduleRestart();
        }
      }
    });
  }

  private scheduleRestart(): void {
    if (this.restartTimer) {
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wantRunning && !this.ffmpeg) {
        void this.start();
      }
    }, 5000);
  }

  private onFragment(fragment: Buffer): void {
    const now = Date.now();
    this.lastFragmentAt = now;
    this.ring.push({ data: fragment, ts: now });
    // Prune anything older than keepMs.
    const cutoff = now - this.keepMs;
    while (this.ring.length > 0 && this.ring[0].ts < cutoff) {
      this.ring.shift();
    }
    // Fan out to live subscribers (active recordings).
    for (const sub of this.liveSubscribers) {
      try {
        sub(fragment);
      } catch (err) {
        this.log.error(`live subscriber error: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Snapshot the prebuffer and open a live subscription for a new recording.
   * Returns null if the init segment isn't ready yet (camera unreachable).
   */
  openSession(): PrebufferSession | null {
    if (!this.initSegment) {
      return null;
    }
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const prebufferedFragments = this.ring
      .filter((f) => f.ts >= windowStart)
      .map((f) => f.data);

    return {
      initSegment: this.initSegment,
      prebufferedFragments,
      subscribeLive: (cb: LiveSubscriber) => {
        this.liveSubscribers.add(cb);
        return () => {
          this.liveSubscribers.delete(cb);
        };
      },
    };
  }
}
