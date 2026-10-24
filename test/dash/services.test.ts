import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runCheck, runCheckDetailed, ServiceWatcher, IPVLAN_REASON, LightNode } from "../../src/dash/services";
import { DEFAULT_SERVICES, ServiceNode, loadSettings } from "../../src/dash/settings";
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

test("blocked: still a red light with the plain reason, pointing at the shim", async () => {
  assert.match((await runCheck({ kind: "blocked", reason: IPVLAN_REASON }, noBridge))!, /can't be checked from the NAS's own network/);
  assert.match(IPVLAN_REASON, /ipvlan-shim\.sh/);
});

test("defaults: the ipvlan apps are real http checks again, reached through the NAS shim (#11)", () => {
  const checks = new Map<string, ServiceNode["check"]>();
  const walk = (ns: ServiceNode[]) => ns.forEach((n) => { checks.set(n.id, n.check); walk(n.children ?? []); });
  walk(DEFAULT_SERVICES);
  assert.equal([...checks.values()].filter((c) => c.kind === "blocked").length, 0, "no default light is blocked any more");
  assert.deepEqual(checks.get("constructicon"), { kind: "http", url: "http://10.0.1.240/", ok: "any" });
  assert.deepEqual(checks.get("constructicon-dev"), { kind: "http", url: "http://10.0.1.241/", ok: "any" });
  assert.deepEqual(checks.get("questlog"), { kind: "http", url: "http://10.0.1.250/", ok: "200" });
  assert.deepEqual(checks.get("questlog-dev"), { kind: "http", url: "http://10.0.1.246/", ok: "200" });
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

test("short and full reasons: the wall shows a one-line label, the full reason stays for tap/hover", async () => {
  const blocked = await runCheckDetailed({ kind: "blocked", reason: IPVLAN_REASON }, noBridge);
  assert.deepEqual(blocked, { short: "can't check yet", full: IPVLAN_REASON });
  const hapOff = await runCheckDetailed({ kind: "bridge" }, () => ({ hapEnabled: false, paired: false, go2rtc: g2 }));
  assert.equal(hapOff!.short, "HomeKit off (test)");
  assert.match(hapOff!.full, /HomeKit is off on this instance/);
  const refused = await runCheckDetailed({ kind: "tcp", host: "127.0.0.1", port: await closedPort() }, noBridge);
  assert.equal(refused!.short, "not answering");
  assert.match(refused!.full, /refused/);
  assert.equal(await runCheck({ kind: "blocked", reason: "x" }, noBridge), "x", "runCheck still gives the full reason");
});

test("no non-green light renders without a reason, and every short reason fits one line", async () => {
  const w = new ServiceWatcher(1);
  const dead = await closedPort();
  const tree: ServiceNode[] = JSON.parse(JSON.stringify(DEFAULT_SERVICES));
  // every probe in the default tree fails here (a closed local port stands in for the NAS)
  const kill = (ns: ServiceNode[]) => ns.forEach((n) => { if (n.check.kind === "tcp" || n.check.kind === "alive") Object.assign(n.check, { host: "127.0.0.1", port: dead, kind: "tcp" }); kill(n.children ?? []); });
  kill(tree);
  for (const bridge of [() => ({ hapEnabled: false, paired: false, go2rtc: g2 }), () => ({ hapEnabled: true, paired: true, go2rtc: g2 })]) {
    const out = await w.poll(tree, bridge);
    const walk = (ns: LightNode[]) => ns.forEach((n) => {
      if (n.state !== "ok") {
        assert.ok(n.short && n.short.trim(), `${n.name} (${n.state}) has a short reason`);
        assert.ok(n.reason && n.reason.trim(), `${n.name} (${n.state}) has a full reason`);
        assert.ok(n.short!.length <= 28, `${n.name}'s short reason fits one line: "${n.short}"`);
      } else {
        assert.equal(n.short, null);
        assert.equal(n.reason, null);
      }
      walk(n.children);
    });
    walk(out);
  }
});

test("a rollup that's orange says why: how many below it aren't green, and which", async () => {
  const tree: ServiceNode[] = [{ id: "server", name: "NAS", rollup: true, check: { kind: "bridge" }, children: [
    { id: "a", name: "A", check: { kind: "blocked", reason: IPVLAN_REASON }, children: [
      { id: "a2", name: "dev", check: { kind: "blocked", reason: IPVLAN_REASON } }] },
    { id: "b", name: "B", check: { kind: "blocked", reason: IPVLAN_REASON } },
    { id: "c", name: "C", check: { kind: "bridge" } },
  ] }];
  const out = (await new ServiceWatcher(1).poll(tree, () => ({ hapEnabled: true, paired: true, go2rtc: g2 })))[0];
  assert.equal(out.state, "warn");
  assert.equal(out.short, "3 can't be checked yet");
  assert.match(out.reason!, /A: can't check yet/);
  assert.match(out.reason!, /dev \(under A\)/);
  const dead = await closedPort();
  const mixed: ServiceNode[] = [{ id: "r", name: "NAS", rollup: true, check: { kind: "bridge" }, children: [
    { id: "a", name: "A", check: { kind: "blocked", reason: IPVLAN_REASON } },
    { id: "t", name: "SMB", check: { kind: "tcp", host: "127.0.0.1", port: dead } }] }];
  const m = (await new ServiceWatcher(1).poll(mixed, () => ({ hapEnabled: true, paired: true, go2rtc: g2 })))[0];
  assert.equal(m.state, "warn");
  assert.equal(m.short, "2 checks not green");
  assert.match(m.reason!, /SMB: not answering/);
});

test("the old default 'Server' rollup is the NAS: renamed in the defaults and in saved settings", () => {
  assert.equal(DEFAULT_SERVICES[0].name, "NAS");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-"));
  const f = path.join(dir, "settings.json");
  fs.writeFileSync(f, JSON.stringify({ services: [{ id: "server", name: "Server", rollup: true, check: { kind: "bridge" } }, { id: "other", name: "Server", check: { kind: "bridge" } }] }));
  const s = loadSettings(f).settings;
  assert.equal(s.services[0].name, "NAS");
  assert.equal(s.services[1].name, "Server", "only the old default node is renamed");
});
