// The recording buffer against a fake ffmpeg that writes real fMP4 box framing to stdout: the stall
// watchdog (#10) and what happens to a clip when the buffer restarts under it (#41).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prebuffer, PrebufferOptions, PREBUFFER_STALL_MS, PREBUFFER_RESTART_DELAY_MS } from "../src/prebuffer";
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
