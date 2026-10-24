import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as net from "net";
import { describeListenError, listenDash } from "../../src/dash/server";
import { UserError } from "../../src/admin/errors";

test("an address that isn't on this machine is refused in plain words", async () => {
  const s = http.createServer();
  // TEST-NET-3 (RFC 5737): never assigned to a real interface.
  await assert.rejects(listenDash(s, "203.0.113.7", 0), (e: unknown) =>
    e instanceof UserError && /203\.0\.113\.7 isn't on this machine/.test(e.body.happened)
      && /HomeKit bridge and the admin pane are unaffected/.test(e.body.changed) && /UNSCRYPTED_DASH_HOST/.test(e.body.next));
});

test("a port in use is refused in plain words, naming the port", async () => {
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
  const port = (blocker.address() as net.AddressInfo).port;
  try {
    await assert.rejects(listenDash(http.createServer(), "127.0.0.1", port), (e: unknown) =>
      e instanceof UserError && new RegExp(`127\\.0\\.0\\.1:${port} \\(EADDRINUSE\\)`).test(e.body.happened));
  } finally { blocker.close(); }
});

test("low ports and unknown errors still get all four parts", () => {
  for (const code of ["EACCES", "EWHATEVER"]) {
    const b = describeListenError("0.0.0.0", 80, Object.assign(new Error("boom"), { code }));
    assert.ok(b.attempted && b.happened && b.changed && b.next, code);
  }
});
