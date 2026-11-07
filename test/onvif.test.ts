// #47: ONVIF motion: the SOAP parsers, WS-Security auth, and the PullPoint / push loops against a
// tiny fake camera on localhost (including renewal failure -> resubscribe).
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";
import * as http from "http";
import { AddressInfo } from "net";
import {
  OnvifClient, OnvifMotionSource, parseFault, parseMotionReadings, extractSubscriptionAddress,
  resolveSenderAddresses,
} from "../src/onvif";
import { Logger, setLogLevel } from "../src/logger";
import { captureLogs, until } from "./helpers/fakes";

setLogLevel("error");
const log = new Logger("test");

// ---- canned SOAP --------------------------------------------------------------------------

const env = (body: string) =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${body}</s:Body></s:Envelope>`;
const fault = (sub: string, text: string) => env(
  `<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>${sub}</s:Value></s:Subcode></s:Code>` +
  `<s:Reason><s:Text xml:lang="en">${text}</s:Text></s:Reason></s:Fault>`);
const motionMsg = (topic: string, item: string, value: string) =>
  `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${topic}</wsnt:Topic>` +
  `<wsnt:Message><tt:Message UtcTime="2026-11-07T10:00:00Z" PropertyOperation="Changed">` +
  `<tt:Source><tt:SimpleItem Name="VideoSourceConfigurationToken" Value="000"/></tt:Source>` +
  `<tt:Data><tt:SimpleItem Name="${item}" Value="${value}"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`;
const CELL = "tns1:RuleEngine/CellMotionDetector/Motion";
const subRef = (addr: string) =>
  `<wsnt:SubscriptionReference><wsa5:Address>${addr}</wsa5:Address></wsnt:SubscriptionReference>`;

// ---- pure parsers -------------------------------------------------------------------------

test("parseFault reads code, subcode and reason; a normal body is not a fault", () => {
  assert.deepEqual(parseFault(fault("ter:ActionNotSupported", "PullPoint not supported")),
    { code: "s:Sender", subcode: "ter:ActionNotSupported", reason: "PullPoint not supported" });
  assert.equal(parseFault(env("<tev:PullMessagesResponse/>")), undefined);
});

test("parseMotionReadings: CellMotionDetector IsMotion and VideoSource MotionAlarm State, in order; other topics ignored", () => {
  const body = env(`<tev:PullMessagesResponse>` +
    motionMsg(CELL, "IsMotion", "true") +
    motionMsg("tns1:VideoSource/SignalLoss", "State", "true") +
    motionMsg("tns1:VideoSource/MotionAlarm", "State", "false") +
    motionMsg(CELL, "IsMotion", "1") +
    `</tev:PullMessagesResponse>`);
  assert.deepEqual(parseMotionReadings(body), [
    { topic: CELL, active: true },
    { topic: "tns1:VideoSource/MotionAlarm", active: false },
    { topic: CELL, active: true },
  ]);
});

test("parseMotionReadings: attributes in either order, and a motion topic without a value is skipped", () => {
  const swapped = `<wsnt:NotificationMessage><wsnt:Topic>${CELL}</wsnt:Topic><tt:Data><tt:SimpleItem Value="true" Name="IsMotion"/></tt:Data></wsnt:NotificationMessage>`;
  assert.deepEqual(parseMotionReadings(env(swapped)), [{ topic: CELL, active: true }]);
  const empty = `<wsnt:NotificationMessage><wsnt:Topic>${CELL}</wsnt:Topic><tt:Data></tt:Data></wsnt:NotificationMessage>`;
  assert.deepEqual(parseMotionReadings(env(empty)), []);
  assert.deepEqual(parseMotionReadings("not xml at all"), []);
});

test("extractSubscriptionAddress finds the SubscriptionReference address, undefined when there is none", () => {
  assert.equal(extractSubscriptionAddress(env(`<tev:CreatePullPointSubscriptionResponse>${subRef(" http://10.0.0.5/onvif/pull?id=7 ")}` +
    `<wsnt:CurrentTime>x</wsnt:CurrentTime></tev:CreatePullPointSubscriptionResponse>`)), "http://10.0.0.5/onvif/pull?id=7");
  assert.equal(extractSubscriptionAddress(env("<tev:SubscribeResponse/>")), undefined);
});

// ---- the fake camera ----------------------------------------------------------------------

interface Seen { path: string; action: string; body: string }
interface CameraScript {
  pullPoint: boolean;
  /** Bodies PullMessages answers with, in order; when empty it answers "no messages" after 20 ms. */
  pulls: string[];
  renewFails: boolean;
  password: string;
}
const seen: Seen[] = [];
let script: CameraScript;
const reset = (over: Partial<CameraScript> = {}) => {
  seen.length = 0;
  script = { pullPoint: true, pulls: [], renewFails: false, password: "camPass1", ...over };
};
reset();

const cam = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const action = /<a:Action>([^<]+)<\/a:Action>/.exec(body)?.[1] ?? "";
    seen.push({ path: req.url ?? "", action, body });
    const send = (xml: string, status = 200) => { res.writeHead(status, { "content-type": "application/soap+xml" }); res.end(xml); };
    const base = `http://127.0.0.1:${(cam.address() as AddressInfo).port}`;
    if (action.endsWith("GetServicesRequest")) {
      return send(env(`<tds:GetServicesResponse>` +
        `<tds:Service><tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace><tds:XAddr>${base}/onvif/device_service</tds:XAddr></tds:Service>` +
        `<tds:Service><tds:Namespace>http://www.onvif.org/ver10/events/wsdl</tds:Namespace><tds:XAddr>${base}/onvif/events</tds:XAddr></tds:Service>` +
        `</tds:GetServicesResponse>`));
    }
    if (action.endsWith("GetEventPropertiesRequest")) {
      return send(env(`<tev:GetEventPropertiesResponse><wstop:TopicSet><tns1:RuleEngine><CellMotionDetector><Motion wstop:topic="true"/></CellMotionDetector></tns1:RuleEngine></wstop:TopicSet></tev:GetEventPropertiesResponse>`));
    }
    if (action.endsWith("CreatePullPointSubscriptionRequest")) {
      if (!script.pullPoint) return send(fault("ter:ActionNotSupported", "PullPoint is not supported"), 400);
      return send(env(`<tev:CreatePullPointSubscriptionResponse>${subRef(`${base}/onvif/pull/1`)}</tev:CreatePullPointSubscriptionResponse>`));
    }
    if (action.endsWith("PullMessagesRequest")) {
      const next = script.pulls.shift();
      if (next !== undefined) return send(next, next.includes("Fault") ? 400 : 200);
      setTimeout(() => send(env("<tev:PullMessagesResponse/>")), 20);
      return;
    }
    if (action.endsWith("SubscribeRequest")) {
      return send(env(`<wsnt:SubscribeResponse>${subRef(`${base}/onvif/sub/${seen.filter((s) => s.action.endsWith("SubscribeRequest")).length}`)}</wsnt:SubscribeResponse>`));
    }
    if (action.endsWith("RenewRequest")) {
      return script.renewFails ? send(fault("wsrf-rw:ResourceUnknownFault", "no such subscription"), 400) : send(env("<wsnt:RenewResponse/>"));
    }
    if (action.endsWith("UnsubscribeRequest")) return send(env("<wsnt:UnsubscribeResponse/>"));
    send(fault("ter:ActionNotSupported", `unknown action ${action}`), 400);
  });
});
const port = new Promise<number>((r) => cam.listen(0, "127.0.0.1", () => r((cam.address() as AddressInfo).port)));
after(() => cam.close());

