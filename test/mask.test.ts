import { test } from "node:test";
import assert from "node:assert/strict";
import { maskSecrets, redactCgi, redactUrl } from "../src/util";
import { maskSecretsInLine, lineMasker, splitLines } from "../src/admin/go2rtc";
import { Logger, parseLogLevel, setLogLevel } from "../src/logger";

test("maskSecrets: URL passwords, including '@' and '/' inside the password", () => {
  const cases: Array<[string, string]> = [
    ["rtsp://admin:hunter2@10.0.0.1:554/11", "rtsp://admin:***@10.0.0.1:554/11"],
    ["rtsp://admin:p@ss/word@10.0.0.1/x: Connection timed out", "rtsp://admin:***@10.0.0.1/x: Connection timed out"],
    ["rtsp://admin:a/b@c@10.0.0.1/x", "rtsp://admin:***@10.0.0.1/x"],
    ["http://u:pw@h/p and rtsp://admin:other@10.0.0.2/y", "http://u:***@h/p and rtsp://admin:***@10.0.0.2/y"],
    ["a: rtsp://x:one@h1/a b: rtsp://y:two@h2/b", "a: rtsp://x:***@h1/a b: rtsp://y:***@h2/b"],
    ["http://10.0.0.1/cgi-bin/CGIProxy.fcgi?cmd=getDevState&usr=admin&pwd=s3cret&x=1", "http://10.0.0.1/cgi-bin/CGIProxy.fcgi?cmd=getDevState&usr=***&pwd=***&x=1"],
  ];
  for (const [input, want] of cases) assert.equal(maskSecrets(input), want);
});

test("maskSecrets: text with no credentials is untouched", () => {
  for (const t of ["rtsp://10.0.0.1:554/11", "http://example.com/path?a=1&b=2", "ffmpeg exited with code 1", "", "user@host and 10.0.0.1:554"]) {
    assert.equal(maskSecrets(t), t);
  }
});

test("redactUrl, redactCgi and maskSecretsInLine are the same masker", () => {
  const u = "rtsp://admin:p@ss@10.0.0.1/x";
  assert.equal(redactUrl(u), "rtsp://admin:***@10.0.0.1/x");
  assert.equal(maskSecretsInLine(u), redactUrl(u));
  assert.equal(redactCgi("http://h/c?cmd=a&usr=bob&pwd=pw"), "http://h/c?cmd=a&usr=***&pwd=***");
});

test("go2rtc line buffer: a URL split across chunks is masked once whole", () => {
  const out: string[] = [];
  const lm = lineMasker((l) => out.push(l));
  lm.push("INF dial rtsp://us");
  assert.deepEqual(out, [], "a partial line is held back");
  lm.push("er:pw@10.0.0.1/11 failed\nsecond ");
  assert.deepEqual(out, ["INF dial rtsp://user:***@10.0.0.1/11 failed"]);
  lm.push("line\r\nthird, no newline yet rtsp://a:b@h");
  lm.flush();
  assert.deepEqual(out, [
    "INF dial rtsp://user:***@10.0.0.1/11 failed",
    "second line",
    "third, no newline yet rtsp://a:***@h",
  ]);
  assert.ok(!out.join("\n").includes("pw@"));
});

test("splitLines: holds back the partial tail, drops blank lines, handles CRLF", () => {
  assert.deepEqual(splitLines("", "a\nb\r\n\nc"), { lines: ["a", "b"], tail: "c" });
  assert.deepEqual(splitLines("par", "tial\n"), { lines: ["partial"], tail: "" });
});

test("parseLogLevel: valid levels pass, unknown falls back to info and warns once naming the value", () => {
  assert.equal(parseLogLevel("debug"), "debug");
  assert.equal(parseLogLevel("WARN"), "warn");
  assert.equal(parseLogLevel(undefined), "info");
  assert.equal(parseLogLevel(""), "info");

  const seen: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
  try {
    assert.equal(parseLogLevel("verbose"), "info");
  } finally {
    console.error = realErr;
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0], /"verbose"/);
  assert.match(seen[0], /WARN/);
});

test("setLogLevel validates: a bad level leaves logging at info instead of silencing or flooding it", () => {
  const realErr = console.error;
  const realLog = console.log;
  const seen: string[] = [];
  console.error = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
  try {
    setLogLevel("verbose" as never);
    const l = new Logger("t");
    l.debug("hidden-debug");
    l.info("shown-info");
  } finally {
    console.error = realErr;
    console.log = realLog;
    setLogLevel("error");
  }
  const all = seen.join("\n");
  assert.match(all, /"verbose"/);
  assert.match(all, /shown-info/);
  assert.doesNotMatch(all, /hidden-debug/);
});
