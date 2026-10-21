// Standalone HomeKit cameras (#57): bridged unless opted in, identity validation, generation and
// persistence. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { resolveConfig, loadConfig, Config, ConfigError, ResolvedCamera } from "../src/config";
import {
  ensureStandaloneIdentities, generatePin, generateSetupId, generateUsername, isValidPin,
  isValidSetupId, isValidUsername, resolveHomekit, tcpPortFree, STANDALONE_BASE_PORT,
} from "../src/homekitIdentity";
import { accessoryUuidSeed } from "../src/camera";
import { classifyChange } from "../src/admin/ipc";
import { applyCameraEdit, redactCamera, writeConfigAtomic, readRawConfig } from "../src/admin/configStore";
import { tempDir } from "./helpers/tmp";

const cfg = (cameras: Config["cameras"], bridge: Config["bridge"] = {}): Config => ({ bridge, cameras } as Config);
const resolve = (c: Config) => resolveConfig(c, path.resolve("/config"));

/** A deterministic byte source: counts up from `seed`. */
function counter(seed = 0) {
  let n = seed;
  return (k: number) => Buffer.from(Array.from({ length: k }, () => (n++ * 37 + 11) & 0xff));
}

// ---------- bridged unless opted in ----------

test("a camera with no homekit block, or mode bridged, stays bridged with its original UUID seed", () => {
  const r = resolve(cfg([
    { name: "A", rtspMain: "rtsp://h/1" },
    { name: "B", rtspMain: "rtsp://h/2", homekit: { mode: "bridged", port: 51830 } },
  ]));
  assert.deepEqual(r.cameras[0].homekit, { mode: "bridged" });
  assert.deepEqual(r.cameras[1].homekit, { mode: "bridged" });
  assert.equal(accessoryUuidSeed(r.cameras[0]), "unscrypted:camera:A");
});

test("a standalone camera gets a different UUID seed than its bridged self", () => {
  const r = resolve(cfg([{ name: "Roof Cam", rtspMain: "rtsp://h/1", homekit: { mode: "standalone" } }]));
  assert.equal(r.cameras[0].homekit.mode, "standalone");
  assert.equal(accessoryUuidSeed(r.cameras[0]), "unscrypted:camera-standalone:Roof Cam");
  assert.notEqual(accessoryUuidSeed(r.cameras[0]), accessoryUuidSeed({ ...r.cameras[0], homekit: { mode: "bridged" } }));
});

test("a standalone camera with missing identity fields still validates (they're generated at startup)", () => {
  const r = resolve(cfg([{ name: "A", rtspMain: "rtsp://h/1", homekit: { mode: "standalone", port: 51840 } }]));
  assert.deepEqual(r.cameras[0].homekit, { mode: "standalone", username: null, pin: null, setupId: null, port: 51840 });
});

test("a full standalone identity is resolved, username and setup id upper-cased", () => {
  const r = resolve(cfg([{ name: "A", rtspMain: "rtsp://h/1",
    homekit: { mode: "standalone", username: "0e:4b:21:9c:a0:13", pin: "482-19-305", setupId: "ab12", port: 51830 } }]));
  assert.deepEqual(r.cameras[0].homekit, { mode: "standalone", username: "0E:4B:21:9C:A0:13", pin: "482-19-305", setupId: "AB12", port: 51830 });
});

// ---------- validation ----------

for (const [label, homekit, re] of [
  ["an unknown mode", { mode: "solo" }, /homekit\.mode must be "bridged" or "standalone"/],
  ["a bad username", { mode: "standalone", username: "not-a-mac" }, /homekit\.username must be a MAC-style id/],
  ["a badly formatted pin", { mode: "standalone", pin: "12345678" }, /homekit\.pin must be formatted/],
  ["a trivial pin", { mode: "standalone", pin: "111-11-111" }, /not a trivial code/],
  ["the 123-45-678 pin", { mode: "standalone", pin: "123-45-678" }, /not a trivial code/],
  ["a bad setup id", { mode: "standalone", setupId: "AB-1" }, /homekit\.setupId must be 4 letters or digits/],
  ["a bad port", { mode: "standalone", port: 70000 }, /homekit\.port must be a valid TCP port/],
  ["a non-object", "standalone", /"homekit" must be an object/],
] as const) {
  test(`config refuses ${label}, naming the camera`, () => {
    assert.throws(
      () => resolve(cfg([{ name: "Roof", rtspMain: "rtsp://h/1", homekit: homekit as never }])),
      (e: Error) => e instanceof ConfigError && /"Roof"/.test(e.message) && re.test(e.message),
    );
  });
}