const count = (suffix: string) => seen.filter((s) => s.action.endsWith(suffix)).length;
const client = async (password = script.password) => new OnvifClient({ host: "127.0.0.1", port: await port, username: "admin", password }, log);

/** Wait for I/O while setTimeout is mocked: setImmediate turns, real-time deadline. `step` runs each turn. */
async function untilIo(cond: () => boolean, what: string, step: () => void = () => {}, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    step();
    await new Promise((r) => setImmediate(r));
  }
}

// ---- client -------------------------------------------------------------------------------

test("every request carries a WS-Security PasswordDigest the camera can verify (and never the password itself)", async () => {
  reset();
  const c = await client("s3cret-pw");
  const url = await c.getEventServiceUrl();
  assert.equal(url, `http://127.0.0.1:${await port}/onvif/events`);
  const body = seen[0].body;
  assert.ok(!body.includes("s3cret-pw"), "the plain password went over the wire");
  const nonce = Buffer.from(/<wsse:Nonce[^>]*>([^<]+)</.exec(body)![1], "base64");
  const created = /<wsu:Created>([^<]+)</.exec(body)![1];
  const digest = /<wsse:Password[^>]*>([^<]+)</.exec(body)![1];
  const expect = crypto.createHash("sha1").update(Buffer.concat([nonce, Buffer.from(created), Buffer.from("s3cret-pw")])).digest("base64");
  assert.equal(digest, expect);
  assert.match(body, /<wsse:Username>admin<\/wsse:Username>/);
});

