import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "../helpers/tmp";
import { photosFromFolder, icloudToken, icloudHost, pickDerivative, photosFromIcloud, PhotoLibrary, IcloudIO } from "../../src/dash/photos";
import { DEFAULTS } from "../../src/dash/settings";

const noSleep = async () => {};

test("folder: newest first, recursing, only photo types, limit respected; a missing folder says so", () => {
  const d = tempDir("unscr-photos-");
  fs.mkdirSync(path.join(d, "sub"));
  const put = (rel: string, age: number) => { const p = path.join(d, rel); fs.writeFileSync(p, "x"); const t = Date.now() / 1000 - age; fs.utimesSync(p, t, t); };
  put("old.jpg", 300); put("sub/new.PNG", 10); put("mid.webp", 100); put("notes.txt", 1); put("x.jpeg", 200);
  const r = photosFromFolder(d, 0);
  assert.deepEqual(r.files.map((f) => path.relative(d, f).replace(/\\/g, "/")), ["sub/new.PNG", "mid.webp", "x.jpeg", "old.jpg"]);
  assert.equal(photosFromFolder(d, 2).files.length, 2);
  assert.throws(() => photosFromFolder(path.join(d, "nope"), 0), /photo folder not found: .*nope/);
});

test("iCloud token and shard host", () => {
  assert.equal(icloudToken("https://www.icloud.com/sharedalbum/#B0aGWZuqDGJ8Kg"), "B0aGWZuqDGJ8Kg");
  assert.throws(() => icloudToken("https://www.icloud.com/sharedalbum/#B0"), /shared-album token/);
  assert.equal(icloudHost("A1xyz"), "p01-sharedstreams.icloud.com");
  assert.equal(icloudHost("B0aGWZ"), "p36-sharedstreams.icloud.com");
});

test("derivative: the smallest at least 1200 wide, else the largest", () => {
  assert.equal(pickDerivative({ "342": { width: "342" }, "1242": { width: "1242" }, "2048": { width: "2048" } }), "1242");
  assert.equal(pickDerivative({ "342": { width: "342" }, "800": { width: "800" } }), "800");
});

function fakeIcloud(failGuid: string | null) {
  const posts: string[] = [];
  let gets = 0;
  const io: IcloudIO = {
    async post(url, body: any) {
      posts.push(url);
      if (url.startsWith("https://p36-") && url.endsWith("/webstream")) return { status: 330, json: { "X-Apple-MMe-Host": "p99-sharedstreams.icloud.com" } };
      if (url.endsWith("/webstream")) {
        return { status: 200, json: { streamName: "Family", photos: [
          { photoGuid: "g1", dateCreated: "2026-01-01", derivatives: { "1242": { width: "1242", checksum: "c1" } } },
          { photoGuid: "g2", dateCreated: "2026-03-01", derivatives: { "1242": { width: "1242", checksum: "c2" } } },
          { photoGuid: "g3", dateCreated: "2026-02-01", derivatives: { "1242": { width: "1242", checksum: "c3" } } },
          { photoGuid: "v1", dateCreated: "2026-04-01", mediaAssetType: "video", derivatives: { "720p": { width: "1280", checksum: "cv" } } },
        ] } };
      }
      assert.ok(!body.photoGuids.includes("v1"), "videos are never fetched");
      return { status: 200, json: { items: Object.fromEntries(body.photoGuids.map((g: string) => [`c${g.slice(1)}`, { url_location: "cdn.example", url_path: `/${g}` }])) } };
    },
    async get(url) {
      gets++;
      if (failGuid && url.endsWith(`/${failGuid}`)) throw new Error("CDN said no");
      return Buffer.from(`jpeg:${url}`);
    },
  };
  return { io, posts, gets: () => gets };
}

test("iCloud: follows the 330 host redirect, caches atomically, retries a failing photo 3 times and counts it", async () => {
  const cache = tempDir("unscr-icloud-");
  const f = fakeIcloud("g3");
  const r = await photosFromIcloud("https://www.icloud.com/sharedalbum/#B0aGWZuqDGJ8Kg", cache, 0, f.io, undefined, noSleep);
  assert.equal(r.album, "Family");
  assert.ok(f.posts.some((p) => p.startsWith("https://p99-")), "used the host iCloud redirected to");
  assert.deepEqual(fs.readdirSync(cache).sort(), ["g1.jpg", "g2.jpg"], "no .part left, no video");
  assert.deepEqual({ failed: r.failed, total: r.total }, { failed: 1, total: 3 });
  assert.equal(f.gets(), 2 + 3, "g3 was tried 3 times");

  // a second run only fetches what's missing
  const f2 = fakeIcloud(null);
  const r2 = await photosFromIcloud("https://www.icloud.com/sharedalbum/#B0aGWZuqDGJ8Kg", cache, 0, f2.io, undefined, noSleep);
  assert.equal(f2.gets(), 1);
  assert.equal(r2.files.length, 3);
});

test("PhotoLibrary: publishes ids it can serve, says how many failed, and keeps the old photos on an error", async () => {
  const cache = tempDir("unscr-icloud-");
  const lib = new PhotoLibrary(fakeIcloud("g3").io, noSleep);
  const s = { ...DEFAULTS.photos, source: "icloud" as const, icloudUrl: "https://www.icloud.com/sharedalbum/#B0aGWZuqDGJ8Kg" };
  await lib.refresh(s, cache);
  const l = lib.list();
  assert.equal(l.items.length, 2);
  assert.equal(l.album, "Family");
  assert.match(l.error!, /1 of 3 photos couldn't be downloaded/);
  for (const it of l.items) { assert.match(it.id, /^[0-9a-f]{12}$/); assert.ok(fs.existsSync(lib.file(it.id)!)); }
  assert.equal(lib.file("deadbeefcafe"), null, "only ids it published");
  assert.equal(lib.file("../../etc/passwd"), null);

  const broken: IcloudIO = { post: async () => { throw new Error("iCloud answered 503"); }, get: async () => Buffer.alloc(0) };
  const lib2 = new PhotoLibrary(broken, noSleep);
  (lib2 as any).published = (lib as any).published;   // as if an earlier round had worked
  (lib2 as any).items = l.items;
  await lib2.refresh({ ...s, caption: "Our photos" }, cache);
  const l2 = lib2.list();
  assert.equal(l2.items.length, 2, "the photos already shown stay");
  assert.match(l2.error!, /couldn't refresh the iCloud album \(iCloud answered 503\)\. Still showing the 2 photos already cached\. Retrying in a minute\./);
});

test("PhotoLibrary: no source set says what to do instead of an empty tile", async () => {
  const lib = new PhotoLibrary(fakeIcloud(null).io, noSleep);
  await lib.refresh({ ...DEFAULTS.photos, source: "icloud", icloudUrl: "" }, tempDir("unscr-icloud-"));
  assert.match(lib.list().error!, /No iCloud album link is set/);
  await lib.refresh({ ...DEFAULTS.photos, source: "folder", folder: "/definitely/not/here" }, tempDir("unscr-icloud-"));
  assert.match(lib.list().error!, /photo folder not found: \/definitely\/not\/here/);
});
