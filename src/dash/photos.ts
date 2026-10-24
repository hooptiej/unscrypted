/**
 * The dashboard's photo slideshow: a folder of images, or a public iCloud shared album cached on
 * disk. A port of Homedash's photos_from_folder / photos_from_icloud / publish_photos, with an
 * injectable I/O seam so tests never touch the network. Only files this module published can be
 * served (by an opaque id), and every skipped or failed photo is counted and said out loud.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { DashSettings } from "./settings";

export const PHOTO_EXT: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ICLOUD_MIN_WIDTH = 1200;   // the tile is small; no need for full-resolution originals

export interface IcloudIO {
  post(url: string, body: unknown): Promise<{ status: number; json: any }>;
  get(url: string): Promise<Buffer>;
}
type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const defaultIcloudIO: IcloudIO = {
  async post(url, body) {
    const r = await fetch(url, { method: "POST", redirect: "manual", headers: { "content-type": "text/plain" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    let json: any = null;
    try { json = await r.json(); } catch { json = null; /* a non-JSON answer: the status says what happened */ }
    return { status: r.status, json };
  },
  async get(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`the photo server answered ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  },
};

export function photosFromFolder(folder: string, limit: number): { album: string; files: string[] } {
  let st: fs.Stats | null = null;
  try { st = fs.statSync(folder); } catch { st = null; }
  if (!st || !st.isDirectory()) throw new Error(`photo folder not found: ${folder}`);
  const out: { p: string; m: number }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && PHOTO_EXT[path.extname(e.name).toLowerCase()]) out.push({ p, m: fs.statSync(p).mtimeMs });
    }
  };
  walk(folder);
  out.sort((a, b) => b.m - a.m);
  return { album: "", files: (limit > 0 ? out.slice(0, limit) : out).map((x) => x.p) };
}

/** The album token is the fragment of https://www.icloud.com/sharedalbum/#TOKEN. */
export function icloudToken(url: string): string {
  const t = (url.includes("#") ? url.split("#", 2)[1] : url.slice(url.lastIndexOf("/") + 1)).trim();
  if (t.length < 3) throw new Error("couldn't find the shared-album token in the iCloud link (it's the part after #)");
  return t;
}

export function icloudHost(token: string): string {
  const n = token[0] === "A" ? B62.indexOf(token[1]) : B62.indexOf(token[1]) * 62 + B62.indexOf(token[2]);
  return `p${String(n).padStart(2, "0")}-sharedstreams.icloud.com`;
}

export function pickDerivative(d: Record<string, { width?: string | number }>): string {
  const sized = Object.entries(d).map(([k, v]) => [Number(v?.width || k || 0), k] as const).sort((a, b) => a[0] - b[0]);
  for (const [w, k] of sized) if (w >= ICLOUD_MIN_WIDTH) return k;
  return sized[sized.length - 1][1];
}

async function icloudPost(io: IcloudIO, host: string, token: string, endpoint: string, body: unknown): Promise<{ json: any; host: string }> {
  for (let i = 0; i < 3; i++) {
    const r = await io.post(`https://${host}/${token}/sharedstreams/${endpoint}`, body);
    if (r.status === 330) { host = r.json?.["X-Apple-MMe-Host"] || host; continue; }   // Apple's "use this host"
    if (r.status < 200 || r.status >= 300) throw new Error(`iCloud answered ${r.status}`);
    return { json: r.json ?? {}, host };
  }
  throw new Error("iCloud kept redirecting to another server");
}

