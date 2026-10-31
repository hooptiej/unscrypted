import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapshotServer, ProbeMemory, Capture } from "../src/snapshots";
import { captureSnapshotJpeg, FfmpegRunError } from "../src/streamingDelegate";
import { watchConnectionCloses, closingConnection } from "../src/hapEventHold";
import { Logger } from "../src/logger";

function recorder(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const at = (lvl: string) => (m: string) => lines.push(`${lvl} ${m}`);
  return { log: { info: at("info"), warn: at("warn"), error: at("error"), debug: () => undefined } as unknown as Logger, lines };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jpeg = (s: string) => Buffer.from(s);
const real = (s: string): Capture => ({ jpeg: jpeg(s), real: true, from: "through go2rtc" });

function server(capture: () => Promise<Capture>, deadlineMs = 60) {
  const r = recorder();
  const placeholders: string[] = [];
  const s = new SnapshotServer({
    name: "Cam", log: r.log, deadlineMs, capture,
    placeholder: async (why) => { placeholders.push(why); return jpeg(`card:${why}`); },
  });
  return { s, ...r, placeholders };
}

test("#99: a fresh snapshot inside the deadline is served, and its time is logged", async () => {
  const { s, lines } = server(async () => real("A"));
  assert.equal((await s.get()).toString(), "A");
  assert.match(lines.join("\n"), /info snapshot through go2rtc: fresh in \d+ ms/);
});

test("#99: a late snapshot is answered with the last good image (any age), says so, and the late one refreshes it", async () => {
  let n = 0;
  const { s, lines } = server(async () => { n++; if (n === 1) return real("old"); await sleep(150); return real("new"); });
  assert.equal((await s.get()).toString(), "old");
  const t0 = Date.now();
  assert.equal((await s.get()).toString(), "old", "late capture: the last good image");
  assert.ok(Date.now() - t0 < 140, "answered at the deadline, not when the capture finished");
  assert.match(lines.join("\n"), /warn snapshot: no fresh picture within 60 ms .*served the last good image from \d+ s ago/);
  await sleep(150);
  assert.match(lines.join("\n"), /the late capture finished after \d+ ms; the next snapshot uses it/);
  assert.equal((await s.get()).toString(), "new", "still slow: now the refreshed image is the one served");
});

test("#99: late with no earlier picture serves the 'camera slow' card, never silence", async () => {
  const { s, lines, placeholders } = server(async () => { await sleep(150); return real("late"); });
  assert.equal((await s.get()).toString(), "card:camera slow to answer");
  assert.deepEqual(placeholders, ["camera slow to answer"]);
  assert.match(lines.join("\n"), /no earlier picture yet; served the "camera slow" card/);
  await sleep(150);
  assert.equal(s.lastGoodAgeMs() !== null, true, "the late capture became the last good image");
});

test("#99: requests during a slow capture share it instead of piling up ffmpeg runs", async () => {
  let runs = 0;
  const { s } = server(async () => { runs++; await sleep(100); return real("x"); }, 500);
  const out = await Promise.all([s.get(), s.get(), s.get()]);
  assert.equal(runs, 1);
  assert.deepEqual(out.map(String), ["x", "x", "x"]);
});

test("#99: a capture that comes back as a placeholder (camera down) is served and logged, and doesn't replace the last good image", async () => {
  let down = false;
  const { s, lines } = server(async () => (down ? { jpeg: jpeg("card:unreachable"), real: false, from: "the camera directly", reason: "camera unreachable" } : real("good")));
  await s.get();
  down = true;
  assert.equal((await s.get()).toString(), "card:unreachable");
  assert.match(lines.join("\n"), /warn snapshot the camera directly: no picture \(camera unreachable\)/);
  down = false;
});

test("#99: if even the placeholder fails, an earlier picture beats an error; with none, the error surfaces", async () => {
  let fail = false;
  const { s } = server(async () => { if (fail) throw new Error("ffmpeg unavailable"); return real("good"); });
  await s.get();
  fail = true;
  assert.equal((await s.get()).toString(), "good");
  const bare = server(async () => { throw new Error("ffmpeg unavailable"); });
  await assert.rejects(bare.s.get(), /ffmpeg unavailable/);
});

test("#99: probe memory goes full only on a proven late camera, and expires", () => {
  let now = 0;
  const { log, lines } = recorder();
  const p = new ProbeMemory("Couch", log, () => now, 1000);
  assert.equal(p.mode, "fast");
  p.missedDuringOutage("snapshot");
  assert.equal(p.mode, "fast", "an outage changes nothing");
  p.learnedLate("snapshot");
  assert.equal(p.mode, "full");
  now = 999;
  assert.equal(p.mode, "full");
  now = 1000;
  assert.equal(p.mode, "fast", "expired: the fast probe gets another look");
  assert.match(lines.join("\n"), /both failed .*not a late camera, so the probe stays fast/);
  assert.match(lines.join("\n"), /use full probing for the next 0 min/);
  assert.match(lines.join("\n"), /trying the fast probe again/);
});

test("#99: a fast-probe miss is 'late' only when the full retry works, 'outage' when it fails too", async () => {
  const { log } = recorder();
  const miss = new FfmpegRunError("snapshot produced no output (exit 1)", 1, "Output file #0 does not contain any stream");
  const outcomes: string[] = [];
  const late = async (_f: string, args: string[]) => { if (args.includes("-probesize")) throw miss; return jpeg("frame"); };
  assert.equal((await captureSnapshotJpeg("ffmpeg", "rtsp://x", 640, 360, log, "fast", (o) => outcomes.push(o), late as never)).toString(), "frame");
  const down = async () => { throw miss; };
  await assert.rejects(captureSnapshotJpeg("ffmpeg", "rtsp://x", 640, 360, log, "fast", (o) => outcomes.push(o), down as never));
  assert.deepEqual(outcomes, ["late", "outage"]);
});

test("#99: a STOP issued while a controller's connection is closing names that controller; a plain STOP doesn't", () => {
  const { log } = recorder();
  const seen: (string | undefined)[] = [];
  const proto = { remoteAddress: "", onTCPSocketClose() { seen.push(closingConnection()); } };
  assert.equal(watchConnectionCloses(proto, log), true);
  const conn = Object.assign(Object.create(proto), { remoteAddress: "10.0.1.219" });
  conn.onTCPSocketClose();
  assert.deepEqual(seen, ["10.0.1.219"]);
  assert.equal(closingConnection(), undefined, "cleared once the close has run");
});