test("a standalone port that clashes with the bridge's or another camera's is refused", () => {
  assert.throws(() => resolve(cfg([{ name: "A", rtspMain: "rtsp://h/1", homekit: { mode: "standalone", port: 51826 } }])),
    /port 51826 is already used by the bridge/);
  assert.throws(() => resolve(cfg([
    { name: "A", rtspMain: "rtsp://h/1", homekit: { mode: "standalone", port: 51830 } },
    { name: "B", rtspMain: "rtsp://h/2", homekit: { mode: "standalone", port: 51830 } },
  ])), /camera "B": homekit\.port 51830 is already used by camera "A"/);
});

test("a standalone username that clashes with the bridge's or another camera's is refused", () => {
  assert.throws(() => resolve(cfg([{ name: "A", rtspMain: "rtsp://h/1",
    homekit: { mode: "standalone", username: "CC:22:3D:E3:CE:F6" } }])), /already used by the bridge/);
  assert.throws(() => resolve(cfg([
    { name: "A", rtspMain: "rtsp://h/1", homekit: { mode: "standalone", username: "0E:00:00:00:00:01" } },
    { name: "B", rtspMain: "rtsp://h/2", homekit: { mode: "standalone", username: "0e:00:00:00:00:01" } },
  ])), /already used by camera "A"/);
});

test("a bridged camera's leftover identity fields don't clash with anything (they're ignored)", () => {
  assert.doesNotThrow(() => resolve(cfg([{ name: "A", rtspMain: "rtsp://h/1", homekit: { mode: "bridged", port: 51826 } }])));
});

// ---------- generators ----------

test("generated usernames are valid, locally administered, unicast MACs", () => {
  for (let i = 0; i < 200; i++) {
    const u = generateUsername();
    assert.ok(isValidUsername(u), u);
    const first = parseInt(u.slice(0, 2), 16);
    assert.equal(first & 0x02, 0x02, `${u} is not locally administered`);
    assert.equal(first & 0x01, 0, `${u} is multicast`);
  }
});

test("generated pins are valid and never trivial, even when the random source keeps offering one", () => {
  for (let i = 0; i < 200; i++) assert.ok(isValidPin(generatePin()));
  // First draw = 11111111 (trivial), second draw = 48219305.
  const draws = [11_111_111, 48_219_305];
  const rand = (n: number) => { const b = Buffer.alloc(n); b.writeUInt32BE(draws.shift() ?? 1, 0); return b; };
  assert.equal(generatePin(rand), "482-19-305");
});

test("generated setup ids are 4 letters or digits", () => {
  for (let i = 0; i < 200; i++) assert.ok(isValidSetupId(generateSetupId()));
});

// ---------- ensureStandaloneIdentities ----------

test("missing identity fields are generated for standalone cameras only; the input isn't modified", async () => {
  const raw = cfg([
    { name: "Bridged", rtspMain: "rtsp://h/0" },
    { name: "Solo", rtspMain: "rtsp://h/1", homekit: { mode: "standalone" } },
  ], { port: 51826 });
  const before = JSON.stringify(raw);
  const { config, generated } = await ensureStandaloneIdentities(raw, { rand: counter() });
  assert.equal(JSON.stringify(raw), before);
  assert.equal(config.cameras[0].homekit, undefined);
  const hk = config.cameras[1].homekit!;
  assert.ok(isValidUsername(hk.username!) && isValidPin(hk.pin!) && isValidSetupId(hk.setupId!));
  assert.equal(hk.port, STANDALONE_BASE_PORT);
  assert.deepEqual(generated.map((g) => [g.camera, g.fields]), [["Solo", ["username", "pin", "setupId", "port"]]]);
  // The result resolves cleanly with a complete identity.
  const r = resolve(config).cameras[1].homekit;
  assert.ok(r.mode === "standalone" && r.username && r.pin && r.setupId && r.port);
});

test("fields that are already set are kept; only the missing ones are generated", async () => {
  const raw = cfg([{ name: "Solo", rtspMain: "rtsp://h/1",
    homekit: { mode: "standalone", username: "0E:4B:21:9C:A0:13", pin: "482-19-305" } }]);
  const { config, generated } = await ensureStandaloneIdentities(raw);
  assert.equal(config.cameras[0].homekit!.username, "0E:4B:21:9C:A0:13");
  assert.equal(config.cameras[0].homekit!.pin, "482-19-305");
  assert.deepEqual(generated[0].fields, ["setupId", "port"]);
});

test("a complete identity generates nothing", async () => {
  const raw = cfg([{ name: "Solo", rtspMain: "rtsp://h/1",
    homekit: { mode: "standalone", username: "0E:4B:21:9C:A0:13", pin: "482-19-305", setupId: "AB12", port: 51830 } }]);
  const { generated } = await ensureStandaloneIdentities(raw);
  assert.deepEqual(generated, []);
});

