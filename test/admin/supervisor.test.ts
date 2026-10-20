import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import { Supervisor } from "../../src/admin/supervisor";
import { Logger } from "../../src/logger";

const log = new Logger("test");
const crashy = () => spawn(process.execPath, ["-e", "process.exit(3)"]);

async function until(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("restarts a crashing child with growing backoff and reports why", async () => {
  const states: string[] = [];
  const s = new Supervisor({ name: "crashy", start: crashy, log, minBackoffMs: 20, maxBackoffMs: 80,
    onState: (st) => states.push(st.state) });
  s.start();
  await until(() => s.status().restarts >= 3);
  await s.stop();
  const st = s.status();
  assert.match(st.lastError ?? "", /exited with code 3/);
  assert.ok(states.includes("backoff"));
  assert.equal(st.state, "stopped");
  const restartsAtStop = st.restarts;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.status().restarts, restartsAtStop, "no relaunch after stop()");
});

test("missing binary is reported as 'missing', not a silent loop", async () => {
  const states: string[] = [];
  const s = new Supervisor({ name: "ghost", start: () => spawn("/nonexistent/go2rtc"), log, minBackoffMs: 20,
    onState: (st) => states.push(st.state) });
  s.start();
  await until(() => s.status().restarts >= 1);
  await s.stop();
  assert.match(s.status().lastError ?? "", /ENOENT|not found/i);
  assert.ok(states.includes("missing"));
});

test("a start() function that throws is reported, and retried", async () => {
  let calls = 0;
  const s = new Supervisor({ name: "thrower", start: () => { calls++; throw new Error("boom"); }, log, minBackoffMs: 20 });
  s.start();
  await until(() => calls >= 2);
  await s.stop();
  assert.match(s.status().lastError ?? "", /boom/);
});

test("stop() kills a long-running child", async () => {
  const s = new Supervisor({ name: "sleeper", start: () => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]), log });
  s.start();
  await until(() => s.status().state === "running");
  const child = s.child()!;
  await s.stop();
  assert.equal(s.status().state, "stopped");
  assert.ok(child.exitCode !== null || child.signalCode !== null, "child process is gone");
  assert.equal(s.child(), null);
});
