// The recording buffer against a fake ffmpeg that writes real fMP4 box framing to stdout: the stall
// watchdog (#10) and what happens to a clip when the buffer restarts under it (#41). The clip side is
// the real RecordingDelegate; only HomeKit (the generator's consumer) is played by the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prebuffer, PrebufferOptions, PREBUFFER_STALL_MS, PREBUFFER_RESTART_DELAY_MS } from "../src/prebuffer";
import { RecordingPacket } from "hap-nodejs";
import { RecordingDelegate } from "../src/recordingDelegate";
import { Logger, setLogLevel } from "../src/logger";
import { FeedChoice } from "../src/source";
import { captureLogs, fakeCamera, fakeFfmpeg, until } from "./helpers/fakes";

setLogLevel("error");

/**
 * A fake ffmpeg script: an init segment (ftyp+moov) tagged `tag`, then `count` fragments every `everyMs`
 * (each moof carries "<tag>-<n>"), then `after`: "stall" keeps running silently, "exit" exits 1.
 */
function fmp4(tag: string, count: number, everyMs: number, after: "stall" | "exit"): string {
  return `
    const box = (t, s) => { const p = Buffer.from(s); const b = Buffer.alloc(8 + p.length); b.writeUInt32BE(8 + p.length, 0); b.write(t, 4, "ascii"); p.copy(b, 8); return b; };
    process.stdout.write(Buffer.concat([box("ftyp", "${tag}"), box("moov", "${tag}")]));
    let i = 0;
    const t = setInterval(() => {
      if (i < ${count}) { process.stdout.write(Buffer.concat([box("moof", "${tag}-" + i), box("mdat", "x")])); i++; return; }
      ${after === "exit" ? "process.exit(1);" : "clearInterval(t); setInterval(() => {}, 1000);"}
    }, ${everyMs});`;
}

function buffer(ff: ReturnType<typeof fakeFfmpeg>, opts: PrebufferOptions = {}, failures: string[] = []): Prebuffer {
  return new Prebuffer(fakeCamera(), "fake-ffmpeg", new Logger("test"), undefined,
    (_feed: FeedChoice, why: string) => { failures.push(why); }, { ffmpeg: ff, restartDelayMs: 50, ...opts });
}

test("#10: the production stall limit is 15 s and the restart delay 5 s", () => {
  assert.equal(PREBUFFER_STALL_MS, 15_000);
  assert.equal(PREBUFFER_RESTART_DELAY_MS, 5_000);
});

test("#10: a buffer whose ffmpeg keeps running but stops sending fragments is restarted, with a WARN", async () => {
  const ff = fakeFfmpeg(fmp4("A", 2, 20, "stall"), fmp4("B", 1000, 20, "stall"));
  const failures: string[] = [];
  const pb = buffer(ff, { stallMs: 300 }, failures);
  const logs = captureLogs();
  try {
    await pb.start();
    await until(() => ff.calls.length === 2, "a second ffmpeg after the stall", 5000);
    await until(() => pb.isRunning() && pb.hasInit(), "the restarted buffer producing again");
    const warns = logs.warns();
    assert.ok(warns.some((l) => /prebuffer stalled while reading the camera directly: ffmpeg was still running but sent no new video for \d+ s \(it had stalled\); stopping it so it restarts/.test(l)), warns.join("\n"));
    assert.ok(warns.some((l) => /prebuffer ffmpeg exited .*it had stalled.*restarting in/.test(l)), warns.join("\n"));
    assert.equal(failures.length, 1, "the stall was reported to the source selector once");
  } finally {
    pb.stop();
    logs.restore();
  }
});

test("#10: a buffer that never produces a fragment after connecting counts as stalled too", async () => {
  const ff = fakeFfmpeg(fmp4("A", 0, 20, "stall"), fmp4("B", 1000, 20, "stall"));
  const pb = buffer(ff, { stallMs: 300 });
  const logs = captureLogs();
  try {
    await pb.start();
    await until(() => ff.calls.length === 2, "a second ffmpeg after the silent one", 5000);
    assert.ok(logs.warns().some((l) => l.includes("sent no video in") && l.includes("it connected, nothing came through")), logs.lines.join("\n"));
  } finally {
    pb.stop();
    logs.restore();
  }
});

