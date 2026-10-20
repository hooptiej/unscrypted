# Homedash Moves In: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Homedash (the living-room camera dashboard) into the unscrypted container. The display is served by a third supervised child process (watch-only, no sign-in), and its settings live behind the admin password in the admin pane. Then the Homedash containers and their go2rtc sidecars retire. (hooptiej/unscrypted#3)

**Architecture:** The bridge process stays the boss. Next to go2rtc and the admin pane, it supervises a new child, the **dash server** (`src/dash/main.ts`). The bridge sends the dash child only a public camera list over IPC (names, go2rtc stream names, and RTSP host and port for the reachability probe; never credentials). The dash child never reads `config.json`, the admin password or the session key. The dash child serves the display page and a GET-only JSON API on its own port. It proxies only go2rtc's player script and the `/api/ws` signalling socket, for configured camera streams only, and only WebRTC messages. Video goes straight from go2rtc's WebRTC port (8557/8558) to the browser, exactly as Homedash does today. The dashboard's settings (`/data/dash/settings.json`) are edited only from a new "Dashboard" tab in the signed-in admin pane. The dash child picks up changes by watching the file's mtime.

**Tech Stack:** Node 22 + TypeScript (existing). Node stdlib only (`http`, `net`, `fs`, `crypto`, global `fetch`): **no new runtime dependencies.** `node:test` via `tsx --test` (existing). go2rtc 1.9.14 (already baked in). Vanilla JS for the page, ported from Homedash's `web/`.

**Spec:** hooptiej/unscrypted#3 (`gh issue view 3 -R hooptiej/unscrypted --comments`). Background: `docs/plans/2026-10-19-admin-pane-go2rtc.md` (conventions, sign-in, CSP, go2rtc proxy, supervisor), and Homedash's `docs/superpowers/specs/2026-10-10-homedash-design.md` plus `server/server.py` (behaviour being ported).

## Plain-language glossary (read once)

- **Dash / display page:** the fullscreen page on the living-room Mac mini: 2x2 live camera tiles, clock, date, weather, photo slideshow, service lights.
- **Kiosk:** the Mac mini runs a LaunchAgent (`homedash-kiosk.sh`) that waits for `<URL>/healthz`, then opens `<URL>` in Chrome `--kiosk`. Its URL is set by `HOMEDASH_URL` in the LaunchAgent plist.
- **ipvlan (`questlog-lan`):** Homedash, Constructicon and Questlog each have their own LAN IP through Docker's ipvlan driver. **The NAS host can't talk to its own ipvlan containers** (Linux ipvlan rule). unscrypted runs on the host network, so it inherits that limit. See Findings 1.
- **Watch-only:** the open dash can read and play video. It can never change anything (no POST/PUT/DELETE at all), never sees secrets, and never reaches go2rtc's stream-editing API.
- **WebSocket frame:** the unit a browser sends over a WebSocket. Browser→server frames are always "masked" (XOR with a 4-byte key), so we unmask a frame to read it, check it, and forward the original bytes unchanged.

## Global Constraints

Owner decisions (quote-faithful) and project rules. Every task implicitly includes this section.

