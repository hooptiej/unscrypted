import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnFfmpeg } from "../src/ffmpeg";
import { Logger, setLogLevel } from "../src/logger";

// A password with both '@' and '/', the nastiest shape for a URL masker.
const PASSWORD = "p@ss/word";
const URL_LINE = `rtsp://admin:${PASSWORD}@10.0.0.1/x`;

test("spawnFfmpeg never logs the camera password: arg line, stderr, WARN tail, stderrTail()", async () => {
  const lines: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  const capture = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = capture;
  console.error = capture;
  setLogLevel("debug");
  let tail = "";
  try {
    // The real node binary stands in for ffmpeg: it prints the credentialed URL on stderr and fails.
    const f = spawnFfmpeg(
      process.execPath,
      ["-e", `console.error(${JSON.stringify(`${URL_LINE}: Connection timed out`)}); process.exit(1)`, "--", "-i", URL_LINE],
      new Logger("test"),
      { label: "probe", logStderr: true },
    );
    const code = await f.done;
    tail = f.stderrTail();
    assert.equal(code, 1);
  } finally {
    console.log = realLog;
    console.error = realErr;
    setLogLevel("error");
  }
  const all = lines.join("\n");
  assert.ok(lines.some((l) => l.includes("spawn probe")), "the arg line was logged");
  assert.ok(lines.some((l) => l.includes("Connection timed out") && l.includes("[DEBUG]")), "the stderr debug line was logged");
  assert.ok(lines.some((l) => l.includes("[WARN]") && l.includes("Last stderr")), "the WARN tail was logged");
  assert.ok(!all.includes(PASSWORD), `password leaked into the log:\n${all}`);
  assert.ok(!all.includes("ss/word"), "no fragment of the password leaked");
  assert.ok(!tail.includes(PASSWORD), "stderrTail() leaked the password");
  assert.match(tail, /rtsp:\/\/admin:\*\*\*@10\.0\.0\.1\/x: Connection timed out/);
});