test("getEventServiceUrl falls back to /onvif/event_service when discovery fails, and says so", async () => {
  const logs = captureLogs();
  try {
    const dead = new OnvifClient({ host: "127.0.0.1", port: 1, username: "u", password: "p", requestTimeoutMs: 500 }, log);
    assert.equal(await dead.getEventServiceUrl(), "http://127.0.0.1:1/onvif/event_service");
    assert.ok(logs.warns().some((l) => l.includes("GetServices request failed")), logs.lines.join("\n"));
  } finally {
    logs.restore();
  }
});

// ---- PullPoint ----------------------------------------------------------------------------

test("PullPoint: motion in a PullMessages batch -> ON once; quiet -> OFF after the cooldown", async () => {
  reset({ pulls: [env(`<tev:PullMessagesResponse>${motionMsg(CELL, "IsMotion", "true")}${motionMsg(CELL, "IsMotion", "true")}</tev:PullMessagesResponse>`)] });
  const edges: boolean[] = [];
  const src = new OnvifMotionSource(await client(), "127.0.0.1", await port, "Garage",
    { cooldownMs: 150, pullTimeoutMs: 1000, notifyPort: 0 }, (a) => edges.push(a), log);
  src.start();
  try {
    await until(() => edges.length === 2, "ON then OFF");
    assert.deepEqual(edges, [true, false]);
    assert.equal(count("CreatePullPointSubscriptionRequest"), 1);
    const pull = seen.find((s) => s.action.endsWith("PullMessagesRequest"))!;
    assert.equal(pull.path, "/onvif/pull/1", "PullMessages goes to the address CreatePullPoint returned");
    assert.match(pull.body, /<Timeout>PT1S<\/Timeout>/);
  } finally {
    src.stop();
  }
});

test("PullPoint: three PullMessages faults in a row -> WARN and the subscription is rebuilt from scratch", async () => {
  const bad = fault("ter:InvalidArgVal", "subscription expired");
  reset({ pulls: [bad, bad, bad] });
  const logs = captureLogs();
  const src = new OnvifMotionSource(await client(), "127.0.0.1", await port, "Garage",
    { cooldownMs: 150, pullTimeoutMs: 1000, notifyPort: 0 }, () => {}, log);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    src.start();
    // 2 s between the first errors, then a 5 s retry: tick through them while the fake answers.
    await untilIo(() => count("CreatePullPointSubscriptionRequest") >= 2, "a second CreatePullPointSubscription", () => mock.timers.tick(250));
    assert.equal(count("PullMessagesRequest") >= 3, true);
    assert.ok(logs.warns().some((l) => /PullMessages (error|failing)/.test(l)), logs.lines.join("\n"));
  } finally {
    src.stop();
    mock.timers.reset();
    logs.restore();
  }
});