test("#10: a buffer that keeps producing is left alone", async () => {
  const ff = fakeFfmpeg(fmp4("A", 1000, 20, "stall"));
  const pb = buffer(ff, { stallMs: 300 });
  const logs = captureLogs();
  try {
    await pb.start();
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(ff.calls.length, 1, "it was restarted although fragments kept coming");
    assert.ok(!logs.lines.some((l) => l.includes("stalled")), logs.lines.join("\n"));
  } finally {
    pb.stop();
    logs.restore();
  }
});

/** Pull a clip to the end in the background; `packets` fills as it goes. */
function drain(gen: AsyncGenerator<RecordingPacket>): { packets: string[]; done: Promise<void> } {
  const packets: string[] = [];
  const done = (async () => { for await (const p of gen) packets.push(p.data.toString("latin1")); })();
  return { packets, done };
}

test("#41: the buffer's ffmpeg exiting mid-clip ends the clip with a WARN naming it; the respawn's fragments never reach it", async () => {
  const ff = fakeFfmpeg(fmp4("AAA", 20, 30, "exit"), fmp4("BBB", 1000, 30, "stall"));
  const pb = buffer(ff);
  const rd = new RecordingDelegate(fakeCamera(), pb, new Logger("test"));
  const logs = captureLogs();
  try {
    rd.updateRecordingActive(true);
    const clip = drain(rd.handleRecordingStreamRequest(30, new AbortController().signal));
    await until(() => clip.packets.length >= 3, "the clip under way");
    assert.equal(rd.activeClips(), 1);
    await clip.done;   // the generator returns by itself when ffmpeg A exits
    assert.equal(rd.activeClips(), 0);
    assert.ok(clip.packets[0].includes("AAA"), "the clip started with A's init segment");
    assert.ok(logs.warns().some((l) =>
      /recording buffer stopped \(its ffmpeg exited: .*\) while clip 30 was being sent to HomeKit; the clip ends here/.test(l)), logs.warns().join("\n"));
    // The buffer respawns and B produces; none of it may land in clip 30.
    await until(() => ff.calls.length === 2 && pb.hasInit(), "the respawned ffmpeg producing");
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(clip.packets.every((p) => !p.includes("BBB")), `a fragment from the new ffmpeg reached the old clip: ${clip.packets.join(" | ")}`);
    assert.ok(logs.lines.some((l) => l.includes("recording stream 30 finished") && l.includes("because the recording buffer stopped under it")), logs.lines.join("\n"));
  } finally {
    rd.updateRecordingActive(false);
    logs.restore();
  }
});

test("#41: HomeKit switching recording off mid-clip ends the clip, saying why", async () => {
  const ff = fakeFfmpeg(fmp4("AAA", 1000, 30, "stall"));
  const pb = buffer(ff);
  const rd = new RecordingDelegate(fakeCamera(), pb, new Logger("test"));
  const logs = captureLogs();
  try {
    rd.updateRecordingActive(true);
    const clip = drain(rd.handleRecordingStreamRequest(31, new AbortController().signal));
    await until(() => clip.packets.length >= 3, "the clip under way");
    rd.updateRecordingActive(false);
    await clip.done;
    assert.equal(rd.activeClips(), 0);
    assert.ok(logs.warns().some((l) => l.includes("recording buffer stopped (HomeKit switched recording off) while clip 31 was being sent")), logs.warns().join("\n"));
  } finally {
    logs.restore();
  }
});

test("#41: a buffer exit with no clip open logs no clip WARN", async () => {
  const ff = fakeFfmpeg(fmp4("AAA", 3, 20, "exit"), fmp4("BBB", 1000, 30, "stall"));
  const pb = buffer(ff);
  const logs = captureLogs();
  try {
    await pb.start();
    await until(() => ff.calls.length === 2, "the respawn");
    assert.ok(!logs.lines.some((l) => l.includes("was being sent to HomeKit")), logs.lines.join("\n"));
  } finally {
    pb.stop();
    logs.restore();
  }
});

test("#10: stop() ends the watchdog with the buffer (no restart afterwards)", async () => {
  const ff = fakeFfmpeg(fmp4("A", 1, 20, "stall"));
  const pb = buffer(ff, { stallMs: 200 });
  await pb.start();
  await until(() => pb.hasInit(), "the init segment");
  pb.stop();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(ff.calls.length, 1);
  assert.equal(pb.isRunning(), false);
});
