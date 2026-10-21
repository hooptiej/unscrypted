import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { AddressInfo } from "net";
import { parseStreams, nextFeed, Go2rtcWatcher } from "../../src/admin/go2rtcWatch";
import { Go2rtcClient, producerErrorFromLine } from "../../src/admin/go2rtc";
import { Logger, setLogLevel } from "../../src/logger";

setLogLevel("error");
// Shape seen on prod 0.3.0 (2026-10-20): connected producers carry remote_addr + bytes_recv, idle ones only a url.
const sample = (bytes: number | null, consumers = 1) => ({
  garagecamtest: { producers: [bytes === null ? { url: "rtsp://u:p@h/11" } : { url: "rtsp://u:p@h/11", remote_addr: "10.0.1.3:554", bytes_recv: bytes }],
    consumers: Array.from({ length: consumers }, () => ({ type: "webrtc" })) },
});

test("parseStreams keeps only counts and byte totals, never URLs", () => {
  const m = parseStreams(sample(1234, 2));
  assert.deepEqual(m.get("garagecamtest"), { consumers: 2, connected: true, bytes: 1234 });
  assert.ok(!JSON.stringify([...m]).includes("rtsp://"));
  assert.deepEqual(parseStreams(sample(null, 0)).get("garagecamtest"), { consumers: 0, connected: false, bytes: null });
  assert.equal(parseStreams("nonsense").size, 0);
  assert.equal(parseStreams(null).size, 0);
});

test("feed states: streaming, stalled after 10 s without bytes, idle, starting then down with the reason", () => {
  let r = nextFeed(undefined, { consumers: 1, connected: true, bytes: 100 }, 0, true, null);
  r = nextFeed(r, { consumers: 1, connected: true, bytes: 200 }, 5000, true, null);
  assert.equal(r.feed.state, "streaming"); assert.equal(r.feed.lastVideoAt, 5000);
  r = nextFeed(r, { consumers: 1, connected: true, bytes: 200 }, 10_000, true, null);
  assert.equal(r.feed.state, "streaming", "5 s without new bytes is still streaming");
  r = nextFeed(r, { consumers: 1, connected: true, bytes: 200 }, 15_000, true, null);
  assert.equal(r.feed.state, "stalled"); assert.match(r.feed.reason!, /stopped sending video/);
  r = nextFeed(r, { consumers: 0, connected: false, bytes: null }, 20_000, true, null);
  assert.equal(r.feed.state, "idle"); assert.equal(r.feed.lastVideoAt, 5000);
  r = nextFeed(r, { consumers: 1, connected: false, bytes: null }, 25_000, true, "EOF");
  assert.equal(r.feed.state, "starting");
  r = nextFeed(r, { consumers: 1, connected: false, bytes: null }, 35_000, true, "dial tcp 10.0.1.3:554: connect: connection refused");
  assert.equal(r.feed.state, "down"); assert.match(r.feed.reason!, /refused/); assert.equal(r.feed.since, 35_000);
  r = nextFeed(r, undefined, 40_000, false, null);
  assert.equal(r.feed.state, "unknown"); assert.match(r.feed.reason!, /go2rtc is down/);
});

test("producer error lines are parsed from masked go2rtc log lines", () => {
  const line = 'INF 19:24:21.191 WRN github.com/AlexxIT/go2rtc/internal/streams/producer.go:170 > error="read tcp 10.0.1.78:42954->10.0.1.3:554: i/o timeout" url=rtsp://admin:***@10.0.1.3:554/11#media=video';
  assert.deepEqual(producerErrorFromLine(line), { error: "read tcp 10.0.1.78:42954->10.0.1.3:554: i/o timeout", url: "rtsp://admin:***@10.0.1.3:554/11" });
  assert.deepEqual(producerErrorFromLine("WRN x/producer.go:170 > error=EOF url=rtsp://h/1#backchannel=0"), { error: "EOF", url: "rtsp://h/1" });
  assert.equal(producerErrorFromLine("INF something else"), null);
});