// ---- push (base notification) -------------------------------------------------------------

/** The source's current subscription address (null between a failure and the next subscribe). */
const subscribed = (src: OnvifMotionSource) => (src as unknown as { subscriptionUrl: string | null }).subscriptionUrl !== null;

/** Start a push-mode source; resolves with the consumer URL the camera was told to POST to. */
async function startPush(edges: boolean[]): Promise<{ src: OnvifMotionSource; consumer: string }> {
  const src = new OnvifMotionSource(await client(), "127.0.0.1", await port, "Back Gate",
    { cooldownMs: 150, pullTimeoutMs: 1000, notifyPort: 0, notifyHost: "127.0.0.1", terminationSeconds: 10 }, (a) => edges.push(a), log);
  src.start();
  await untilIo(() => count("SubscribeRequest") >= 1 && subscribed(src), "the push Subscribe");
  const sub = seen.find((s) => s.action.endsWith("SubscribeRequest"))!;
  return { src, consumer: /<wsa:Address>([^<]+)<\/wsa:Address>/.exec(sub.body)![1] };
}

function notify(consumer: string, xml: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(consumer);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end(xml);
  });
}

test("push: no PullPoint -> subscribes with a consumer address; a Notify with IsMotion=true -> ON, then OFF", async () => {
  reset({ pullPoint: false });
  const edges: boolean[] = [];
  const { src, consumer } = await startPush(edges);
  try {
    assert.match(consumer, /^http:\/\/127\.0\.0\.1:\d+\/onvif-notify\/Back%20Gate$/);
    assert.equal(await notify(consumer, env(`<wsnt:Notify>${motionMsg(CELL, "IsMotion", "true")}</wsnt:Notify>`)), 200);
    await until(() => edges.length === 2, "ON then OFF");
    assert.deepEqual(edges, [true, false]);
  } finally {
    src.stop();
  }
});

test("push: a failed renewal is logged at WARN and the source subscribes again", async () => {
  reset({ pullPoint: false, renewFails: true });
  const logs = captureLogs();
  mock.timers.enable({ apis: ["setTimeout"] });
  let src: OnvifMotionSource | undefined;
  try {
    ({ src } = await startPush([]));
    // Renewal is due at 60% of the lifetime (15 s minimum); then a 3 s retry rebuilds it.
    // Wait for the second subscription to finish, too: stopping mid-subscribe would leave its timers
    // armed with real time once the mock is reset.
    await untilIo(() => count("SubscribeRequest") >= 2 && subscribed(src!), "a second Subscribe after the failed Renew", () => mock.timers.tick(500));
    assert.equal(count("RenewRequest"), 1);
    assert.ok(logs.warns().some((l) => l.includes("subscription renew failed") && l.includes("no such subscription")), logs.lines.join("\n"));
  } finally {
    src?.stop();
    mock.timers.reset();
    logs.restore();
  }
});

// ---- #42: who may talk to the push receiver ------------------------------------------------

/** A push-mode source whose camera is configured at `cameraHost` (the Subscribe still reaches the fake camera). */
async function startPushFor(cameraHost: string, edges: boolean[]): Promise<{ src: OnvifMotionSource; consumer: string }> {
  const src = new OnvifMotionSource(await client(), cameraHost, await port, "Back Gate",
    { cooldownMs: 150, pullTimeoutMs: 1000, notifyPort: 0, notifyHost: "127.0.0.1", terminationSeconds: 10 }, (a) => edges.push(a), log);
  src.start();
  await untilIo(() => count("SubscribeRequest") >= 1 && subscribed(src), "the push Subscribe");
  const sub = seen.find((s) => s.action.endsWith("SubscribeRequest"))!;
  return { src, consumer: /<wsa:Address>([^<]+)<\/wsa:Address>/.exec(sub.body)![1] };
}

