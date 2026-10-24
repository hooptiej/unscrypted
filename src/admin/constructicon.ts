/**
 * Fonts from Constructicon (#14): the dashboard's font list can include the font files kept in
 * Constructicon as brand assets, the way Homedash's did. Runs in the admin process only: the
 * install token is read from a secrets file here and never reaches the browser or the open
 * dashboard. A chosen font is downloaded once into the dashboard's fonts folder, so from then on it
 * is an ordinary folder font: the dashboard keeps working when Constructicon is down, and the cache
 * is the fallback.
 *
 * Every failure is a plain reason (no token, token refused, unreachable, not a font) and the local
 * fonts keep working regardless.
 */

import * as fs from "fs";
import * as path from "path";

export interface CxFont { slug: string; name: string; ext: string }
export interface CxOptions {
  /** Where the read-only Constructicon token lives (one line). Missing = the feature says so. */
  tokenFile: string;
  fetchImpl?: typeof fetch;
  /** How long a listing is reused (default 5 min). */
  cacheMs?: number;
  timeoutMs?: number;
}

const FONT_EXT = /\.(otf|ttf|woff2?)$/i;
const SLUG = /^[A-Za-z0-9_-]{1,64}$/;
/** The cached copy's file name in the fonts folder: a plain folder font from then on. */
export const cachedFontFile = (slug: string, ext: string): string => `cx-${slug}.${ext}`;

export class ConstructiconFonts {
  private cache: { url: string; at: number; fonts: CxFont[] } | null = null;
  constructor(private readonly o: CxOptions) {}

  /** The token, or a reason there isn't one. Read every time: the file may appear later. */
  private token(): { token: string } | { reason: string } {
    try {
      const t = fs.readFileSync(this.o.tokenFile, "utf8").trim();
      if (!t) return { reason: `the token file ${this.o.tokenFile} is empty; put a read-only Constructicon token in it (one line)` };
      return { token: t };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { reason: `no Constructicon token at ${this.o.tokenFile}; put a read-only token there (one line, mounted read-only) and reload` };
      return { reason: `the token file ${this.o.tokenFile} couldn't be read (${code ?? (err as Error).message})` };
    }
  }

  /** Why the feature can't work right now, or null when it can be tried. */
  availability(url: string): { available: boolean; reason: string | null } {
    if (!url) return { available: false, reason: "no Constructicon address is set; enter it above (for example http://10.0.1.240) and save" };
    const t = this.token();
    if ("reason" in t) return { available: false, reason: t.reason };
    return { available: true, reason: null };
  }

  private async get(url: string, pathname: string, token: string | null): Promise<Response> {
    const f = this.o.fetchImpl ?? fetch;
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    try {
      return await f(url.replace(/\/+$/, "") + pathname, { headers, signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000), redirect: "follow" });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const why = e.name === "TimeoutError" ? "no answer within 10 s" : (e.cause?.code ?? e.message);
      throw new Error(`Constructicon at ${url} didn't answer (${why})`);
    }
  }

  /** Constructicon's font items (brand assets whose title is a font file), de-duplicated and sorted. */
  async list(url: string, force = false): Promise<{ fonts: CxFont[]; error: string | null }> {
    const avail = this.availability(url);
    if (!avail.available) return { fonts: this.cache?.url === url ? this.cache.fonts : [], error: avail.reason };
    if (!force && this.cache && this.cache.url === url && Date.now() - this.cache.at < (this.o.cacheMs ?? 300_000)) return { fonts: this.cache.fonts, error: null };
    const t = this.token() as { token: string };
    let res: Response;
    try { res = await this.get(url, "/api/brand-assets", t.token); } catch (err) { return { fonts: this.cache?.fonts ?? [], error: (err as Error).message }; }
    if (res.status === 401 || res.status === 403) return { fonts: this.cache?.fonts ?? [], error: `Constructicon refused the token in ${this.o.tokenFile} (${res.status}); check it's a current token for ${url}` };
    if (!res.ok) return { fonts: this.cache?.fonts ?? [], error: `Constructicon answered ${res.status} to the brand-assets list` };
    let raw: unknown;
    try { raw = await res.json(); } catch { return { fonts: this.cache?.fonts ?? [], error: "Constructicon's brand-assets list wasn't JSON" }; }
    if (!Array.isArray(raw)) return { fonts: this.cache?.fonts ?? [], error: "Constructicon's brand-assets list had an unexpected shape (not a list)" };
    const seen = new Map<string, CxFont>();
    const entries = raw.filter((a): a is { slug: string; title: string } => a && typeof a === "object" && typeof (a as { slug?: unknown }).slug === "string" && typeof (a as { title?: unknown }).title === "string");
    // "Name.otf" before "Name (1).otf", so the original wins the de-duplication.
    entries.sort((a, b) => Number(a.title.includes("(")) - Number(b.title.includes("(")) || a.title.localeCompare(b.title));
    for (const a of entries) {
      const m = FONT_EXT.exec(a.title);
      if (!m || !SLUG.test(a.slug)) continue;
      const name = a.title.slice(0, -m[0].length).replace(/\s*\(\d+\)$/, "").trim() || a.slug;
      if (!seen.has(name)) seen.set(name, { slug: a.slug, name, ext: m[1].toLowerCase() });
    }
    const fonts = [...seen.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    this.cache = { url, at: Date.now(), fonts };
    return { fonts, error: null };
  }

  /**
   * Download one catalogued font into the fonts folder (atomic), and record its display name in
   * names.json there. Returns the folder entry. Throws an Error with a plain reason.
   */
  async fetchInto(url: string, slug: string, fontsDir: string): Promise<{ file: string; name: string }> {
    if (!SLUG.test(slug)) throw new Error(`"${slug.slice(0, 40)}" isn't a Constructicon item slug`);
    const l = await this.list(url);
    const item = l.fonts.find((f) => f.slug === slug);
    if (!item) throw new Error(l.error ? `couldn't check Constructicon's font list: ${l.error}` : `"${slug}" isn't one of Constructicon's fonts (the list may have changed; reload the page)`);
    const file = cachedFontFile(item.slug, item.ext);
    const dest = path.join(fontsDir, file);
    if (!fs.existsSync(dest)) {
      const t = this.token();
      const res = await this.get(url, `/f/${encodeURIComponent(slug)}`, "token" in t ? t.token : null);
      if (!res.ok) throw new Error(`Constructicon answered ${res.status} when asked for "${item.name}"`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length < 4) throw new Error(`Constructicon sent an empty file for "${item.name}"`);
      fs.mkdirSync(fontsDir, { recursive: true });
      const tmp = path.join(fontsDir, `.${file}.${process.pid}.part`);
      try {
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, dest);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw new Error(`couldn't write ${dest} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); check that data/dash/fonts is writable by the container`);
      }
    }
    recordName(fontsDir, file, item.name);
    return { file, name: item.name };
  }
}

/** Adds { file: name } to names.json in the fonts folder, keeping what's there. A broken names.json is left alone and reported. */
function recordName(fontsDir: string, file: string, name: string): void {
  const namesFile = path.join(fontsDir, "names.json");
  let names: Record<string, unknown> = {};
  if (fs.existsSync(namesFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(namesFile, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("it isn't a JSON object");
      names = raw;
    } catch (err) {
      throw new Error(`the font was saved as ${file}, but ${namesFile} couldn't be updated with its name (${(err as Error).message}); fix that file as { "<file>": "<name>" }`);
    }
  }
  if (names[file] === name) return;
  names[file] = name;
  const tmp = `${namesFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(names, null, 2) + "\n");
  fs.renameSync(tmp, namesFile);
}