test("watcher: healthy only when the supervisor runs, the API answers and the RTSP port accepts", async () => {
  const api = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(sample(10))); });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  const rtsp = http.createServer(); // any listener stands in for go2rtc's RTSP accept
  await new Promise<void>((r) => rtsp.listen(0, "127.0.0.1", () => r()));
  const seen: any[] = [];
  let state = "running";
  const w = new Go2rtcWatcher({ client: new Go2rtcClient(`http://127.0.0.1:${(api.address() as AddressInfo).port}`, 3000),
    rtspPort: (rtsp.address() as AddressInfo).port, supervisor: () => ({ state, since: 42 } as any), lastError: () => null,
    log: new Logger("t"), onHealth: (h) => seen.push(h) });
  try {
    await w.tick();
    assert.equal(seen.at(-1).apiOk && seen.at(-1).rtspOk && seen.at(-1).supervisor === "running", true);
    assert.equal(seen.at(-1).startedAt, 42);
    assert.equal(w.feeds().get("garagecamtest")!.state, "starting"); // first sample: no growth seen yet
    state = "backoff";
    await w.tick();
    assert.equal(seen.at(-1).supervisor, "backoff");
    assert.equal(seen.at(-1).startedAt, null);
    assert.match(seen.at(-1).error, /isn't running/);
    rtsp.close();
    state = "running";
    await w.tick();
    assert.equal(seen.at(-1).rtspOk, false);
    assert.match(seen.at(-1).error, /RTSP/);
  } finally { api.close(); rtsp.close(); }
});

test("watcher: a dead API is unhealthy, feeds turn unknown, and removed cameras drop out", async () => {
  let body: unknown = { ...sample(10), check_abcd: { producers: [], consumers: [{}] }, oldcam: { producers: [], consumers: [] } };
  const api = http.createServer((req, res) => { res.end(JSON.stringify(body)); });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  const seen: any[] = [];
  const port = (api.address() as AddressInfo).port;
  const w = new Go2rtcWatcher({ client: new Go2rtcClient(`http://127.0.0.1:${port}`, 3000), rtspPort: null,
    supervisor: () => ({ state: "running", since: 1 } as any), lastError: () => null, known: () => new Set(["garagecamtest"]),
    log: new Logger("t"), onHealth: (h) => seen.push(h) });
  try {
    await w.tick();
    assert.ok(!w.feeds().has("check_abcd"), "feed-check temp streams aren't cameras");
    assert.ok(w.feeds().has("oldcam"), "still in go2rtc: kept");
    body = sample(20);
    await w.tick();
    assert.ok(!w.feeds().has("oldcam"), "gone from go2rtc and the camera list: dropped");
    api.close();
    await new Promise((r) => setTimeout(r, 50));
    await w.tick();
    assert.equal(seen.at(-1).apiOk, false);
    assert.match(seen.at(-1).error, /API didn't answer/);
    assert.equal(w.feeds().get("garagecamtest")!.state, "unknown");
  } finally { api.close(); }
});

test("watcher: health carries go2rtc's view of each stream (state and its last producer error, explained), so outages can be told apart", async () => {
  const api = http.createServer((req, res) => { res.end(JSON.stringify(sample(10))); });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  const seen: any[] = [];
  const w = new Go2rtcWatcher({ client: new Go2rtcClient(`http://127.0.0.1:${(api.address() as AddressInfo).port}`, 3000), rtspPort: null,
    supervisor: () => ({ state: "running", since: 1 } as any),
    lastError: (s) => (s === "garagecamtest" ? { error: "dial tcp 10.0.1.3:554: i/o timeout", at: 1234 } : null),
    log: new Logger("t"), onHealth: (h) => seen.push(h) });
  try {
    await w.tick();
    const v = seen.at(-1).streams.garagecamtest;
    assert.equal(v.state, w.feeds().get("garagecamtest")!.state);
    assert.equal(v.errorAt, 1234);
    assert.equal(v.error, "The camera didn't answer at that address.");
    assert.ok(!JSON.stringify(seen.at(-1).streams).includes("10.0.1.3"), "no addresses in the view");
    api.close();
    await new Promise((r) => setTimeout(r, 50));
    await w.tick();
    assert.equal(seen.at(-1).streams, undefined, "no view when go2rtc's API didn't answer");
  } finally { api.close(); }
});
