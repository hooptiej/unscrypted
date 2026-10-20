# Admin Pane with Built-in go2rtc: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give unscrypted a signed-in web admin pane, running in the same container as the HomeKit bridge, that shows the pairing QR, lists and edits cameras without hand-editing `config.json`, shows live status, and live-checks every feed through a go2rtc binary baked into the image. (hooptiej/unscrypted#2)

**Architecture:** The existing bridge process (`dist/index.js`) stays the boss. It starts two supervised children: **go2rtc** (a small Go program that pulls RTSP camera feeds and re-serves them to browsers) and the **admin web server** (a second Node process running our own code). The two Node processes talk over Node's built-in parent/child message channel (IPC). If the admin server or go2rtc crashes, the bridge logs it and restarts the child after a short wait. The bridge itself keeps serving HomeKit. Config edits are written by the admin server, then the bridge is told "camera X changed" and re-applies just that camera.

**Tech Stack:** Node 22 + TypeScript (existing), hap-nodejs 0.14.3 (existing), Node stdlib `http` (no web framework), `node:test` via `tsx --test` for tests, `qrcode` npm package (pinned) for the QR image, go2rtc **1.9.14** release binary (pinned by version + SHA-256), vanilla HTML/JS for the pane (no build step, matching Homedash's `web/`).

**Spec:** hooptiej/unscrypted#2 (`gh issue view 2 -R hooptiej/unscrypted`). Follow-on outline: hooptiej/unscrypted#3. Homedash's go2rtc usage: `C:\Users\hoopt\Claude Code\homedash\docs\superpowers\specs\2026-10-10-homedash-design.md` section 4.

## Plain-language glossary (read once)

- **HAP / HomeKit Accessory Protocol:** how the Home app talks to the bridge. `hap-nodejs` does it for us.
- **Bridge identity:** the bridge's `username` (looks like a MAC address) + the pairing keys stored in the persist folder. Change either and Home thinks it's a brand-new, unpaired device.
- **Camera identity:** `uuid.generate("unscrypted:camera:" + name)` in `src/camera.ts`. The camera's **name is its identity**. Rename it and Home sees a new camera (old one goes "No Response", its recordings and automations are orphaned).
- **go2rtc:** a single-file program that connects to a camera's RTSP feed once and re-serves it to browsers (MSE over a WebSocket, or WebRTC). It has a small HTTP API.
- **MSE:** "Media Source Extensions", a way for a browser to play a video stream that arrives over a normal web connection. It needs no extra network ports, so it can go through our admin server's sign-in.
- **WebRTC:** lower-latency browser video, but the browser needs a direct extra port (UDP/TCP) to go2rtc. Homedash uses it.
- **IPC:** inter-process messages. `child_process.fork()` gives a parent and child Node process a built-in message pipe (`process.send` / `on("message")`).
- **Atomic write:** write the new file under a temp name, flush it to disk, then rename it over the old one. A crash mid-write leaves either the old file or the new file, never half of each.
- **Host networking:** the container shares the NAS's network ports directly (required for HomeKit discovery). Every port we open is a port on the NAS itself, so clashes matter.

## Global Constraints

- **Camera names are immutable from the pane.** Any request that changes an existing camera's `name` is refused with: what was attempted, that nothing changed, and why (Home identity). New-camera names are checked unique and the form warns they're permanent.
- **Never change** `bridge.name`, `bridge.username`, `bridge.setupId`, or the pairing-state folder from the pane. The pane does not edit `bridge.*` at all in #2.
- **Secrets never go to the browser.** Passwords and URL-embedded passwords come back as `{ "set": true }` / `rtsp://user:***@host/...`. Write-only fields: absent = keep, string = replace.
- **Every error** (API JSON and UI) carries `attempted`, `happened`, `changed`, `next` in plain words. No swallowed exceptions, no `catch {}` without logging + surfacing, no blank tiles, no dead buttons.
- **The bridge must survive** any crash in admin code or go2rtc: both run as supervised child processes with restart backoff (1s doubling to 60s cap, reset after 5 minutes healthy).
- **Ports (verified free on the NAS 2026-10-19 via `ss -ltnp`):** admin pane `8190/tcp`; go2rtc API `127.0.0.1:1986` (loopback only, reached through the admin proxy); go2rtc RTSP server disabled; go2rtc WebRTC disabled in #2 (reserve `8557` for #3). Test instance: admin `8191`, go2rtc API `127.0.0.1:1987`, HAP `51827` if HAP is on. In use already: HAP `51826`, ONVIF notify receiver `8101` (configured 8099-8102, all reserved), Homedash go2rtc prod `1984/8555`, dev `1985/8556`, `3300`, `80/443` (TrueNAS UI), `22`, `139/445`.
- **go2rtc pinned:** version `1.9.14` (what Homedash runs on the box today, `linux/amd64`, NAS is `x86_64`), downloaded at build time and checked against a SHA-256 recorded in the Dockerfile. Never `latest`, never the `alexxit/go2rtc` image.
- **Docker standard:** code baked into image, image tag = `package.json` version (bump to `0.2.0`), pinned base + deps, per-install config via env and secrets files, test instance via compose override.
- **Workflow:** GitHub issue, then branch, then PR, then owner confirms merge. Live-test on the NAS test instance before merge. No pushes to `main`.
- **Test instance must never collide with prod's HomeKit identity:** it runs with HAP **off** by default (see Task 9 and Open Question 4).
- **Line endings:** local checkout is CRLF (`core.autocrlf=true`). Use the Edit tool; check `git diff --stat` for whole-file rewrites before each commit.
- **Dev tab label:** test instance page title is `unscrypted admin - TEST`; prod is `unscrypted admin`.
- **Theme:** olive/avocado green accent (`#7a8a2e`-ish), never emerald. Logo: placeholder text mark in the header.

## Findings from the live box (2026-10-19, read-only)

1. **Pairing keys live in a throwaway Docker volume.** The prod `config.json` has `"persistDir": "persist"`, which `resolveConfig` resolves next to the config file (`/config/persist`) and which **beats** the `UNSCRYPTED_PERSIST_DIR=/data/persist` env var. `/config` is an *anonymous* Docker volume (created by `VOLUME ["/config","/data"]` in the Dockerfile), so the live keys (`AccessoryInfo.CC223DE3CEF7.json`, `ControllerStorage...`, `IdentifierCache...`) sit in `/mnt/.ix-apps/docker/volumes/aee15.../_data/persist`. `./data` on the host is **empty**. A `docker compose down` (or any change to the `/config` mount, which this plan needs) would lose them and force a full re-pair in Home. Task 0 fixes this first, as its own issue and PR.
2. **`config.json` is mounted read-only as a single file.** The pane must write it, and atomic rename doesn't work over a single-file bind mount (`EBUSY`). It needs a directory mount: `./config:/config` (rw).
3. **The NAS checkout (`~/unscrypted`) is not a git repo.** It was copied over (scp). The compose comment "git pull && docker compose up" doesn't apply. Gap noted. Open Question 7.
4. **Only one ONVIF notify receiver runs** (port 8101). The other cameras' `notifyPort` values (8099, 8100, 8102) are ignored with a warning every 10 minutes. Harmless, but the pane's status page should show "ONVIF push receiver: 8101" so this isn't confusing. (Not fixed here; file a small issue.)
5. **Docker gaps vs the owner's standard:** `apt-get install ffmpeg` is unpinned; base image pinned by tag but not digest; anonymous `VOLUME` lines (the cause of finding 1); no healthcheck; no test compose override; config mount read-only single file; image tag hard-coded in compose rather than tied to the release. Tasks 0 and 9 cover these, except ffmpeg pinning which is listed as a follow-up issue.

## File structure

New files:

| Path | Responsibility |
|---|---|
| `src/admin/errors.ts` | `UserError` type (attempted/happened/changed/next) and JSON shape. |
| `src/admin/configStore.ts` | Read raw config, redact for the browser, merge an edit (secrets + name lock), validate, atomic write with backups. Pure functions + one fs function. |
| `src/admin/go2rtcConfig.ts` | Stream slug from camera name; build go2rtc YAML from a `ResolvedConfig`. Pure. |
| `src/admin/supervisor.ts` | Generic child-process supervisor (spawn/fork, restart with backoff, state reporting). |
| `src/admin/go2rtc.ts` | Go2rtc manager: writes YAML (mode 0600) to a runtime dir, supervises the binary, small API client. |
| `src/admin/ipc.ts` | Message types between bridge (parent) and admin server (child). |
| `src/admin/auth.ts` | Admin password check, signed session cookie, login rate limit. |
| `src/admin/server.ts` | HTTP routing, error boundary, static files, go2rtc proxy (HTTP + WebSocket). |
| `src/admin/main.ts` | Admin child entry point (forked by the bridge). |
| `src/bridgeRuntime.ts` | Bridge-side: camera registry, apply/add camera at runtime, status snapshot, starts/supervises the two children. |
| `web/admin/index.html`, `app.js`, `style.css` | The pane (vanilla JS). |
| `test/admin/*.test.ts` | Unit tests (`node:test`). |
| `docker-compose.test.yml` | Test-instance override. |
| `secrets/.gitkeep` | Secrets folder placeholder (contents gitignored). |

Modified: `src/index.ts` (hand off to `bridgeRuntime`), `src/camera.ts` (status + live reconfigure), `src/recordingDelegate.ts` (expose recording-active), `src/streamingDelegate.ts` (expose live session count), `src/config.ts` (export raw types already exported; add `persistDir` precedence fix in Task 0), `package.json`, `Dockerfile`, `docker-compose.yml`, `.gitignore`, `.dockerignore`, `README.md`.

**Why `node:test` for tests:** it ships with Node 22 (no new dependency), and `tsx` (already a dev dependency) runs TypeScript test files directly: `tsx --test`. Tests live in `test/` so `tsc` (rootDir `src`) never compiles them into the image.

---

## Phase 0: Prerequisites (separate issue + PR, before any pane code)

### Task 0: Move pairing keys out of the throwaway volume; make config a writable folder

**This touches prod. Every step that changes the box needs the owner's go-ahead first (Open Question 1).**

**Files:**
- Modify: `src/config.ts` (persistDir precedence), `Dockerfile` (drop anonymous `VOLUME`), `docker-compose.yml` (directory mounts), `.gitignore`, `.dockerignore`, `README.md`
- Test: `test/admin/config-persist.test.ts`

**Interfaces:**
- Produces: config lives at host `./config/config.json` mounted at `/config` (rw); pairing state at host `./data/persist` mounted at `/data/persist`; `UNSCRYPTED_PERSIST_DIR` env wins over `config.persistDir`.

- [ ] **Step 1: File the issue.** `gh issue create -R hooptiej/unscrypted --title "Pairing keys are squatting in a throwaway volume" --body-file <file>` describing finding 1 and the fix. Branch `fix/persist-out-of-anon-volume-<n>`.

- [ ] **Step 2: Add the test runner.** In `package.json` scripts add `"test": "tsx --test test/**/*.test.ts"`. Create `test/admin/config-persist.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../../src/config";

const base = { bridge: {}, cameras: [{ name: "Cam", rtspMain: "rtsp://h/1" }] };

test("UNSCRYPTED_PERSIST_DIR beats config.persistDir", () => {
  process.env.UNSCRYPTED_PERSIST_DIR = "/data/persist";
  try {
    const r = resolveConfig({ ...base, persistDir: "persist" } as any, "/config");
    assert.equal(r.persistDir, "/data/persist");
  } finally {
    delete process.env.UNSCRYPTED_PERSIST_DIR;
  }
});

test("config.persistDir used when env unset, resolved next to config", () => {
  delete process.env.UNSCRYPTED_PERSIST_DIR;
  const r = resolveConfig({ ...base, persistDir: "persist" } as any, "/config");
  assert.equal(r.persistDir.replace(/\\/g, "/").endsWith("/config/persist"), true);
});
```

- [ ] **Step 3: Run it, expect the first test to FAIL.** `npm test` → `persistDir` is `/config/persist`.

- [ ] **Step 4: Fix precedence** in `src/config.ts` `resolveConfig`:

```ts
  const persistDir = path.resolve(
    baseDir,
    process.env.UNSCRYPTED_PERSIST_DIR ?? raw.persistDir ?? "persist",
  );
```

Add a comment: env wins so the container's mounted `/data/persist` can't be overridden by a stale config key.

- [ ] **Step 5: `npm test` passes; `npm run typecheck` passes.**

- [ ] **Step 6: Dockerfile.** Delete the `VOLUME ["/config", "/data"]` line (anonymous volumes are what trapped the keys; compose bind mounts are the source of truth). Keep `ENV UNSCRYPTED_PERSIST_DIR=/data/persist`.

- [ ] **Step 7: docker-compose.yml volumes** become:

```yaml
    volumes:
      # Config folder (rw so the admin pane can save edits; backups land in ./config/backups).
      # config.json holds camera passwords: gitignored, never committed.
      - ./config:/config
      # HAP pairing state. Losing this forces re-pairing every camera in Home.
      - ./data:/data
```

`.gitignore` add: `config/`, `secrets/*` with `!secrets/.gitkeep`, `run.*`, `qr*.png`. `.dockerignore` add: `config`, `secrets`, `test`, `docs`.

- [ ] **Step 8: Rehearse the migration on a copy (no prod change).** On the NAS:

```bash
cd "$HOME"
VOL=$(sudo docker inspect unscrypted --format '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Source}}{{end}}{{end}}')
echo "$VOL"            # expect /mnt/.ix-apps/docker/volumes/<id>/_data
sudo ls -la "$VOL/persist"   # expect the three *.CC223DE3CEF7.json files
```

- [ ] **Step 9 (owner go-ahead required): Migrate prod.** Back up first, then move, then redeploy with the new code. Home shows the cameras "No Response" for about 30 seconds.

```bash
cd "$HOME/unscrypted"
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$HOME/unscrypted-backups/$STAMP"
sudo cp -a "$VOL/persist" "$HOME/unscrypted-backups/$STAMP/persist"
cp -a config.json "$HOME/unscrypted-backups/$STAMP/config.json"
mkdir -p config data/persist
sudo cp -a "$VOL/persist/." data/persist/
sudo chown -R 1000:1000 data config   # node user in the image is uid 1000
mv config.json config/config.json
# copy the branch's changed files here (scp from the local worktree), then:
sudo docker compose up -d --build
sudo docker logs unscrypted 2>&1 | grep "HAP pairing state"   # expect /data/persist
```

- [ ] **Step 10: Verify the bridge kept its identity.** `sudo docker logs unscrypted | grep -c "setup code"` (still prints) and, crucially, ask the owner to open Home and confirm the cameras came back without re-pairing. Only then remove the old anonymous volume (owner go-ahead, it's a delete): `sudo docker volume rm <id>`.

- [ ] **Step 11: README** "Docker" section: new folder layout, `./config` and `./data` meaning, "never delete `./data`".

- [ ] **Step 12: Commit + PR** `git commit -m "fix: keep HAP pairing keys in ./data, config folder writable (#<n>)"`. Owner confirms merge.

---

## Phase 1: Foundations (branch `feat/admin-pane-2`)

### Task 1: User-facing errors + config store (read, redact, merge, validate, atomic write)

**Files:**
- Create: `src/admin/errors.ts`, `src/admin/configStore.ts`
- Test: `test/admin/configStore.test.ts`

**Interfaces:**
- Produces:
  - `class UserError extends Error { constructor(public readonly body: UserErrorBody, public readonly status = 400) }`
  - `interface UserErrorBody { attempted: string; happened: string; changed: string; next: string }`
  - `readRawConfig(file: string): Config`
  - `redactCamera(cam: CameraConfig): PublicCamera` / `redactConfig(raw: Config): PublicConfig`
  - `applyCameraEdit(raw: Config, originalName: string | null, edit: CameraEdit): Config` (null = add)
  - `writeConfigAtomic(file: string, next: Config, opts?: { keepBackups?: number }): { backupPath: string | null }`
  - `type CameraEdit = Partial<Omit<CameraConfig, "foscam" | "onvif">> & { foscam?: Partial<FoscamConfig> | null; onvif?: Partial<OnvifConfig> | null }`

- [ ] **Step 1: Write failing tests** `test/admin/configStore.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  redactCamera, applyCameraEdit, writeConfigAtomic, readRawConfig,
} from "../../src/admin/configStore";
import { UserError } from "../../src/admin/errors";

const cfg = () => ({
  bridge: { name: "Unscrypted", username: "CC:22:3D:E3:CE:F6", pin: "031-45-154" },
  cameras: [
    { name: "Garage", rtspMain: "rtsp://admin:s3cret@10.0.0.3:554/11",
      onvif: { host: "10.0.0.3", port: 8080, username: "admin", password: "s3cret" } },
    { name: "Front", host: "10.0.0.5", rtspUser: "admin", rtspPassword: "pw2",
      foscam: { cgiBase: "http://10.0.0.5:88", username: "admin", password: "pw2" } },
  ],
});

test("redaction hides every password, keeps 'set' markers", () => {
  const out = JSON.stringify([redactCamera(cfg().cameras[0] as any), redactCamera(cfg().cameras[1] as any)]);
  assert.ok(!out.includes("s3cret"));
  assert.ok(!out.includes("pw2"));
  assert.ok(out.includes("rtsp://admin:***@10.0.0.3:554/11"));
  assert.ok(out.includes('"password":{"set":true}'));
  assert.ok(out.includes('"rtspPassword":{"set":true}'));
});

test("rename of an existing camera is refused, nothing changes", () => {
  const raw = cfg();
  assert.throws(
    () => applyCameraEdit(raw as any, "Garage", { name: "Garage 2" }),
    (e: unknown) => e instanceof UserError && /new camera/i.test(e.body.happened + e.body.next),
  );
  assert.equal(raw.cameras[0].name, "Garage");
});

test("absent password keeps stored one; masked URL keeps stored password", () => {
  const next = applyCameraEdit(cfg() as any, "Garage", {
    rtspMain: "rtsp://admin:***@10.0.0.3:554/12",
    onvif: { port: 80 },
  });
  const g = next.cameras[0];
  assert.equal(g.rtspMain, "rtsp://admin:s3cret@10.0.0.3:554/12");
  assert.equal(g.onvif!.password, "s3cret");
  assert.equal(g.onvif!.port, 80);
});

test("new password string replaces stored one", () => {
  const next = applyCameraEdit(cfg() as any, "Front", { rtspPassword: "newpw" });
  assert.equal(next.cameras[1].rtspPassword, "newpw");
});

test("adding a camera with a duplicate name is refused", () => {
  assert.throws(() => applyCameraEdit(cfg() as any, null, { name: "Garage", rtspMain: "rtsp://x/1" }), UserError);
});

test("invalid result is refused by the existing validator before any write", () => {
  assert.throws(
    () => applyCameraEdit(cfg() as any, "Garage", { foscam: { cgiBase: "http://x", username: "a", password: "b" } }),
    (e: unknown) => e instanceof UserError && /motion source/i.test(e.body.happened),
  );
});

test("atomic write: backup of previous version, new content readable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unscr-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg()));
  const next = applyCameraEdit(cfg() as any, "Front", { prebufferSeconds: 6 });
  const { backupPath } = writeConfigAtomic(file, next);
  assert.ok(backupPath && fs.existsSync(backupPath));
  assert.equal(readRawConfig(file).cameras[1].prebufferSeconds, 6);
  assert.equal(JSON.parse(fs.readFileSync(backupPath!, "utf8")).cameras[1].prebufferSeconds, undefined);
});

test("backups are pruned to keepBackups", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unscr-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg()));
  for (let i = 0; i < 5; i++) writeConfigAtomic(file, cfg() as any, { keepBackups: 3 });
  assert.equal(fs.readdirSync(path.join(dir, "backups")).length, 3);
});
```

- [ ] **Step 2: Run `npm test`, expect FAIL** (modules missing).

- [ ] **Step 3: Implement `src/admin/errors.ts`:**

```ts
/** Every failure the pane can show: what was tried, what happened, what changed, what to do. */
export interface UserErrorBody {
  attempted: string;
  happened: string;
  changed: string;
  next: string;
}

export class UserError extends Error {
  constructor(public readonly body: UserErrorBody, public readonly status = 400) {
    super(`${body.attempted}: ${body.happened}`);
  }
}

export function toErrorJson(err: unknown, attempted: string): { status: number; body: { error: UserErrorBody } } {
  if (err instanceof UserError) return { status: err.status, body: { error: err.body } };
  const msg = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: {
      error: {
        attempted,
        happened: `Unexpected error inside unscrypted: ${msg}`,
        changed: "Unknown; check the bridge log before retrying.",
        next: "Look at `docker logs unscrypted` for the full error, then retry. If it repeats, file an issue with the log lines.",
      },
    },
  };
}
```

- [ ] **Step 4: Implement `src/admin/configStore.ts`:**

```ts
import * as fs from "fs";
import * as path from "path";
import { Config, CameraConfig, FoscamConfig, OnvifConfig, resolveConfig, ConfigError } from "../config";
import { UserError } from "./errors";

export type Secret = { set: boolean };
export type PublicCamera = Omit<CameraConfig, "rtspPassword" | "foscam" | "onvif"> & {
  rtspPassword?: Secret;
  foscam?: Omit<FoscamConfig, "password"> & { password: Secret };
  onvif?: Omit<OnvifConfig, "password"> & { password: Secret };
};
export type CameraEdit = Partial<Omit<CameraConfig, "foscam" | "onvif">> & {
  foscam?: Partial<FoscamConfig> | null;
  onvif?: Partial<OnvifConfig> | null;
};

const MASK = "***";
const URL_CREDS = /^(rtsp:\/\/[^:/@]+:)([^@]*)(@.*)$/i;

export function maskUrl(url: string | undefined): string | undefined {
  return url?.replace(URL_CREDS, `$1${MASK}$3`);
}

/** If the submitted URL still carries the mask, put the stored password back. */
function unmaskUrl(submitted: string, stored: string | undefined): string {
  const m = URL_CREDS.exec(submitted);
  if (!m || m[2] !== MASK) return submitted;
  const old = stored ? URL_CREDS.exec(stored) : null;
  if (!old) {
    throw new UserError({
      attempted: "Save the camera's stream URL",
      happened: `The URL still has "${MASK}" as its password, and there's no stored password to keep.`,
      changed: "Nothing was saved.",
      next: "Type the real password into the URL (it's stored server-side and never shown again).",
    });
  }
  return `${m[1]}${old[2]}${m[3]}`;
}

