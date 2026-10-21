// #36: HomeKit can be limited to chosen addresses, so Apple devices can't connect on an extra one
// (an ipvlan shim, a dashboard alias) while live video goes out from the main address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostIpv4s, parseHapBind } from "../src/util";

test("unset or blank UNSCRYPTED_HAP_BIND means no bind (every address, hap-nodejs default)", () => {
  assert.equal(parseHapBind(undefined), undefined);
  assert.equal(parseHapBind(""), undefined);
  assert.equal(parseHapBind("  , ,"), undefined);
});

test("one address, or a comma list of addresses and interface names, trimmed", () => {
  assert.deepEqual(parseHapBind("10.0.1.78"), ["10.0.1.78"]);
  assert.deepEqual(parseHapBind(" 10.0.1.78 , enp2s0,"), ["10.0.1.78", "enp2s0"]);
});

test("hostIpv4s lists external IPv4s only (shim and alias included, loopback and IPv6 not)", () => {
  const ifaces = {
    lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    enp2s0: [
      { family: "IPv4", internal: false, address: "10.0.1.78" },
      { family: "IPv4", internal: false, address: "10.0.1.248" },
      { family: "IPv6", internal: false, address: "fe80::1" },
    ],
    ipvlshim: [{ family: 4, internal: false, address: "10.0.1.249" }],
  };
  assert.deepEqual(hostIpv4s(ifaces), ["10.0.1.78", "10.0.1.248", "10.0.1.249"]);
});