- **One container (owner, 2026-10-19):** "just one container would be the goal, probably build the admin on to unscrypted and then use the webserver on it to move the home dash features into." And: "A>B, not c. the intent would be a single container to simplify the setup." No two-container compose.
- **Dash is its own supervised child process.** A dash crash can never take the HomeKit bridge (or the admin pane) down. Restart backoff is the existing `Supervisor` (1 s doubling to 60 s, reset after 5 min healthy). `UNSCRYPTED_DASH=off` switches it off.
- **Accepted trade-off (owner):** any image rebuild restarts the whole container. A dash-only update drops live views and HomeKit recordings for a few seconds. Fine for home use. **Batch dash changes into as few prod deploys as possible.**
- **Role split (owner):** Apple Home (through unscrypted, Apple TV as hub) does notifications and HKSV recording. The dash is only the viewer. He switched from fullscreen Apple Home to Homedash because "our dash is just smoother". **Tile smoothness and latency must not regress:** same go2rtc version, same WebRTC video-only mode, same 1080p main streams, video straight from go2rtc's WebRTC port. Only the signalling WebSocket goes through our proxy.
- **Live video = WebRTC, video only**, through go2rtc's own player (`video-stream.js`, `mode = "webrtc"`, `media = "video"`). These cameras don't play over MSE in Chrome. "we should just copy what works".
- **No sign-in on the display (owner, 2026-10-20 09:25):** "no sign in on the kiosk, free viewing, require the password to view the admin". Guardrails, all required:
  - **Watch only.** Every non-GET request to the dash port gets a 405 with the four-part error. No config writes, no pairing code or QR, no camera logins, no feed-check temp streams, no go2rtc stream editing.
  - **Its own video path.** The dash proxies `/go2rtc/api/ws?src=<name>` only for the main/sub stream names of cameras in `config.json` (from the bridge's IPC list). It rejects `check_*` feed-check streams and anything else with 403. Client messages are filtered to `webrtc/offer` and `webrtc/candidate` only. A connection cap (16) stops one LAN client from opening unlimited camera sessions. The admin pane's own proxy stays behind sign-in, unchanged.
  - **No secrets in the open API.** No passwords, no RTSP URLs, no camera IPs, no setup code, no tokens in any dash response. A test asserts this.
  - **Admin stays separate.** The admin CSRF and session model is unchanged. The dash sends the same security headers (CSP, no framing, nosniff, no-referrer, no-store). The dash never sets a cookie and never reads one. It strips the `Cookie` header before proxying to go2rtc. (Browsers send the admin cookie to every port on the same host, because cookies ignore ports. The dash ignores it. The admin's Origin check compares host:port, so a page on the dash port can't make state-changing admin requests.)
  - **Same reach as today.** Anyone on the LAN can watch the cameras, exactly like the current Homedash. The owner accepted this.
- **NEVER force a HomeKit re-pair:** never touch `bridge.name`/`username`/`setupId` or `./data/persist`, and never rename a camera in `config.json`. Dashboard tile labels are a dashboard-only setting (`label`), separate from the camera's HomeKit name.
- **Never fail silently.** Every error says what was attempted, what happened, what changed, and what to do next (the existing `UserError`). No blank tiles: a dark tile says why ("camera not answering at its RTSP port since 7:42 PM", "video server restarting", "video didn't start: <reason>"). A stale status panel says "stale since <time>". Weather and photos show their failure reason in place. Background loops log, and expose their last error in `/api/state`.
- **Permissions never hide features.** The display's Settings button stays. It opens the admin pane's Dashboard tab, which asks for the password (see Open Question 7). Things the open dash can't do are absent from its API, not hidden in the UI.
- **Dev tab label:** test instance titles are `Homedash - TEST` (dash) and `unscrypted admin - TEST` (pane). Prod: `Homedash`, `unscrypted admin`.
- **Theme:** olive/avocado (Homedash's existing `#8a9a3b`/`#a3b83f` on `#0b0d08`), never emerald.
- **Ports (checked with `ss -lntup` on the NAS 2026-10-20):** dash prod `8180/tcp`, dash test `8181/tcp`. Both are free. Existing: admin `8190`/`8191`, go2rtc API `127.0.0.1:1986`/`1987`, WebRTC `8557`/`8558` (tcp+udp), HAP `51826`, ONVIF notify `8100`. Homedash's go2rtc holds `1984`/`8555` (prod) and `1985`/`8556` (dev) until retirement. Also in use: `80`/`443` (TrueNAS nginx on 10.0.1.78), `22`, `139`/`445`, `3300`, `5357`. Re-check with `sudo ss -lntup | grep -E ':(8180|8181) '` before the first test deploy and again before prod.
- **Docker standard:** code baked into the image. Version `0.3.0` (`unscrypted:0.3.0`, `unscrypted:0.3.0-test`). Pinned base and deps (no new deps). Per-install config via env and `./data`/`./secrets`. Test instance via the existing compose override.
- **Workflow:** issue #3 exists. Branch `feat/homedash-move-3` (this worktree). Commit per task. Live-test on `unscrypted-test` after each phase. One PR at the end, and the owner confirms the merge. No pushes to `main`. Prod deploy only after the merge go-ahead.
- **Test instance:** `unscrypted-test` (admin 8191, WebRTC 8558, HomeKit OFF, motion off) stays running for this work. Rebuilding it never touches prod.
- **Owner rule "ask more, act less":** every Open Question below is held until answered. An unanswered question means that piece waits. It never means "go with the recommendation".
- **Line endings:** the local checkout is CRLF. Use the Edit tool. Check `git diff --stat` for whole-file rewrites before each commit.
- **Secrets on the box:** never print `go2rtc.yaml` stream URLs, camera passwords, `constructicon_token`, or `admin_password`. Print keys and shapes only.

## Findings from the live box (2026-10-20, read-only)

1. **The host network can't reach the ipvlan apps.** From inside `unscrypted-test` (host network), TCP connects to `10.0.1.240` (Constructicon), `.241` (Constructicon test), `.250` (Questlog), `.246` (Questlog dev), `.248`/`.245` (Homedash) all **time out**. SMB (`127.0.0.1:445`), the TrueNAS UI (`10.0.1.78:80`), all four camera RTSP ports, and outbound DNS (Open-Meteo, iCloud) work. Homedash dodges this today with a private `hostlink` bridge, because it lives on the ipvlan side. **Consequence:** the Constructicon and Questlog lights, and any live Constructicon font fetch, can't work from inside unscrypted without a network change (Open Question 1). Everything else ports cleanly.
2. **Scrypted is gone.** Port 30131 is refused and there's no Scrypted container (only `scrypted-mcp`). Homedash prod's `/api/state` right now shows `scrypted: down`, so the living room's **Server light is orange all the time**. Open Question 2.
3. **Camera names don't match.** Homedash's streams are `dogcam`, `backyardcam`, `garagecam`, `onvif_camera` (+ `_sub`), with labels DogCam, BackyardCam, Garagecam, ONVIF Camera. unscrypted's cameras are `Couch Cam` (Foscam, not on Homedash), `GarageCamTest`, `BackyardCamTest`, `OnvifCamTest`, `DogCamTest`. Their go2rtc slugs are `couch_cam`, `garagecamtest`, `backyardcamtest`, `onvifcamtest`, `dogcamtest`. The names are HomeKit identity and can't change, so the dash keeps its own labels and order. That makes **5 cameras for a 2x2 grid** (Open Question 5).
4. **Homedash prod uses a Constructicon font** for both the UI and the clock (slug `rMrRHh34w5nN`). Three font files are cached in `~/homedash/data/fonts` (73 KB). The dev instance uses system serif. The photo source is an iCloud shared album: 413 photos, a 625 MB cache in `~/homedash/data/cache/icloud`. Weather has a place plus pinned lat/lon. No service-tree override in `data/config.json`.
5. **Homedash's `/admin` has no sign-in today.** Anyone on the LAN can POST settings. Moving settings behind the admin password tightens this.
6. **The kiosk URL is probably the IP, not the name.** Homedash #24 (open) found launchd can't resolve `homedash.local`, and its fix defaults `HOMEDASH_URL` to `http://10.0.1.248`. One signalling WebSocket was open from `10.0.1.101` (likely the Mac mini) to Homedash's go2rtc `:1984`. Confirm the plist's URL on the Mac before cutover (Task 15, Step 1).
7. **Homedash's go2rtc sidecars run `alexxit/go2rtc` unpinned** (resolves to 1.9.14 today). Prod's go2rtc holds about 40 UDP sockets (about 10 on 5353 plus many ephemeral ports), which may be stale WebRTC sessions. This doesn't matter once it retires, but if the new dash shows socket growth, compare.
8. **Avahi aliases** are plain systemd units in `/etc/systemd/system/<name>-mdns.service`, each `avahi-publish -a -R <name>.local <ip>` with `Wants=avahi-daemon.service`. `homedash-mdns` points at `10.0.1.248` and `homedash-dev-mdns` at `.245`. The ONVIF push receiver now listens on `8100` (#2's notes said 8101). `~/homedash` is a git clone. `~/homedash-dev` isn't.
9. **CSP gotcha.** Homedash injects `@font-face` through an inline `<style>` element, and its settings page uses an inline `<style>` block. unscrypted's CSP (`style-src 'self'`) blocks both. The port uses the `FontFace` API and an external stylesheet. CSSOM (`el.style.x = ...`) is fine under CSP.
10. **Camera RTSP sessions while testing.** During the test phases each camera may have up to four pullers: unscrypted prod's prebuffer ffmpeg, Homedash's go2rtc (only while someone watches), test go2rtc (while the test dash is open), plus the Mac. The XM cameras may cap concurrent RTSP sessions. If a tile on either dash goes dark only while both are open, that's why. Close the test page when you're not looking at it.

## Feature inventory: where everything lands

| Homedash feature (today) | Lands in unscrypted | Decision needed? |
|---|---|---|
| Live camera tiles, 2x2, WebRTC video-only, 1080p main streams, "reconnecting..." amber tile when the camera's RTSP port is down | `web/dash/app.js` tiles; stream names from bridge IPC; TCP probe per `pollSeconds` in the dash child (Task 2, 4, 5) | Q5 (5 cameras), Q6 (labels), Q12 (main/sub) |
| Fullscreen camera on click, idle countdown back to grid, "tap anywhere to stay" | Ported as-is (Task 5) | No |
| go2rtc sidecar + `secrets/go2rtc.yaml` | Replaced by the bundled go2rtc, streams generated from `config.json` (#2) | Retire after soak (Q10) |
| Service status outline with rollup (Server, SMB, Scrypted, Constructicon(+dev), Questlog(+dev)), links open in new tab, 2-miss debounce | `src/dash/services.ts` (Task 6). Server/SMB work. Constructicon/Questlog need a network change | **Q1** (reachability), **Q2** (Scrypted light) |
| Clock, day, date | Ported as-is (Task 5) | No |
| Weather (Open-Meteo, geocode once, WMO text, high/low, sunrise/sunset) | `src/dash/weather.ts` (Task 7) | No |
| Sun-driven olive/warm background glow; `?t=HH:MM` override; `?tune` slider | Ported as-is (Task 5) | No |
| Photo slideshow: iCloud shared album or NAS folder, crossfade, shuffle, caption, cache | `src/dash/photos.ts` (Task 8). Cache seeded from Homedash's (Task 15) | No |
| Fonts: system stacks or Constructicon font items (read-only token, cached locally) | `src/dash/fonts.ts` (Task 9): fonts from `/data/dash/fonts` | **Q3** (keep live Constructicon fetch?) |
| Self-refresh every `reload_minutes` (never while fullscreen) | Ported, plus an immediate reload when settings change (Task 5, 10) | No |
| `/healthz` (the kiosk's wait probe) | Dash port `/healthz` (Task 4) | No |
| Settings page `/admin` (fonts, camera label/shown, fullscreen timeout, refresh, photos, weather), idle-return when opened from the dash | "Dashboard" tab in the signed-in admin pane (Task 11) | **Q7** (kiosk sign-in flow), **Q8** (look) |
| Settings button on the display | Kept, opens `http://<host>:<adminPort>/#/dash?from=dash` | Q7 |
| `data/config.json` | `/data/dash/settings.json` (+ `fonts/`, `photos/`, `cache/icloud/`), imported once (Task 12) | No |
| Dev/prod split (`homedash-dev` on .245, "DEV" badge, "Homedash - DEV" title) | `unscrypted-test` dash on 8181, title "Homedash - TEST" | Q10 (retire homedash-dev) |
| Own LAN IP + `homedash.local` mDNS | Dash on `10.0.1.78:8180`. Kiosk re-pointed | **Q4** |
| Mac kiosk scripts (`scripts/mac-kiosk/`) | Moved to unscrypted, new default URL (Task 14) | Q9 |
| Nothing (silent today): failed fetches swallowed, black tile when WebRTC fails, weather/photo/font errors only in the log | Every one gets a visible reason (Tasks 5-10) | No (global rule) |

## File structure

New files:

| Path | Responsibility |
|---|---|
| `src/dash/settings.ts` | Dashboard settings type, defaults, load (never overwrites a bad file), validate an edit, atomic save, camera-pref reconciliation. Pure + one fs function. |
| `src/dash/ipc.ts` | Bridge→dash message types and `dashCameras()`, the credential-free camera list. |
| `src/dash/wsFilter.ts` | Stateful parser that passes only WebRTC signalling messages from the browser. |
| `src/dash/services.ts` | Status checks (tcp, alive, http, bridge), 2-miss debounce, rollup tree with reasons. |
| `src/dash/weather.ts` | Geocode + forecast via Open-Meteo, WMO table. Injectable fetch. |
| `src/dash/photos.ts` | Folder and iCloud shared-album sources, cache, `PhotoLibrary`. Injectable I/O. |
| `src/dash/fonts.ts` | Font files in `/data/dash/fonts` (+ `names.json`), font spec → page output. |
| `src/dash/runtime.ts` | `DashRuntime`: holds cameras, bridge info, settings, and the loops; builds `/api/config` and `/api/state`. |
| `src/dash/server.ts` | GET-only HTTP server, static files, go2rtc script + WS proxy with allowlist, filter and cap. |
| `src/dash/main.ts` | Dash child entry, forked and supervised by the bridge. |
| `src/dash/importHomedash.ts` | One-shot CLI: Homedash `data/config.json` (+ font names) → `settings.json`. |
| `web/dash/index.html`, `app.js`, `style.css` | The display page, ported from Homedash `web/`. |
| `test/dash/*.test.ts` | Unit tests. |
| `scripts/mac-kiosk/*` | Moved from homedash (only if Q9 = a). |

Modified: `src/bridgeRuntime.ts` (third child + IPC), `src/index.ts` (dash options from env), `src/admin/server.ts` (export `securityHeaders`; `/api/dash/settings` routes), `web/admin/app.js` + `index.html` + `style.css` (Dashboard tab), `package.json` (0.3.0), `Dockerfile`, `docker-compose.yml`, `docker-compose.test.yml`, `README.md`.

---

## Phase 0: Ready the branch (no visible change)

### Task 0: Version bump and owner answers

**Files:** Modify `package.json`, `docker-compose.yml`, `docker-compose.test.yml`

- [ ] **Step 1: Hold for answers.** Open Questions 1-12 are put to the owner by the coordinator. Record the answers under "Owner decisions" at the bottom of this file before starting any task they gate: Q5/Q6/Q12 gate Task 1 defaults, Q1/Q2 gate Task 6, Q3 gates Task 9, Q7/Q8 gate Task 11, Q4/Q9 gate Task 14/15, Q10 gates Task 16, Q11 gates Task 13.
- [ ] **Step 2: Bump the version first,** so every test build is tagged `0.3.0-test` and the old `0.2.0`/`0.2.0-test` images stay on the box as rollbacks. In `package.json`: `"version": "0.3.0"`. In `docker-compose.yml`: `image: unscrypted:0.3.0`. In `docker-compose.test.yml`: `image: unscrypted:0.3.0-test`.
- [ ] **Step 3:** `npm run typecheck && npm test`. Expect PASS (nothing else changed).
- [ ] **Step 4: Commit.** `git commit -am "build: v0.3.0 for the Homedash move-in (#3)"` with the attribution trailer.

---

## Phase 1: The dash child stands up (owner sees: a clock page at `http://10.0.1.78:8181`)

### Task 1: Dashboard settings

**Files:**
- Create: `src/dash/settings.ts`
- Test: `test/dash/settings.test.ts`

**Interfaces:**
- Produces: the types `DashSettings`, `DashCameraPref`, `FontSpec`, `ServiceNode`, `ServiceCheck`; the constants `DEFAULTS`, `DEFAULT_SERVICES`, `GRID_MAX`; and the functions `loadSettings(file): { settings: DashSettings; warning: string | null; mtimeMs: number }`, `applySettingsEdit(cur, edit, ctx: { cameras: string[]; fontFiles: string[] }): DashSettings` (throws `UserError`), `saveSettings(file, s): { backupPath: string | null }`, and `effectiveCameras(s, cameraNames): (DashCameraPref & { missing: boolean })[]`.

- [ ] **Step 1: Write the failing test** `test/dash/settings.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "../helpers/tmp";
import { DEFAULTS, loadSettings, applySettingsEdit, saveSettings, effectiveCameras, GRID_MAX } from "../../src/dash/settings";
import { UserError } from "../../src/admin/errors";

const ctx = { cameras: ["DogCamTest", "BackyardCamTest", "GarageCamTest", "OnvifCamTest", "Couch Cam"], fontFiles: ["rMrRHh34w5nN.otf"] };

test("missing file gives defaults and no warning", () => {
  const r = loadSettings(path.join(tempDir("unscr-dash-"), "settings.json"));
  assert.deepEqual(r.settings, DEFAULTS);
  assert.equal(r.warning, null);
});

test("broken file gives defaults plus a warning, and is not overwritten", () => {
  const f = path.join(tempDir("unscr-dash-"), "settings.json");
  fs.writeFileSync(f, "{not json");
  const r = loadSettings(f);
  assert.deepEqual(r.settings, DEFAULTS);
  assert.match(r.warning!, /settings\.json.*couldn't be read/i);
  assert.equal(fs.readFileSync(f, "utf8"), "{not json");
});

test("partial file is merged over defaults", () => {
  const f = path.join(tempDir("unscr-dash-"), "settings.json");
  fs.writeFileSync(f, JSON.stringify({ idleSeconds: 45, weather: { place: "Sterling, CO" } }));
  const s = loadSettings(f).settings;
  assert.equal(s.idleSeconds, 45);
  assert.equal(s.weather.place, "Sterling, CO");
  assert.equal(s.weather.unit, "fahrenheit");
});

test("edit validates ranges with the field name and changes nothing", () => {
  assert.throws(() => applySettingsEdit(DEFAULTS, { idleSeconds: 2 }, ctx), (e: unknown) =>
    e instanceof UserError && /Fullscreen timeout/.test(e.body.happened) && /Nothing was saved/.test(e.body.changed));
});

test("edit refuses an unknown camera and more than GRID_MAX shown", () => {
  assert.throws(() => applySettingsEdit(DEFAULTS, { cameras: [{ camera: "Nope", label: "x", shown: true, stream: "main" }] }, ctx), /isn't in config\.json/);
  const five = ctx.cameras.map((c) => ({ camera: c, label: c, shown: true, stream: "main" }));
  assert.throws(() => applySettingsEdit(DEFAULTS, { cameras: five }, ctx), new RegExp(`at most ${GRID_MAX}`));
});

test("labels are dashboard-only and never touch camera names", () => {
  const s = applySettingsEdit(DEFAULTS, { cameras: [{ camera: "DogCamTest", label: "DogCam", shown: true, stream: "main" }] }, ctx);
  assert.deepEqual(s.cameras, [{ camera: "DogCamTest", label: "DogCam", shown: true, stream: "main" }]);
});

test("a font must be a file in the fonts folder", () => {
  assert.throws(() => applySettingsEdit(DEFAULTS, { fonts: { ui: { kind: "file", file: "../etc/passwd" } } }, ctx), /isn't in the fonts folder/);
  const s = applySettingsEdit(DEFAULTS, { fonts: { clock: { kind: "file", file: "rMrRHh34w5nN.otf" } } }, ctx);
  assert.deepEqual(s.fonts.clock, { kind: "file", file: "rMrRHh34w5nN.otf" });
});

test("a new place clears pinned coordinates unless new ones are given", () => {
  const pinned = { ...DEFAULTS, weather: { ...DEFAULTS.weather, place: "A", lat: 1, lon: 2 } };
  const s = applySettingsEdit(pinned, { weather: { place: "B" } }, ctx);
  assert.equal(s.weather.lat, null);
  assert.equal(s.weather.lon, null);
});

test("iCloud link must be a shared-album link", () => {
  assert.throws(() => applySettingsEdit(DEFAULTS, { photos: { icloudUrl: "https://evil.example/x" } }, ctx), /shared-album link/);
});

test("save is atomic and keeps the previous file as .bak", () => {
  const f = path.join(tempDir("unscr-dash-"), "settings.json");
  saveSettings(f, DEFAULTS);
  const r = saveSettings(f, { ...DEFAULTS, idleSeconds: 60 });
  assert.equal(r.backupPath, f + ".bak");
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).idleSeconds, 60);
  assert.equal(JSON.parse(fs.readFileSync(f + ".bak", "utf8")).idleSeconds, DEFAULTS.idleSeconds);
  assert.equal(fs.existsSync(f + ".tmp"), false);
});

test("effectiveCameras: prefs in order, unknown new cameras appended hidden, missing ones flagged", () => {
  const s = { ...DEFAULTS, cameras: [{ camera: "Gone", label: "Old", shown: true, stream: "main" as const }, { camera: "DogCamTest", label: "DogCam", shown: true, stream: "main" as const }] };
  const e = effectiveCameras(s, ["DogCamTest", "Couch Cam"]);
  assert.deepEqual(e.map((c) => [c.camera, c.shown, c.missing]), [["Gone", true, true], ["DogCamTest", true, false], ["Couch Cam", false, false]]);
});
```

- [ ] **Step 2: Run it.** `npx tsx --test test/dash/settings.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `src/dash/settings.ts`:

```ts
/**
 * The dashboard's own settings (/data/dash/settings.json). Kept apart from config.json so a bad
 * dashboard setting can never break camera config or HomeKit. Edited only from the signed-in
 * admin pane; the open dash process only reads it.
 */

import * as fs from "fs";
import * as path from "path";
import { UserError } from "../admin/errors";

export type SystemFamily = "sans" | "serif" | "mono" | "inherit";
export type FontSpec = { kind: "system"; family: SystemFamily } | { kind: "file"; file: string };
export type ServiceCheck =
  | { kind: "tcp"; host: string; port: number }
  | { kind: "alive"; host: string; port: number }
  | { kind: "http"; url: string; ok: "any" | "200" }
  | { kind: "bridge" };
export interface ServiceNode { id: string; name: string; link?: string; rollup?: boolean; check: ServiceCheck; children?: ServiceNode[] }
export interface DashCameraPref { camera: string; label: string; shown: boolean; stream: "main" | "sub" }
export interface DashSettings {
  idleSeconds: number;
  pollSeconds: number;
  reloadMinutes: number;
  /** Grid order. `camera` is the config.json camera name (HomeKit identity, never edited here). */
  cameras: DashCameraPref[];
  weather: { place: string; lat: number | null; lon: number | null; unit: "fahrenheit" | "celsius"; refreshSeconds: number };
  photos: { source: "folder" | "icloud"; folder: string; icloudUrl: string; rotateSeconds: number; refreshMinutes: number; maxPhotos: number; caption: string };
  fonts: { ui: FontSpec; clock: FontSpec };
  services: ServiceNode[];
}

export const GRID_MAX = 4;
export const FONT_FILE = /^[A-Za-z0-9_-]{1,64}\.(otf|ttf|woff2?)$/;

// Hosts as seen from the NAS's own network (unscrypted runs with host networking).
// The Constructicon/Questlog entries depend on Open Question 1; Scrypted's on Open Question 2.
export const DEFAULT_SERVICES: ServiceNode[] = [
  { id: "server", name: "Server", rollup: true, check: { kind: "alive", host: "10.0.1.78", port: 80 }, children: [
    { id: "smb", name: "SMB", check: { kind: "tcp", host: "127.0.0.1", port: 445 } },
    { id: "homekit", name: "HomeKit bridge", check: { kind: "bridge" } },
    { id: "constructicon", name: "Constructicon", link: "http://constructicon.local", check: { kind: "http", url: "http://10.0.1.240/", ok: "any" }, children: [
      { id: "constructicon-dev", name: "dev", link: "http://10.0.1.241", check: { kind: "http", url: "http://10.0.1.241/", ok: "any" } },
    ] },
    { id: "questlog", name: "Questlog", link: "http://questlog.local", check: { kind: "http", url: "http://10.0.1.250/", ok: "200" }, children: [
      { id: "questlog-dev", name: "dev", link: "http://questlog-dev.local", check: { kind: "http", url: "http://10.0.1.246/", ok: "200" } },
    ] },
  ] },
];

export const DEFAULTS: DashSettings = {
  idleSeconds: 30,
  pollSeconds: 4,
  reloadMinutes: 20,
  cameras: [],
  weather: { place: "", lat: null, lon: null, unit: "fahrenheit", refreshSeconds: 600 },
  photos: { source: "folder", folder: "/data/dash/photos", icloudUrl: "", rotateSeconds: 20, refreshMinutes: 30, maxPhotos: 0, caption: "" },
  fonts: { ui: { kind: "system", family: "sans" }, clock: { kind: "system", family: "inherit" } },
  services: DEFAULT_SERVICES,
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function bad(field: string, msg: string): UserError {
  return new UserError({ attempted: "Save the dashboard settings", happened: `${field}: ${msg}`, changed: "Nothing was saved.", next: "Fix that field and save again." });
}

/** Never throws, never writes. A broken file falls back to defaults and says so. */
export function loadSettings(file: string): { settings: DashSettings; warning: string | null; mtimeMs: number } {
  let text: string;
  let mtimeMs = 0;
  try {
    text = fs.readFileSync(file, "utf8");
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: clone(DEFAULTS), warning: null, mtimeMs: 0 };
    return { settings: clone(DEFAULTS), warning: `${file} couldn't be read (${(err as Error).message}); showing default dashboard settings.`, mtimeMs };
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("it isn't a JSON object");
    const d = clone(DEFAULTS);
    const s: DashSettings = {
      ...d, ...raw,
      weather: { ...d.weather, ...(raw.weather ?? {}) },
      photos: { ...d.photos, ...(raw.photos ?? {}) },
      fonts: { ...d.fonts, ...(raw.fonts ?? {}) },
      cameras: Array.isArray(raw.cameras) ? raw.cameras : d.cameras,
      services: Array.isArray(raw.services) ? raw.services : d.services,
    };
    return { settings: s, warning: null, mtimeMs };
  } catch (err) {
    return { settings: clone(DEFAULTS), warning: `${file} couldn't be read (${(err as Error).message}); showing default dashboard settings. Fix it from the admin pane's Dashboard tab (saving rewrites it).`, mtimeMs };
  }
}

const int = (v: unknown, lo: number, hi: number, label: string): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isInteger(n)) throw bad(label, "must be a whole number");
  if (n < lo || n > hi) throw bad(label, `must be between ${lo} and ${hi}`);
  return n;
};
const text = (v: unknown, max: number, label: string): string => {
  const s = String(v ?? "").trim();
  if (s.length > max) throw bad(label, `is too long (at most ${max} characters)`);
  return s;
};
const coord = (v: unknown, lo: number, hi: number, label: string): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(label, "must be a number");
  if (n < lo || n > hi) throw bad(label, `must be between ${lo} and ${hi}`);
  return n;
};
function font(v: any, role: "ui" | "clock", fontFiles: string[]): FontSpec {
  const label = role === "ui" ? "Interface font" : "Clock font";
  if (v?.kind === "system") {
    const ok = role === "clock" ? ["sans", "serif", "mono", "inherit"] : ["sans", "serif", "mono"];
    if (!ok.includes(v.family)) throw bad(label, `"${v.family}" isn't one of ${ok.join(", ")}`);
    return { kind: "system", family: v.family };
  }
  if (v?.kind === "file") {
    if (typeof v.file !== "string" || !FONT_FILE.test(v.file) || !fontFiles.includes(v.file)) throw bad(label, `"${v.file}" isn't in the fonts folder (/data/dash/fonts)`);
    return { kind: "file", file: v.file };
  }
  throw bad(label, "must be a system font or a font file");
}

/** Validates a partial edit and returns the whole new settings. Throws UserError; never writes. */
export function applySettingsEdit(cur: DashSettings, edit: any, ctx: { cameras: string[]; fontFiles: string[] }): DashSettings {
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) throw bad("Request", "wasn't a settings object");
  const s = clone(cur);
  if ("idleSeconds" in edit) s.idleSeconds = int(edit.idleSeconds, 5, 600, "Fullscreen timeout (s)");
  if ("pollSeconds" in edit) s.pollSeconds = int(edit.pollSeconds, 2, 60, "Status check interval (s)");
  if ("reloadMinutes" in edit) s.reloadMinutes = int(edit.reloadMinutes, 1, 1440, "Page refresh (min)");
  if ("cameras" in edit) {
    if (!Array.isArray(edit.cameras)) throw bad("Cameras", "must be a list");
    const seen = new Set<string>();
    s.cameras = edit.cameras.map((c: any) => {
      const camera = String(c?.camera ?? "");
      if (!ctx.cameras.includes(camera)) throw bad("Cameras", `"${camera}" isn't in config.json (add cameras on the Cameras tab)`);
      if (seen.has(camera)) throw bad("Cameras", `"${camera}" is listed twice`);
      seen.add(camera);
      const label = text(c.label, 40, `Label for ${camera}`) || camera;
      if (c.stream !== "main" && c.stream !== "sub") throw bad(`Stream for ${camera}`, "must be main or sub");
      return { camera, label, shown: c.shown === true, stream: c.stream };
    });
    const shown = s.cameras.filter((c) => c.shown).length;
    if (shown > GRID_MAX) throw bad("Cameras", `the grid shows at most ${GRID_MAX}; ${shown} are switched on. Switch one off.`);
  }
  if ("weather" in edit) {
    const w = edit.weather ?? {};
    if ("unit" in w) {
      if (w.unit !== "fahrenheit" && w.unit !== "celsius") throw bad("Temperature unit", "must be fahrenheit or celsius");
      s.weather.unit = w.unit;
    }
    if ("place" in w) {
      const place = text(w.place, 80, "Weather place");
      if (place !== s.weather.place && !("lat" in w)) { s.weather.lat = null; s.weather.lon = null; }
      s.weather.place = place;
    }
    if ("lat" in w) s.weather.lat = coord(w.lat, -90, 90, "Latitude");
    if ("lon" in w) s.weather.lon = coord(w.lon, -180, 180, "Longitude");
  }
  if ("photos" in edit) {
    const p = edit.photos ?? {};
    if ("source" in p) {
      if (p.source !== "icloud" && p.source !== "folder") throw bad("Photo source", "must be iCloud or folder");
      s.photos.source = p.source;
    }
    if ("icloudUrl" in p) {
      const u = text(p.icloudUrl, 400, "iCloud link");
      if (u && !u.startsWith("https://www.icloud.com/sharedalbum/")) throw bad("iCloud link", "doesn't look like an iCloud shared-album link (https://www.icloud.com/sharedalbum/#...)");
      s.photos.icloudUrl = u;
    }
    if ("folder" in p) {
      const f = text(p.folder, 300, "Photo folder");
      if (f && !path.posix.isAbsolute(f)) throw bad("Photo folder", "must be a full path inside the container, e.g. /data/dash/photos");
      s.photos.folder = f;
    }
    if ("rotateSeconds" in p) s.photos.rotateSeconds = int(p.rotateSeconds, 3, 600, "Seconds per photo");
    if ("caption" in p) s.photos.caption = text(p.caption, 80, "Caption");
  }
  if ("fonts" in edit) {
    const f = edit.fonts ?? {};
    for (const role of Object.keys(f)) if (role !== "ui" && role !== "clock") throw bad("Fonts", `unknown font role "${role}"`);
    if (f.ui) s.fonts.ui = font(f.ui, "ui", ctx.fontFiles);
    if (f.clock) s.fonts.clock = font(f.clock, "clock", ctx.fontFiles);
  }
  return s;
}

/** Atomic write (temp file, fsync, rename). The previous file is kept as settings.json.bak. */
export function saveSettings(file: string, s: DashSettings): { backupPath: string | null } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backupPath: string | null = null;
  if (fs.existsSync(file)) { fs.copyFileSync(file, file + ".bak"); backupPath = file + ".bak"; }
  const tmp = file + ".tmp";
  const fd = fs.openSync(tmp, "w", 0o644);
  try { fs.writeSync(fd, JSON.stringify(s, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  return { backupPath };
}

/**
 * Preferences in grid order, plus every config.json camera that has no preference yet (appended,
 * not shown, so a newly added camera is listed in Settings rather than silently absent).
 */
export function effectiveCameras(s: DashSettings, cameraNames: string[]): (DashCameraPref & { missing: boolean })[] {
  const out = s.cameras.map((c) => ({ ...c, missing: !cameraNames.includes(c.camera) }));
  for (const n of cameraNames) if (!s.cameras.some((c) => c.camera === n)) out.push({ camera: n, label: n, shown: false, stream: "main", missing: false });
  return out;
}
```

- [ ] **Step 4:** `npx tsx --test test/dash/settings.test.ts`. Expect PASS. Then `npm run typecheck`.
- [ ] **Step 5: Commit.** `git add src/dash/settings.ts test/dash/settings.test.ts && git commit -m "feat(dash): dashboard settings file, validation and atomic save (#3)"`

### Task 2: Credential-free camera list, the dash child, and a clock page

**Files:**
- Create: `src/dash/ipc.ts`, `src/dash/runtime.ts` (first cut), `src/dash/server.ts` (first cut), `src/dash/main.ts`, `web/dash/index.html`, `web/dash/style.css`, `web/dash/app.js` (clock only)
- Modify: `src/bridgeRuntime.ts`, `src/index.ts`, `src/admin/server.ts` (add `export` to `securityHeaders`)
- Test: `test/dash/ipc.test.ts`, `test/dash/server.test.ts` (first cut), `test/admin/bridgeRuntime.test.ts` (add a case)

**Interfaces:**
- Consumes: `streamNames()` from `src/admin/go2rtcConfig.ts`, `Supervisor` from `src/admin/supervisor.ts`, `securityHeaders(req)` from `src/admin/server.ts`.
- Produces:
  - `interface DashCamera { name: string; main: string; sub: string | null; probe: { host: string; port: number } | null }`
  - `interface DashBridgeInfo { hapEnabled: boolean; paired: boolean; go2rtc: { state: string; lastError: string | null; nextRetryAt: number | null } }`
  - `type ToDash = { type: "cameras"; cameras: DashCamera[] } | { type: "bridge"; bridge: DashBridgeInfo }`
  - `dashCameras(cfg: Pick<ResolvedConfig, "cameras">): DashCamera[]`
  - `checkToDash(m: unknown): ToDash | string`
  - `createDashServer(d: DashDeps): http.Server`
  - Bridge env for the dash child: `UNSCRYPTED_DASH_PORT`, `UNSCRYPTED_DASH_DIR`, `UNSCRYPTED_DASH_TITLE`, `UNSCRYPTED_GO2RTC_API`, `UNSCRYPTED_ADMIN_PORT`, `UNSCRYPTED_HAP`, `UNSCRYPTED_LOG_LEVEL`, `PATH`, `TZ`, `NODE_ENV` (an allowlist, not `...process.env`).

- [ ] **Step 1: Failing tests.** `test/dash/ipc.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dashCameras, checkToDash } from "../../src/dash/ipc";

const cams = [
  { name: "DogCamTest", rtspMain: "rtsp://admin:s3cret@10.0.1.99:554/11", rtspSub: "rtsp://admin:s3cret@10.0.1.99:554/12" },
  { name: "Couch Cam", rtspMain: "rtsp://u:pw@10.0.1.50/videoMain" },
  { name: "Broken", rtspMain: "not a url" },
] as any;

test("dashCameras carries stream names and probe host/port, never credentials or URLs", () => {
  const out = dashCameras({ cameras: cams });
  assert.deepEqual(out[0], { name: "DogCamTest", main: "dogcamtest", sub: "dogcamtest_sub", probe: { host: "10.0.1.99", port: 554 } });
  assert.deepEqual(out[1], { name: "Couch Cam", main: "couch_cam", sub: null, probe: { host: "10.0.1.50", port: 554 } });
  assert.equal(out[2].probe, null);
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /s3cret|pw|rtsp:|admin/);
});

test("checkToDash rejects malformed messages with a reason", () => {
  assert.equal(typeof checkToDash({ type: "nope" }), "string");
  assert.equal(typeof checkToDash({ type: "cameras", cameras: "x" }), "string");
  assert.deepEqual(checkToDash({ type: "cameras", cameras: [] }), { type: "cameras", cameras: [] });
});
```

`test/dash/server.test.ts` (first cut; Task 4 extends it):

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { AddressInfo } from "net";
import { tempDir } from "../helpers/tmp";
import { createDashServer, DashDeps } from "../../src/dash/server";
import { setLogLevel } from "../../src/logger";

setLogLevel("error");
let base = "";
let srv: http.Server;
export const webRoot = tempDir("unscr-dashweb-");

export function deps(over: Partial<DashDeps> = {}): DashDeps {
  return {
    webRoot, title: "Homedash - TEST", go2rtcApi: "",
    publicConfig: () => ({ title: "Homedash - TEST", env: "test", adminPort: 8191, idleSeconds: 30, pollSeconds: 4, reloadMinutes: 20, cameras: [], fonts: { ui: { family: "x" }, clock: { inherit: true } } }),
    state: () => ({ updated: 1 } as any),
    allowedStreams: () => new Set<string>(),
    go2rtcInfo: () => ({ state: "running", lastError: null, nextRetryAt: null }),
    photoFile: () => null, fontsDir: tempDir("unscr-dashfonts-"),
    ...over,
  };
}

before(async () => {
  fs.writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>__TITLE__</title>");
  fs.writeFileSync(path.join(webRoot, "app.js"), "export {};");
  fs.writeFileSync(path.join(webRoot, "style.css"), "body{}");
  srv = createDashServer(deps());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(() => srv.close());

test("page has the title and the security headers, and sets no cookie", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>Homedash - TEST<\/title>/);
  assert.match(r.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("set-cookie"), null);
});

test("healthz answers for the kiosk's wait probe", async () => {
  assert.deepEqual(await (await fetch(base + "/healthz")).json(), { ok: true });
});

test("watch only: every non-GET is refused with the four-part error", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    for (const p of ["/", "/api/config", "/api/state", "/api/dash/settings", "/go2rtc/api/streams"]) {
      const r = await fetch(base + p, { method, body: method === "DELETE" ? undefined : "{}" });
      assert.equal(r.status, 405, `${method} ${p}`);
      const b = await r.json();
      assert.ok(b.error.attempted && b.error.happened && b.error.changed && b.error.next);
      assert.match(b.error.next, /admin pane/);
    }
  }
});

test("unknown paths are a 404 with a reason, not a blank page", async () => {
  const r = await fetch(base + "/api/pairing");
  assert.equal(r.status, 404);
  assert.match((await r.json()).error.happened, /No such page/);
});
```

- [ ] **Step 2:** `npx tsx --test test/dash/ipc.test.ts test/dash/server.test.ts`. Expect FAIL (modules missing).

- [ ] **Step 3: `src/dash/ipc.ts`:**

```ts
/**
 * Bridge -> dash child messages. The dash child gets ONLY what it needs to show video and probe
 * reachability: camera names, go2rtc stream names, and RTSP host:port. Never credentials, never
 * URLs. The dash child never reads config.json itself.
 */

import { ResolvedConfig } from "../config";
import { streamNames } from "../admin/go2rtcConfig";

export interface DashCamera { name: string; main: string; sub: string | null; probe: { host: string; port: number } | null }
export interface DashBridgeInfo { hapEnabled: boolean; paired: boolean; go2rtc: { state: string; lastError: string | null; nextRetryAt: number | null } }
export type ToDash = { type: "cameras"; cameras: DashCamera[] } | { type: "bridge"; bridge: DashBridgeInfo };

function probeOf(url: string): DashCamera["probe"] {
  try {
    const u = new URL(url);
    return u.hostname ? { host: u.hostname, port: Number(u.port || 554) } : null;
  } catch {
    return null;   // the bridge logs unparseable URLs; the tile says "address can't be read"
  }
}

export function dashCameras(cfg: Pick<ResolvedConfig, "cameras">): DashCamera[] {
  const names = streamNames(cfg.cameras);
  return cfg.cameras.map((c) => {
    const n = names.get(c.name)!;
    return { name: c.name, main: n.main, sub: n.sub ?? null, probe: probeOf(c.rtspMain) };
  });
}

export function checkToDash(m: unknown): ToDash | string {
  if (!m || typeof m !== "object") return "message is not an object";
  const o = m as Record<string, unknown>;
  if (o.type === "cameras") return Array.isArray(o.cameras) ? { type: "cameras", cameras: o.cameras as DashCamera[] } : "cameras message has no list";
  if (o.type === "bridge") return o.bridge && typeof o.bridge === "object" ? { type: "bridge", bridge: o.bridge as DashBridgeInfo } : "bridge message has no status";
  return `unknown message type ${JSON.stringify(o.type)}`;
}
```

- [ ] **Step 4: `src/dash/server.ts` (first cut).** Export `securityHeaders` from `src/admin/server.ts` (change `function securityHeaders` to `export function securityHeaders`; no other change). Then:

```ts
/**
 * The open, watch-only dashboard server (runs in the forked dash child). GET only. No cookies are
 * set or read. Every failure is the four-part plain-words error. See the plan's Global
 * Constraints for the guardrails; the admin pane is the only place anything can be changed.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { UserError, toErrorJson } from "../admin/errors";
import { securityHeaders } from "../admin/server";
import { Logger } from "../logger";

export interface PublicConfig {
  title: string; env: "prod" | "test"; adminPort: number;
  idleSeconds: number; pollSeconds: number; reloadMinutes: number;
  cameras: { id: string; label: string; stream: string }[];
  fonts: { ui: unknown; clock: unknown };
}

export interface DashDeps {
  webRoot: string;
  title: string;
  /** go2rtc's loopback API base, "" when go2rtc is off. */
  go2rtcApi: string;
  publicConfig: () => PublicConfig;
  state: () => unknown;
  /** Stream names the open page may play: main/sub of every camera in config.json. */
  allowedStreams: () => Set<string>;
  go2rtcInfo: () => { state: string; lastError: string | null; nextRetryAt: number | null };
  photoFile: (id: string) => string | null;
  fontsDir: string;
  maxStreams?: number;   // default 16 (Task 4)
  log?: Logger;
}

const STATIC: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

export function createDashServer(d: DashDeps): http.Server {
  const log = d.log ?? new Logger("dash");
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(securityHeaders(req))) res.setHeader(k, v);
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    let attempted = `${method} ${url.pathname}`;
    try {
      if (method !== "GET" && method !== "HEAD") {
        throw new UserError({ attempted, happened: "The dashboard is watch-only: it never changes anything.", changed: "Nothing.",
          next: "Change dashboard settings in the admin pane's Dashboard tab (needs the admin password)." }, 405);
      }
      if (url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
      if (STATIC[url.pathname]) {
        attempted = "Load the dashboard";
        const file = path.join(d.webRoot, STATIC[url.pathname]);
        let body: string;
        try { body = fs.readFileSync(file, "utf8"); } catch (err) {
          throw new UserError({ attempted, happened: `The dashboard's web files are missing from this build (${(err as Error).message}).`,
            changed: "Nothing; the HomeKit bridge is unaffected.", next: "Rebuild the image (the Dockerfile must copy web/ into it)." }, 500);
        }
        if (file.endsWith(".html")) body = body.replace(/__TITLE__/g, d.title);
        res.writeHead(200, { "content-type": MIME[path.extname(file)] });
        return res.end(body);
      }
      if (url.pathname === "/api/config") return json(res, 200, d.publicConfig());
      if (url.pathname === "/api/state") return json(res, 200, d.state());
      // Task 4 adds /go2rtc/*, Task 8 /api/photos + /api/photo/:id, Task 9 /fonts/:file.
      throw new UserError({ attempted, happened: "No such page on the dashboard.", changed: "Nothing.", next: "Open the dashboard's home page." }, 404);
    } catch (e) {
      const { status, body } = toErrorJson(e, attempted);
      if (status >= 500) log.warn(`${attempted}: ${(body.error as { happened: string }).happened}`);
      if (!res.headersSent) json(res, status, body); else res.destroy();
    }
  });
  return server;
}
```

- [ ] **Step 5: `src/dash/runtime.ts` (first cut)** holds the bridge's camera list and bridge info, and loads settings. Tasks 6-10 add loops to it.

```ts
/**
 * The dash child's state: the bridge's public camera list and status, the settings file, and
 * (Tasks 6-10) the probe, status, weather and photo loops. Builds /api/config and /api/state.
 */