export function redactCamera(cam: CameraConfig): PublicCamera {
  const out: any = { ...cam, rtspMain: maskUrl(cam.rtspMain), rtspSub: maskUrl(cam.rtspSub) };
  if (cam.rtspPassword !== undefined) out.rtspPassword = { set: cam.rtspPassword !== "" };
  if (cam.foscam) out.foscam = { ...cam.foscam, password: { set: cam.foscam.password !== "" } };
  if (cam.onvif) out.onvif = { ...cam.onvif, password: { set: cam.onvif.password !== "" } };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export function redactConfig(raw: Config): { cameras: PublicCamera[] } {
  return { cameras: raw.cameras.map(redactCamera) };
}

export function readRawConfig(file: string): Config {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Config;
}

function mergeBlock<T extends { password: string }>(
  stored: T | undefined, edit: Partial<T> | null | undefined,
): T | undefined {
  if (edit === null) return undefined;          // explicit removal of the block
  if (edit === undefined) return stored;
  const merged = { ...(stored ?? {}), ...edit } as T;
  if (edit.password === undefined && stored) merged.password = stored.password;
  return merged;
}

export function applyCameraEdit(raw: Config, originalName: string | null, edit: CameraEdit): Config {
  const next: Config = JSON.parse(JSON.stringify(raw));
  let cam: CameraConfig;
  if (originalName === null) {
    const name = (edit.name ?? "").trim();
    if (!name) {
      throw new UserError({ attempted: "Add a camera", happened: "No name was given.", changed: "Nothing was saved.",
        next: "Pick a name. It's permanent: Home uses it as the camera's identity." });
    }
    if (next.cameras.some((c) => c.name === name)) {
      throw new UserError({ attempted: `Add camera "${name}"`, happened: "A camera with that name already exists.",
        changed: "Nothing was saved.", next: "Pick a different name, or edit the existing camera instead." }, 409);
    }
    cam = { name } as CameraConfig;
    next.cameras.push(cam);
  } else {
    const found = next.cameras.find((c) => c.name === originalName);
    if (!found) {
      throw new UserError({ attempted: `Edit camera "${originalName}"`, happened: "No camera with that name is in config.json.",
        changed: "Nothing was saved.", next: "Reload the page; someone may have edited config.json by hand." }, 404);
    }
    if (edit.name !== undefined && edit.name !== originalName) {
      throw new UserError({
        attempted: `Rename camera "${originalName}" to "${edit.name}"`,
        happened: "Renaming is blocked: HomeKit uses the camera's name as its identity, so a rename makes Home see a brand-new camera and orphans the old one's recordings and automations.",
        changed: "Nothing was saved.",
        next: "Keep the name here and rename the camera inside the Home app instead (that only changes what Home displays).",
      }, 409);
    }
    cam = found;
  }

  const { foscam, onvif, name: _ignored, ...plain } = edit;
  for (const [k, v] of Object.entries(plain)) {
    if (v === undefined) continue;
    if ((k === "rtspMain" || k === "rtspSub") && typeof v === "string") {
      (cam as any)[k] = unmaskUrl(v, (cam as any)[k]);
    } else {
      (cam as any)[k] = v;
    }
  }
  const f = mergeBlock(cam.foscam, foscam as Partial<FoscamConfig> | null | undefined);
  const o = mergeBlock(cam.onvif, onvif as Partial<OnvifConfig> | null | undefined);
  if (f) cam.foscam = f; else delete cam.foscam;
  if (o) cam.onvif = o; else delete cam.onvif;

  try {
    resolveConfig(next, "/");   // the existing validator; throws ConfigError
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new UserError({ attempted: `Save camera "${cam.name}"`, happened: err.message,
        changed: "Nothing was saved; config.json is untouched.", next: "Fix the field named above and save again." });
    }
    throw err;
  }
  return next;
}