test("generated ports skip the bridge's port, ports other cameras have, and ports in use on the host", async () => {
  const raw = cfg([
    { name: "A", rtspMain: "rtsp://h/1", homekit: { mode: "standalone" } },
    { name: "B", rtspMain: "rtsp://h/2", homekit: { mode: "standalone", port: 51831 } },
    { name: "C", rtspMain: "rtsp://h/3", homekit: { mode: "standalone" } },
  ], { port: 51830 });
  const busy = new Set([51832]);
  const { config } = await ensureStandaloneIdentities(raw, { isPortFree: async (p) => !busy.has(p) });
  assert.deepEqual(config.cameras.map((c) => c.homekit!.port), [51833, 51831, 51834]);
  assert.doesNotThrow(() => resolve(config));
});

test("two generated usernames never collide with each other or with the bridge", async () => {
  // A random source that repeats itself: the second draw must be retried.
  const same = () => Buffer.from([0x0e, 1, 2, 3, 4, 5]);
  let calls = 0;
  const rand = (n: number) => (++calls <= 2 || n !== 6 ? same().subarray(0, n) : Buffer.from([0x0e, 9, 9, 9, 9, 9]));
  const raw = cfg([
    { name: "A", rtspMain: "rtsp://h/1", homekit: { mode: "standalone", pin: "482-19-305", setupId: "AB12" } },
    { name: "B", rtspMain: "rtsp://h/2", homekit: { mode: "standalone", pin: "482-19-306", setupId: "AB13" } },
  ]);
  const { config } = await ensureStandaloneIdentities(raw, { rand });
  assert.notEqual(config.cameras[0].homekit!.username, config.cameras[1].homekit!.username);
  assert.doesNotThrow(() => resolve(config));
});

// ---------- persistence ----------

test("a generated identity saved with writeConfigAtomic survives a reload, and isn't regenerated", async () => {
  const dir = tempDir("unscr-57-");
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg([
    { name: "Bridged", rtspMain: "rtsp://h/0" },
    { name: "Solo", rtspMain: "rtsp://h/1", homekit: { mode: "standalone" } },
  ])));
  const first = await ensureStandaloneIdentities(readRawConfig(file));
  const { backupPath } = writeConfigAtomic(file, first.config);
  assert.ok(backupPath && fs.existsSync(backupPath), "the previous config.json is kept");
  const loaded = loadConfig(file).cameras.find((c) => c.name === "Solo")!.homekit;
  const hk = first.config.cameras[1].homekit!;
  assert.deepEqual(loaded, { mode: "standalone", username: hk.username, pin: hk.pin, setupId: hk.setupId, port: hk.port });
  const again = await ensureStandaloneIdentities(readRawConfig(file));
  assert.deepEqual(again.generated, []);
  assert.deepEqual(again.config.cameras[1].homekit, first.config.cameras[1].homekit);
});

// ---------- admin pane interplay ----------

test("saving a camera from the pane keeps its homekit block (the pane can't edit it)", () => {
  const raw = cfg([{ name: "Solo", rtspMain: "rtsp://h/1",
    homekit: { mode: "standalone", username: "0E:4B:21:9C:A0:13", pin: "482-19-305", setupId: "AB12", port: 51830 } }]);
  const next = applyCameraEdit(raw, "Solo", { hksv: false });
  assert.deepEqual(next.cameras[0].homekit, raw.cameras[0].homekit);
  assert.throws(() => applyCameraEdit(raw, "Solo", { homekit: { mode: "bridged" } } as never), /Unknown field/);
});

test("the camera list never carries a standalone camera's setup code", () => {
  const pub = redactCamera({ name: "Solo", rtspMain: "rtsp://h/1",
    homekit: { mode: "standalone", username: "0E:4B:21:9C:A0:13", pin: "482-19-305", setupId: "AB12", port: 51830 } });
  assert.deepEqual(pub.homekit, { mode: "standalone", username: "0E:4B:21:9C:A0:13", setupId: "AB12", port: 51830 });
  assert.ok(!JSON.stringify(pub).includes("482-19-305"));
});

test("moving a camera between bridged and standalone, or changing its identity, needs a restart", () => {
  const base = resolve(cfg([{ name: "A", rtspMain: "rtsp://h/1" }])).cameras[0];
  const solo: ResolvedCamera = { ...base, homekit: resolveHomekit({ mode: "standalone", port: 51830 }) };
  assert.equal(classifyChange(base, { ...base }), "live");
  assert.equal(classifyChange(base, solo), "restart-needed");
  assert.equal(classifyChange(solo, { ...solo, homekit: resolveHomekit({ mode: "standalone", port: 51831 }) }), "restart-needed");
});

// ---------- port probe ----------

test("tcpPortFree says false for a port something listens on, true once it's released", async () => {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  assert.equal(await tcpPortFree(port, "127.0.0.1"), false);
  await new Promise<void>((r) => srv.close(() => r()));
  assert.equal(await tcpPortFree(port, "127.0.0.1"), true);
});