import * as path from "path";
import { DashBridgeInfo, DashCamera } from "./ipc";
import { DashSettings, loadSettings, effectiveCameras } from "./settings";
import { PublicConfig } from "./server";
import { Logger } from "../logger";

export interface DashRuntimeOptions { dir: string; title: string; env: "prod" | "test"; adminPort: number; log: Logger }

export class DashRuntime {
  cameras: DashCamera[] = [];
  bridge: DashBridgeInfo | null = null;
  settings: DashSettings;
  settingsWarning: string | null;
  settingsMtime: number;
  readonly settingsFile: string;

  constructor(private readonly o: DashRuntimeOptions) {
    this.settingsFile = path.join(o.dir, "settings.json");
    const s = loadSettings(this.settingsFile);
    this.settings = s.settings; this.settingsWarning = s.warning; this.settingsMtime = s.mtimeMs;
    if (s.warning) o.log.warn(s.warning);
  }

  /** Re-reads settings.json if its mtime changed. Returns true when it changed. */
  reloadSettingsIfChanged(statMtime: number): boolean {
    if (statMtime === this.settingsMtime) return false;
    const s = loadSettings(this.settingsFile);
    this.settings = s.settings; this.settingsWarning = s.warning; this.settingsMtime = s.mtimeMs;
    if (s.warning) this.o.log.warn(s.warning); else this.o.log.info("dashboard settings changed; reloaded");
    return true;
  }