export function writeConfigAtomic(file: string, next: Config, opts: { keepBackups?: number } = {}): { backupPath: string | null } {
  const keep = opts.keepBackups ?? 20;
  const dir = path.dirname(file);
  const backups = path.join(dir, "backups");
  fs.mkdirSync(backups, { recursive: true });
  let backupPath: string | null = null;
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(backups, `config-${stamp}-${process.hrtime.bigint()}.json`);
    fs.copyFileSync(file, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(next, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const all = fs.readdirSync(backups).filter((n) => n.startsWith("config-")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(backups, old));
  return { backupPath };
}
```

- [ ] **Step 5: `npm test` → all configStore tests PASS. `npm run typecheck` clean.**

- [ ] **Step 6: Commit** `git add src/admin test/admin package.json && git commit -m "feat(admin): config store with redaction, rename lock, atomic write (#2)"`

### Task 2: go2rtc config generator

**Files:**
- Create: `src/admin/go2rtcConfig.ts`
- Test: `test/admin/go2rtcConfig.test.ts`

**Interfaces:**
- Consumes: `ResolvedConfig` / `ResolvedCamera` from `src/config.ts`.
- Produces: `streamSlug(name: string): string`, `streamNames(cams: ResolvedCamera[]): Map<string, { main: string; sub?: string }>` (camera name → go2rtc stream names, collision-safe), `buildGo2rtcYaml(cfg: ResolvedConfig, ports: Go2rtcPorts): string`, `interface Go2rtcPorts { api: number; webrtc: number | null }`.

- [ ] **Step 1: Failing tests:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { streamSlug, streamNames, buildGo2rtcYaml } from "../../src/admin/go2rtcConfig";

const cam = (name: string, extra: any = {}) => ({ name, rtspMain: "rtsp://u:p@h/11", rtspSub: "rtsp://u:p@h/12", audio: false, ...extra });

test("slug is lowercase, safe, stable", () => {
  assert.equal(streamSlug("Couch Cam"), "couch_cam");
  assert.equal(streamSlug("Garage (ONVIF)!"), "garage_onvif");
});

test("colliding slugs get numeric suffixes in config order", () => {
  const m = streamNames([cam("A b"), cam("a-b")] as any);
  assert.equal(m.get("A b")!.main, "a_b");
  assert.equal(m.get("a-b")!.main, "a_b_2");
  assert.equal(m.get("a-b")!.sub, "a_b_2_sub");
});

test("yaml: loopback API, RTSP server off, WebRTC off when null, video-only streams", () => {
  const y = buildGo2rtcYaml({ cameras: [cam("Couch Cam")] } as any, { api: 1986, webrtc: null });
  assert.match(y, /listen: "127\.0\.0\.1:1986"/);
  assert.match(y, /rtsp:\n  listen: ""/);
  assert.match(y, /webrtc:\n  listen: ""/);
  assert.match(y, /couch_cam: "rtsp:\/\/u:p@h\/11#media=video"/);
  assert.match(y, /couch_cam_sub: "rtsp:\/\/u:p@h\/12#media=video"/);
});

test("audio cameras keep audio", () => {
  const y = buildGo2rtcYaml({ cameras: [cam("X", { audio: true })] } as any, { api: 1986, webrtc: null });
  assert.match(y, /x: "rtsp:\/\/u:p@h\/11"\n/);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement:**

```ts
import { ResolvedCamera, ResolvedConfig } from "../config";

export interface Go2rtcPorts { api: number; webrtc: number | null }

export function streamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "camera";
}

export function streamNames(cams: ResolvedCamera[]): Map<string, { main: string; sub?: string }> {
  const used = new Set<string>();
  const out = new Map<string, { main: string; sub?: string }>();
  for (const c of cams) {
    const base = streamSlug(c.name);
    let slug = base;
    for (let i = 2; used.has(slug); i++) slug = `${base}_${i}`;
    used.add(slug);
    out.set(c.name, { main: slug, sub: c.rtspSub ? `${slug}_sub` : undefined });
  }
  return out;
}

/** JSON strings are valid YAML scalars, so JSON.stringify quotes safely. */
const q = (s: string) => JSON.stringify(s);

export function buildGo2rtcYaml(cfg: Pick<ResolvedConfig, "cameras">, ports: Go2rtcPorts): string {
  const names = streamNames(cfg.cameras);
  const lines = [
    "# Generated by unscrypted from config.json. Do not edit; it's rewritten on every start/apply.",
    "api:",
    `  listen: ${q(`127.0.0.1:${ports.api}`)}`,
    "rtsp:",
    '  listen: ""',
    "webrtc:",
    `  listen: ${q(ports.webrtc ? `:${ports.webrtc}` : "")}`,
    "log:",
    "  level: info",
    "streams:",
  ];
  for (const c of cfg.cameras) {
    const n = names.get(c.name)!;
    const suffix = c.audio ? "" : "#media=video";
    lines.push(`  ${n.main}: ${q(c.rtspMain + suffix)}`);
    if (n.sub && c.rtspSub) lines.push(`  ${n.sub}: ${q(c.rtspSub + suffix)}`);
  }
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Tests PASS.** Also confirm against the real binary later (Task 9 step "go2rtc parses our YAML").

- [ ] **Step 5: Commit** `feat(admin): generate go2rtc streams from config.json (#2)`.

### Task 3: Child-process supervisor

**Files:**
- Create: `src/admin/supervisor.ts`
- Test: `test/admin/supervisor.test.ts`

**Interfaces:**
- Produces:

```ts
export type ChildState = "starting" | "running" | "backoff" | "stopped" | "missing";
export interface ChildStatus { name: string; state: ChildState; restarts: number; lastError: string | null; nextRetryAt: number | null; since: number }
export interface SupervisorOptions {
  name: string;
  start: () => import("child_process").ChildProcess;   // spawn or fork
  log: import("../logger").Logger;
  minBackoffMs?: number;  // default 1000
  maxBackoffMs?: number;  // default 60000
  healthyResetMs?: number; // default 300000
  onState?: (s: ChildStatus) => void;
}
export class Supervisor { constructor(o: SupervisorOptions); start(): void; stop(): Promise<void>; status(): ChildStatus; child(): import("child_process").ChildProcess | null }
```

- [ ] **Step 1: Failing tests** (use `process.execPath` as a fake child):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import { Supervisor } from "../../src/admin/supervisor";
import { rootLogger } from "../../src/logger";

const crashy = () => spawn(process.execPath, ["-e", "process.exit(3)"]);

test("restarts a crashing child with growing backoff and reports why", async () => {
  const states: string[] = [];
  const s = new Supervisor({ name: "crashy", start: crashy, log: rootLogger, minBackoffMs: 20, maxBackoffMs: 80,
    onState: (st) => states.push(st.state) });
  s.start();
  await new Promise((r) => setTimeout(r, 400));
  await s.stop();
  const st = s.status();
  assert.ok(st.restarts >= 3, `restarts=${st.restarts}`);
  assert.match(st.lastError ?? "", /exited with code 3/);
  assert.ok(states.includes("backoff"));
  assert.equal(st.state, "stopped");
});

test("missing binary is reported as 'missing', not a silent loop", async () => {
  const s = new Supervisor({ name: "ghost", start: () => spawn("/nonexistent/go2rtc"), log: rootLogger, minBackoffMs: 20 });
  s.start();
  await new Promise((r) => setTimeout(r, 100));
  await s.stop();
  assert.match(s.status().lastError ?? "", /ENOENT|not found/i);
});

test("stop() kills a long-running child", async () => {
  const s = new Supervisor({ name: "sleeper", start: () => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]), log: rootLogger });
  s.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.status().state, "running");
  await s.stop();
  assert.equal(s.status().state, "stopped");
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement:**

```ts
import { ChildProcess } from "child_process";
import { Logger } from "../logger";

export type ChildState = "starting" | "running" | "backoff" | "stopped" | "missing";
export interface ChildStatus { name: string; state: ChildState; restarts: number; lastError: string | null; nextRetryAt: number | null; since: number }
export interface SupervisorOptions {
  name: string; start: () => ChildProcess; log: Logger;
  minBackoffMs?: number; maxBackoffMs?: number; healthyResetMs?: number;
  onState?: (s: ChildStatus) => void;
}

export class Supervisor {
  private proc: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private backoff: number;
  private wanted = false;
  private st: ChildStatus;
  private startedAt = 0;

  constructor(private readonly o: SupervisorOptions) {
    this.backoff = o.minBackoffMs ?? 1000;
    this.st = { name: o.name, state: "stopped", restarts: 0, lastError: null, nextRetryAt: null, since: Date.now() };
  }

  status(): ChildStatus { return { ...this.st }; }
  child(): ChildProcess | null { return this.proc; }

  private set(p: Partial<ChildStatus>): void {
    this.st = { ...this.st, ...p, since: p.state && p.state !== this.st.state ? Date.now() : this.st.since };
    this.o.onState?.(this.status());
  }

  start(): void { this.wanted = true; this.launch(); }

  private launch(): void {
    if (!this.wanted) return;
    this.set({ state: "starting", nextRetryAt: null });
    let proc: ChildProcess;
    try {
      proc = this.o.start();
    } catch (err) {
      this.fail(`could not start: ${(err as Error).message}`, true);
      return;
    }
    this.proc = proc;
    this.startedAt = Date.now();
    proc.once("spawn", () => this.set({ state: "running" }));
    proc.once("error", (err: NodeJS.ErrnoException) => {
      this.proc = null;
      this.fail(`could not start: ${err.message}`, err.code === "ENOENT");
    });
    proc.once("exit", (code, signal) => {
      if (this.proc !== proc) return;   // already handled by 'error'
      this.proc = null;
      if (!this.wanted) { this.set({ state: "stopped" }); return; }
      this.fail(signal ? `killed by ${signal}` : `exited with code ${code}`, false);
    });
  }

  private fail(reason: string, missing: boolean): void {
    if (Date.now() - this.startedAt > (this.o.healthyResetMs ?? 300_000)) this.backoff = this.o.minBackoffMs ?? 1000;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.o.maxBackoffMs ?? 60_000);
    this.o.log.error(`${this.o.name} ${reason}; restarting in ${Math.round(wait / 1000)}s (the HomeKit bridge is unaffected)`);
    this.set({ state: missing ? "missing" : "backoff", lastError: reason, restarts: this.st.restarts + 1, nextRetryAt: Date.now() + wait });
    if (!this.wanted) { this.set({ state: "stopped" }); return; }
    this.timer = setTimeout(() => this.launch(), wait);
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.proc;
    if (p && p.exitCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { p.kill("SIGKILL"); resolve(); }, 3000);
        p.once("exit", () => { clearTimeout(t); resolve(); });
        p.kill("SIGTERM");
      });
    }
    this.proc = null;
    this.set({ state: "stopped", nextRetryAt: null });
  }
}
```

- [ ] **Step 4: Tests PASS.**
- [ ] **Step 5: Commit** `feat(admin): child supervisor with backoff and loud status (#2)`.

### Task 4: go2rtc manager (YAML on disk, supervised binary, API client)

**Files:**
- Create: `src/admin/go2rtc.ts`
- Test: `test/admin/go2rtc.test.ts` (client error mapping only; the real binary is exercised in Task 9)

**Interfaces:**
- Consumes: `Supervisor` (Task 3), `buildGo2rtcYaml`, `Go2rtcPorts` (Task 2).
- Produces:

```ts
export interface Go2rtcOptions { binary: string; runtimeDir: string; ports: Go2rtcPorts; log: Logger; onState?: (s: ChildStatus) => void }
export class Go2rtcManager {
  constructor(o: Go2rtcOptions);
  start(cfg: ResolvedConfig): void;          // writes yaml, starts supervisor
  reload(cfg: ResolvedConfig): Promise<void>; // rewrites yaml, restarts the go2rtc child (a few seconds of no preview; HomeKit unaffected)
  stop(): Promise<void>;
  status(): ChildStatus;
  apiBase(): string;                          // "http://127.0.0.1:<api>"
}
export class Go2rtcClient {
  constructor(base: string, timeoutMs?: number);
  addTempStream(name: string, src: string): Promise<void>;   // PUT /api/streams?name=&src=
  removeStream(name: string): Promise<void>;                 // DELETE /api/streams?src=
  frame(src: string): Promise<Buffer>;                       // GET /api/frame.jpeg?src=
}
export function explainGo2rtcFailure(raw: string): { happened: string; next: string };
```

- [ ] **Step 1: Failing test for the failure explainer** (the user-facing part):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { explainGo2rtcFailure } from "../../src/admin/go2rtc";

test("maps common go2rtc failures to plain words", () => {
  assert.match(explainGo2rtcFailure("rtsp: wrong user/pass 401 Unauthorized").happened, /login/i);
  assert.match(explainGo2rtcFailure("dial tcp 10.0.1.3:554: connect: connection refused").happened, /refused/i);
  assert.match(explainGo2rtcFailure("dial tcp 10.0.1.3:554: i/o timeout").happened, /didn't answer/i);
  assert.match(explainGo2rtcFailure("rtsp: 404 Not Found").happened, /path/i);
  const other = explainGo2rtcFailure("weird thing");
  assert.match(other.happened, /weird thing/);
  assert.ok(other.next.length > 0);
});
```

- [ ] **Step 2: Run, FAIL.**

- [ ] **Step 3: Implement:**

```ts
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { spawn } from "child_process";
import { Logger } from "../logger";
import { ResolvedConfig } from "../config";
import { Supervisor, ChildStatus } from "./supervisor";
import { buildGo2rtcYaml, Go2rtcPorts } from "./go2rtcConfig";

export interface Go2rtcOptions { binary: string; runtimeDir: string; ports: Go2rtcPorts; log: Logger; onState?: (s: ChildStatus) => void }

export class Go2rtcManager {
  private readonly sup: Supervisor;
  private readonly yamlPath: string;

  constructor(private readonly o: Go2rtcOptions) {
    this.yamlPath = path.join(o.runtimeDir, "go2rtc.yaml");
    this.sup = new Supervisor({
      name: "go2rtc",
      log: o.log,
      onState: o.onState,
      start: () => {
        const p = spawn(o.binary, ["-config", this.yamlPath], { stdio: ["ignore", "pipe", "pipe"] });
        const pipe = (b: Buffer) => b.toString().split("\n").filter(Boolean).forEach((l) => o.log.info(l));
        p.stdout?.on("data", pipe);
        p.stderr?.on("data", pipe);
        return p;
      },
    });
  }

  private writeYaml(cfg: ResolvedConfig): void {
    fs.mkdirSync(this.o.runtimeDir, { recursive: true, mode: 0o700 });
    const tmp = this.yamlPath + ".tmp";
    fs.writeFileSync(tmp, buildGo2rtcYaml(cfg, this.o.ports), { mode: 0o600 });
    fs.renameSync(tmp, this.yamlPath);
  }

  start(cfg: ResolvedConfig): void { this.writeYaml(cfg); this.sup.start(); }
  async reload(cfg: ResolvedConfig): Promise<void> { this.writeYaml(cfg); await this.sup.stop(); this.sup.start(); }
  stop(): Promise<void> { return this.sup.stop(); }
  status(): ChildStatus { return this.sup.status(); }
  apiBase(): string { return `http://127.0.0.1:${this.o.ports.api}`; }
}

export class Go2rtcClient {
  constructor(private readonly base: string, private readonly timeoutMs = 15000) {}

  private req(method: string, p: string): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const r = http.request(this.base + p, { method }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      });
      r.setTimeout(this.timeoutMs, () => r.destroy(new Error(`go2rtc did not answer within ${this.timeoutMs / 1000}s`)));
      r.on("error", reject);
      r.end();
    });
  }

  async addTempStream(name: string, src: string): Promise<void> {
    const r = await this.req("PUT", `/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`);
    if (r.status >= 300) throw new Error(r.body.toString() || `HTTP ${r.status}`);
  }
  async removeStream(name: string): Promise<void> {
    await this.req("DELETE", `/api/streams?src=${encodeURIComponent(name)}`);
  }
  async frame(src: string): Promise<Buffer> {
    const r = await this.req("GET", `/api/frame.jpeg?src=${encodeURIComponent(src)}`);
    if (r.status !== 200 || r.body.length === 0) throw new Error(r.body.toString() || `HTTP ${r.status}`);
    return r.body;
  }
}

