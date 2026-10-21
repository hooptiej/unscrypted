import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLiveInputArgs, buildLiveVideoCodecArgs, buildSnapshotArgs, StreamingDelegate } from "../src/streamingDelegate";
import { Logger, setLogLevel } from "../src/logger";

setLogLevel("error");

test("live view and snapshot read the chosen feed over TCP with a socket timeout", () => {
  const f = { url: "rtsp://127.0.0.1:8554/garagecamtest", via: "go2rtc" as const };
  assert.deepEqual(buildLiveInputArgs(f), ["-hide_banner", "-loglevel", "warning", "-rtsp_transport", "tcp", "-timeout", "10000000",
    "-i", f.url]);
  const s = buildSnapshotArgs(f, 640, 360);
  assert.equal(s[s.indexOf("-i") + 1], f.url);
  assert.deepEqual(s.slice(s.indexOf("-timeout"), s.indexOf("-timeout") + 2), ["-timeout", "10000000"]);
  assert.ok(s.includes("scale=640:360:force_original_aspect_ratio=decrease"));
});

test("0.4.3: live view and snapshots use ffmpeg's default input analysis (a tiny probe broke Couch Cam's Foscam on prod)", () => {
  const f = { url: "rtsp://127.0.0.1:8554/cam", via: "camera" as const };
  for (const a of [buildLiveInputArgs(f), buildSnapshotArgs(f, 640, 360)]) {
    assert.ok(!a.includes("-analyzeduration"), "no -analyzeduration override");
    assert.ok(!a.includes("-probesize"), "no -probesize override");
  }
});

test("0.4.3: a copied live view is a plain copy (dump_extra held back until checked on real cameras)", () => {
  assert.deepEqual(buildLiveVideoCodecArgs(true, 30, 300), ["-an", "-c:v", "copy"]);
  const t = buildLiveVideoCodecArgs(false, 15, 299);
  assert.ok(!t.includes("dump_extra"));
  assert.deepEqual(t.slice(t.indexOf("-r"), t.indexOf("-r") + 4), ["-r", "15", "-b:v", "299k"]);
  assert.equal(t[t.indexOf("-c:v") + 1], "libx264");
});

test("snapshots: one ffmpeg for requests that overlap, a 10 s cache per size, failures not cached", async () => {
  const sd = new StreamingDelegate({ name: "Cam", rtspMain: "rtsp://u:p@h/11" } as any, "ffmpeg", new Logger("t"));
  let runs = 0; let fail = false;
  (sd as any).snapshotNow = async () => { runs++; await new Promise((r) => setTimeout(r, 20)); if (fail) throw new Error("no"); return Buffer.from(`jpeg${runs}`); };
  const req = { width: 640, height: 360 } as any;
  const [a, b] = await Promise.all([(sd as any).takeSnapshot(req), (sd as any).takeSnapshot(req)]);
  assert.equal(runs, 1); assert.equal(a.toString(), "jpeg1"); assert.equal(b.toString(), "jpeg1");
  assert.equal((await (sd as any).takeSnapshot(req)).toString(), "jpeg1", "cached");
  await (sd as any).takeSnapshot({ width: 320, height: 240 });
  assert.equal(runs, 2, "another size is its own entry");
  (sd as any).snapCache.clear(); fail = true;
  await assert.rejects((sd as any).takeSnapshot(req));
  fail = false;
  assert.equal((await (sd as any).takeSnapshot(req)).toString(), "jpeg4", "the failure wasn't cached");
});

test("a failed snapshot is reported with where it read from (the selector counts only go2rtc reads)", async () => {
  const seen: string[] = [];
  const sd = new StreamingDelegate({ name: "Cam", rtspMain: "rtsp://u:p@h/11" } as any, process.execPath, new Logger("t"),
    () => ({ url: "rtsp://127.0.0.1:1/cam", via: "go2rtc" }), (feed, why) => seen.push(`${feed.via}: ${why}`));
  (sd as any).runToBuffer = async () => { throw new Error("snapshot produced no output (exit 1)"); };
  await assert.rejects((sd as any).readSnapshot("ffmpeg", { url: "rtsp://127.0.0.1:1/cam", via: "go2rtc" }, { width: 1, height: 1 }), /reading through go2rtc failed/);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^go2rtc: snapshot reading through go2rtc failed/);
});