  shown(): { cam: DashCamera; label: string; stream: string }[] {
    return effectiveCameras(this.settings, this.cameras.map((c) => c.name))
      .filter((p) => p.shown && !p.missing)
      .map((p) => {
        const cam = this.cameras.find((c) => c.name === p.camera)!;
        return { cam, label: p.label, stream: p.stream === "sub" && cam.sub ? cam.sub : cam.main };
      });
  }

  allowedStreams(): Set<string> {
    const s = new Set<string>();
    for (const c of this.cameras) { s.add(c.main); if (c.sub) s.add(c.sub); }
    return s;
  }

  publicConfig(): PublicConfig {
    const s = this.settings;
    return {
      title: this.o.title, env: this.o.env, adminPort: this.o.adminPort,
      idleSeconds: s.idleSeconds, pollSeconds: s.pollSeconds, reloadMinutes: s.reloadMinutes,
      cameras: this.shown().map((x) => ({ id: x.cam.main, label: x.label, stream: x.stream })),
      fonts: { ui: { family: null }, clock: { inherit: true } },   // Task 9 fills this in
    };
  }

  state(): Record<string, unknown> {
    return { updated: Date.now(), settingsVersion: this.settingsMtime, settingsWarning: this.settingsWarning,
      bridgeKnown: this.bridge !== null, go2rtc: this.bridge?.go2rtc ?? null };
  }
}
```

- [ ] **Step 6: `src/dash/main.ts`:**

```ts
/**
 * Dash child entry point, forked and supervised by the bridge. Serves the open, watch-only
 * dashboard. Gets cameras and bridge status only over IPC; never reads config.json, the admin
 * password or the session key. A crash here is restarted with backoff; HomeKit is unaffected.
 */

import * as fs from "fs";
import * as path from "path";
import { createDashServer } from "./server";
import { DashRuntime } from "./runtime";
import { checkToDash } from "./ipc";
import { Logger } from "../logger";

const log = new Logger("dash");
const hapOff = process.env.UNSCRYPTED_HAP === "off";
const port = Number(process.env.UNSCRYPTED_DASH_PORT ?? 8180);
const dir = process.env.UNSCRYPTED_DASH_DIR || "/data/dash";
const title = process.env.UNSCRYPTED_DASH_TITLE || (hapOff ? "Homedash - TEST" : "Homedash");
const rt = new DashRuntime({ dir, title, env: hapOff ? "test" : "prod", adminPort: Number(process.env.UNSCRYPTED_ADMIN_PORT ?? 8190), log });

process.on("message", (raw: unknown) => {
  const m = checkToDash(raw);
  if (typeof m === "string") { log.warn(`ignored a malformed message from the bridge: ${m}`); return; }
  if (m.type === "cameras") rt.cameras = m.cameras; else rt.bridge = m.bridge;
});
process.on("disconnect", () => { log.warn("lost the connection to the bridge; exiting (the bridge restarts the dashboard)"); process.exit(0); });
process.on("unhandledRejection", (e) => log.error(`unhandled rejection in the dashboard (kept running): ${(e as Error)?.stack ?? e}`));
process.on("uncaughtException", (e) => { log.error(`dashboard crashed: ${e.stack ?? e}. The bridge will restart it.`); process.exit(1); });

setInterval(() => {
  try { rt.reloadSettingsIfChanged(fs.statSync(rt.settingsFile).mtimeMs); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`couldn't check ${rt.settingsFile}: ${(err as Error).message}`); }
}, 2000).unref();

const server = createDashServer({
  webRoot: path.join(__dirname, "..", "..", "web", "dash"), title,
  go2rtcApi: process.env.UNSCRYPTED_GO2RTC_API ?? "",
  publicConfig: () => rt.publicConfig(), state: () => rt.state(), allowedStreams: () => rt.allowedStreams(),
  go2rtcInfo: () => rt.bridge?.go2rtc ?? { state: "unknown", lastError: "the bridge hasn't reported yet", nextRetryAt: null },
  photoFile: () => null, fontsDir: path.join(dir, "fonts"), log,
});
server.on("error", (e: NodeJS.ErrnoException) => {
  log.error(`could not listen on port ${port}: ${e.message}${e.code === "EADDRINUSE" ? " (something else is using it; set UNSCRYPTED_DASH_PORT)" : ""}`);
  process.exit(1);
});
server.listen(port, "0.0.0.0", () => log.info(`dashboard listening on http://0.0.0.0:${port}`));
```

- [ ] **Step 7: Bridge wiring** in `src/bridgeRuntime.ts`:
  - Add `dash: { port: number; enabled: boolean; dir: string; title?: string; disabledReason?: string }` to `RuntimeOptions`.
  - Add `resolveDashEntry()`, the same as `resolveAdminEntry()` but for `dash/main`.
  - Add `private dash: Supervisor | null = null`. In `start()`, after the admin block:

```ts
    const dz = this.o.dash;
    const dashEntry = dz.enabled ? resolveDashEntry() : null;
    if (!dz.enabled) {
      log.info(`dashboard not started: ${dz.disabledReason ?? "disabled (UNSCRYPTED_DASH=off)"}.`);
    } else if (!dashEntry) {
      log.warn(`dashboard not started: this build has no dashboard server (${path.join(__dirname, "dash", "main.js")} is missing). The HomeKit bridge is unaffected.`);
    } else {
      this.dash = new Supervisor({
        name: "dash", log: log.child("dash"), onState: () => this.pushStatus(),
        start: () => {
          // An allowlisted env, not ...process.env: the open dashboard process gets no secret paths.
          const pick = (k: string) => (process.env[k] !== undefined ? { [k]: process.env[k] as string } : {});
          const child = fork(dashEntry, [], { env: {
            ...pick("PATH"), ...pick("TZ"), ...pick("NODE_ENV"), ...pick("UNSCRYPTED_LOG_LEVEL"), ...pick("UNSCRYPTED_HAP"),
            UNSCRYPTED_DASH_PORT: String(dz.port), UNSCRYPTED_DASH_DIR: dz.dir,
            ...(dz.title ? { UNSCRYPTED_DASH_TITLE: dz.title } : {}),
            UNSCRYPTED_ADMIN_PORT: String(this.o.admin.port),
            UNSCRYPTED_GO2RTC_API: this.go2rtc?.apiBase() ?? "",
          } });
          setTimeout(() => this.pushDash(true), 200);
          return child;
        },
      });
      this.dash.start();
      log.info(`dashboard starting on port ${dz.port}`);
    }