export function explainGo2rtcFailure(raw: string): { happened: string; next: string } {
  const s = raw.toLowerCase();
  if (/401|unauthorized|wrong user/.test(s)) return { happened: "The camera rejected the login (user name or password is wrong).", next: "Re-enter the camera's password and check the user name, then try the check again." };
  if (/connection refused/.test(s)) return { happened: "The camera refused the connection on that port.", next: "Check the RTSP port (usually 554) and that RTSP is enabled in the camera's own settings." };
  if (/timeout|no route|host is unreachable/.test(s)) return { happened: "The camera didn't answer at that address.", next: "Check the IP address and that the camera is powered and on the network (try pinging it)." };
  if (/404|not found/.test(s)) return { happened: "The camera answered but has no stream at that path.", next: "Check the stream path (Foscam: /videoMain, XM cameras: /11 and /12)." };
  return { happened: `go2rtc reported: ${raw}`, next: "Check the URL and login. If it looks right, look at `docker logs unscrypted` for the go2rtc lines around this time." };
}
```

Note: go2rtc returns error text in the response body on failed `frame.jpeg`; the exact wording varies by version, so the explainer falls back to quoting it. In Task 9 capture the real 1.9.14 messages for a wrong password / wrong IP and add them to the test if they differ.

- [ ] **Step 4: Tests PASS. Commit** `feat(admin): supervised go2rtc with plain-words failure messages (#2)`.

### Task 5: Bridge runtime (camera registry, live apply, add at runtime, status, IPC)

**Files:**
- Create: `src/admin/ipc.ts`, `src/bridgeRuntime.ts`
- Modify: `src/camera.ts`, `src/recordingDelegate.ts`, `src/streamingDelegate.ts`, `src/index.ts`
- Test: `test/admin/applyPlan.test.ts`

**Interfaces:**
- Consumes: `Supervisor`, `Go2rtcManager`, `loadConfig`, `UnscryptedCamera`.
- Produces (`src/admin/ipc.ts`):

```ts
export interface CameraStatus {
  name: string; stream: string; hksv: boolean; motionKind: "foscam-cgi" | "onvif" | "none";
  reachable: boolean | null; reachableCheckedAt: number | null; reachError: string | null;
  liveSessions: number; recordingActive: boolean; motionActive: boolean; lastMotionAt: number | null;
  pendingRestart: boolean;   // saved change needs a bridge restart to take effect
}
export interface BridgeStatus {
  bridgeName: string; pin: string; setupURI: string; paired: boolean; hapPort: number | null; hapEnabled: boolean;
  cameras: CameraStatus[]; go2rtc: ChildStatus; startedAt: number; version: string;
}
export type ToAdmin =
  | { type: "status"; status: BridgeStatus }
  | { type: "applied"; reqId: string; ok: true; mode: "live" | "added" | "restart-needed"; message: string }
  | { type: "applied"; reqId: string; ok: false; error: UserErrorBody };
export type ToBridge =
  | { type: "apply"; reqId: string; name: string; isNew: boolean }
  | { type: "restart-bridge"; reqId: string }
  | { type: "reload-go2rtc"; reqId: string };
export type ApplyMode = "live" | "added" | "restart-needed";
export function classifyChange(before: ResolvedCamera | undefined, after: ResolvedCamera): ApplyMode;
```

`classifyChange` is the one pure decision in this task. HAP-shape fields (`hksv`, `prebufferSeconds`, motion source present vs absent, `manufacturer`, `model`, `serialNumber`) change what the camera advertises to Home, so they return `"restart-needed"`. URL/credential/timing fields (`rtspMain`, `rtspSub`, `audio`, `copyVideo`, `maxRecordingSeconds`, foscam/onvif contents with the same source kind) return `"live"`. No `before` returns `"added"`. **This rule set depends on Open Question 3; if the owner picks "always restart", `classifyChange` returns `"restart-needed"` for everything except `"added"`.**

- [ ] **Step 1: Failing tests** `test/admin/applyPlan.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyChange } from "../../src/admin/ipc";

const base: any = { name: "G", rtspMain: "rtsp://a", hksv: true, prebufferSeconds: 4, audio: false, copyVideo: true,
  maxRecordingSeconds: 170, manufacturer: "M", model: "X", serialNumber: "s",
  onvif: { host: "h", port: 8080, username: "u", password: "p", pollIntervalMs: 60000, motionCooldownMs: 8000, notifyPort: 0 } };

test("new camera", () => assert.equal(classifyChange(undefined, base), "added"));
test("password/URL change is live", () => {
  assert.equal(classifyChange(base, { ...base, rtspMain: "rtsp://b" }), "live");
  assert.equal(classifyChange(base, { ...base, onvif: { ...base.onvif, password: "q" } }), "live");
});
test("HKSV toggle / prebuffer / motion source added or removed needs restart", () => {
  assert.equal(classifyChange(base, { ...base, hksv: false }), "restart-needed");
  assert.equal(classifyChange(base, { ...base, prebufferSeconds: 6 }), "restart-needed");
  assert.equal(classifyChange(base, { ...base, onvif: undefined }), "restart-needed");
  assert.equal(classifyChange(base, { ...base, model: "Y" }), "restart-needed");
});
```

- [ ] **Step 2: Run, FAIL. Then implement `src/admin/ipc.ts`** with the types above plus:

```ts
const HAP_SHAPE: (keyof ResolvedCamera)[] = ["hksv", "prebufferSeconds", "manufacturer", "model", "serialNumber"];
const motionKind = (c: ResolvedCamera) => (c.foscam ? "foscam" : c.onvif ? "onvif" : "none");

export function classifyChange(before: ResolvedCamera | undefined, after: ResolvedCamera): ApplyMode {
  if (!before) return "added";
  if (HAP_SHAPE.some((k) => before[k] !== after[k])) return "restart-needed";
  if (motionKind(before) !== motionKind(after)) return "restart-needed";
  return "live";
}
```

Run tests → PASS.

- [ ] **Step 3: Expose status hooks in delegates.**
  - `src/recordingDelegate.ts`: add `isRecordingActive(): boolean { return this.recordingActive; }`.
  - `src/streamingDelegate.ts`: add `liveSessionCount(): number { return this.activeSessions.size; }`.
  - `src/camera.ts`: keep `camera` as a mutable reference (`private camera: ResolvedCamera`, drop `readonly`), track motion, and add:

```ts
  private motionActive = false;
  private lastMotionAt: number | null = null;

  private setMotion(active: boolean): void {
    this.motionActive = active;
    if (active) this.lastMotionAt = Date.now();
    const svc = this.controller.motionService;
    if (svc) svc.updateCharacteristic(Characteristic.MotionDetected, active);
  }

  get name(): string { return this.camera.name; }
  get resolved(): ResolvedCamera { return this.camera; }

  snapshotStatus() {
    return {
      hksv: this.camera.hksv,
      motionKind: (this.camera.foscam ? "foscam-cgi" : this.camera.onvif ? "onvif" : "none") as "foscam-cgi" | "onvif" | "none",
      liveSessions: this.streamingDelegate.liveSessionCount(),
      recordingActive: this.recordingDelegate?.isRecordingActive() ?? false,
      motionActive: this.motionActive,
      lastMotionAt: this.lastMotionAt,
    };
  }

  /**
   * Apply a "live" change (URLs, logins, motion timings) without touching what HomeKit sees.
   * The delegates hold this same object, so they pick up new values on their next ffmpeg spawn.
   */
  reconfigure(next: ResolvedCamera): void {
    if (next.name !== this.camera.name) throw new Error("reconfigure cannot rename a camera");
    this.motionSource?.stop();
    const prebufferWasRunning = this.prebuffer?.isRunning() ?? false;
    this.prebuffer?.stop();
    Object.assign(this.camera, next);
    this.motionSource = this.buildMotionSource();   // extract the existing foscam/onvif wiring from the constructor into this method
    this.motionSource?.start();
    if (prebufferWasRunning) void this.prebuffer?.start();
  }
```

Move the constructor's "Wire the selected motion source" block into `private buildMotionSource(): MotionSource | undefined` and call it from the constructor. Existing behaviour must be unchanged; run `npm run selftest` (needs ffmpeg; on Windows without ffmpeg it fails loudly by design, so run it in the container in Task 9) and `npm run typecheck`.

- [ ] **Step 4: Implement `src/bridgeRuntime.ts`:**

```ts
import * as net from "net";
import * as path from "path";
import { fork } from "child_process";
import { Bridge, uuid } from "hap-nodejs";
import { loadConfig, ResolvedConfig, ResolvedCamera } from "./config";
import { Logger } from "./logger";
import { UnscryptedCamera } from "./camera";
import { Supervisor } from "./admin/supervisor";
import { Go2rtcManager } from "./admin/go2rtc";
import { streamNames } from "./admin/go2rtcConfig";
import { BridgeStatus, CameraStatus, ToAdmin, ToBridge, classifyChange } from "./admin/ipc";
import { toErrorJson } from "./admin/errors";

export interface RuntimeOptions {
  config: ResolvedConfig; configPath: string; bridge: Bridge | null; cameras: UnscryptedCamera[];
  log: Logger; ffmpegPath: string; version: string;
  admin: { port: number; enabled: boolean };
  go2rtc: { binary: string; apiPort: number; webrtcPort: number | null; runtimeDir: string; enabled: boolean };
}

export class BridgeRuntime {
  private readonly cams = new Map<string, UnscryptedCamera>();
  private readonly pendingRestart = new Set<string>();
  private readonly reach = new Map<string, { ok: boolean | null; at: number | null; err: string | null }>();
  private config: ResolvedConfig;
  private go2rtc: Go2rtcManager | null = null;
  private admin: Supervisor | null = null;
  private readonly startedAt = Date.now();
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly o: RuntimeOptions) {
    this.config = o.config;
    for (const c of o.cameras) this.cams.set(c.name, c);
  }

  start(): void {
    if (this.o.go2rtc.enabled) {
      this.go2rtc = new Go2rtcManager({ binary: this.o.go2rtc.binary, runtimeDir: this.o.go2rtc.runtimeDir,
        ports: { api: this.o.go2rtc.apiPort, webrtc: this.o.go2rtc.webrtcPort }, log: this.o.log.child("go2rtc"),
        onState: () => this.pushStatus() });
      this.go2rtc.start(this.config);
    }
    if (this.o.admin.enabled) {
      this.admin = new Supervisor({
        name: "admin-pane", log: this.o.log.child("admin"), onState: () => this.pushStatus(),
        start: () => {
          const child = fork(path.join(__dirname, "admin", "main.js"), [], {
            env: { ...process.env, UNSCRYPTED_ADMIN_PORT: String(this.o.admin.port),
              UNSCRYPTED_CONFIG: this.o.configPath, UNSCRYPTED_GO2RTC_API: this.go2rtc?.apiBase() ?? "" },
          });
          child.on("message", (m: ToBridge) => void this.onMessage(m));
          setTimeout(() => this.pushStatus(), 200);
          return child;
        },
      });
      this.admin.start();
    }
    this.timers.push(setInterval(() => this.pushStatus(), 2000));
    this.timers.push(setInterval(() => void this.probeAll(), 30_000));
    void this.probeAll();
  }

  /** Cheap reachability: can we open a TCP connection to the camera's RTSP host:port? */
  private async probeAll(): Promise<void> {
    for (const c of this.config.cameras) {
      let host = "", port = 554;
      try { const u = new URL(c.rtspMain); host = u.hostname; port = Number(u.port || 554); } catch { /* reported below */ }
      const res = await new Promise<{ ok: boolean; err: string | null }>((resolve) => {
        if (!host) return resolve({ ok: false, err: "stream URL can't be parsed" });
        const s = net.connect({ host, port, timeout: 3000 });
        s.once("connect", () => { s.destroy(); resolve({ ok: true, err: null }); });
        s.once("timeout", () => { s.destroy(); resolve({ ok: false, err: `no answer from ${host}:${port} within 3s` }); });
        s.once("error", (e) => resolve({ ok: false, err: `${host}:${port}: ${e.message}` }));
      });
      this.reach.set(c.name, { ok: res.ok, at: Date.now(), err: res.err });
    }
  }

  status(): BridgeStatus {
    const names = streamNames(this.config.cameras);
    const b = this.o.bridge;
    const cameras: CameraStatus[] = this.config.cameras.map((rc) => {
      const cam = this.cams.get(rc.name);
      const r = this.reach.get(rc.name);
      const s = cam?.snapshotStatus();
      return {
        name: rc.name, stream: names.get(rc.name)!.main, hksv: rc.hksv,
        motionKind: s?.motionKind ?? (rc.foscam ? "foscam-cgi" : rc.onvif ? "onvif" : "none"),
        reachable: r?.ok ?? null, reachableCheckedAt: r?.at ?? null, reachError: r?.err ?? null,
        liveSessions: s?.liveSessions ?? 0, recordingActive: s?.recordingActive ?? false,
        motionActive: s?.motionActive ?? false, lastMotionAt: s?.lastMotionAt ?? null,
        pendingRestart: this.pendingRestart.has(rc.name) || !cam,
      };
    });
    return {
      bridgeName: this.config.bridge.name, pin: this.config.bridge.pin,
      setupURI: b ? b.setupURI() : "", paired: Boolean(b?._accessoryInfo?.paired()),
      hapPort: b ? this.config.bridge.port : null, hapEnabled: Boolean(b),
      cameras, go2rtc: this.go2rtc?.status() ?? { name: "go2rtc", state: "stopped", restarts: 0, lastError: "disabled in this instance", nextRetryAt: null, since: this.startedAt },
      startedAt: this.startedAt, version: this.o.version,
    };
  }

  private send(m: ToAdmin): void {
    const c = this.admin?.child();
    if (c?.connected) c.send(m);
  }
  private pushStatus(): void { this.send({ type: "status", status: this.status() }); }

  private async onMessage(m: ToBridge): Promise<void> {
    try {
      if (m.type === "apply") return await this.applyCamera(m.reqId, m.name);
      if (m.type === "reload-go2rtc") { await this.go2rtc?.reload(this.config); this.send({ type: "applied", reqId: m.reqId, ok: true, mode: "live", message: "go2rtc restarted with the current config." }); return; }
      if (m.type === "restart-bridge") {
        this.send({ type: "applied", reqId: m.reqId, ok: true, mode: "restart-needed", message: "Bridge is restarting now. Home will show cameras as No Response for about 30 seconds." });
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);   // existing graceful shutdown; Docker restart policy brings it back
      }
    } catch (err) {
      const { body } = toErrorJson(err, "Apply a change from the admin pane");
      if ("reqId" in m) this.send({ type: "applied", reqId: m.reqId, ok: false, error: body.error });
    }
  }

  private async applyCamera(reqId: string, name: string): Promise<void> {
    const next = loadConfig(this.o.configPath);   // validated by the existing loader
    const after = next.cameras.find((c) => c.name === name);
    if (!after) throw new Error(`camera "${name}" not found in config.json after save`);
    const before = this.config.cameras.find((c) => c.name === name);
    const mode = classifyChange(before, after);
    this.config = next;
    let message: string;
    if (mode === "live") {
      this.cams.get(name)?.reconfigure(after);
      message = `Saved and applied to "${name}" without restarting. Home was not disturbed.`;
    } else if (mode === "added" && this.o.bridge) {
      const cam = new UnscryptedCamera(after, this.o.ffmpegPath, this.o.log);
      this.o.bridge.addBridgedAccessory(cam.accessory);
      cam.start();
      this.cams.set(name, cam);
      message = `Added "${name}". It should appear in Home within a minute (pull down to refresh the Home app).`;
    } else {
      this.pendingRestart.add(name);
      message = `Saved. "${name}" changed something Home sees (HKSV, prebuffer, motion source or model), so it takes effect after a bridge restart. Use "Restart bridge" when convenient.`;
    }
    await this.go2rtc?.reload(this.config);
    this.send({ type: "applied", reqId, ok: true, mode: mode === "added" && !this.o.bridge ? "restart-needed" : mode, message });
    this.pushStatus();
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    await Promise.allSettled([this.admin?.stop(), this.go2rtc?.stop()]);
  }
}
```

**Safety notes for the implementer:**
- `onMessage` is the only entry point from the admin child. It's wrapped in try/catch, and every failure is sent back to the pane as an error. Nothing the child sends can throw into the bridge's event loop uncaught.
- `addBridgedAccessory` after `publish()` is supported by hap-nodejs 0.14 (`Accessory.d.ts:413`). It bumps the bridge's config number so Home re-reads the accessory list. The camera's AID is assigned through `IdentifierCache` keyed by UUID, so it's stable across restarts.
- `go2rtc.reload` restarts only the go2rtc child. HomeKit's own ffmpeg pipelines don't use go2rtc.

- [ ] **Step 5: Wire into `src/index.ts`.** After `printPairingInfo(...)` and the `cam.start()` loop:

```ts
  const runtime = new BridgeRuntime({
    config, configPath: resolvedConfigPath, bridge: hapEnabled ? bridge : null, cameras, log,
    ffmpegPath: config.ffmpegPath, version: require("../package.json").version,
    admin: { port: Number(process.env.UNSCRYPTED_ADMIN_PORT ?? 8190), enabled: process.env.UNSCRYPTED_ADMIN !== "off" },
    go2rtc: { binary: process.env.UNSCRYPTED_GO2RTC_BIN ?? "/usr/local/bin/go2rtc",
      apiPort: Number(process.env.UNSCRYPTED_GO2RTC_API_PORT ?? 1986), webrtcPort: null,
      runtimeDir: process.env.UNSCRYPTED_RUNTIME_DIR ?? "/tmp/unscrypted", enabled: process.env.UNSCRYPTED_GO2RTC !== "off" },
  });
  runtime.start();
```

and in `shutdown` call `await runtime.stop()` before `bridge.unpublish()`. Also:
- `loadConfig` must report which path it used. Add `export function findConfigPath(explicit?: string): string` to `src/config.ts` (same candidate logic, throws the same `ConfigError`), and use it for `resolvedConfigPath`.
- **HAP-off mode for the test instance:** `const hapEnabled = process.env.UNSCRYPTED_HAP !== "off";`. When off, skip `bridge.publish()` and `printPairingInfo`, log `HAP disabled (UNSCRYPTED_HAP=off): this instance is NOT visible to HomeKit` at WARN, and still build the cameras (so status and feed checks work).
- Add a process-level guard so a stray async error in the bridge's own new code logs loudly instead of exiting silently: `process.on("unhandledRejection", (e) => log.error(\`unhandled rejection (bridge kept running): ${(e as Error)?.stack ?? e}\`))`.

- [ ] **Step 6: `npm run typecheck`, `npm test`. Commit** `feat: bridge runtime with live camera apply, runtime add, status (#2)`.

---

## Phase 2: The pane

### Task 6: Admin sign-in

**Files:**
- Create: `src/admin/auth.ts`
- Test: `test/admin/auth.test.ts`

**Interfaces:**
- Produces: `loadAdminPassword(file: string): string` (throws `UserError` with instructions if missing/empty), `checkPassword(given: string, expected: string): boolean` (constant-time), `issueSession(secret: Buffer, now?: number): string`, `verifySession(cookie: string | undefined, secret: Buffer, now?: number): boolean`, `class LoginLimiter { allow(ip: string, now?: number): boolean; fail(ip: string, now?: number): void; reset(ip: string): void }`, `SESSION_DAYS = 30`.

Mechanism (per Open Question 2's recommendation): one admin password in `secrets/admin_password` (mounted read-only at `/run/secrets/unscrypted_admin_password`). Sign-in form → HMAC-signed, `HttpOnly; SameSite=Strict; Path=/` cookie. The signing secret is random per process start, so restarting signs everyone out (acceptable, and it means no extra secret file). 5 failed attempts per IP per 5 minutes, then a 5-minute lockout with a message saying when to retry.

- [ ] **Step 1: Failing tests:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";
import { checkPassword, issueSession, verifySession, LoginLimiter } from "../../src/admin/auth";

const key = crypto.randomBytes(32);

test("password check", () => {
  assert.ok(checkPassword("hunter2", "hunter2"));
  assert.ok(!checkPassword("hunter3", "hunter2"));
  assert.ok(!checkPassword("", "hunter2"));
});
test("session round-trip, tamper and expiry", () => {
  const now = 1_700_000_000_000;
  const c = issueSession(key, now);
  assert.ok(verifySession(c, key, now + 1000));
  assert.ok(!verifySession(c.replace(/.$/, (ch) => (ch === "a" ? "b" : "a")), key, now));
  assert.ok(!verifySession(c, key, now + 31 * 864e5));
  assert.ok(!verifySession(undefined, key, now));
});
test("limiter locks after 5 failures for 5 minutes", () => {
  const l = new LoginLimiter();
  for (let i = 0; i < 5; i++) l.fail("1.2.3.4", 0);
  assert.ok(!l.allow("1.2.3.4", 1000));
  assert.ok(l.allow("1.2.3.4", 5 * 60_000 + 1));
  assert.ok(l.allow("5.6.7.8", 1000));
});
```

- [ ] **Step 2: Run, FAIL. Step 3: Implement:**

```ts
import * as crypto from "crypto";
import * as fs from "fs";
import { UserError } from "./errors";

export const SESSION_DAYS = 30;

export function loadAdminPassword(file: string): string {
  let pw = "";
  try { pw = fs.readFileSync(file, "utf8").trim(); } catch { /* handled below */ }
  if (!pw) {
    throw new UserError({
      attempted: "Start the admin pane's sign-in",
      happened: `No admin password found at ${file}.`,
      changed: "The admin pane is refusing every request; the HomeKit bridge is running normally.",
      next: "On the NAS: put a password in ~/unscrypted/secrets/admin_password (one line), then restart the container.",
    }, 503);
  }
  return pw;
}

export function checkPassword(given: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return given.length > 0 && crypto.timingSafeEqual(a, b);
}

const sign = (secret: Buffer, payload: string) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");

export function issueSession(secret: Buffer, now = Date.now()): string {
  const payload = String(now + SESSION_DAYS * 864e5);
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySession(cookie: string | undefined, secret: Buffer, now = Date.now()): boolean {
  if (!cookie) return false;
  const [payload, mac] = cookie.split(".");
  if (!payload || !mac) return false;
  const expect = sign(secret, payload);
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return false;
  return Number(payload) > now;
}

export class LoginLimiter {
  private fails = new Map<string, number[]>();
  private readonly windowMs = 5 * 60_000;
  allow(ip: string, now = Date.now()): boolean {
    const recent = (this.fails.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    this.fails.set(ip, recent);
    return recent.length < 5;
  }
  fail(ip: string, now = Date.now()): void { this.fails.set(ip, [...(this.fails.get(ip) ?? []), now]); }
  reset(ip: string): void { this.fails.delete(ip); }
}
```

- [ ] **Step 4: Tests PASS. Commit** `feat(admin): password sign-in with signed cookie and lockout (#2)`.

### Task 7: Admin HTTP server (routes, error boundary, go2rtc proxy, feed check)

**Files:**
- Create: `src/admin/server.ts`, `src/admin/main.ts`
- Modify: `package.json` (add `"qrcode": "1.5.4"`, `"@types/qrcode": "1.5.5"` dev; run `npm install --save-exact` and confirm those versions exist on npm first)
- Test: `test/admin/server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 2, 4, 5 (IPC types), 6.
- Produces: `createAdminServer(deps: AdminDeps): http.Server`, where

```ts
export interface AdminDeps {
  configPath: string;
  passwordFile: string;
  go2rtcApi: string;            // "" when go2rtc disabled
  webRoot: string;              // dist/../web/admin
  bridge: { status(): BridgeStatus | null; request(m: Omit<ToBridge, "reqId">): Promise<Extract<ToAdmin, { type: "applied" }>> };
  title: string;                // "unscrypted admin" or "unscrypted admin - TEST"
}
```

Routes (all JSON unless noted; everything except `/login`, `/api/login`, `/healthz` and static assets requires a session):

| Method + path | Does |
|---|---|
| `GET /healthz` | `{ ok: true }` (no auth; for Docker healthcheck) |
| `POST /api/login` `{password}` | sets cookie or 401/429 with UserError body |
| `POST /api/logout` | clears cookie |
| `GET /api/status` | `BridgeStatus` minus `pin`/`setupURI` |
| `GET /api/pairing` | `{ pin, setupURI, paired, qrSvg, note }`. `note` explains: once paired, the code only works after removing the bridge from Home. |
| `GET /api/cameras` | `redactConfig(readRawConfig(...))` + per-camera status |
| `POST /api/cameras` `CameraEdit` | add: `applyCameraEdit(raw, null, edit)` then `writeConfigAtomic` then `bridge.request({type:"apply", isNew:true})` |
| `PUT /api/cameras/:name` `CameraEdit` | edit: same flow with `originalName` |
| `POST /api/cameras/check` `{ name?: string, edit: CameraEdit }` | resolves the candidate URL (merging stored secrets via `applyCameraEdit` on a copy, **not written**), registers a temp go2rtc stream `check_<random>`, grabs one frame (15 s timeout), returns `{ ok, stream, frameUrl }` or a UserError with `explainGo2rtcFailure`. Temp streams are deleted after 5 minutes or on `DELETE /api/cameras/check/:stream`. |
| `POST /api/bridge/restart` | `bridge.request({type:"restart-bridge"})` |
| `GET /go2rtc/api/frame.jpeg?src=` | proxied to go2rtc (auth required) |
| `GET /go2rtc/api/ws?src=` (WebSocket upgrade) | proxied to go2rtc (auth checked on the upgrade request) for MSE live preview |
| `GET /go2rtc/video-rtc.js` | go2rtc's player script, proxied from go2rtc's own `/video-rtc.js` so it always matches the pinned binary |

Error boundary: every handler runs inside `try { ... } catch (e) { const {status, body} = toErrorJson(e, attempted); send(status, body) }`. The `attempted` string is set per route (e.g. `Save camera "Garage"`). go2rtc unreachable → 503 with `happened: "Feed check unavailable: go2rtc isn't running (state: backoff, restarting in 8s). Last error: ..."`, `changed: "Nothing."`, `next: "Wait for it to restart. If it stays down, check docker logs unscrypted for go2rtc lines."`. When a save succeeds but the bridge doesn't answer the apply message within 10 s: 202 with a message saying the file was saved, the change isn't live yet, and to restart the bridge.

- [ ] **Step 1: Failing integration tests** (`test/admin/server.test.ts`), starting the server on port 0 with a fake bridge and a temp config + password file:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import { AddressInfo } from "net";
import { createAdminServer } from "../../src/admin/server";

let base = ""; let srv: any; let dir = ""; const applied: any[] = [];
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "unscr-srv-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    bridge: { name: "U", username: "CC:22:3D:E3:CE:F6", pin: "031-45-154" },
    cameras: [{ name: "Garage", rtspMain: "rtsp://admin:s3cret@10.0.0.3:554/11" }] }));
  fs.writeFileSync(path.join(dir, "pw"), "letmein\n");
  srv = createAdminServer({
    configPath: path.join(dir, "config.json"), passwordFile: path.join(dir, "pw"), go2rtcApi: "",
    webRoot: path.join(__dirname, "../../web/admin"), title: "unscrypted admin - TEST",
    bridge: { status: () => null, request: async (m: any) => { applied.push(m); return { type: "applied", reqId: "x", ok: true, mode: "live", message: "ok" }; } },
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(() => srv.close());

async function login() {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "letmein" }) });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie")!.split(";")[0];
}

test("unauthenticated API is refused with a clear message", async () => {
  const r = await fetch(base + "/api/cameras");
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.ok(j.error.next.length > 0);
});

test("camera list never contains the password", async () => {
  const cookie = await login();
  const t = await (await fetch(base + "/api/cameras", { headers: { cookie } })).text();
  assert.ok(!t.includes("s3cret"));
  assert.ok(t.includes("***"));
});

test("rename via PUT is refused and config.json is unchanged", async () => {
  const cookie = await login();
  const before = fs.readFileSync(path.join(dir, "config.json"), "utf8");
  const r = await fetch(base + "/api/cameras/Garage", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Garage2" }) });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(dir, "config.json"), "utf8"), before);
});

test("edit saves atomically, keeps password, tells the bridge", async () => {
  const cookie = await login();
  const r = await fetch(base + "/api/cameras/Garage", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ prebufferSeconds: 6 }) });
  assert.equal(r.status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(saved.cameras[0].prebufferSeconds, 6);
  assert.ok(saved.cameras[0].rtspMain.includes("s3cret"));
  assert.equal(applied.at(-1).type, "apply");
  assert.ok(fs.readdirSync(path.join(dir, "backups")).length >= 1);
});

test("feed check with go2rtc disabled says so plainly", async () => {
  const cookie = await login();
  const r = await fetch(base + "/api/cameras/check", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Garage", edit: {} }) });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error.happened, /go2rtc/i);
});

test("a throwing handler returns JSON 500, server keeps serving", async () => {
  const cookie = await login();
  const r = await fetch(base + "/api/cameras/Garage", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: "{not json" });
  assert.equal(r.status, 400);
  assert.equal((await fetch(base + "/healthz")).status, 200);
});
```

- [ ] **Step 2: Run, FAIL. Step 3: Implement `src/admin/server.ts`.** Key pieces (full file):

```ts
import * as http from "http";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import QRCode from "qrcode";
import { BridgeStatus, ToAdmin, ToBridge } from "./ipc";
import { UserError, toErrorJson } from "./errors";
import { readRawConfig, redactConfig, applyCameraEdit, writeConfigAtomic, CameraEdit } from "./configStore";
import { resolveConfig } from "../config";
import { Go2rtcClient, explainGo2rtcFailure } from "./go2rtc";
import { loadAdminPassword, checkPassword, issueSession, verifySession, LoginLimiter, SESSION_DAYS } from "./auth";

export interface AdminDeps { /* as in Interfaces above */
  configPath: string; passwordFile: string; go2rtcApi: string; webRoot: string; title: string;
  bridge: { status(): BridgeStatus | null; request(m: Omit<ToBridge, "reqId">): Promise<Extract<ToAdmin, { type: "applied" }>> };
}

const COOKIE = "unscrypted_admin";
const STATIC: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

export function createAdminServer(d: AdminDeps): http.Server {
  const secret = crypto.randomBytes(32);
  const limiter = new LoginLimiter();
  const tempStreams = new Map<string, NodeJS.Timeout>();
  const g2 = d.go2rtcApi ? new Go2rtcClient(d.go2rtcApi) : null;

  const cookieOf = (req: http.IncomingMessage) =>
    (req.headers.cookie ?? "").split(";").map((s) => s.trim()).find((s) => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  const authed = (req: http.IncomingMessage) => verifySession(cookieOf(req), secret);
  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const readJson = (req: http.IncomingMessage, attempted: string) => new Promise<any>((resolve, reject) => {
    let s = ""; req.on("data", (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new UserError({ attempted, happened: "The request body wasn't valid JSON.", changed: "Nothing.", next: "Reload the page and try again." })); } });
    req.on("error", reject);
  });
  const go2rtcDown = (attempted: string) => {
    const g = d.bridge.status()?.go2rtc;
    const when = g?.nextRetryAt ? `, restarting in ${Math.max(0, Math.round((g.nextRetryAt - Date.now()) / 1000))}s` : "";
    return new UserError({ attempted,
      happened: `Feed check unavailable: go2rtc isn't running (state: ${g?.state ?? "disabled"}${when}). Last error: ${g?.lastError ?? "none recorded"}.`,
      changed: "Nothing.", next: "Wait for go2rtc to restart and try again. If it stays down, check `docker logs unscrypted` for go2rtc lines." }, 503);
  };
  const needAuth = new UserError({ attempted: "Use the admin pane", happened: "You're not signed in (or your session expired).", changed: "Nothing.", next: "Sign in again." }, 401);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let attempted = `${req.method} ${url.pathname}`;
    try {
      if (url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (req.method === "GET" && STATIC[url.pathname]) {
        const file = path.join(d.webRoot, STATIC[url.pathname]);
        let body = fs.readFileSync(file, "utf8");
        if (file.endsWith(".html")) body = body.replace(/__TITLE__/g, d.title);
        res.writeHead(200, { "content-type": MIME[path.extname(file)], "cache-control": "no-store" });
        return res.end(body);
      }
      const password = loadAdminPassword(d.passwordFile);   // throws a 503 UserError with setup instructions
      const ip = req.socket.remoteAddress ?? "?";

      if (url.pathname === "/api/login" && req.method === "POST") {
        attempted = "Sign in";
        if (!limiter.allow(ip)) throw new UserError({ attempted, happened: "Too many wrong passwords from this computer.", changed: "Nothing.", next: "Wait 5 minutes, then try again." }, 429);
        const { password: given } = await readJson(req, attempted);
        if (!checkPassword(String(given ?? ""), password)) {
          limiter.fail(ip);
          throw new UserError({ attempted, happened: "Wrong password.", changed: "Nothing.", next: "Check ~/unscrypted/secrets/admin_password on the NAS if you've forgotten it." }, 401);
        }
        limiter.reset(ip);
        return json(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=${issueSession(secret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}` });
      }
      if (url.pathname === "/api/logout") return json(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; Path=/; Max-Age=0` });
      if (!authed(req)) throw needAuth;

      if (url.pathname === "/api/status") {
        const s = d.bridge.status();
        if (!s) throw new UserError({ attempted: "Read bridge status", happened: "The bridge hasn't reported its status yet.", changed: "Nothing.", next: "Wait a few seconds; the page retries on its own." }, 503);
        const { pin: _p, setupURI: _u, ...pub } = s;
        return json(res, 200, pub);
      }
      if (url.pathname === "/api/pairing") {
        attempted = "Show the pairing code";
        const s = d.bridge.status();
        if (!s?.hapEnabled) throw new UserError({ attempted, happened: "HomeKit is switched off in this instance (UNSCRYPTED_HAP=off), so there's nothing to pair.", changed: "Nothing.", next: "Use the production pane for pairing." }, 409);
        const qrSvg = await QRCode.toString(s.setupURI, { type: "svg", margin: 1 });
        return json(res, 200, { pin: s.pin, setupURI: s.setupURI, paired: s.paired, qrSvg,
          note: s.paired ? "Already paired with a Home. This code only works again after the bridge is removed from Home." : "Not paired yet: scan the QR in the Home app (Add Accessory)." });
      }
      if (url.pathname === "/api/cameras" && req.method === "GET") {
        attempted = "List cameras";
        return json(res, 200, { ...redactConfig(readRawConfig(d.configPath)), status: d.bridge.status()?.cameras ?? [] });
      }
      const camMatch = /^\/api\/cameras\/([^/]+)$/.exec(url.pathname);
      if ((url.pathname === "/api/cameras" && req.method === "POST") || (camMatch && req.method === "PUT" && camMatch[1] !== "check")) {
        const original = camMatch ? decodeURIComponent(camMatch[1]) : null;
        attempted = original ? `Save camera "${original}"` : "Add a camera";
        const edit = (await readJson(req, attempted)) as CameraEdit;
        const next = applyCameraEdit(readRawConfig(d.configPath), original, edit);
        const { backupPath } = writeConfigAtomic(d.configPath, next);
        const name = original ?? String(edit.name).trim();
        const reply = await Promise.race([
          d.bridge.request({ type: "apply", name, isNew: original === null } as any),
          new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
        ]);
        if (!reply) return json(res, 202, { saved: true, backupPath, message: `Saved to config.json, but the bridge didn't confirm applying it within 10s. The change is NOT live yet. Use "Restart bridge" to apply it.` });
        if (!reply.ok) return json(res, 500, { saved: true, backupPath, error: { ...reply.error, changed: `config.json WAS saved (previous version kept at ${backupPath}); the running bridge did not apply it. ${reply.error.changed}` } });
        return json(res, 200, { saved: true, backupPath, mode: reply.mode, message: reply.message });
      }
      if (url.pathname === "/api/cameras/check" && req.method === "POST") {
        attempted = "Check the feed";
        if (!g2 || d.bridge.status()?.go2rtc.state !== "running") throw go2rtcDown(attempted);
        const { name, edit } = await readJson(req, attempted);
        const raw = readRawConfig(d.configPath);
        const candidate = applyCameraEdit(raw, name ?? null, { ...(edit ?? {}), ...(name ? {} : { name: edit?.name || "__feedcheck__" }) });
        const cam = resolveConfig(candidate, path.dirname(d.configPath)).cameras.find((c) => c.name === (name ?? (edit?.name || "__feedcheck__")))!;
        const stream = `check_${crypto.randomBytes(4).toString("hex")}`;
        await g2.addTempStream(stream, cam.rtspMain + (cam.audio ? "" : "#media=video"));
        tempStreams.set(stream, setTimeout(() => { void g2.removeStream(stream); tempStreams.delete(stream); }, 5 * 60_000));
        try {
          await g2.frame(stream);
        } catch (e) {
          const ex = explainGo2rtcFailure((e as Error).message);
          throw new UserError({ attempted: `Check the feed for "${cam.name === "__feedcheck__" ? "new camera" : cam.name}"`, happened: ex.happened, changed: "Nothing was saved; this was only a test.", next: ex.next }, 502);
        }
        return json(res, 200, { ok: true, stream, frameUrl: `/go2rtc/api/frame.jpeg?src=${stream}` });
      }
      if (url.pathname === "/api/bridge/restart" && req.method === "POST") {
        attempted = "Restart the bridge";
        const reply = await d.bridge.request({ type: "restart-bridge" } as any);
        return reply.ok ? json(res, 200, { message: reply.message }) : json(res, 500, { error: reply.error });
      }
      if (url.pathname.startsWith("/go2rtc/")) {
        attempted = "Load the live preview";
        if (!d.go2rtcApi) throw go2rtcDown(attempted);
        const upstream = http.request(d.go2rtcApi + url.pathname.slice("/go2rtc".length) + url.search, { method: "GET" }, (up) => {
          res.writeHead(up.statusCode ?? 502, { "content-type": up.headers["content-type"] ?? "application/octet-stream", "cache-control": "no-store" });
          up.pipe(res);
        });
        upstream.on("error", () => { if (!res.headersSent) { const { status, body } = toErrorJson(go2rtcDown(attempted), attempted); json(res, status, body); } });
        return upstream.end();
      }
      throw new UserError({ attempted, happened: "No such page or API.", changed: "Nothing.", next: "Go back to the admin home page." }, 404);
    } catch (e) {
      const { status, body } = toErrorJson(e, attempted);
      if (status >= 500) console.error(`[admin] ${attempted} failed:`, e);
      if (!res.headersSent) json(res, status, body);
    }
  });

  // WebSocket proxy for go2rtc's MSE player (/go2rtc/api/ws?src=...). Auth is checked on the upgrade.
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/go2rtc/api/ws") || !authed(req) || !d.go2rtcApi) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const target = new URL(d.go2rtcApi);
    const up = net.connect(Number(target.port), target.hostname, () => {
      const lines = [`GET ${url.pathname.slice("/go2rtc".length)}${url.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        if (/^(host|cookie)$/i.test(k)) continue;
        lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push(`Host: ${target.host}`, "", "");
      up.write(lines.join("\r\n"));
      if (head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    const close = () => { up.destroy(); socket.destroy(); };
    up.on("error", close); socket.on("error", close);
  });

  return server;
}
```

- [ ] **Step 4: Implement `src/admin/main.ts`** (the forked child):

```ts
import * as path from "path";
import { randomUUID } from "crypto";
import { createAdminServer } from "./server";
import { BridgeStatus, ToAdmin, ToBridge } from "./ipc";

let latest: BridgeStatus | null = null;
const waiting = new Map<string, (m: Extract<ToAdmin, { type: "applied" }>) => void>();

process.on("message", (m: ToAdmin) => {
  if (m.type === "status") latest = m.status;
  if (m.type === "applied") { waiting.get(m.reqId)?.(m); waiting.delete(m.reqId); }
});
process.on("disconnect", () => process.exit(0));   // bridge went away: don't linger as an orphan

const port = Number(process.env.UNSCRYPTED_ADMIN_PORT ?? 8190);
const server = createAdminServer({
  configPath: process.env.UNSCRYPTED_CONFIG ?? "/config/config.json",
  passwordFile: process.env.UNSCRYPTED_ADMIN_PASSWORD_FILE ?? "/run/secrets/unscrypted_admin_password",
  go2rtcApi: process.env.UNSCRYPTED_GO2RTC_API ?? "",
  webRoot: path.join(__dirname, "..", "..", "web", "admin"),
  title: process.env.UNSCRYPTED_ADMIN_TITLE ?? "unscrypted admin",
  bridge: {
    status: () => latest,
    request: (m) => new Promise((resolve) => {
      const reqId = randomUUID();
      waiting.set(reqId, resolve);
      process.send?.({ ...m, reqId } as ToBridge);
    }),
  },
});
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(`[admin] could not listen on port ${port}: ${e.message}${e.code === "EADDRINUSE" ? " (something else is using it; set UNSCRYPTED_ADMIN_PORT)" : ""}`);
  process.exit(1);   // supervisor logs it and retries with backoff
});
server.listen(port, "0.0.0.0", () => console.log(`[admin] admin pane listening on http://0.0.0.0:${port}`));
```

- [ ] **Step 5: `npm test` PASS, `npm run build`, `npm run typecheck`. Commit** `feat(admin): admin HTTP server, feed check, go2rtc proxy (#2)`.

### Task 8: The pane UI (vanilla JS)

**Files:**
- Create: `web/admin/index.html`, `web/admin/app.js`, `web/admin/style.css`
- Modify: `Dockerfile` (copy `web/` into the runtime image; Task 9)

No unit tests (plain DOM code). It's verified in Task 9's checklist against the running test instance, by curl + owner eyes. **No Browser-pane automation unless the owner invites it.**

Screens (single page, hash routing `#/cameras`, `#/camera/<name>`, `#/add`, `#/pairing`, `#/status`):

1. **Sign-in:** password box + button. Shows the server's `error.happened` / `error.next` verbatim.
2. **Header:** placeholder logo mark ("unscrypted" wordmark in olive), page title from `__TITLE__`, green dot or red banner for go2rtc: red banner text = the `go2rtc` status line, e.g. "Feed check unavailable: go2rtc isn't running, restarting in 8s." Banner for any camera with `pendingRestart`, with a "Restart bridge" button and the warning "Home shows cameras as No Response for about 30 seconds."
3. **Cameras list:** one card per camera: name, motion source, HKSV on/off, reachable (green "reachable" / red with `reachError` text / grey "not checked yet"), live viewers count, recording on/off, last motion ("2 min ago" / "never since start"), and a snapshot tile from `/go2rtc/api/frame.jpeg?src=<stream>`. If the image fails to load the tile shows the reason text, never blank. "Edit" and "Check feed" buttons.
4. **Add / Edit form:** fields: name (read-only on edit, with a lock icon and the hint "Name is the camera's HomeKit identity and can't be changed here. Rename it in the Home app instead."; on add: "Pick carefully: this name is permanent"), two input modes (host + user + password + paths, or full RTSP URLs), motion source radio (None / Foscam CGI / ONVIF) with its block's fields, HKSV checkbox, prebuffer seconds (min 4), audio checkbox. Password inputs are always empty with placeholder "saved (leave blank to keep)" when `{set:true}`. Blank = not sent. Buttons: **Check feed** (POST `/api/cameras/check` with the unsaved form, shows the frame, then a "Watch live" button that loads go2rtc's `video-rtc.js` player from `/go2rtc/video-rtc.js` pointed at `/go2rtc/api/ws?src=<stream>`), **Save** (disabled while a request is in flight; never silently disabled: the button label says "Saving..."). After save: show `message` (live / added / restart-needed) in a green or amber box. On error: red box with all four `error` fields labelled "What we tried / What happened / What changed / What to do".
5. **Pairing:** QR SVG, setup code in large type, paired/not-paired note, "Refresh" button.
6. **Status:** bridge version, uptime, HAP port, paired state, go2rtc state/restarts/last error, ONVIF notify receiver note.

`app.js` skeleton (implementer fills each render function along these lines; keep it one file, no framework):

```js
const $ = (sel) => document.querySelector(sel);
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({ error: { attempted: `${method} ${path}`, happened: `Server answered ${r.status} with something that isn't JSON.`, changed: "Unknown.", next: "Reload the page; if it repeats, check docker logs unscrypted." } }));
  if (r.status === 401 && path !== "/api/login") { location.hash = "#/login"; }
  return { status: r.status, ...j };
}
function errorBox(e) {
  const d = document.createElement("div"); d.className = "err";
  for (const [label, k] of [["What we tried", "attempted"], ["What happened", "happened"], ["What changed", "changed"], ["What to do", "next"]]) {
    const p = document.createElement("p"); p.innerHTML = `<b>${label}:</b> `; p.append(document.createTextNode(e[k] ?? "")); d.append(p);
  }
  return d;
}
window.addEventListener("hashchange", route); window.addEventListener("load", route);
setInterval(() => { if (/cameras|status/.test(location.hash)) refreshStatus(); }, 5000);
// route(), renderLogin(), renderCameras(), renderForm(name|null), renderPairing(), renderStatus(), refreshStatus()
```

All text inserted from the server goes through `textContent` / `createTextNode` (camera names are user input).

- [ ] **Step 1:** Write the three files. `index.html` has `<title>__TITLE__</title>`, a `<header>` with the placeholder logo, `<main id="app">`.
- [ ] **Step 2:** `style.css`: CSS variables `--accent: #7a8a2e; --accent-2: #9aab3f; --bad: #b3261e; --warn: #b8860b;`, light and dark via `prefers-color-scheme`, cards in a responsive grid, 16px gutter on phones.
- [ ] **Step 3:** Smoke-check locally: `npm run build && UNSCRYPTED_HAP=off UNSCRYPTED_GO2RTC=off UNSCRYPTED_ADMIN_PASSWORD_FILE=./secrets/admin_password node dist/index.js --config config.example.json` and `curl -s localhost:8190/ | grep "<title>"`, `curl -s -X POST localhost:8190/api/login -d '{"password":"..."}' -H 'content-type: application/json' -i | grep -i set-cookie`.
- [ ] **Step 4: Commit** `feat(admin): admin pane UI (#2)`.

---

## Phase 3: Packaging and live test

### Task 9: Bake go2rtc into the image, compose + test override, version 0.2.0, README

**Files:**
- Modify: `Dockerfile`, `docker-compose.yml`, `package.json` (version `0.2.0`), `README.md`, `.dockerignore`
- Create: `docker-compose.test.yml`, `secrets/.gitkeep`

- [ ] **Step 1: Pin go2rtc.** Check https://github.com/AlexxIT/go2rtc/releases for 1.9.14's `go2rtc_linux_amd64` asset (or a newer stable patch release, owner Open Question 6). Download once on the NAS into a scratch dir and record the checksum: `sha256sum go2rtc_linux_amd64`. Cross-check it against the binary inside the running `go2rtc` container: `sudo docker exec go2rtc sha256sum /usr/local/bin/go2rtc` (same version should give the same hash; if not, find out why before continuing).

- [ ] **Step 2: Dockerfile** additions (runtime stage):

```dockerfile
# ---- go2rtc (feed checks in the admin pane). Pinned version + checksum, never latest.
ARG GO2RTC_VERSION=1.9.14
ARG GO2RTC_SHA256=<sha256 recorded in step 1>
ADD --checksum=sha256:${GO2RTC_SHA256} \
    https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_linux_amd64 /usr/local/bin/go2rtc
RUN chmod 0755 /usr/local/bin/go2rtc && /usr/local/bin/go2rtc -version

COPY web ./web
ENV UNSCRYPTED_GO2RTC_BIN=/usr/local/bin/go2rtc \
    UNSCRYPTED_ADMIN_PORT=8190 \
    UNSCRYPTED_GO2RTC_API_PORT=1986 \
    UNSCRYPTED_RUNTIME_DIR=/tmp/unscrypted \
    UNSCRYPTED_ADMIN_PASSWORD_FILE=/run/secrets/unscrypted_admin_password
EXPOSE 8190/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.UNSCRYPTED_ADMIN_PORT||8190)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
```

(`ADD --checksum` needs BuildKit, which Docker on TrueNAS uses by default. If the build errors on the flag, fall back to `curl -fsSL ... -o` + `echo "${GO2RTC_SHA256}  /usr/local/bin/go2rtc" | sha256sum -c -`, installing `curl` in that layer only. Never skip the check.)

Note the healthcheck only covers the admin pane. A failing admin pane marks the container "unhealthy" but nothing restarts on that alone, so the bridge is untouched.

- [ ] **Step 3: docker-compose.yml** (prod) gains:

```yaml
    image: unscrypted:0.2.0
    volumes:
      - ./config:/config
      - ./data:/data
      - ./secrets/admin_password:/run/secrets/unscrypted_admin_password:ro
    environment:
      - UNSCRYPTED_CONFIG=/config/config.json
      - UNSCRYPTED_PERSIST_DIR=/data/persist
      - UNSCRYPTED_LOG_LEVEL=info
      - UNSCRYPTED_ADMIN_PORT=8190
      - UNSCRYPTED_GO2RTC_API_PORT=1986
```

- [ ] **Step 4: docker-compose.test.yml** (a separate project, run from a separate checkout `~/unscrypted-test` on the NAS so its `./config`, `./data`, `./secrets` are separate):

```yaml
# Test instance: HomeKit OFF (no second bridge in the family's Home app), own ports.
# Run from ~/unscrypted-test:  sudo docker compose -f docker-compose.yml -f docker-compose.test.yml -p unscrypted-test up -d --build
services:
  unscrypted:
    image: unscrypted:0.2.0-test
    container_name: unscrypted-test
    volumes:
      - ./src:/app/src:ro      # fast loop: not used by the baked dist; rebuild for real tests
    environment:
      - UNSCRYPTED_HAP=off
      - UNSCRYPTED_ADMIN_PORT=8191
      - UNSCRYPTED_GO2RTC_API_PORT=1987
      - UNSCRYPTED_ADMIN_TITLE=unscrypted admin - TEST
      - UNSCRYPTED_RUNTIME_DIR=/tmp/unscrypted-test
```

(Drop the `./src` line if the owner prefers rebuild-only; Open Question 5.) The test instance's `config/config.json` is a copy of prod's camera list with **ONVIF blocks removed or `notifyPort` set to a different value (e.g. 8111)**, so its ONVIF receiver can't fight prod's on 8101. Also remove `persistDir` from the copy. Copy commands (no secrets printed): `mkdir -p ~/unscrypted-test/config && python3 -c "import json;c=json.load(open('$HOME/unscrypted/config/config.json'));[cam.get('onvif',{}).update(notifyPort=8111) for cam in c['cameras']];c.pop('persistDir',None);json.dump(c,open('$HOME/unscrypted-test/config/config.json','w'),indent=2)"`.

Note for the owner: the test instance pulls the same cameras over RTSP, so each camera has one more viewer while it runs. Most cameras allow 2 to 4 at once.

- [ ] **Step 5: README:** new "Admin pane" section (URL `http://10.0.1.78:8190`, sign-in file, what's editable, why names are locked, what "restart needed" means), "Ports" table, "Test instance" section, updated Docker layout. `.dockerignore` already updated in Task 0.

- [ ] **Step 6: Build and verify on the NAS test instance** (scp the branch files to `~/unscrypted-test`, password in `secrets/admin_password` generated with `openssl rand -base64 18 > secrets/admin_password`, never echoed):

```bash
cd ~/unscrypted-test
sudo docker compose -f docker-compose.yml -f docker-compose.test.yml -p unscrypted-test up -d --build
sudo docker logs unscrypted-test 2>&1 | grep -E "HAP disabled|admin pane listening|go2rtc" | head
sudo ss -ltnp | grep -E ":8191|:1987|:51827"     # expect 8191 on *, 1987 on 127.0.0.1, NO 51827
sudo docker exec unscrypted-test node dist/index.js --selftest   # existing ffmpeg pipeline still OK
```

Then the curl checklist (cookie jar in a temp file; password read from the file, not typed):

```bash
J=$(mktemp); PW=$(cat secrets/admin_password)
curl -s -c $J -X POST localhost:8191/api/login -H 'content-type: application/json' -d "{\"password\":\"$PW\"}"
curl -s -b $J localhost:8191/api/cameras | grep -c '\*\*\*'          # >0, and:
curl -s -b $J localhost:8191/api/cameras | grep -ci password_value_you_know || true   # must print 0 (owner checks)
curl -s -b $J localhost:8191/api/status | python3 -m json.tool | head -40
curl -s -b $J -X POST localhost:8191/api/cameras/check -H 'content-type: application/json' -d '{"name":"<a real camera>","edit":{}}'
curl -s -b $J -o /tmp/f.jpg -w '%{http_code} %{size_download}\n' "localhost:8191/go2rtc/api/frame.jpeg?src=<stream from status>"
curl -s -b $J -X PUT localhost:8191/api/cameras/<name> -H 'content-type: application/json' -d '{"name":"renamed"}'   # 409
curl -s -b $J -X POST localhost:8191/api/cameras/check -H 'content-type: application/json' -d '{"name":"<cam>","edit":{"rtspMain":"rtsp://admin:wrong@<ip>:554/11"}}'   # 502, "rejected the login"
```

Failure drills (each must leave the admin pane answering and say so plainly):
- Kill go2rtc inside the container: `sudo docker exec unscrypted-test pkill -f "go2rt[c] -config"`. Within 2 s `/api/status` shows `go2rtc.state: "backoff"`, the check endpoint returns 503 with "restarting in", then it comes back.
- Kill the admin child: `sudo docker exec unscrypted-test pkill -f "admin/mai[n].js"`. The container keeps running (`docker ps`), the log shows "admin-pane exited ... restarting in 1s (the HomeKit bridge is unaffected)", and `/healthz` answers again.
- Missing password file: the pane returns 503 with the setup instructions; the bridge log is clean.
- Bad edit (both foscam and onvif): 400 with the validator's message, `config/config.json` byte-identical (compare `sha256sum` before/after).
- Capture go2rtc 1.9.14's real error strings for wrong password / wrong IP / wrong path and update `explainGo2rtcFailure` + its test if they differ.

Then the **owner checks the pane by eye** on `http://10.0.1.78:8191` (add a camera, check feed, watch live, edit a login, see the pending-restart banner). The "appears in Home" part can't be tested on a HAP-off instance; it's verified on prod right after deploy (Task 10).

- [ ] **Step 7: Commit + push branch, open PR** referencing #2, with the checklist results pasted in. Ask the owner to confirm the merge (button panel).

### Task 10: Prod deploy (after merge go-ahead)

- [ ] **Step 1:** Back up `~/unscrypted/config` and `~/unscrypted/data` to `~/unscrypted-backups/<stamp>/`.
- [ ] **Step 2:** Create `~/unscrypted/secrets/admin_password` (`openssl rand -base64 18`, mode 600). Tell the owner where it is; don't print it.
- [ ] **Step 3:** Copy merged files, `sudo docker compose up -d --build`. Check the log: same `HAP pairing state: /data/persist`, same bridge username, "admin pane listening on ...:8190", go2rtc running, port 51826 still owned by the bridge.
- [ ] **Step 4:** Owner checks: Home still shows all cameras (no re-pair); pane on `http://10.0.1.78:8190` signs in, pairing QR shows; add a test camera (or re-use a spare) and confirm it appears in Home; edit a login and see "applied without restarting".
- [ ] **Step 5:** Decide what to do with the test instance (Open Question 5: leave it running for #3 or stop it). Update quest-log; close #2 when the owner confirms.

---

## Phase 4 (outline only): #3 Homedash moves in

Not detailed tasks; plan it properly after #2 ships.

1. **Turn on WebRTC** in the bundled go2rtc (port `8557` tcp/udp, Global Constraints reservation), because the living-room tiles want low latency. The pane keeps MSE.
2. **Port the display page:** copy Homedash's `web/` into `web/dash/`, served by the same admin server at `/dash` **without** sign-in (it's a wall display; read-only; never exposes credentials). Owner question when we get there: sign-in or not for `/dash`.
3. **Port the backend endpoints** (`/api/config`, `/api/state`, service checks, photo and font caches) from `server/server.py` to TypeScript modules under `src/dash/`, each wrapped in the same error boundary. Settings move from Homedash's `data/config.json` into unscrypted's `/data/dash.json` (not `config.json`, so dashboard settings can't break camera config).
4. **Streams:** tiles use go2rtc stream names from `streamNames()`. The Homedash `secrets/go2rtc.yaml` and its two go2rtc containers retire. Note the current Homedash stream names (`dogcam`, `garagecam`, `backyardcam`, `onvif_camera` and `_sub`) differ from slugs of unscrypted camera names; the display settings need a one-time remap.
5. **Display address:** Homedash runs on its own LAN IPs (`10.0.1.248` prod, `.245` dev via the `questlog-lan` ipvlan network) with `homedash.local` mDNS. unscrypted is on host networking at `10.0.1.78`. Options to decide then: repoint the `homedash.local` avahi alias to `10.0.1.78` and serve `/dash` on port 80 (clashes with the TrueNAS UI on `10.0.1.78:80`, so no), or keep a tiny redirect container on `.248` that 302s to `http://10.0.1.78:8190/dash`, or bind a second admin listener. Owner choice.
6. **Constructicon font fetch:** decide whether to carry the read-only token across.
7. **Retire Homedash** only after a few days of clean running, with a go-ahead.

---

## Owner decisions (2026-10-20)

Owner, 2026-10-20 06:20 MDT: "go !" (accepting the recommendations offered for questions 2, 3, 4, 8 and 9, plus the separate admin child process).

- **Q1:** Task 0 done first, as its own fix (#4, PR #7, live on prod as 0.1.1). This branch builds on that branch.
- **Q2:** (a) password file + sign-in page + 30-day cookie + lockout after 5 bad tries.
- **Q3:** (a) logins/URLs/motion timings apply live; new cameras are added live; HAP-shape changes wait for a "Restart bridge" button.
- **Q4:** (a) test instance runs with HomeKit OFF.
- **Q8:** (a) no camera delete in #2 (file it as its own issue); MSE-only preview.
- **Q9:** admin pane on 8190 (prod), 8191 (test).
- **Admin server:** a separate supervised child process in the same container (the "Your call" in the planning report).
- **Not yet answered:**
  - **Q5** (keep the test instance after #2): ask at the end of Phase 3.
  - **Q6** (go2rtc version): go with the recommended 1.9.14 pin unless the owner says otherwise.
  - **Q7** (NAS git clone): not needed for this build; ask before touching the NAS layout.

## Open questions for the owner

1. **Pairing-key rescue first (Task 0).** The live pairing keys are in a throwaway Docker volume; a `compose down` would force re-pairing every camera. Plan: (a) fix it now as its own small issue + PR, with a ~30 s camera blip, before any pane work **(recommended)**; (b) fold it into the #2 deploy; (c) leave it.
2. **Sign-in mechanism.** (a) One admin password in `secrets/admin_password`, sign-in page, 30-day cookie, lockout after 5 bad tries **(recommended)**; (b) browser pop-up "Basic auth" with the same password (simpler, but no clean sign-out and the browser re-sends the password on every request); (c) no sign-in, LAN trust only. Also: 30-day session OK, or shorter?
3. **How edits take effect.** (a) Logins/URLs/motion timings apply live to that one camera; new cameras are added live; changes Home "sees" (HKSV on/off, prebuffer, motion source type, model) are saved and wait for a "Restart bridge" button (~30 s "No Response") **(recommended)**; (b) every save restarts the bridge (simplest, always a blip); (c) also hot-swap HAP-shape changes by removing and re-adding that one accessory (no full restart, but riskier: Home may briefly show the camera removed, and it's the least-trodden path in hap-nodejs).
4. **Test instance and HomeKit.** (a) Test instance runs with HomeKit OFF; "appears in Home" is checked on prod after deploy **(recommended, since the household uses Home)**; (b) test instance pairs as a second bridge "Unscrypted Test" (own username/port 51827), removed from Home after testing.
5. **Test instance lifetime and fast loop.** (a) Keep `unscrypted-test` running after #2 for #3 work, rebuild-only (no bind-mounted source) **(recommended)**; (b) stop it after #2; (c) add a bind-mount fast loop (needs a dev-mode `tsx` entrypoint in the override).
6. **go2rtc version.** (a) Pin 1.9.14, the version Homedash already runs here **(recommended)**; (b) the newest stable release at build time (pinned + checksummed either way).
7. **NAS checkout.** `~/unscrypted` isn't a git clone (files were copied in). (a) Convert it to a real clone of `hooptiej/unscrypted` during the Task 0 deploy, keeping `config/`, `data/`, `secrets/` untracked **(recommended)**; (b) keep copying files with scp.
8. **Scope checks.** Deleting a camera from the pane isn't in #2's list (and deleting in Home drops its recordings). (a) Leave delete out of #2, file it as its own issue **(recommended)**; (b) add it now. Also: is WebRTC live preview needed in the pane for #2, or is MSE (no extra port, goes through sign-in) enough? (MSE-only recommended; WebRTC arrives with #3.)
9. **Admin port.** `8190` for prod, `8191` test (both verified free). OK, or a preferred number? An mDNS name like `unscrypted.local` → `10.0.1.78:8190` could come later.

## Follow-up issues to file (not in this plan's scope)

- ffmpeg from apt is unpinned in the Dockerfile (owner's Docker standard).
- Only one ONVIF notify receiver runs; per-camera `notifyPort` values other than the first are ignored with a warning every 10 minutes (prod shows this). Either document "set the same port on all cameras" or validate it.
- Base image pinned by tag, not digest.