/** POST `xml` to `consumer`; resolves with the status, or the socket error code if the receiver cut the connection first. */
function notifyRaw(consumer: string, xml: string): Promise<number | string> {
  return new Promise((resolve) => {
    const u = new URL(consumer);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
    req.end(xml);
  });
}

const ON = env(`<wsnt:Notify>${motionMsg(CELL, "IsMotion", "true")}</wsnt:Notify>`);

test("#42: a sender that isn't a configured camera is refused (403), logged at WARN with its address, and raises no motion", async () => {
  reset({ pullPoint: false });
  const logs = captureLogs();
  const edges: boolean[] = [];
  // The camera is configured at 192.0.2.77; the POST below comes from 127.0.0.1, which is not a camera.
  const { src, consumer } = await startPushFor("192.0.2.77", edges);
  try {
    assert.equal(await notifyRaw(consumer, ON), 403);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(edges, [], "a stranger's notification must not reach the camera's motion handler");
    const warn = logs.warns().find((l) => l.includes("refused"));
    assert.ok(warn, logs.lines.join("\n"));
    assert.match(warn!, /from 127\.0\.0\.1: that address isn't one of the ONVIF cameras in config\.json/);
  } finally {
    src.stop();
    logs.restore();
  }
});

test("#42: refusals from one address are logged once a minute, not once per request", async () => {
  reset({ pullPoint: false });
  const logs = captureLogs();
  const { src, consumer } = await startPushFor("192.0.2.77", []);
  try {
    for (let i = 0; i < 5; i++) assert.equal(await notifyRaw(consumer, ON), 403);
    assert.equal(logs.warns().filter((l) => l.includes("refused an ONVIF notification")).length, 1, logs.lines.join("\n"));
  } finally {
    src.stop();
    logs.restore();
  }
});

test("#42: a known camera (its configured address) still gets through", async () => {
  reset({ pullPoint: false });
  const logs = captureLogs();
  const edges: boolean[] = [];
  const { src, consumer } = await startPushFor("127.0.0.1", edges);
  try {
    assert.equal(await notifyRaw(consumer, ON), 200);
    await until(() => edges.length === 2, "ON then OFF");
    assert.deepEqual(edges, [true, false]);
    assert.equal(logs.warns().filter((l) => l.includes("refused")).length, 0, logs.lines.join("\n"));
  } finally {
    src.stop();
    logs.restore();
  }
});

test("#42: a body over the size cap is refused (413 or a cut connection), logged at WARN, and never parsed", async () => {
  reset({ pullPoint: false });
  const logs = captureLogs();
  const edges: boolean[] = [];
  const { src, consumer } = await startPushFor("127.0.0.1", edges);
  try {
    // A valid motion-ON notification padded past the cap: if it were read and parsed, it would raise motion.
    const huge = ON + " ".repeat(256 * 1024 + 1024);
    const result = await notifyRaw(consumer, huge);
    assert.ok(result === 413 || typeof result === "string", `expected 413 or a cut connection, got ${result}`);
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(edges, [], "an oversized notification must not raise motion");
    const warn = logs.warns().find((l) => l.includes("refused"));
    assert.ok(warn, logs.lines.join("\n"));
    assert.match(warn!, /256 KB/);
    // The receiver is still serving the camera afterwards.
    assert.equal(await notifyRaw(consumer, ON), 200);
  } finally {
    src.stop();
    logs.restore();
  }
});

test("#42: resolveSenderAddresses uses an IP as is (v4-mapped form cleaned) and warns when a name doesn't resolve", async () => {
  const logs = captureLogs();
  try {
    assert.deepEqual(await resolveSenderAddresses("10.0.0.5", log), ["10.0.0.5"]);
    assert.deepEqual(await resolveSenderAddresses("::ffff:10.0.0.5", log), ["10.0.0.5"]);
    assert.deepEqual(await resolveSenderAddresses("no-such-camera.invalid", log), []);
    assert.ok(logs.warns().some((l) => l.includes("no-such-camera.invalid") && l.includes("will be refused")), logs.lines.join("\n"));
  } finally {
    logs.restore();
  }
});