```

  - Add `pushDash(withCameras: boolean)`, which sends `{ type: "bridge", bridge: { hapEnabled, paired, go2rtc } }` (from `this.status()`) and, when `withCameras`, `{ type: "cameras", cameras: dashCameras(this.config) }`. Use the same guarded `send` pattern (log a warning on failure, never throw). Call `pushDash(false)` from the existing 2 s timer, and call `pushDash(true)` at the end of the apply path (after `this.config` is updated) so a new or edited camera reaches the dash.
  - Add `this.dash?.stop()` to `stop()`'s `Promise.allSettled`.
  - Add the dash child's `ChildStatus` to `BridgeStatus` as `dash: ChildStatus` (in `src/admin/ipc.ts`), so the admin Status page shows it. Update `test/admin/server.test.ts`'s `status()` helper with a `dash` entry.
- [ ] **Step 8: `src/index.ts`:** `const dashPort = envPort("UNSCRYPTED_DASH_PORT", 8180, log);` and pass `dash: { port: dashPort.port, enabled: process.env.UNSCRYPTED_DASH !== "off" && dashPort.error === null, dir: process.env.UNSCRYPTED_DASH_DIR ?? path.join(path.dirname(config.persistDir), "dash"), title: process.env.UNSCRYPTED_DASH_TITLE, disabledReason: dashPort.error ?? undefined }`.
- [ ] **Step 9: Add a bridgeRuntime test** in `test/admin/bridgeRuntime.test.ts`: with `dash.enabled: false`, `start()` logs "dashboard not started" and `status().dash.state === "stopped"`. Follow the file's existing fake-camera setup.
- [ ] **Step 10: The page shell.** Copy Homedash `web/index.html` and `web/style.css` to `web/dash/`. Changes:
  - `<title>__TITLE__</title>`;
  - `<link rel="stylesheet" href="/style.css">` and `<script type="module" src="/app.js">` (absolute paths);
  - add `<div id="notice" class="notice gone" role="status"></div>` inside `.in` (used from Task 5 on for settings or bridge warnings).
  - In `style.css` add `.notice{position:absolute;left:50%;top:calc(8*var(--u));transform:translateX(-50%);z-index:6;background:#2a1d0c;color:#e0b54d;border:calc(2*var(--u)) solid #6b4a12;border-radius:calc(8*var(--u));padding:calc(6*var(--u)) calc(16*var(--u));font-size:calc(22*var(--u))}`.

  Create `web/dash/app.js`, the clock-only first cut. Task 5 replaces it with the full port:

```js
const $ = (id) => document.getElementById(id);
function tick() {
  const now = new Date();
  $("clock").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  $("day").textContent = now.toLocaleDateString([], { weekday: "long" });
  $("date").textContent = now.toLocaleDateString([], { month: "long", day: "numeric" });
}
tick();
setInterval(tick, 1000);
```

- [ ] **Step 11:** `npm test && npm run typecheck`. Expect PASS.
- [ ] **Step 12: Commit.** `git commit -m "feat(dash): supervised dashboard child with a credential-free camera list (#3)"`

### Task 2b: Deploy to the test instance (repeat at the end of every phase)

- [ ] **Step 1:** On the box, `sudo ss -lntup | grep -E ':(8180|8181) '` must print nothing.
- [ ] **Step 2: Back up the test checkout once:** `cp -a ~/unscrypted-test ~/unscrypted-backups/test-before-3-$(date +%Y%m%d-%H%M)` (excluding nothing, it's small).
- [ ] **Step 3:** `scp -r` the worktree's `src web package.json package-lock.json Dockerfile docker-compose.yml docker-compose.test.yml` into `~/unscrypted-test/` (never `config/`, `data/`, `secrets/`). Then:
  `cd ~/unscrypted-test && sudo docker compose -f docker-compose.yml -f docker-compose.test.yml -p unscrypted-test up -d --build`
- [ ] **Step 4: Verify for real**, not by self-report:
  - `sudo docker logs --tail 50 unscrypted-test` shows "dashboard listening on http://0.0.0.0:8181", go2rtc running, and the admin pane on 8191;
  - `sudo docker exec unscrypted-test node -e "fetch('http://127.0.0.1:8181/healthz').then(r=>r.text()).then(console.log)"` prints `{"ok":true}`;
  - `curl -s -X POST http://10.0.1.78:8181/api/config` from Windows returns 405 JSON;
  - prod is untouched: `sudo docker ps --filter name=^unscrypted$` still shows `unscrypted:0.2.0` with the same uptime.
- [ ] **Step 5: Owner check:** "CHECK THE THING http://10.0.1.78:8181" (expect the Homedash layout with a live clock, placeholders elsewhere, tab title "Homedash - TEST").

---

## Phase 2: Live tiles (owner sees: the cameras playing on `:8181`, as smooth as Homedash)

### Task 3: WebRTC-only WebSocket filter

**Files:** Create `src/dash/wsFilter.ts`. Test `test/dash/wsFilter.test.ts`.

**Interfaces:** Produces `class ClientFrameFilter { push(chunk: Buffer): { forward: Buffer } | { reject: string } }` and `ALLOWED_TYPES: Set<string>`.

- [ ] **Step 0: Confirm the message types** the 1.9.14 player sends: `sudo docker exec unscrypted-test node -e "fetch('http://127.0.0.1:1987/video-rtc.js').then(r=>r.text()).then(t=>console.log([...t.matchAll(/send\(\{type: ?'([^']+)'/g)].map(m=>m[1])))"`. Expect `webrtc/offer` and `webrtc/candidate` among MSE/HLS/MJPEG/MP4 types. If webrtc mode sends anything else, add it to `ALLOWED_TYPES` and note it in the commit.
- [ ] **Step 1: Failing test:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientFrameFilter } from "../../src/dash/wsFilter";

function frame(op: number, payload: string | Buffer, fin = true, masked = true): Buffer {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = Buffer.from([1, 2, 3, 4]);
  const len = p.length < 126 ? Buffer.from([(masked ? 0x80 : 0) | p.length]) : Buffer.from([(masked ? 0x80 : 0) | 126, p.length >> 8, p.length & 255]);
  const body = masked ? Buffer.from(p.map((b, i) => b ^ mask[i & 3])) : p;
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op]), len, masked ? mask : Buffer.alloc(0), body]);
}
const offer = JSON.stringify({ type: "webrtc/offer", value: "v=0..." });

test("passes a WebRTC offer and candidate through byte-for-byte", () => {
  const f = new ClientFrameFilter();
  const a = frame(1, offer), b = frame(1, JSON.stringify({ type: "webrtc/candidate", value: "candidate:1" }));
  const r = f.push(Buffer.concat([a, b]));
  assert.ok("forward" in r);
  assert.deepEqual((r as any).forward, Buffer.concat([a, b]));
});

test("holds a frame split across chunks until it's complete", () => {
  const f = new ClientFrameFilter();
  const a = frame(1, offer);
  assert.deepEqual((f.push(a.subarray(0, 5)) as any).forward.length, 0);
  assert.deepEqual((f.push(a.subarray(5)) as any).forward, a);
});

test("checks a fragmented message as a whole", () => {
  const f = new ClientFrameFilter();
  const p1 = frame(1, offer.slice(0, 10), false), p2 = frame(0, offer.slice(10), true);
  assert.equal((f.push(p1) as any).forward.length, 0);
  assert.deepEqual((f.push(p2) as any).forward, Buffer.concat([p1, p2]));
});

test("refuses MSE, binary, non-JSON, unmasked and oversized messages", () => {
  assert.match((new ClientFrameFilter().push(frame(1, JSON.stringify({ type: "mse", value: "" }))) as any).reject, /only WebRTC/);
  assert.match((new ClientFrameFilter().push(frame(2, Buffer.from([1, 2])) ) as any).reject, /binary/);
  assert.match((new ClientFrameFilter().push(frame(1, "hello")) as any).reject, /isn't JSON/);
  assert.match((new ClientFrameFilter().push(frame(1, offer, true, false)) as any).reject, /unmasked/);
  assert.match((new ClientFrameFilter().push(frame(1, "x".repeat(70_000))) as any).reject, /64 KB/);
});

test("ping, pong and close pass through", () => {
  const f = new ClientFrameFilter();
  const c = Buffer.concat([frame(9, ""), frame(10, ""), frame(8, Buffer.from([3, 232]))]);
  assert.deepEqual((f.push(c) as any).forward, c);
});
```

- [ ] **Step 2:** Run it. Expect FAIL.
- [ ] **Step 3: Implement** `src/dash/wsFilter.ts`:

```ts
/**
 * Browser -> go2rtc WebSocket filter for the open dashboard. Parses the client's frames (always
 * masked, RFC 6455), unmasks each text message to read its JSON "type", and forwards the ORIGINAL
 * bytes only when every message is WebRTC signalling. Anything else ends the connection with a
 * reason the server logs. Server -> browser traffic isn't touched.
 */

export const ALLOWED_TYPES = new Set(["webrtc/offer", "webrtc/candidate"]);
const MAX_MESSAGE = 64 * 1024;

export class ClientFrameFilter {
  private buf = Buffer.alloc(0);
  private parts: Buffer[] = [];     // unmasked payloads of the text message being assembled
  private held: Buffer[] = [];      // its raw frames, forwarded once the whole message checks out
  private inText = false;

  push(chunk: Buffer): { forward: Buffer } | { reject: string } {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f;
      if ((b1 & 0x80) === 0) return { reject: "an unmasked frame (not sent by a browser)" };
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return { reject: "a message over 64 KB" };
        len = Number(big); off = 10;
      }
      if (len > MAX_MESSAGE) return { reject: "a message over 64 KB" };
      const total = off + 4 + len;
      if (this.buf.length < total) break;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, total));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      const raw = Buffer.from(this.buf.subarray(0, total));
      this.buf = this.buf.subarray(total);

      if (op === 0x8 || op === 0x9 || op === 0xa) { out.push(raw); continue; }   // close / ping / pong
      if (op === 0x2) return { reject: "a binary message (the dashboard only sends WebRTC signalling)" };
      if (op === 0x1) { if (this.inText) return { reject: "a malformed message sequence" }; this.inText = true; this.parts = []; this.held = []; }
      else if (op === 0x0) { if (!this.inText) return { reject: "a malformed message sequence" }; }
      else return { reject: `an unknown frame type (${op})` };
      this.parts.push(payload);
      this.held.push(raw);
      if (this.parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) return { reject: "a message over 64 KB" };
      if (!fin) continue;
      this.inText = false;
      let type: unknown;
      try { type = JSON.parse(Buffer.concat(this.parts).toString("utf8"))?.type; }
      catch { return { reject: "a message that isn't JSON" }; }
      if (typeof type !== "string" || !ALLOWED_TYPES.has(type)) return { reject: `a "${String(type)}" request (only WebRTC is allowed on the open dashboard)` };
      out.push(...this.held);
      this.held = [];
    }
    return { forward: Buffer.concat(out) };
  }
}
```

- [ ] **Step 4:** Run the test. Expect PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(dash): WebRTC-only filter for the open video socket (#3)"`

### Task 4: go2rtc proxy on the dash port (scripts + filtered WebSocket)

**Files:** Modify `src/dash/server.ts`. Test: extend `test/dash/server.test.ts`.

**Interfaces:** Consumes `ClientFrameFilter` (Task 3) and `DashDeps.allowedStreams`, `go2rtcInfo`, `go2rtcApi`, `maxStreams`.

- [ ] **Step 1: Failing tests** (add to `test/dash/server.test.ts`). Use a fake go2rtc built with `http.createServer`: it serves `/video-stream.js` and `/video-rtc.js`, and on `upgrade` writes a `101 Switching Protocols` response and then echoes. Start a second dash server with `go2rtcApi` pointing at it and `allowedStreams: () => new Set(["dogcamtest", "dogcamtest_sub"])`. Tests:
  - `GET /go2rtc/video-stream.js` → 200 from the fake; `GET /go2rtc/api/streams` → 404 four-part ("isn't passed through");
  - upgrade `/go2rtc/api/ws?src=dogcamtest` → 101, and the fake saw no `Cookie` header even though the client sent `Cookie: unscrypted_admin=abc`;
  - upgrade `?src=check_1234abcd` → `403` with body naming the stream;
  - upgrade `?src=../api` → `400`;
  - sending a masked `{"type":"mse"}` frame after the 101 → the socket is closed and the fake received nothing after the handshake;
  - with `maxStreams: 1`, a second simultaneous upgrade → `503` "too many live views";
  - with `go2rtcApi: ""` → `503` naming go2rtc's state from `go2rtcInfo`.

  Raw upgrade client helper:

```ts
import * as net from "net";
function upgrade(port: number, pathAndQuery: string, extra = ""): Promise<{ head: string; sock: net.Socket }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(
      `GET ${pathAndQuery} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`));
    let buf = "";
    sock.on("data", (d) => { buf += d.toString("latin1"); if (buf.includes("\r\n\r\n")) resolve({ head: buf.split("\r\n\r\n")[0], sock }); });
    sock.on("error", reject);
  });
}
```

- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement.** In the GET handler, before the 404:

```ts
      const GO2RTC_FILES = new Set(["/video-stream.js", "/video-rtc.js"]);
      if (url.pathname.startsWith("/go2rtc/")) {
        attempted = "Load the camera player";
        const sub = url.pathname.slice("/go2rtc".length);
        if (!GO2RTC_FILES.has(sub)) throw new UserError({ attempted, happened: "That go2rtc address isn't passed through by the dashboard.", changed: "Nothing.", next: "Open the dashboard's home page." }, 404);
        if (!d.go2rtcApi) throw go2rtcDown(attempted);
        await pipeGet(d.go2rtcApi + sub, res, attempted);   // same shape as the admin proxy's GET pipe, 20 s timeout
        return;
      }
```

  `go2rtcDown(attempted)` builds a 503 UserError from `d.go2rtcInfo()`: "The video server (go2rtc) isn't running (state: X, restarting in Ns). Last error: Y." with changed "Nothing; HomeKit is unaffected." and next "The tiles retry on their own; if it stays down, check `docker logs unscrypted` for go2rtc lines." Copy `pipeGet` from the admin server's `/go2rtc/` GET block into a local function. Don't share it, so the admin proxy stays untouched.

  Then the upgrade handler:

```ts
  let open = 0;
  const maxStreams = d.maxStreams ?? 16;
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const refuse = (code: string, why: string) => {
      log.warn(`refused a dashboard video connection from ${req.socket.remoteAddress}: ${why}`);
      socket.end(`HTTP/1.1 ${code}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${why}\n`);
    };
    const src = url.searchParams.get("src") ?? "";
    if (url.pathname !== "/go2rtc/api/ws") return refuse("404 Not Found", "only /go2rtc/api/ws is a WebSocket here");
    if (!/^[a-z0-9_]{1,64}$/.test(src)) return refuse("400 Bad Request", `"${src}" isn't a stream name`);
    if (!d.allowedStreams().has(src)) return refuse("403 Forbidden", `"${src}" isn't one of the cameras in config.json`);
    if (!d.go2rtcApi) { const g = d.go2rtcInfo(); return refuse("503 Service Unavailable", `the video server (go2rtc) isn't running (state: ${g.state}; ${g.lastError ?? "no error recorded"})`); }
    if (open >= maxStreams) return refuse("503 Service Unavailable", `too many live views open at once (${maxStreams}); close one and the tile retries`);
    open++;
    let closed = false;
    const done = () => { if (!closed) { closed = true; open--; } };
    const target = new URL(d.go2rtcApi);
    const filter = new ClientFrameFilter();
    const up = net.connect(Number(target.port), target.hostname, () => {
      const lines = [`GET /api/ws?src=${encodeURIComponent(src)} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (/^(host|cookie|origin|authorization)$/i.test(req.rawHeaders[i])) continue;
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push(`Host: ${target.host}`, "", "");
      up.write(lines.join("\r\n"));
      const feed = (chunk: Buffer) => {
        const r = filter.push(chunk);
        if ("reject" in r) { log.warn(`closed a dashboard video connection for "${src}": the browser sent ${r.reject}`); socket.destroy(); up.destroy(); return; }
        if (r.forward.length) up.write(r.forward);
      };
      if (head.length) feed(head);
      socket.on("data", feed);
      up.pipe(socket);
    });
    up.on("error", (err) => { log.warn(`dashboard video: couldn't reach go2rtc at ${target.host}: ${err.message}`); socket.destroy(); done(); });
    socket.on("error", () => up.destroy());
    socket.on("close", () => { up.destroy(); done(); });
    up.on("close", () => { socket.destroy(); done(); });
  });
```

  Imports: `import * as net from "net"; import { ClientFrameFilter } from "./wsFilter";`.
- [ ] **Step 4:** Run tests. Expect PASS. `npm run typecheck`.
- [ ] **Step 5: Commit.** `git commit -m "feat(dash): open video path, configured cameras and WebRTC only (#3)"`

### Task 5: Tiles, fullscreen and the full page port

**Files:** Replace `web/dash/app.js` with the Homedash port. Modify `src/dash/runtime.ts` (camera probe loop + state). Test: `test/dash/runtime.test.ts`.

**Interfaces:**
- `/api/config` → `PublicConfig` (Task 2): `cameras: [{ id, label, stream }]`.
- `/api/state` adds `cameras: Record<id, { up: boolean; reason: string | null; since: number }>`, plus `go2rtc` and `settingsVersion` (existing).

- [ ] **Step 1: Failing runtime test** `test/dash/runtime.test.ts`: create a `DashRuntime` with a temp dir and a settings file showing `DogCamTest`. Set `rt.cameras` to one camera whose probe is a `net.createServer` listening on `127.0.0.1:<port>`, and a second whose probe port is closed. Call `await rt.probeCameras()`. Assert `state().cameras` has `{ up: true, reason: null }` for the first and `{ up: false, reason: /not answering at its RTSP port/ }` for the second. Also check that `publicConfig().cameras` lists only shown cameras with their labels, and that `JSON.stringify(rt.publicConfig()) + JSON.stringify(rt.state())` contains no `rtsp:`, no IP addresses (`/\b\d+\.\d+\.\d+\.\d+\b/`), and no `password`.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Runtime.** Add a `tcpProbe(host, port, timeoutMs = 1500): Promise<string | null>` (null = up, else the reason) to `src/dash/services.ts`. Create the file now; Task 6 fills in the rest. Then in `DashRuntime`:

```ts
  private camState = new Map<string, { up: boolean; reason: string | null; since: number }>();
  async probeCameras(): Promise<void> {
    await Promise.all(this.shown().map(async ({ cam }) => {
      const reason = cam.probe ? await tcpProbe(cam.probe.host, cam.probe.port) : "the camera's address in config.json can't be read";
      const up = reason === null;
      const prev = this.camState.get(cam.main);
      this.camState.set(cam.main, { up, reason: up ? null : `Camera not answering at its RTSP port (${reason})`, since: prev && prev.up === up ? prev.since : Date.now() });
    }));
  }
```

  Add `cameras: Object.fromEntries(this.camState)` to `state()`. The reason names the cause but not the IP (no addresses in the open API). `tcpProbe` therefore returns generic reasons: "no answer within 1.5 s", "connection refused", "network unreachable". In `main.ts`, run `probeCameras()` every `settings.pollSeconds` (re-read each round) with a guard against overlap, logging any thrown error.
- [ ] **Step 4: Port `web/dash/app.js`.** Start from Homedash `web/app.js` verbatim, then make exactly these changes:
  1. **Title:** delete the `document.title = ...` line (the server fills `__TITLE__`).
  2. **Fonts:** replace `applyFonts` with the `FontFace` API (CSP blocks inline `<style>`):

```js
async function applyFonts(fonts) {
  const root = document.documentElement.style;
  for (const role of ["ui", "clock"]) {
    const f = (fonts || {})[role];
    if (!f) continue;
    let css = f.family || null;
    if (f.file) {
      try {
        const face = new FontFace(`hd-${role}`, `url("${f.file}")`);
        document.fonts.add(await face.load());
        css = `"hd-${role}"`;
      } catch (err) {
        showNotice(`The ${role === "ui" ? "interface" : "clock"} font "${f.name}" didn't load (${err.message}); using the system font. Pick another in the admin pane's Dashboard tab.`);
      }
    }
    if (css) root.setProperty(role === "ui" ? "--font-ui" : "--font-clock", css);
  }
}
```

  3. **Player and streams:** replace `await import(\`${cfg.go2rtc}/video-stream.js\`)` and `wsBase`/`streamSrc` with:

```js
try { await import("/go2rtc/video-stream.js"); }
catch (err) { showNotice(`The camera player didn't load (${err.message}). The video server may be restarting; the page retries at its next refresh.`); }
const wsBase = location.origin.replace(/^http/, "ws");
const streamSrc = (stream) => `${wsBase}/go2rtc/api/ws?src=${encodeURIComponent(stream)}`;
```

  `makeStream(cam)` takes the camera object and uses `cam.stream`. Tiles are keyed by `cam.id`, and labels use `cam.label`.
  4. **No blank tiles.** `setUp(id, st)` takes the state object. When it's down, the `.off` text is `st.reason` plus " since " + the local time of `st.since`, and `.s` reads "offline". When go2rtc isn't running (`state.go2rtc.state !== "running"`), every tile's `.off` reads "Video server restarting: <lastError>" while its stream element is kept so it reconnects. A watchdog covers the black-tile case: 15 s after `makeStream`, if the inner `<video>` has `readyState < 2`, overlay "Video didn't start: no picture from the camera within 15 s. Retrying." and recreate the element once a minute until a frame arrives. Clear the overlay on the video's `playing` event.
  5. **Stale marker:** `pollState` keeps `lastOk`. On a failed fetch it shows `#notice` "Lost touch with the dashboard server at <time>; showing the last known state. Retrying every N s." and hides it on the next success. `catch (_) {}` blocks are banned: every catch updates a visible message.
  6. **Settings changes:** when `st.settingsVersion` differs from the value seen at load, reload, unless a camera is fullscreen (then reload on `closeFull`). `st.settingsWarning` is shown in `#notice`.
  7. **Settings button:** set `document.querySelector(".settings-btn").href = \`http://${location.hostname}:${cfg.adminPort}/#/dash?from=dash\`` and its text to "Settings". The behaviour depends on Q7.
  8. Leave the services, weather, photo and background code in place. Tasks 6-8 make their data real. The `?t=` and `?tune` parameters stay as they are.
- [ ] **Step 5:** `npm test && npm run typecheck`. Expect PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(dash): live WebRTC tiles and fullscreen, ported from Homedash (#3)"`
- [ ] **Step 7: Test deploy** (Task 2b). Seed `~/unscrypted-test/data/dash/settings.json` by hand with the four Homedash cameras mapped per the Q6 answer (e.g. `{"cameras":[{"camera":"DogCamTest","label":"DogCam","shown":true,"stream":"main"}, ...]}`). Verify from the box that a disallowed stream gets a 403 (raw upgrade with `src=check_00000000` via a Node one-liner written to a file per the shell-quoting rule). **Owner check:** "CHECK THE THING http://10.0.1.78:8181". Open it on the Mac mini in a normal Chrome window next to the kiosk: the tiles play, clicking a tile opens fullscreen, and it feels as smooth as Homedash. Unplug a camera (or wait for one to be offline) and check the tile explains why. Close the test page afterwards (Findings 10).

---

## Phase 3: Status lights and weather (owner sees: the status outline and the weather band)

### Task 6: Service checks and rollup

**Files:** Complete `src/dash/services.ts`. Test `test/dash/services.test.ts`.

**Interfaces:**
- `type Light = "ok" | "warn" | "down"`
- `interface LightNode { id: string; name: string; state: Light; reason: string | null; link?: string; children: LightNode[] }`
- `runCheck(c: ServiceCheck, bridge: () => DashBridgeInfo | null): Promise<string | null>` (null = healthy)
- `class ServiceWatcher { constructor(failsBeforeDown = 2); poll(tree: ServiceNode[], bridge): Promise<LightNode[]> }`

**Gated by Q1 and Q2.** Q2 decides whether the `homekit` node replaces Scrypted (the default above assumes "replace"). Q1 decides how Constructicon/Questlog are reached. If Q1 = (c), the defaults keep those nodes and `runCheck` returns "can't be checked from the NAS's own network yet (it sits on the ipvlan LAN; see hooptiej/unscrypted#<follow-up>)", and the light shows **down with that reason** rather than a fake green.

- [ ] **Step 1: Failing tests:**
  - tcp: a listening `net.Server` → null; a closed port → a reason containing "refused";
  - alive: a closed port on 127.0.0.1 (refused) → null (a refusal proves the host answered); an unroutable address with a 300 ms timeout → reason "no answer";
  - http `ok:"any"`: a fake server returning 401 → null; `ok:"200"` with 500 → reason "answered 500";
  - https with a self-signed certificate → null (`rejectUnauthorized: false`, checks only);
  - bridge: `{hapEnabled:true, paired:true}` → null; `hapEnabled:false` → "HomeKit is off on this instance (test)"; `paired:false` → "not paired with Home"; `null` → "the bridge hasn't reported yet";
  - debounce: one failure keeps `ok`, two failures turn it `down` with the reason;
  - rollup: a Server with a down child → `warn`; a non-rollup parent with a down child stays `ok`; links only when `http(s)://`.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement** (port of `run_check`/`evaluate_services`):

```ts
import * as net from "net";
import * as http from "http";
import * as https from "https";
import { ServiceCheck, ServiceNode } from "./settings";
import { DashBridgeInfo } from "./ipc";

export type Light = "ok" | "warn" | "down";
export interface LightNode { id: string; name: string; state: Light; reason: string | null; link?: string; children: LightNode[] }

/** null when the TCP port accepts; otherwise a plain reason with no address in it. */
export function tcpProbe(host: string, port: number, timeoutMs = 1500, refusedIsUp = false): Promise<string | null> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: timeoutMs });
    s.once("connect", () => { s.destroy(); resolve(null); });
    s.once("timeout", () => { s.destroy(); resolve(`no answer within ${timeoutMs / 1000} s`); });
    s.once("error", (e: NodeJS.ErrnoException) => {
      s.destroy();
      if (e.code === "ECONNREFUSED") resolve(refusedIsUp ? null : "connection refused (nothing listening)");
      else resolve(e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH" ? "network unreachable" : `connection failed (${e.code ?? e.message})`);
    });
  });
}

function httpStatus(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const r = lib.get(url, { timeout: timeoutMs, rejectUnauthorized: false } as https.RequestOptions, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on("timeout", () => r.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
    r.on("error", reject);
  });
}

export async function runCheck(c: ServiceCheck, bridge: () => DashBridgeInfo | null, timeoutMs = 3000): Promise<string | null> {
  try {
    switch (c.kind) {
      case "tcp": return await tcpProbe(c.host, c.port, timeoutMs);
      case "alive": return await tcpProbe(c.host, c.port, timeoutMs, true);
      case "http": {
        const code = await httpStatus(c.url, timeoutMs);
        return c.ok === "200" && code !== 200 ? `answered ${code}, expected 200` : null;
      }
      case "bridge": {
        const b = bridge();
        if (!b) return "the bridge hasn't reported yet";
        if (!b.hapEnabled) return "HomeKit is off on this instance (test)";
        return b.paired ? null : "not paired with Home";
      }
    }
  } catch (err) {
    return (err as Error).message;
  }
}

export class ServiceWatcher {
  private fails = new Map<string, number>();
  constructor(private readonly failsBeforeDown = 2) {}

  async poll(tree: ServiceNode[], bridge: () => DashBridgeInfo | null): Promise<LightNode[]> {
    const flat: ServiceNode[] = [];
    const walk = (ns: ServiceNode[]) => ns.forEach((n) => { flat.push(n); walk(n.children ?? []); });
    walk(tree);
    const raw = new Map(await Promise.all(flat.map(async (n) => [n.id, await runCheck(n.check, bridge)] as const)));
    const up = new Map<string, boolean>();
    for (const [id, reason] of raw) {
      const f = reason === null ? 0 : (this.fails.get(id) ?? 0) + 1;
      this.fails.set(id, f);
      up.set(id, reason === null || f < this.failsBeforeDown);   // one miss is a blip, not an outage
    }
    const anyDown = (n: ServiceNode): boolean => (n.children ?? []).some((k) => !up.get(k.id) || anyDown(k));
    const build = (n: ServiceNode): LightNode => {
      const ok = up.get(n.id)!;
      const state: Light = !ok ? "down" : n.rollup && anyDown(n) ? "warn" : "ok";
      const out: LightNode = { id: n.id, name: n.name, state, reason: ok ? null : raw.get(n.id) ?? null, children: (n.children ?? []).map(build) };
      if (n.link && /^https?:\/\//.test(n.link)) out.link = n.link;
      return out;
    };
    return tree.map(build);
  }
}
```

  Don't put host or port in the reason strings: `tcpProbe` already keeps addresses out.
- [ ] **Step 4: Wire it up.** `DashRuntime.pollServices()` stores `services` plus `servicesAt`. `main.ts` runs it every `pollSeconds`, guarded against overlap. `state()` adds `services` and `servicesAt`. In `app.js`'s `svcNode`, a down node gets a muted reason line (`<span class="why">no answer within 3 s</span>`). Style: `.svc .why{margin-left:calc(10*var(--u));font-size:calc(18*var(--u));color:#8b6f4a}`.
- [ ] **Step 5:** Tests PASS, typecheck. **Commit** `feat(dash): service lights with reasons, ported from Homedash (#3)`.

### Task 7: Weather

**Files:** Create `src/dash/weather.ts`. Test `test/dash/weather.test.ts`.

**Interfaces:**
- `type FetchJson = (url: string) => Promise<any>`
- `interface Weather { temp: number; condition: string; high: number; low: number; sunrise: string; sunset: string; sunriseMin: number; sunsetMin: number; place: string }`
- `resolveLocation(w, fetchJson): Promise<{ lat: number; lon: number; label: string } | null>`
- `fetchWeather(lat, lon, unit, fetchJson): Promise<Omit<Weather, "place">>`
- `defaultFetchJson`

- [ ] **Step 1: Failing tests** with a fake `fetchJson` that returns canned Open-Meteo shapes:
  - pinned lat/lon skip geocoding (the fake asserts it's never called with `geocoding-api`);
  - an empty place → null;
  - no geocoding match → throws "no geocoding match for 'X'";
  - forecast parsing: `sunrise: "2026-10-20T07:12"` → `"7:12 AM"`, `sunriseMin = 432`; `weather_code 61` → "Light rain"; rounding of temps.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement.** Port `WMO`, `resolve_location`, `fetch_weather` from `server.py` lines 84-249. Use the same URLs, querying `place.split(",")[0]`. `defaultFetchJson = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(\`Open-Meteo answered ${r.status}\`); return r.json(); }`. Time formatting: parse `"YYYY-MM-DDTHH:MM"` by splitting (it's already local to the place, `timezone=auto`), so `h12 = ((h + 11) % 12) + 1`, `${h12}:${mm} ${h < 12 ? "AM" : "PM"}`.
- [ ] **Step 4: Loop in `DashRuntime`.** `weatherLoop()` copies the Python logic: geocode once, then refresh every `refreshSeconds`, or 60 s after an error or with no place. The location resets when `weather.place/lat/lon` change (compare a JSON key on each settings reload). `state()` gets `weather` and `weatherError` (e.g. "Weather unavailable since 7:40 PM: Open-Meteo answered 503. Retrying every minute."). `app.js`'s `renderWeather` shows `weatherError` in `#wx` instead of clearing it.
- [ ] **Step 5:** Tests PASS. **Commit** `feat(dash): weather band via Open-Meteo, errors shown in place (#3)`.
- [ ] **Step 6: Test deploy** (Task 2b). **Owner check:** the status outline and weather on `:8181`, with reasons on any red light.

---

## Phase 4: Photos and fonts (owner sees: the slideshow and his font)

### Task 8: Photo slideshow

**Files:** Create `src/dash/photos.ts`. Modify `src/dash/server.ts` (`/api/photos`, `/api/photo/:id`), `src/dash/runtime.ts`. Test `test/dash/photos.test.ts`.

**Interfaces:**
- `PHOTO_EXT`
- `photosFromFolder(folder, limit): { album: string; files: string[] }`
- `icloudToken(url): string`, `icloudHost(token): string`, `pickDerivative(d): string`
- `interface IcloudIO { post(url: string, body: unknown): Promise<{ status: number; json: any }>; get(url: string): Promise<Buffer> }`
- `photosFromIcloud(url, cacheDir, limit, io, publish?): Promise<{ album: string; files: string[] }>`
- `class PhotoLibrary { refresh(s: DashSettings["photos"], cacheDir: string): Promise<void>; list(): { items: { id: string; v: number }[]; album: string; error: string | null }; file(id: string): string | null }`

- [ ] **Step 1: Failing tests:**
  - folder: files sorted newest-first, recursing, only `.jpg/.jpeg/.png/.webp`, `limit` respected, a missing folder throws "photo folder not found: /x";
  - `icloudToken("https://www.icloud.com/sharedalbum/#B0aGWZuqDGJ8Kg")` → `"B0aGWZuqDGJ8Kg"`; a short token throws;
  - `icloudHost("A1xyz")` → `"p01-sharedstreams.icloud.com"`; `icloudHost("B0a...")` → `p${0*62+36}` = `"p36-sharedstreams.icloud.com"` (B62 = `0-9A-Za-z`, so `'a'` = 36);
  - `pickDerivative({"342":{width:"342"},"1242":{width:"1242"},"2048":{width:"2048"}})` → `"1242"`; with all under 1200 → the largest;
  - iCloud with a fake `io`: the first post answers 330 with `{"X-Apple-MMe-Host":"p99-..."}`, then 200; `webasseturls` maps checksums; the gets write `<guid>.jpg` atomically (no `.part` left); a failing get is retried 3 times, skipped, and **counted** in `PhotoLibrary.list().error` ("1 of 3 photos couldn't be downloaded"), never silently dropped; videos are excluded;
  - `PhotoLibrary.file(id)` only returns paths it published (id = first 12 hex of sha1(path)).
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement.** A straight port of `server.py` lines 279-430 with the `IcloudIO` seam. The default `io` uses `fetch` with `redirect: "manual"`, `Content-Type: text/plain`, a 20 s timeout for posts and 60 s for gets. Retry delays are 1.5 s × attempt, injectable as `sleep` for tests. `PhotoLibrary.refresh` catches and stores `error` with the four-part wording in one line ("Photos: couldn't refresh the iCloud album at 7:40 PM (iCloud answered 503). Still showing the 413 photos already cached. Retrying in a minute."). The loop in `main.ts`: refresh every `refreshMinutes`, 60 s after an error, and immediately when the `photos` settings change.
- [ ] **Step 4: Routes.** `GET /api/photos` → `{ items, album, rotateSeconds, error }`. `GET /api/photo/:id` streams `PhotoLibrary.file(id)` with its `PHOTO_EXT` type, or a 404 four-part error. `app.js`'s `loadPhotos` shows `error` as the photo tile's caption when there are no items, so the tile never stays an empty placeholder.
- [ ] **Step 5:** Tests PASS. **Commit** `feat(dash): photo slideshow from iCloud or a folder, ported (#3)`.

### Task 9: Fonts

**Gated by Q3.** Steps below are for Q3 = (a) (recommended: font files in `/data/dash/fonts`, no token at runtime). If Q3 = (b), add Step 6. If (c), skip this task, and the font selects offer system fonts only.

**Files:** Create `src/dash/fonts.ts`. Modify `src/dash/server.ts` (`/fonts/:file`), `src/dash/runtime.ts` (`publicConfig().fonts`). Test `test/dash/fonts.test.ts`.

**Interfaces:**
- `interface FontEntry { file: string; name: string }`
- `listFonts(dir): FontEntry[]` (names from `names.json`, `{ "<file>": "<display name>" }`, falling back to the file stem)
- `fontOut(spec: FontSpec, role, fonts: FontEntry[]): { family: string } | { file: string; name: string } | { inherit: true }`
- `SYSTEM_FONTS`

- [ ] **Step 1: Failing tests:**
  - `listFonts` returns only files that match `FONT_FILE`, sorted by name; a bad `names.json` falls back to stems and reports it (`listFonts` returns `{ fonts, warning }`);
  - `fontOut` for a file that's gone → the system sans stack, plus a warning string;
  - `fontOut({kind:"system",family:"inherit"}, "clock")` → `{ inherit: true }`; for "ui" → sans;
  - `GET /fonts/../settings.json` → 404; `GET /fonts/rMrRHh34w5nN.otf` → 200 `font/otf`.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement.** Port `SYSTEM_FONTS`, `FONT_MIME` and `font_spec` (server.py lines 75-81, 486-500). Serve `/fonts/:file` only for names matching `FONT_FILE` that exist in `fontsDir`, with a long cache header (`cache-control: public, max-age=86400` overrides `no-store` for this route only).
- [ ] **Step 4:** `publicConfig().fonts` uses `fontOut`. Font warnings go into `state().settingsWarning`'s list (make it `notices: string[]`).
- [ ] **Step 5:** Tests PASS. **Commit** `feat(dash): fonts from the dashboard's fonts folder (#3)`.
- [ ] **Step 6 (only if Q3 = b):** Add `src/dash/constructicon.ts`, a port of `cx_get`/`font_catalog`/`ensure_font`. It reads the token from `UNSCRYPTED_DASH_CX_TOKEN_FILE` (default `/run/secrets/constructicon_token`; the `./secrets` mount already exists). Add that variable to the bridge's dash env allowlist. The token is used only server-side, never logged, never in any response. A test asserts no response body contains the token. It runs in the **admin** child (listing fonts for the Settings tab and downloading the chosen file into `/data/dash/fonts` with its name in `names.json`), so the open dash process never holds the token. Requires Q1 (a) or (b) for `10.0.1.240` to be reachable. Otherwise the Settings tab shows "Constructicon can't be reached from the NAS's own network" greyed out with that reason.
- [ ] **Step 7: Test deploy.** Copy the three cached fonts: `sudo cp ~/homedash/data/fonts/*.otf ~/unscrypted-test/data/dash/fonts/`. Then write `names.json` from Homedash's catalog: `sudo docker exec homedash python3 -c "import urllib.request,json;c=json.load(urllib.request.urlopen('http://localhost/api/admin/config'))['catalog'];print(json.dumps({f['slug']+'.'+f['ext']:f['name'] for f in c}))"` > `names.json` (font names only, nothing secret). Copy or link the iCloud cache: `sudo cp -a ~/homedash/data/cache/icloud ~/unscrypted-test/data/dash/cache/` (625 MB; Homedash's copy stays). **Owner check:** the slideshow and the font on `:8181`.

---

## Phase 5: Settings behind the admin password (owner sees: a Dashboard tab in the pane at `:8191`)

### Task 10: Settings change propagation and immediate reload

Already built in Tasks 2 and 5 (mtime watch, `settingsVersion`, the page reloads when not fullscreen). This task only adds the missing test:

- [ ] **Step 1:** In `test/dash/runtime.test.ts`: `saveSettings` new content, call `reloadSettingsIfChanged(fs.statSync(f).mtimeMs)` → returns true; `publicConfig()` reflects the new label; `state().settingsVersion` changed. Writing garbage → returns true, defaults are used, and `settingsWarning` is set (the page shows it).
- [ ] **Step 2:** PASS. **Commit** `test(dash): settings changes reach the open page (#3)`.

### Task 11: Dashboard tab in the admin pane

**Gated by Q7 (kiosk sign-in flow) and Q8 (look).** The steps assume Q7 = (a) and Q8 = (a).

**Files:** Modify `src/admin/server.ts`, `src/admin/main.ts` (pass `dashDir`, `dashPort`), `web/admin/app.js`, `web/admin/index.html`, `web/admin/style.css`. Test: extend `test/admin/server.test.ts`.

**Interfaces:**
- `AdminDeps` gains `dashDir: string; dashPort: number`.
- `GET /api/dash/settings` (signed in) → `{ settings, cameras: (DashCameraPref & { missing })[], fonts: FontEntry[], systemFonts: string[], gridMax, warning, dashUrl }`.
- `PUT /api/dash/settings` (signed in + CSRF + Origin) with a partial edit → `{ saved: true, backupPath, settings }` or the four-part error.

- [ ] **Step 1: Failing tests:**
  - not signed in → 401, both routes;
  - PUT without CSRF → 403;
  - a valid PUT writes `settings.json` (and `.bak`) and returns the new settings;
  - an invalid PUT (6 cameras shown) → 400 naming the field, and the file is unchanged;
  - an unknown camera → 400 "isn't in config.json";
  - GET lists every `config.json` camera, including ones with no pref (`shown:false`), so nothing is hidden;
  - the response never contains `rtspPassword` values or `rtsp://` with credentials.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement the routes** after the session/CSRF gate, next to `/api/cameras`. The camera names come from `readRawConfig(d.configPath).cameras.map(c => c.name)`. `applySettingsEdit` + `saveSettings` from Task 1, `listFonts` from Task 9. `dashUrl` = `http://<req host without port>:<dashPort>/`.
- [ ] **Step 4: UI.** Add a "Dashboard" nav link (`#/dash`) in `index.html`. In `app.js`, add a `#/dash` route that renders, in the pane's existing card style:
  - **Cameras:** one row per camera, in grid order, with up/down buttons, a label input (max 40, hint "only on the dashboard; the HomeKit name stays <name>"), a "Shown" checkbox and a main/sub select. A row whose camera is missing from config.json is shown greyed out with "not in config.json any more"; it isn't removed. Checking a fifth "Shown" box disables the others' checkboxes with the title "the grid shows 4; switch one off first" (greyed, with a reason).
  - **Display:** fullscreen timeout, page refresh, status interval.
  - **Photos:** source, iCloud link, folder, seconds per photo, caption.
  - **Weather:** place, unit, lat, lon, with the hint "Changing the place clears the pinned coordinates."
  - **Fonts:** interface and clock selects (system + the fonts folder), with a live preview using `FontFace` against `http://<host>:<dashPort>/fonts/<file>` (add that origin to the admin CSP's `font-src` for this one host:port).
  - **Save** button; **Open the dashboard** link (`dashUrl`). Errors use the existing `errorBox(r.error)`.
  - **Arrived from the kiosk (`?from=dash`):** an idle countdown back to `dashUrl` after `idleSeconds`, as Homedash #14 did. On idle-return it first calls `POST /api/logout`, so the living room doesn't stay signed in.
- [ ] **Step 5:** Tests PASS, typecheck. **Commit** `feat(admin): Dashboard settings tab, behind the admin password (#3)`.

### Task 12: One-shot Homedash settings import

**Files:** Create `src/dash/importHomedash.ts`. Test `test/dash/importHomedash.test.ts`.

**Interfaces:** `importHomedash(hd: any, map: Record<string, string>, fontNames: Record<string, string>): DashSettings`. CLI: `node dist/dash/importHomedash.js <homedash-config.json> <out settings.json> --map dogcam=DogCamTest,backyardcam=BackyardCamTest,garagecam=GarageCamTest,onvif_camera=OnvifCamTest`. Refuses to overwrite an existing output unless `--force` is given.

- [ ] **Step 1: Failing test:** a Homedash config shaped like prod's (Findings 4: `idle_seconds`, `reload_minutes`, `cameras[{key,name,ip,port,enabled}]`, `photos{source,icloud_url,folder,rotate_seconds,refresh_minutes,max_photos,caption}`, `weather{place,lat,lon,unit,refresh_seconds}`, `fonts{ui:{kind:"constructicon",slug}}`) maps to:
  - `cameras` in Homedash order with `label` = the Homedash `name`, `shown` = `enabled`, `stream: "main"`;
  - an unmapped key throws "no --map entry for 'dogcam'";
  - `photos.folder` `/app/data/photos` → `/data/dash/photos`;
  - `fonts.ui` constructicon slug `S` → `{kind:"file", file:"S.otf"}` when `S.otf` exists in the font list, else system sans plus a printed warning;
  - the result passes `applySettingsEdit(DEFAULTS, result, ctx)` unchanged (it round-trips validation).
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. The CLI prints what it mapped and every field it couldn't map, and exits non-zero on any refusal.
- [ ] **Step 4:** PASS. **Commit** `feat(dash): import Homedash's settings once (#3)`.
- [ ] **Step 5: Test deploy.** Run the import inside `unscrypted-test` against a copy of `~/homedash/data/config.json` (copied into `~/unscrypted-test/data/dash/homedash-config.json`; it holds no secrets, just the iCloud album link and place). **Owner check:** at `http://10.0.1.78:8191/#/dash` change a label and save; within about 2 s the `:8181` page reloads with it. Wrong-password and no-CSRF paths refuse with reasons.

---

## Phase 6: Packaging, review, soak on test

### Task 13: Image, compose, README (v0.3.0)

**Files:** Modify `Dockerfile`, `docker-compose.yml`, `docker-compose.test.yml`, `README.md`.

- [ ] **Step 1: Dockerfile.** Add `UNSCRYPTED_DASH_PORT=8180` and `UNSCRYPTED_DASH_DIR=/data/dash` to the `ENV` block, and `EXPOSE 8180/tcp`. `COPY web ./web` already carries `web/dash`. The healthcheck stays on the admin pane only (an unhealthy dash restarts nothing; the Status page shows it).
- [ ] **Step 2: Compose.** In `docker-compose.yml` environment add `- UNSCRYPTED_DASH_PORT=8180`. In `docker-compose.test.yml` add `- UNSCRYPTED_DASH_PORT=8181` and `- UNSCRYPTED_DASH_TITLE=Homedash - TEST`. If Q11 = (a), add to the test override only:

```yaml
    volumes:
      # Page-only fast loop on the test instance: edit web/dash on the box, reload the browser, no rebuild.
      - ./web/dash:/app/web/dash:ro
```

- [ ] **Step 3: README.** Add a "Dashboard" section: URL, open and watch-only by design (anyone on the LAN can watch, same as Homedash), where its settings live (`./data/dash/`), the ports table rows (8180 / 8181), `UNSCRYPTED_DASH=off`, and "rebuilding restarts HomeKit too (a few seconds of No Response): batch dashboard changes".
- [ ] **Step 4:** `npm test && npm run typecheck && npm run build`. Then a local `docker build .` if Docker is available on this machine. Otherwise the test deploy is the build check.
- [ ] **Step 5: Commit** `build: dashboard port, env and docs for v0.3.0 (#3)`.

### Task 14: Kiosk scripts (gated by Q9)

- [ ] If Q9 = (a): `git mv`-equivalent copy of `homedash/scripts/mac-kiosk/*` into `scripts/mac-kiosk/`. Set the default `HOMEDASH_URL` to `http://10.0.1.78:8180` in `homedash-kiosk.sh`, `install.sh` and the bundled `homedash-kiosk-setup.sh`. Fold in homedash#24's fix (log what the probe sees every 30 s, give up after `HOMEDASH_WAIT=180` and open anyway, `HOMEDASH_BROWSER` override). Add a README pointer. `bash -n` each script. Comment on homedash#24 that the fix moved here. **Commit** `feat(kiosk): Mac kiosk scripts move in, pointed at the new dashboard (#3)`.
- [ ] Running anything on the Mac is the Mac session's job. The coordinator hands it a brief via SendMessage (CLAUDE.md "Cross-machine coordination").

### Task 14b: Review and PR

- [ ] **Step 1:** Run superpowers:requesting-code-review on the branch diff, focused on the guardrails: no non-GET on the dash, no secrets in dash responses, the allowlisted env, WS filter correctness, no `catch {}`.
- [ ] **Step 2:** Final test deploy (Task 2b) and **a 24-hour soak on test**: the logs show no dash restarts (`sudo docker logs unscrypted-test 2>&1 | grep -c "dash.*exited"` → 0), memory is steady (`docker stats --no-stream unscrypted-test` twice, 12 h apart), and the go2rtc UDP socket count is steady (`sudo ss -lunp | grep -c 'pid=<test go2rtc>'`).
- [ ] **Step 3:** `git diff main --stat` shows no whole-file rewrites (CRLF check). Push the branch and open the PR "Homedash moves in: one container, one roof (closes #3)" with the attribution line. Ask the owner to confirm the merge (button panel per memory). **Do not merge without that.**

---

## Phase 7: Prod cutover (after the merge go-ahead)

### Task 15: Deploy prod, switch the living room

- [ ] **Step 1: Confirm the kiosk's current URL** (the Mac session reads `HOMEDASH_URL` from `~/Library/LaunchAgents/com.hooptiej.homedash-kiosk.plist` and reports it). This is the rollback value.
- [ ] **Step 2: Back up:** `cp -a ~/unscrypted/config ~/unscrypted/data ~/unscrypted-backups/pre-0.3.0-$(date +%Y%m%d-%H%M)/` and `cp -a ~/homedash/data/config.json ~/homedash/data/fonts ~/unscrypted-backups/pre-0.3.0-.../homedash/` (skip the 625 MB cache; it isn't being touched).
- [ ] **Step 3: Re-check ports:** `sudo ss -lntup | grep ':8180 '` → nothing.
- [ ] **Step 4: Seed `~/unscrypted/data/dash/`** before the restart, so the dash comes up already configured: copy the fonts + `names.json`, copy the iCloud cache, and place `homedash-config.json`.
- [ ] **Step 5: Deploy** (the one batched prod restart; tell the owner first: "cameras show No Response in Home for about 30 s"). Copy the merged files to `~/unscrypted`, then `sudo docker compose up -d --build`. Verify in the log: the same `HAP pairing state: /data/persist`, the same bridge username, "dashboard listening on http://0.0.0.0:8180", the admin pane on 8190, go2rtc running. `sudo ss -lntup | grep -E ':(51826|8180|8190|8557) '` shows each owned by the container.
- [ ] **Step 6: Import settings:** `sudo docker exec unscrypted node dist/dash/importHomedash.js /data/dash/homedash-config.json /data/dash/settings.json --map <the Q6 mapping>`. The dash picks it up within 2 s.
- [ ] **Step 7: Owner check on his own browser first:** "CHECK THE THING http://10.0.1.78:8180" (tiles, lights, weather, photo, font). Plus: Home still shows all cameras, with no re-pair.
- [ ] **Step 8: Switch the kiosk** (Mac session, via the coordinator's brief): set `HOMEDASH_URL=http://10.0.1.78:8180` in the plist (or re-run the moved setup script if Q9 = a), then `launchctl kickstart -k gui/$(id -u)/com.hooptiej.homedash-kiosk`. The living room flips over in seconds. The old Homedash keeps running untouched.
- [ ] **Step 9: Update quest-log** with "cutover done, soak started <date>".

**Rollback, cheapest first:**
1. **Display only:** the Mac session sets `HOMEDASH_URL` back to the Step 1 value and kickstarts. The old Homedash is still running. Takes seconds.
2. **Old Homedash already stopped:** `cd ~/homedash && sudo docker compose start` (the containers were stopped, not removed), then step 1.
3. **The bridge itself misbehaves on 0.3.0:** restore `~/unscrypted`'s files from the backup's matching copy (or `git checkout` the 0.2.0 files locally and scp them), then `sudo docker compose up -d` **without `--build`** so it runs the existing `unscrypted:0.2.0` image. `./data/dash/` is ignored by 0.2.0. Pairing is untouched either way.

### Task 16: Retire Homedash (owner's call; nothing is deleted without his word)

- [ ] **Step 1:** After the soak period from Q10 (recommended 3 days with no dash restarts and no owner complaints), ask the owner to approve stopping the old stack.
- [ ] **Step 2 (on yes):** `cd ~/homedash && sudo docker compose stop` (homedash + go2rtc), and the same for `~/homedash-dev` (`-f docker-compose.dev.yml`). **Stop, not down or rm.** Verify 1984/1985/8555/8556 are free.
- [ ] **Step 3 (per the Q4/Q10 answer):** `sudo systemctl disable --now homedash-mdns homedash-dev-mdns` (unit files kept), or re-point them.
- [ ] **Step 4:** Deleting containers, images, `~/homedash*` checkouts, the iCloud cache copy, or archiving the homedash repo only happens on a later explicit word. File a quest-log reminder.
- [ ] **Step 5:** Close #3 when the owner confirms. Update quest-log.

---

## Owner decisions

- 2026-10-19: one container; the dash moves onto unscrypted's web server; go2rtc baked in (done in #2).
- 2026-10-19: "A>B, not c": single container, the dash as its own child process; rebuilds restart both (accepted).
- 2026-10-20: live video is WebRTC video-only through go2rtc's player ("we should just copy what works").
- 2026-10-20: `unscrypted-test` stays up for this work.
- 2026-10-20 09:25: "no sign in on the kiosk, free viewing, require the password to view the admin" (guardrails in Global Constraints).
- **2026-10-20 09:43, answers to the 12 questions** (relayed verbatim from the owner's Mac session): "1c, 2a, 3a, 4b, 5a, 6a, 7a, 8b, 9a, 10A, 11a, 12a". These answers override the "(recommended)" marks below.
  - **Q1 c:** no extra network on the other apps. The Constructicon, Constructicon-test, Questlog and Questlog-dev lights show red, with the reason "can't be checked from the NAS's own network yet (ipvlan)". A follow-up issue tracks it.
  - **Q2 a:** the Scrypted light becomes a "HomeKit bridge" light, from unscrypted's own status.
  - **Q3 a:** copy the three cached Constructicon font files once into `./data/dash/fonts`; no token.
  - **Q4 b:** re-point the kiosk to `http://10.0.1.78:8180` AND re-point `homedash.local` at the NAS (10.0.1.78), so the kiosk URL must carry `:8180`. A bare `http://homedash.local` would open the TrueNAS login, so say so in the README and the cutover notes. Ports 8180 (prod) / 8181 (test) taken as OK (implied by 4b). The mDNS and kiosk changes happen only in Phase 7, after the prod go-ahead.
  - **Q5 a:** the 2x2 grid with today's four cameras. Couch Cam is listed but off, and a fifth is refused with a clear message.
  - **Q6 a:** Homedash's labels as dashboard-only labels; the HomeKit names are untouched.
  - **Q7 a:** keep the Settings button. It asks for the admin password, and idling back to the dash signs that browser out.
  - **Q8 b (not the recommendation):** port Homedash's own one-screen, no-scroll settings page (#16) as its own page behind the admin sign-in, instead of a Dashboard tab in the pane. **Phase 5 changes accordingly.**
  - **Q9 a:** move the kiosk scripts into unscrypted and fold in homedash#24's fix.
  - **Q10 a:** after 3 clean days, stop (not remove) the old Homedash containers and disable their two mDNS units. Deleting waits for a later word.
  - **Q11 a:** bind-mount `web/dash` read-only into `unscrypted-test` only.
  - **Q12 a:** main 1080p streams, with sub selectable per camera.

## Open questions for the owner

Each one is held until answered. "(recommended)" marks the planner's pick.

1. **Constructicon and Questlog lights can't be reached from inside unscrypted** (host networking can't talk to ipvlan containers; Findings 1). (a) Give Constructicon, Constructicon-test, Questlog and Questlog-dev a second, tiny fixed-IP bridge network (e.g. `dashlink`, 172.16.40.0/24), which the NAS host can reach. That's a small compose change in each of those repos, each with its own issue and test-first deploy **(recommended)**. (b) Add an ipvlan "shim" interface on the NAS so the host can reach the whole ipvlan block (one change covers everything, but it's a NAS network setting, and it needs to survive TrueNAS reboots and updates). (c) For now the lights say "can't be checked from the NAS's own network yet" (red with that reason) and a follow-up issue tracks it. (d) Drop those four lights.
2. **Scrypted light.** Scrypted is gone, so Homedash's Server light is orange right now (Findings 2). (a) Replace it with a "HomeKit bridge" light from unscrypted's own status (green = running and paired) **(recommended)**. (b) Just drop it. (c) Keep it.
3. **Constructicon fonts.** Prod uses one of your Constructicon fonts for the clock and the UI. (a) Copy the three cached font files (and their names) once into `./data/dash/fonts`, pick from that folder, and use no token at all. A new font = drop a file in the folder **(recommended)**. (b) Keep the live "From Constructicon" list with the read-only token in `./secrets/constructicon_token`, used only by the signed-in admin process and never sent to the browser. This needs Q1 (a) or (b). (c) System fonts only (your clock face would change).
4. **The living-room address.** The new dash lives at `10.0.1.78:8180`, and nothing can answer on `10.0.1.248` without a second container. (a) Re-point the kiosk once to `http://10.0.1.78:8180` (the Mac session edits one plist line). The old Homedash stays on `.248` during the soak, so rollback is one edit. Retire `homedash.local` with Homedash **(recommended)**. (b) Also re-point `homedash.local` to `10.0.1.78` (note that the bare `http://homedash.local` would then open the TrueNAS login; it needs `:8180`). (c) Keep a tiny redirect container on `.248` (breaks "one container"; transitional only). Also: are ports 8180 (prod) / 8181 (test) OK?
5. **Five cameras, a four-tile grid.** unscrypted also has Couch Cam (Foscam), which Homedash never showed. (a) Keep the 2x2 grid with the same four as today. Couch Cam is listed in Settings, switched off, and Settings refuses a fifth with a clear message **(recommended)**. (b) Grow the grid to 3x2 when more than four are on (a layout change). (c) Something else.
6. **Tile labels.** (a) Keep Homedash's labels (DogCam, BackyardCam, Garagecam, ONVIF Camera) as dashboard-only labels, with the HomeKit names (…Test) untouched **(recommended)**. (b) Show the HomeKit names.
7. **The Settings button on the kiosk** (settings now need the admin password). (a) Keep it. It opens the pane's Dashboard tab and asks for the password; when it idles back to the dashboard it signs that browser out, so the living room never stays signed in **(recommended)**. (b) Keep it and stay signed in for 30 days on the kiosk. (c) Take the button off the display (a hidden feature, against your rule).
8. **Settings page look.** (a) A "Dashboard" tab in the admin pane, in the pane's style **(recommended)**. (b) Port Homedash's one-screen, no-scroll 2560 canvas settings page (#16) as its own page behind sign-in.
9. **Kiosk scripts.** (a) Move `scripts/mac-kiosk/` into unscrypted with the new default URL, and fold in homedash#24's fix **(recommended)**. (b) Leave them in the homedash repo and update them there.
10. **Retirement.** (a) After 3 clean days, stop (not remove) `homedash`, `go2rtc`, `homedash-dev`, `go2rtc-dev`, and disable the two `homedash*-mdns` units. Deleting and archiving the repo wait for a later word **(recommended)**. (b) A different soak length. (c) Keep `homedash-dev` running for now.
11. **Fast page loop on the test instance.** (a) Bind-mount `web/dash` read-only into `unscrypted-test` only, so page tweaks need no rebuild (prod stays baked) **(recommended)**. (b) Rebuild-only, as #2 chose.
12. **Stream per tile.** (a) Main 1080p streams, as Homedash uses today, with sub selectable per camera in Settings **(recommended)**. (b) Sub streams by default.

## Follow-up issues to file (not in this plan's scope)

- (if Q1 = c) Constructicon/Questlog status lights: reach the ipvlan apps from the host network.
- Homedash's go2rtc sidecars run `alexxit/go2rtc` unpinned (moot after retirement; note it on homedash if it's kept).
- The `/etc/systemd/system/*-mdns.service` units live outside any repo, and two `.bak` copies sit beside them. Track the units in a repo, or note how they survive TrueNAS updates.
- unscrypted's apt ffmpeg is still unpinned (carried over from #2).
