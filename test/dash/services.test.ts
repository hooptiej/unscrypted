import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import { execFileSync } from "child_process";
import { runCheck, ServiceWatcher, IPVLAN_REASON } from "../../src/dash/services";
import { DEFAULT_SERVICES, ServiceNode } from "../../src/dash/settings";
import { DashBridgeInfo } from "../../src/dash/ipc";

const noBridge = () => null;
const g2 = { state: "running", lastError: null, nextRetryAt: null };

function listenOn(s: net.Server): Promise<number> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as net.AddressInfo).port)));
}
async function closedPort(): Promise<number> {
  const s = net.createServer();
  const p = await listenOn(s);
  await new Promise((r) => s.close(r));
  return p;
}

test("tcp: a listening port is healthy; a closed one says refused", async () => {
  const s = net.createServer((c) => c.destroy());
  const port = await listenOn(s);
  try {
    assert.equal(await runCheck({ kind: "tcp", host: "127.0.0.1", port }, noBridge), null);
    const why = await runCheck({ kind: "tcp", host: "127.0.0.1", port: await closedPort() }, noBridge);
    assert.match(why!, /refused/);
    assert.doesNotMatch(why!, /127\.0\.0\.1/, "no address in a reason");
  } finally { s.close(); }
});

test("alive: a refusal proves the host answered; no answer is a reason", async () => {
  assert.equal(await runCheck({ kind: "alive", host: "127.0.0.1", port: await closedPort() }, noBridge), null);
  // 10.255.255.1 is unroutable on a normal LAN: the connect times out (or the network says unreachable).
  const why = await runCheck({ kind: "alive", host: "10.255.255.1", port: 80 }, noBridge, 300);
  assert.match(why!, /no answer|unreachable/);
});

test("http: ok any accepts a 401; ok 200 names the code it got", async () => {
  let code = 401;
  const s = http.createServer((_q, r) => { r.writeHead(code); r.end(); });
  const port = await listenOn(s);
  try {
    assert.equal(await runCheck({ kind: "http", url: `http://127.0.0.1:${port}/`, ok: "any" }, noBridge), null);
    code = 500;
    assert.match((await runCheck({ kind: "http", url: `http://127.0.0.1:${port}/`, ok: "200" }, noBridge))!, /answered 500/);
    code = 200;
    assert.equal(await runCheck({ kind: "http", url: `http://127.0.0.1:${port}/`, ok: "200" }, noBridge), null);
  } finally { s.close(); }
});

test("https with a self-signed certificate still counts as up (it's only a check)", async (t) => {
  let key: string, cert: string;
  try {
    // openssl ships with Git for Windows and every Linux image; skip (saying why) if it really isn't there.
    const out = execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", "-", "-out", "-"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    key = out.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/)![0];
    cert = out.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)![0];
  } catch (err) {
    t.skip(`openssl isn't available to make a test certificate: ${(err as Error).message}`);
    return;
  }
  const s = https.createServer({ key, cert }, (_q, r) => { r.writeHead(200); r.end(); });
  const port = await listenOn(s);
  try {
    assert.equal(await runCheck({ kind: "http", url: `https://127.0.0.1:${port}/`, ok: "200" }, noBridge), null);
  } finally { s.close(); }
});

test("bridge: green only when HomeKit is on and paired; otherwise says which", async () => {
  const b = (over: Partial<DashBridgeInfo>) => () => ({ hapEnabled: true, paired: true, go2rtc: g2, ...over });
  assert.equal(await runCheck({ kind: "bridge" }, b({})), null);
  assert.match((await runCheck({ kind: "bridge" }, b({ hapEnabled: false })))!, /HomeKit is off on this instance \(test\)/);
  assert.match((await runCheck({ kind: "bridge" }, b({ paired: false })))!, /not paired with Home/);
  assert.match((await runCheck({ kind: "bridge" }, noBridge))!, /the bridge hasn't reported yet/);
});

test("blocked: the ipvlan apps are red with the plain reason and the tracking issue", async () => {
  assert.match((await runCheck({ kind: "blocked", reason: IPVLAN_REASON }, noBridge))!, /can't be checked from the NAS's own network yet/);
  assert.match(IPVLAN_REASON, /unscrypted#11/);
  const ids = new Set<string>();
  const walk = (ns: ServiceNode[]) => ns.forEach((n) => { if (n.check.kind === "blocked") ids.add(n.id); walk(n.children ?? []); });
  walk(DEFAULT_SERVICES);
  assert.deepEqual([...ids].sort(), ["constructicon", "constructicon-dev", "questlog", "questlog-dev"]);
});

test("an unknown check kind (a hand-edited settings file) is a reason, not a crash or a green", async () => {
  assert.match((await runCheck({ kind: "nope" } as any, noBridge))!, /unknown check kind "nope"/);
});

test("debounce: one miss stays ok, the second turns it down with the reason", async () => {
  const s = net.createServer((c) => c.destroy());
  const port = await listenOn(s);
  const dead = await closedPort();
  const tree: ServiceNode[] = [{ id: "a", name: "A", check: { kind: "tcp", host: "127.0.0.1", port } }];
  const w = new ServiceWatcher();
  try {
    assert.equal((await w.poll(tree, noBridge))[0].state, "ok");
    (tree[0].check as any).port = dead;
    const one = (await w.poll(tree, noBridge))[0];
    assert.deepEqual({ state: one.state, reason: one.reason }, { state: "ok", reason: null });
    const two = (await w.poll(tree, noBridge))[0];
    assert.equal(two.state, "down");
    assert.match(two.reason!, /refused/);
  } finally { s.close(); }
});

test("rollup: a down child makes a rollup parent warn; a plain parent stays ok; links only http(s)", async () => {
  const tree: ServiceNode[] = [
    { id: "server", name: "Server", rollup: true, check: { kind: "bridge" }, children: [
      { id: "x", name: "X", link: "javascript:alert(1)", check: { kind: "blocked", reason: "nope" }, children: [] },
    ] },
    { id: "plain", name: "Plain", link: "http://ok.local", check: { kind: "bridge" }, children: [
      { id: "y", name: "Y", check: { kind: "blocked", reason: "nope" } },
    ] },
  ];
  const w = new ServiceWatcher(1);
  const out = await w.poll(tree, () => ({ hapEnabled: true, paired: true, go2rtc: g2 }));
  assert.equal(out[0].state, "warn");
  assert.equal(out[0].children[0].state, "down");
  assert.equal(out[0].children[0].reason, "nope");
  assert.equal(out[0].children[0].link, undefined, "a non-web link is dropped");
  assert.equal(out[1].state, "ok");
  assert.equal(out[1].link, "http://ok.local");
});