export async function photosFromIcloud(url: string, cacheDir: string, limit: number, io: IcloudIO,
  publish?: (album: string, files: string[]) => void, sleep: Sleep = realSleep,
  warn: (msg: string) => void = (m) => console.warn(m)): Promise<{ album: string; files: string[]; failed: number; total: number }> {
  const token = icloudToken(url);
  const first = await icloudPost(io, icloudHost(token), token, "webstream", { streamCtag: null });
  const host = first.host;
  const album: string = first.json.streamName || "iCloud album";
  let entries: any[] = (first.json.photos ?? []).filter((p: any) => p?.mediaAssetType !== "video");
  entries.sort((a, b) => String(b.dateCreated ?? "").localeCompare(String(a.dateCreated ?? "")));
  if (limit > 0) entries = entries.slice(0, limit);

  const best = new Map<string, string>();   // checksum -> photoGuid, one derivative per photo
  for (const p of entries) {
    const d = p.derivatives ?? {};
    if (Object.keys(d).length && typeof p.photoGuid === "string" && /^[A-Za-z0-9-]+$/.test(p.photoGuid)) best.set(d[pickDerivative(d)].checksum, p.photoGuid);
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const fileOf = (g: string) => path.join(cacheDir, `${g}.jpg`);
  const cached = () => [...best.values()].map(fileOf).filter((f) => fs.existsSync(f));
  if (publish && cached().length) publish(album, cached());   // what's already on disk shows right away

  const wanted = [...best.values()].filter((g) => !fs.existsSync(fileOf(g)));
  const jobs: { guid: string; link: string }[] = [];
  for (let i = 0; i < wanted.length; i += 100) {
    const urls = await icloudPost(io, host, token, "webasseturls", { photoGuids: wanted.slice(i, i + 100) });
    for (const [checksum, loc] of Object.entries<any>(urls.json.items ?? {})) {
      const guid = best.get(checksum);
      if (guid && wanted.includes(guid)) jobs.push({ guid, link: `https://${loc.url_location}${loc.url_path}` });
    }
  }
  let failed = wanted.length - jobs.length;   // iCloud gave no address for these
  const fetchOne = async ({ guid, link }: { guid: string; link: string }) => {
    const part = path.join(cacheDir, `${guid}.part`);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.writeFileSync(part, await io.get(link));
        fs.renameSync(part, fileOf(guid));   // atomic: never serve a half-written file
        return;
      } catch (err) {
        if (attempt === 2) {
          failed++;
          fs.rmSync(part, { force: true });
          warn(`photos: skipped ${guid} after 3 tries: ${(err as Error).message}`);
        } else await sleep(1500 * (attempt + 1));   // DNS and CDN blips are transient
      }
    }
  };
  const queue = jobs.slice();
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => { while (queue.length) await fetchOne(queue.shift()!); }));
  return { album, files: cached(), failed, total: best.size };
}

export class PhotoLibrary {
  private published = new Map<string, string>();
  private items: { id: string; v: number }[] = [];
  private album = "";
  private error: string | null = null;
  /** True when the last refresh failed outright (retry in a minute); partial misses wait for the normal refresh. */
  retrySoon = false;

  /** `warn` carries per-photo download failures to the dashboard's log (#12: the Logger, not console.warn). */
  constructor(private readonly io: IcloudIO = defaultIcloudIO, private readonly sleep: Sleep = realSleep,
    private readonly warn: (msg: string) => void = (m) => console.warn(m)) {}

  private publish(album: string, files: string[], caption: string): void {
    const by = new Map<string, string>();
    const items: { id: string; v: number }[] = [];
    for (const f of files) {
      let m: number;
      try { m = Math.floor(fs.statSync(f).mtimeMs / 1000); } catch { continue; /* gone since the listing: just not published */ }
      const id = crypto.createHash("sha1").update(f).digest("hex").slice(0, 12);
      by.set(id, f); items.push({ id, v: m });
    }
    this.published = by; this.items = items; this.album = caption || album;
  }

  /** One refresh. Never throws: a failure keeps what's showing and says why in list().error. */
  async refresh(s: DashSettings["photos"], cacheDir: string): Promise<void> {
    const limit = Number(s.maxPhotos) || 0;
    this.retrySoon = false;
    try {
      if (s.source === "icloud") {
        if (!s.icloudUrl) {
          this.publish("", [], s.caption);
          this.error = "No iCloud album link is set. Add one in the dashboard settings (admin password needed).";
          return;
        }
        const r = await photosFromIcloud(s.icloudUrl, cacheDir, limit, this.io, (a, f) => this.publish(a, f, s.caption), this.sleep, this.warn);
        this.publish(r.album, r.files, s.caption);
        this.error = r.failed ? `${r.failed} of ${r.total} photos couldn't be downloaded; showing the other ${r.files.length}. They're retried on the next refresh.` : null;
      } else {
        const r = photosFromFolder(s.folder, limit);
        this.publish(r.album, r.files, s.caption);
        this.error = r.files.length ? null : `The photo folder ${s.folder} has no .jpg, .png or .webp files yet. Add some there.`;
      }
    } catch (err) {
      const why = (err as Error).message;
      this.retrySoon = true;
      if (!this.items.length && s.source === "icloud" && fs.existsSync(cacheDir)) {
        // e.g. iCloud is down right after a restart: whatever is cached from before still shows.
        this.publish("", fs.readdirSync(cacheDir).filter((n) => n.endsWith(".jpg")).map((n) => path.join(cacheDir, n)), s.caption);
      }
      const kept = this.items.length ? `Still showing the ${this.items.length} photos already cached.` : "No photos to show yet.";
      this.error = s.source === "icloud"
        ? `Photos: couldn't refresh the iCloud album (${why}). ${kept} Retrying in a minute.`
        : `Photos: ${why}. ${kept} Fix the folder in the dashboard settings; retrying in a minute.`;
    }
  }

  list(): { items: { id: string; v: number }[]; album: string; error: string | null } {
    return { items: this.items, album: this.album, error: this.error };
  }

  /** Only ever a path this library published; anything else is null (404). */
  file(id: string): string | null {
    return this.published.get(id) ?? null;
  }
}
