/**
 * Camera name -> go2rtc stream names. Shared by the bridge, the admin pane and the open dashboard
 * (each needs the same names), so it lives here and not under src/admin/ (#46).
 */

import { ResolvedCamera } from "../config";

export function streamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "camera";
}

/**
 * Camera name -> go2rtc stream names. Collision-safe in config order: a camera's main slug is
 * bumped (`_2`, `_3`...) until neither it nor its `_sub` twin is taken by an earlier camera.
 */
export function streamNames(cams: Pick<ResolvedCamera, "name" | "rtspSub">[]): Map<string, { main: string; sub?: string }> {
  const used = new Set<string>();
  const out = new Map<string, { main: string; sub?: string }>();
  for (const c of cams) {
    const base = streamSlug(c.name);
    let slug = base;
    for (let i = 2; used.has(slug) || used.has(`${slug}_sub`); i++) slug = `${base}_${i}`;
    used.add(slug);
    const sub = c.rtspSub ? `${slug}_sub` : undefined;
    if (sub) used.add(sub);
    out.set(c.name, { main: slug, sub });
  }
  return out;
}
