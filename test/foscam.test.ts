// #47: the Foscam CGI motion poller, against a fake camera's CGI on localhost.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { AddressInfo } from "net";
import { FoscamClient, MotionPoller } from "../src/foscam";
import { Logger, setLogLevel } from "../src/logger";
import { captureLogs, until } from "./helpers/fakes";

setLogLevel("error");

/** What the fake CGI answers next: a motionDetectAlarm value, or an HTTP error status. */
let answer: { alarm?: number; status?: number } = { alarm: 1 };
const seen: URL[] = [];
const cgi = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  seen.push(u);
  if (answer.status) {
    res.writeHead(answer.status);
    res.end("nope");
    return;
  }
  res.writeHead(200, { "content-type": "text/xml" });
  res.end(`<CGI_Result><result>0</result><IOAlarm>0</IOAlarm>` +
    (answer.alarm === undefined ? "" : `<motionDetectAlarm>${answer.alarm}</motionDetectAlarm>`) + `</CGI_Result>`);
});
const ready = new Promise<string>((r) => cgi.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(cgi.address() as AddressInfo).port}`)));
after(() => cgi.close());

const client = async (password = "p&ss word") => new FoscamClient({ cgiBase: await ready, username: "admin", password, timeoutMs: 1000 });

test("the CGI URL carries the command and URL-encoded credentials", async () => {
  const c = await client();
  const u = new URL(c.buildUrl("getDevState"));
  assert.equal(u.pathname, "/cgi-bin/CGIProxy.fcgi");
  assert.equal(u.searchParams.get("cmd"), "getDevState");
  assert.equal(u.searchParams.get("usr"), "admin");
  assert.equal(u.searchParams.get("pwd"), "p&ss word");
});

test("readField reads flat XML fields and says undefined when one is missing", () => {
  assert.equal(FoscamClient.readField("<a><motionDetectAlarm>2</motionDetectAlarm></a>", "motionDetectAlarm"), "2");
  assert.equal(FoscamClient.readField("<a><MOTIONDETECTALARM>1</MOTIONDETECTALARM></a>", "motionDetectAlarm"), "1");
  assert.equal(FoscamClient.readField("<a></a>", "motionDetectAlarm"), undefined);
});

test("getMotionState reads motionDetectAlarm, undefined when absent, and an HTTP error throws without the password", async () => {
  const c = await client("hunter2");
  answer = { alarm: 2 };
  assert.equal(await c.getMotionState(), 2);
  answer = {};
  assert.equal(await c.getMotionState(), undefined);
  answer = { status: 500 };
  await assert.rejects(c.getMotionState(), (err: Error) => {
    assert.match(err.message, /HTTP 500/);
    assert.ok(!err.message.includes("hunter2"), `password in the error: ${err.message}`);
    return true;
  });
});

test("poller: motion on -> one ON however many alarms; alarms stop -> OFF after the cooldown", async () => {
  const c = await client();
  answer = { alarm: 2 };
  const edges: boolean[] = [];
  const p = new MotionPoller(c, { pollIntervalMs: 10, cooldownMs: 150 }, (a) => edges.push(a), new Logger("test"));
  p.start();
  try {
    const before = seen.length;
    await until(() => seen.length >= before + 5, "five polls with motion");
    assert.deepEqual(edges, [true], "only one ON edge while the alarm stays up");
    answer = { alarm: 1 };
    await until(() => edges.length === 2, "the OFF edge");
    assert.deepEqual(edges, [true, false]);
  } finally {
    p.stop();
  }
});

test("poller: a CGI error is logged at WARN and polling keeps going; motion after it still fires", async () => {
  const c = await client("hunter2");
  const logs = captureLogs();
  const edges: boolean[] = [];
  const p = new MotionPoller(c, { pollIntervalMs: 10, cooldownMs: 10_000 }, (a) => edges.push(a), new Logger("test"));
  try {
    answer = { status: 500 };
    p.start();
    const before = seen.length;
    await until(() => seen.length >= before + 3, "three failing polls");
    assert.ok(logs.warns().some((l) => /motion poll failed \(\d+ in a row\).*HTTP 500/.test(l)), logs.lines.join("\n"));
    assert.ok(!logs.lines.join("\n").includes("hunter2"), "the password was logged");
    answer = { alarm: 2 };
    await until(() => edges.length === 1, "motion after the errors");
    assert.deepEqual(edges, [true]);
  } finally {
    p.stop();
    logs.restore();
  }
});

test("poller: detection switched off on the camera is a WARN, not silence", async () => {
  const c = await client();
  const logs = captureLogs();
  const p = new MotionPoller(c, { pollIntervalMs: 10, cooldownMs: 100 }, () => {}, new Logger("test"));
  try {
    answer = { alarm: 0 };
    p.start();
    await until(() => logs.warns().some((l) => l.includes("motion detection is DISABLED")), "the disabled WARN");
  } finally {
    p.stop();
    logs.restore();
  }
});

test("poller: stop() ends polling", async () => {
  const c = await client();
  answer = { alarm: 2 };
  const edges: boolean[] = [];
  const p = new MotionPoller(c, { pollIntervalMs: 10, cooldownMs: 100 }, (a) => edges.push(a), new Logger("test"));
  p.start();
  await until(() => edges.length === 1, "the ON edge");
  p.stop();
  const after = seen.length;
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(seen.length <= after + 1, "polling continued after stop()");
});
