/**
 * Dashboard fonts (owner Q3 = a): font files dropped in /data/dash/fonts, with display names in
 * names.json ({ "<file>": "<name>" }). No Constructicon token anywhere; a new font is a new file.
 * A port of Homedash's SYSTEM_FONTS / FONT_MIME / font_spec.
 */

import * as fs from "fs";
import * as path from "path";
import { FONT_FILE, FontSpec } from "./settings";

export interface FontEntry { file: string; name: string }
export type FontOut = { family: string } | { file: string; name: string } | { inherit: true };

export const SYSTEM_FONTS: Record<"sans" | "serif" | "mono", string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "JetBrains Mono", Consolas, monospace',
};
export const FONT_MIME: Record<string, string> = { ".otf": "font/otf", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2" };

/** Never throws. A missing folder is no fonts; an unreadable names.json falls back to file names and says so. */
export function listFonts(dir: string): { fonts: FontEntry[]; warning: string | null } {
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => FONT_FILE.test(f)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { fonts: [], warning: null };
    return { fonts: [], warning: `The fonts folder ${dir} couldn't be read (${(err as Error).message}); only system fonts are offered.` };
  }
  let names: Record<string, unknown> = {};
  let warning: string | null = null;
  const namesFile = path.join(dir, "names.json");
  if (fs.existsSync(namesFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(namesFile, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("it isn't a JSON object");
      names = raw;
    } catch (err) {
      warning = `${namesFile} couldn't be read (${(err as Error).message}); showing the fonts by their file names instead. Fix it as { "<file>": "<name>" }.`;
    }
  }
  const fonts = files.map((file) => {
    const n = names[file];
    return { file, name: typeof n === "string" && n.trim() ? n.trim() : path.parse(file).name };
  });
  fonts.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { fonts, warning };
}

/** What the display page needs for one font role, plus a warning when the chosen file is gone. */
export function fontOut(spec: FontSpec, role: "ui" | "clock", fonts: FontEntry[]): { out: FontOut; warning: string | null } {
  if (spec?.kind === "file") {
    const f = fonts.find((x) => x.file === spec.file);
    if (f) return { out: { file: `/fonts/${f.file}`, name: f.name }, warning: null };
    return { out: { family: SYSTEM_FONTS.sans },
      warning: `The ${role === "ui" ? "interface" : "clock"} font "${spec.file}" isn't in the fonts folder (/data/dash/fonts) any more; using the system font. Put the file back or pick another font in the dashboard settings.` };
  }
  const family = spec?.kind === "system" ? spec.family : "sans";
  if (family === "inherit" && role === "clock") return { out: { inherit: true }, warning: null };
  return { out: { family: SYSTEM_FONTS[family as keyof typeof SYSTEM_FONTS] ?? SYSTEM_FONTS.sans }, warning: null };
}
