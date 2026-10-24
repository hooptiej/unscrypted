// #14: Constructicon's font list and the one-time copy into the fonts folder, against a fake Constructicon.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { AddressInfo } from "net";
import { tempDir } from "../helpers/tmp";
import { ConstructiconFonts, cachedFontFile } from "../../src/admin/constructicon";

let fake: http.Server;
let base = "";
let refuse = false;
const hits: string[] = [];
const ASSETS = [
  { slug: "hooptiejwm00", title: "hooptiej-wordmark.png", brand_role: "logo" },
  { slug: "AlbLight0001", title: "AlbertusMT-Light.otf" },
  { slug: "AlbLightDupe", title: "AlbertusMT-Light (1).otf" },
  { slug: "AlbRegular01", title: "AlbertusMT.otf" },
  { slug: "bad slug!!", title: "Evil.ttf" },
  { slug: "WoffOne00001", title: "Mono.woff2" },
];

before(async () => {
  fake = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url} ${req.headers.authorization ? "auth" : "anon"}`);
    if (req.url === "/api/brand-assets") {
      if (refuse || req.headers.authorization !== "Bearer tok-123") { res.writeHead(401); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(ASSETS));
    }
    if (req.url === "/f/AlbRegular01") { res.writeHead(200, { "content-type": "font/otf" }); return res.end(Buffer.from("OTTO-fake-font-bytes")); }
    if (req.url === "/f/WoffOne00001") { res.writeHead(404); return res.end("gone"); }
    res.writeHead(404); res.end("nope");
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
after(() => fake.close());

function withToken(text: string | null): string {
  const dir = tempDir("unscr-cxtok-");
  const f = path.join(dir, "constructicon_token");
  if (text !== null) fs.writeFileSync(f, text);
  return f;
}

test("no address, no token, empty token: each a plain reason, and the folder fonts are unaffected", async () => {
  const none = new ConstructiconFonts({ tokenFile: withToken(null) });
  assert.match(none.availability("").reason!, /no Constructicon address is set/);
  assert.match(none.availability(base).reason!, /no Constructicon token at .*constructicon_token/);
  assert.deepEqual(await none.list(base), { fonts: [], error: none.availability(base).reason });
  const empty = new ConstructiconFonts({ tokenFile: withToken("  \n") });
  assert.match(empty.availability(base).reason!, /is empty/);
});

test("the list: only font files, de-duplicated ('(1)' loses), bad slugs dropped, sorted; the token goes along", async () => {
  const cx = new ConstructiconFonts({ tokenFile: withToken("tok-123\n") });
  const l = await cx.list(base);
  assert.equal(l.error, null);
  assert.deepEqual(l.fonts, [
    { slug: "AlbRegular01", name: "AlbertusMT", ext: "otf" },
    { slug: "AlbLight0001", name: "AlbertusMT-Light", ext: "otf" },
    { slug: "WoffOne00001", name: "Mono", ext: "woff2" },
  ]);
  assert.ok(hits.at(-1)!.endsWith("auth"), "the brand-assets listing carries the Bearer token");
  const n = hits.length;
  await cx.list(base);
  assert.equal(hits.length, n, "a second listing within 5 minutes is served from the cache");
});

test("a refused token and an unreachable Constructicon say so, keeping the last good list", async () => {
  const cx = new ConstructiconFonts({ tokenFile: withToken("tok-123") });
  assert.equal((await cx.list(base)).error, null);
  refuse = true;
  try {
    const l = await cx.list(base, true);
    assert.match(l.error!, /refused the token in .*constructicon_token \(401\)/);
    assert.equal(l.fonts.length, 3, "the last good list is kept");
  } finally { refuse = false; }
  const dead = new ConstructiconFonts({ tokenFile: withToken("tok-123"), timeoutMs: 2000 });
  const l2 = await dead.list("http://127.0.0.1:9", true);
  assert.match(l2.error!, /Constructicon at http:\/\/127\.0\.0\.1:9 didn't answer \(/);
  assert.deepEqual(l2.fonts, []);
});

test("fetchInto copies the font once (atomic), records its name in names.json, and reuses the copy", async () => {
  const cx = new ConstructiconFonts({ tokenFile: withToken("tok-123") });
  const fontsDir = path.join(tempDir("unscr-cxfonts-"), "fonts");
  fs.mkdirSync(fontsDir);
  fs.writeFileSync(path.join(fontsDir, "names.json"), JSON.stringify({ "other.otf": "Other" }));
  const got = await cx.fetchInto(base, "AlbRegular01", fontsDir);
  assert.deepEqual(got, { file: cachedFontFile("AlbRegular01", "otf"), name: "AlbertusMT" });
  assert.equal(fs.readFileSync(path.join(fontsDir, got.file), "utf8"), "OTTO-fake-font-bytes");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fontsDir, "names.json"), "utf8")), { "other.otf": "Other", [got.file]: "AlbertusMT" });
  assert.ok(!fs.readdirSync(fontsDir).some((f) => f.endsWith(".part")), "no temp file left behind");
  const n = hits.filter((h) => h.includes("/f/")).length;
  await cx.fetchInto(base, "AlbRegular01", fontsDir);
  assert.equal(hits.filter((h) => h.includes("/f/")).length, n, "already in the folder: not downloaded again");
});

test("fetchInto refuses an unknown or malformed slug, and reports a failed download plainly", async () => {
  const cx = new ConstructiconFonts({ tokenFile: withToken("tok-123") });
  const fontsDir = tempDir("unscr-cxfonts-");
  await assert.rejects(cx.fetchInto(base, "../../etc", fontsDir), /isn't a Constructicon item slug/);
  await assert.rejects(cx.fetchInto(base, "NotThere0000", fontsDir), /isn't one of Constructicon's fonts/);
  await assert.rejects(cx.fetchInto(base, "WoffOne00001", fontsDir), /answered 404 when asked for "Mono"/);
  assert.deepEqual(fs.readdirSync(fontsDir), [], "nothing written on failure");
});
