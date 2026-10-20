# One Camera, One Caller: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each camera stream gets exactly one RTSP connection, and go2rtc holds it. HomeKit's recording buffer, live views and snapshots, the dashboard and the admin pane all re-stream from go2rtc on loopback. A health-checked fallback reads the camera directly only while go2rtc is down. (hooptiej/unscrypted#16)

**Architecture:** go2rtc's RTSP server is switched on, bound to `127.0.0.1` only (prod `8554`, test `8555`). A new **source selector** (`src/source.ts`) decides, at every ffmpeg spawn, whether a HomeKit pipeline reads `rtsp://127.0.0.1:8554/<stream>` (normal) or the camera itself (fallback). It decides from a **go2rtc watcher** (`src/admin/go2rtcWatch.ts`). The watcher runs in the bridge every 5 s and checks the supervisor state, whether go2rtc's API answers, and whether its RTSP port accepts on loopback. It also reads `/api/streams` for each stream's producer state, which replaces both TCP camera probes (the bridge's 30 s probe and the dashboard's 4 s probe). The switch has hysteresis, so a crash-looping go2rtc can't make HomeKit flap. The admin feed check reuses the configured stream for an unchanged camera. It opens a temporary stream only for a new or edited URL, and closes that stream right after it gets one frame.

**Tech Stack:** Node 22 + TypeScript (existing), hap-nodejs 0.14.3, ffmpeg 5.1.9 (Debian bookworm, in the image), go2rtc 1.9.14 (pinned by SHA-256, already in the image). `node:test` via `tsx --test`. **No new dependencies.**

**Spec:** hooptiej/unscrypted#16 (`gh issue view 16 -R hooptiej/unscrypted --comments`), plus the owner decisions copied into "Global Constraints" below. Background: `docs/plans/2026-10-19-admin-pane-go2rtc.md` (supervisor, go2rtc manager, error shape) and `docs/plans/2026-10-20-homedash-move-in.md` (dash child, IPC, watch-only rules).

## Plain-language glossary

- **Producer / consumer (go2rtc words):** the *producer* is go2rtc's one connection to the camera. A *consumer* is anything watching through go2rtc: a dashboard tile, an admin preview, or (new) HomeKit's ffmpeg. go2rtc opens the producer when the first consumer arrives and closes it when the last one leaves. Ten consumers still mean one camera connection.
- **Restream:** go2rtc re-serving a camera's stream from its own RTSP server, here `rtsp://127.0.0.1:8554/<stream>`. "Loopback" (`127.0.0.1`) means the stream never leaves the NAS.
- **Prebuffer:** unscrypted's always-running ffmpeg for a camera with HomeKit recording turned on. It keeps the last 4 s of video ready, so a recorded clip starts *before* the motion. It's a permanent consumer, so a recording camera's connection stays open around the clock. That's already true today, and the only change is that go2rtc holds it.
- **Fallback ("direct"):** while go2rtc is down, new HomeKit pipelines read the camera themselves, as 0.3.0 does today.
- **GOP / keyframe:** cameras send a full picture (keyframe) every N frames, and the frames in between only carry changes. HomeKit wants every recording fragment to start on a keyframe and to last no more than 4 s.

## Global Constraints

Every task implicitly includes this section.

- **Goal (owner, final):** each camera stream gets exactly ONE RTSP connection, held by go2rtc. Everything else re-streams from go2rtc on loopback (`rtsp://127.0.0.1:8554/<stream>`). go2rtc's RTSP server is bound to `127.0.0.1` only.
- **Fallback: YES (owner, final).** If go2rtc is down, HomeKit's prebuffer and live view fall back to the camera directly until go2rtc is healthy again, then switch back. With hysteresis, so it never flaps.
- **Main vs sub: "Not sure, find out" (owner, final).** An explicit test task: one camera at a time, at a quiet moment, with HomeKit recording briefly affected and the owner told first. It opens main and sub through go2rtc at the same time, then records per camera model whether the camera refuses or drops one. The result decides whether dashboard tiles may use sub. **It needs the owner's go-ahead at run time.**
- **The dashboard's "camera up?"** comes from go2rtc's stream and producer state, never from TCP probes to the camera. `DashRuntime.probeCameras`'s TCP probing is removed (and so is the bridge's own 30 s `probeAll`, the same kind of probe).
- **Admin feed check:** an existing, unchanged camera reuses its configured stream (the frame comes from the existing producer). A separate temp stream is opened only for a new or edited URL, and closed right after.
- **Unchanged:** camera config names and the bridge identity (`bridge.name`/`username`/`setupId`, `./data/persist`). **HomeKit must never need re-pairing.** The dash stays watch-only, and the admin pane stays behind sign-in. Live video stays WebRTC (video only, go2rtc's player).
- **Never fail silently.** Every failure says what was attempted, what happened, what changed, and the next step (the existing `UserError`). The Status page says, in words, when HomeKit is reading the cameras directly and since when. Background loops log their failures and expose their last error in status. No `catch {}` or `|| true` that hides a failure.
- **Never open camera sessions casually.** The cameras tolerate about one client. Prod HomeKit recording is live. The test instance runs against a **synthetic pattern camera** (Task 3), never the real cameras. Any step that opens a real camera session on prod is marked **[owner go-ahead]**.
- **Never print secrets:** no config.json passwords, no RTSP URLs with credentials (`maskSecretsInLine` / `redactUrl`), no `admin_password`, no tokens.
- **Docker standard:** code baked into the image, version **0.4.0** (`unscrypted:0.4.0`, `unscrypted:0.4.0-test`), pinned base image, pinned go2rtc, no new deps. **The `unscrypted:0.3.0` image stays on the box as the rollback.**
- **Workflow:** issue #16 → branch `feat/one-rtsp-16` (this worktree) → a commit per task → one PR → **the owner confirms the merge.** No pushes to `main`. Prod deploy only after the merge go-ahead.
- **"Ask more, act less":** every Open Question is held until answered. An unanswered question means that piece waits. It never means "go with the recommendation".
- **Line endings:** the checkout is CRLF. Use the Edit tool. Before each commit, check `git diff --stat` for whole-file rewrites.
- **Test instance:** `unscrypted-test` is stopped right now (no standing dev instance, owner's choice). Start it on demand (`sudo docker start unscrypted-test`, or the compose `up` in Task 2b) and **stop it when the phase check is done** (`sudo docker stop unscrypted-test`).
- **Plain language** in logs, Status lines and error messages. Times on the Status page show in the viewer's local time.

## Findings from the live box (2026-10-20, about 17:00 MT, read-only)

The camera IPs aren't secret, and the plan uses them for the counts:

| Camera (HomeKit name) | IP | Model | Has sub | Audio | HomeKit recording (last 6 h of logs) |
|---|---|---|---|---|---|
| Couch Cam | 10.0.1.189 | Foscam FI9803P V2 | yes | yes (default) | not enabled |
| GarageCamTest | 10.0.1.3 | Generic XM | yes | no | **on**: 383 clips |
| BackyardCamTest | 10.0.1.4 | Generic XM | yes | no | on 19:45, **off** 20:00 |
| OnvifCamTest | 10.0.1.9 | Generic XM | yes | no | **on**: 100 clips |
| DogCamTest | 10.0.1.99 | Generic XM | yes | no | not enabled |

1. **Established RTSP connections right now** (`ss -tnp state established "( dport = :554 )"`):
   - Couch Cam: 1 (go2rtc)
   - GarageCamTest: **2** (go2rtc + ffmpeg prebuffer)
   - BackyardCamTest: 1 (go2rtc)
   - OnvifCamTest: 1 (ffmpeg prebuffer)
   - DogCamTest: 1 (go2rtc)
2. **TIME-WAIT** (connections closed in the last ~60 s): 18 each to .3, .4 and .99 (the three cameras whose dash tiles play), 2 to .9, 0 to .189. That matches the dash probe (every 4 s, so about 15 a minute) plus the bridge probe (every 30 s, 2 a minute) to each shown camera. The probes are the churn.
3. **GarageCamTest is the visible victim.** It's the only camera with two simultaneous clients, and in 6 h its prebuffer ffmpeg "exited (code 0); restarting" 15 times. go2rtc logged `EOF` / `i/o timeout` against `10.0.1.3:554` at the same times. That fits "the camera drops a client when it has two". After this fix it has one.
4. **Couch Cam looks wedged.** go2rtc holds an ESTABLISHED socket to `.189`, but `/api/streams` shows `couch_cam` and `couch_cam_sub` with no connected producer and 0 consumers. Over 6 h: 13 HomeKit snapshot timeouts and 3 live views where ffmpeg exited with code 1. The dash setting shows it (`shown: true`). Watch it in the prod verification. It's evidence the Foscam dislikes concurrent sessions too.
5. **go2rtc's `/api/streams` already gives producer state without opening sessions.** A connected producer lists `remote_addr`, `medias`, `receivers` and `bytes_recv`. An idle producer lists only its URL. Reading it opened no camera connection (counts were unchanged). Consumers show their type (`webrtc`, and an RTSP consumer will show too). So `bytes_recv` growth between two polls means "video is flowing".
6. **Tools:** ffmpeg in the image is `5.1.9-0+deb12u1`. Its RTSP demuxer has `-timeout <µs>` (socket I/O timeout); `-stimeout` is gone in 5.x. `tcpdump` is at `/usr/bin/tcpdump` on the host. Ports `8554`, `8555`, `8654` and `1988` are free. Prod dash `pollSeconds` = 4. The old Homedash `go2rtc` / `go2rtc-dev` containers are stopped.
7. **The NAS checkouts are file copies, not git** (`~/unscrypted`, `~/unscrypted-test`). Backups go in `~/unscrypted-backups/<YYYYMMDD-HHMMSS>-pre-<version>/` (that's the naming used so far).
8. **Snapshots are an RTSP client too** (not named in #16, but they're "everything else"). `StreamingDelegate.takeSnapshot` opens the camera's sub stream (main if there's no sub) for every HomeKit snapshot request. The Home app asks about every 10 s per tile while it's open. That's churn, and a second concurrent client on recording cameras. This plan routes snapshots through go2rtc as well (Task 8, Q1).

## go2rtc 1.9.14 behaviour this plan relies on

- **RTSP server:** `rtsp: listen: "127.0.0.1:8554"` serves every configured stream at `rtsp://127.0.0.1:8554/<name>`, and temp streams added through the API too. With no `username`/`password` set, it takes no auth (see Q7). An empty `listen` (today's config) switches it off.
- **Producer lifetime:** go2rtc opens the producer on the first consumer and stops it when the last consumer leaves. Task 12 Step 4 measures whether it lingers after the last consumer, and the plan doesn't depend on a linger.
- **Source flags:** `#media=video` limits the producer to video (already used for audio-less cameras). `#backchannel=0` stops go2rtc asking the camera for an ONVIF two-way-audio channel (Q2). Flags chain: `rtsp://…/11#media=video#backchannel=0`.
- **Timestamps:** go2rtc doesn't transcode an RTSP→RTSP restream. It de-packetizes H.264 and re-packetizes it with the camera's RTP timestamps, so B-frames and GOP are whatever the camera sends. It sends no RTCP sender reports to RTSP consumers as far as this plan assumes, so ffmpeg can't use wall-clock pairing between audio and video. That only matters for Couch Cam (the only camera with audio). Task 12 Step 6 checks a clip.
- **Mid-GOP join:** a consumer that joins an already-running producer gets packets from "now", not from the last keyframe. ffmpeg with `-c:v copy` drops packets until the first keyframe by default (`-copyinkf` is off), so the first fragment still starts on a keyframe. But **live-view startup can take up to one GOP longer** when the producer is already open (recording cameras). Task 5 measures it on the pattern camera, and Task 14 has the owner judge it on prod.
- **`/api/streams`:** lists every stream with `producers[]` (connected ones carry `remote_addr` and `bytes_recv`) and `consumers[]`. It never starts a producer.
- **Producer errors are only in the log:** `WRN …/producer.go:170 > error=EOF url=rtsp://…`. `Go2rtcManager` already pipes and masks these lines. Task 6 keeps the last error per source URL so the Status page can say why.

## HKSV correctness through the restream

- **The prebuffer ffmpeg command changes in exactly two places.** The input becomes `rtsp://127.0.0.1:<rtspPort>/<main stream>` instead of the camera's URL. A `-timeout 10000000` (10 s socket I/O timeout) is added before `-i`, so a wedged go2rtc makes ffmpeg exit and the prebuffer restart instead of hanging. Everything else stays byte-for-byte the same: `-fflags +genpts`, `-rtsp_transport tcp`, `-c:v copy` (or the transcode branch), the AAC audio chain, `-movflags frag_keyframe+empty_moov+default_base_moof` and `-frag_duration 4000000`. The fallback uses the same args with the camera URL. The 0.3.0 args are `buildPrebufferArgs(cam, cam.rtspMain)` minus the `-timeout` pair.
- **Keyframe-aligned fragments:** `frag_keyframe` still cuts at every keyframe, and the copy mode still drops packets until the first keyframe. The new `--selftest --source <url>` (Task 4) proves it: it reads every fragment's first-sample flags and fails if any fragment doesn't start on a sync sample.
- **4-second prebuffer:** unchanged (`prebufferSeconds * 1000`, with a 2 s margin). The selftest reports the longest fragment. Over 4 s, it warns that the camera's keyframe interval is too long. That's a camera setting, not something the restream does.
- **Timestamps start at zero:** ffmpeg rebases output timestamps to its own start, whatever the input's RTP clock says (no `-copyts`). The selftest checks the first fragment's `tfdt` is 0 (within half a second), and that `tfdt` only increases. HomeKit gets one init segment plus fragments from the one long-running ffmpeg, exactly as in 0.3.0. **If that check fails on a real restream** (it shouldn't), the fix is to add `-avoid_negative_ts make_zero` to `buildPrebufferArgs`, and Task 4 Step 6 says when.
- **No B-frames:** go2rtc passes the camera's H.264 through untouched. The selftest fails if any `trun` carries non-zero composition offsets (that's what B-frames look like in fMP4). The XM and Foscam cameras send none today (HKSV works on 0.3.0 with copy mode).
- **Why `-rtsp_transport tcp` against 127.0.0.1 is safe, and what it costs:** loopback TCP can't drop or reorder packets, so a big 1080p keyframe never arrives half-lost (over UDP, a full socket buffer silently drops packets and corrupts frames in a recording). It needs no UDP port pair per session, and no firewall or NAT is involved. Head-of-line blocking only matters on lossy links, and loopback isn't one. Added latency is the kernel copy, well under 1 ms. go2rtc's own repacketizing adds a few ms. HKSV doesn't notice either.

## Live view latency through the restream

- **Steady-state delay:** direct, it's camera → ffmpeg (copy) → SRTP → phone. Through the restream, it's camera → go2rtc → loopback → ffmpeg → SRTP → phone, which adds a few ms (go2rtc repacketizing plus loopback). That's below what you can see. The SRTP leg to the phone is unchanged.
- **Startup:** it may get faster or slower. Faster, when the producer is already open: no camera RTSP handshake (DESCRIBE/SETUP/PLAY to these cameras takes roughly 0.5-2 s). Slower, by up to one GOP: a mid-GOP join waits for the next keyframe, where a camera usually starts a fresh session on a keyframe. Measure it on the pattern camera (Task 5 Step 5). If it's bad on prod, the cheap fix is a 1-2 s keyframe interval in the camera's own settings, which also keeps HKSV fragments short.

## Producer lifetime and "camera up?" status

- **Recording cameras** (HomeKit recording on): the prebuffer is a permanent go2rtc consumer, so their main connection stays open around the clock. That's already true today (the prebuffer's own connection). The connection moves from ffmpeg to go2rtc, and every other viewer shares it. **OK.**
- **Non-recording cameras** connect only while someone watches: a dash tile, an admin preview, a HomeKit live view or a snapshot. The kiosk shows its tiles all day, so those cameras stay connected anyway. **OK**, and it's the point: no viewers means no camera connection.
- **Status that creates no churn** (`FeedState`, computed in the bridge from `/api/streams` every 5 s):
  - `streaming`: the producer is connected and `bytes_recv` grew since the last poll. "video flowing (N viewers through go2rtc)".
  - `starting`: consumers are waiting, and the producer has been unconnected for less than 10 s. "connecting…".
  - `stalled`: the producer is connected, but no new bytes for 10 s. "The camera is connected but stopped sending video".
  - `down`: consumers are waiting, and the producer has been unconnected for 10 s or more. "go2rtc can't get video from the camera: <plain reason from the last go2rtc log line>".
  - `idle`: no consumers. "Idle: nobody is watching (last video 7:42 PM)". **No check is made**, on purpose (Q5).
  - `unknown`: go2rtc isn't healthy, so nothing can be read. "go2rtc is down, so the camera's state can't be read".
- **The dash tile** treats `idle`, `starting` and `unknown` as "try to play". Its own player is what makes the stream non-idle, so it must not wait for "up" first. `down` and `stalled` show the reason over the tile **while the player keeps retrying**. go2rtc's player reconnects about every 15 s, plus the page's existing once-a-minute recreate. A dead camera then sees one connection attempt about every 15 s, from one client (go2rtc). Today it's a TCP probe every 4 s plus go2rtc's own retries.

## The fallback

- **Health** (`Go2rtcHealth`, every 5 s, loopback only, never a camera):
  - the supervisor state is `running`;
  - `GET /api/streams` answers 200 with JSON within 3 s;
  - a TCP connect to `127.0.0.1:<rtspPort>` succeeds within 1 s.

  All three must pass. Producer health (above) feeds the Status page. It doesn't trigger the fallback unless Q3 = (b). A camera that's down for go2rtc is almost always down for a direct ffmpeg too, and hammering a struggling camera with a second client is the very thing #16 fixes.
- **Switching (hysteresis, Q8 timings):**
  - **go2rtc → direct:** unhealthy continuously for **15 s**. That covers a deliberate go2rtc restart after a camera save, which takes 1-3 s.
  - **direct → go2rtc:** healthy continuously for **60 s** AND at least **2 min** since switching to direct. A crash-looping go2rtc (up for 30 s, down for 5 s) stays on direct.
  - The boot state is `go2rtc` and counts as unhealthy until the first good check, so a go2rtc that never comes up flips to direct 15 s after boot.
  - `UNSCRYPTED_GO2RTC=off` or `UNSCRYPTED_GO2RTC_RTSP=off` gives mode `off`: always direct (0.3.0 behaviour), and the Status page says so.
- **What switches when:**
  - **New spawns** (live views, snapshots, prebuffer restarts) read the selector at spawn time.
  - **A running prebuffer** whose input no longer matches the mode is restarted. If a clip is being recorded, the restart waits until the clip ends, then happens within 2 s. When go2rtc dies, the prebuffer's ffmpeg dies too and retries every 5 s, so after the 15 s grace its next restart goes direct by itself.
  - **Open live views** keep their source until closed (same as a config change today).
- **Logs:**
  - `WARN` on go2rtc → direct: `HomeKit now reads the cameras directly: go2rtc is down (<reason>) since <ISO time>. Cameras may see an extra connection each until it's back; HomeKit switches back on its own once go2rtc has been healthy for 60 s.`
  - `INFO` on the way back: `HomeKit is reading the cameras through go2rtc again (it was direct for 3m12s).`
  - Each pipeline's start line says `reading through go2rtc` or `reading the camera directly`.
- **Status page:**
  - In `direct` mode, an amber notice: "HomeKit is reading the cameras directly because go2rtc is down (since 7:42 PM): go2rtc isn't running (backoff: exited with code 1). Cameras may see an extra connection each until go2rtc is back. HomeKit switches back on its own once go2rtc has been healthy for a minute." Once go2rtc is healthy again, the last sentence becomes "go2rtc is healthy again; HomeKit switches back to it at 7:46 PM if it stays healthy."
  - In `go2rtc` mode, a quiet line: "HomeKit reads every camera through go2rtc: one connection per camera stream."
  - Each camera's card shows a "Video" line (its `FeedState` text), a "HomeKit reads" line (`through go2rtc` / `the camera directly`) and a "Recording buffer" line (running or not, its source, the last fragment's age).

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/source.ts` | **create** | `SourceSelector`, the pure hysteresis step `nextSourceState`, `FeedPicker`, `directPicker`, `sourceText` |
| `src/admin/go2rtcWatch.ts` | **create** | `Go2rtcWatcher`: health checks plus `/api/streams` → per-stream `FeedStatus`, and the pure `parseStreams`/`nextFeed` |
| `src/admin/go2rtcConfig.ts` | modify | RTSP listen on loopback, `restreamUrl`, `sourceSuffix` (`#media=video`, `#backchannel=0`) |
| `src/admin/go2rtc.ts` | modify | the `rtsp` port, skip the restart when the YAML is unchanged, last producer error per source URL, `Go2rtcClient.streams()` |
| `src/mp4.ts` | modify | `inspectFragment`, `videoTimescale` (read-only box inspection for the selftest) |
| `src/prebuffer.ts` | modify | the exported `buildPrebufferArgs(cam, inputUrl)`, input from a `FeedPicker`, `restart()`, `status()` |
| `src/streamingDelegate.ts` | modify | live view and snapshot input from a `FeedPicker`, a 10 s snapshot cache with single-flight |
| `src/recordingDelegate.ts` | modify | `activeClips()` |
| `src/camera.ts` | modify | takes a `SourceSelector`, re-points the prebuffer on a mode change, `startPrebufferForTest()`, prebuffer status |
| `src/selftest.ts` | modify | `--source <url>` mode: the real prebuffer args → fMP4 checks |
| `src/index.ts` | modify | the RTSP port env, the selector built before the cameras, selftest args, `UNSCRYPTED_TEST_PREBUFFER` |
| `src/bridgeRuntime.ts` | modify | the watcher drives the selector; drop `probeAll`/`probeRtsp`; feed status to the admin and the dash |
| `src/admin/ipc.ts` | modify | `CameraStatus` gets `feed`/`subFeed`/`via`/`prebuffer` (and loses `reachable*`); `BridgeStatus.homekitSource` |
| `src/admin/server.ts` | modify | feed-check reuse, one-off temp streams with an in-memory frame, the HomeKit-source notice |
| `src/dash/ipc.ts`, `src/dash/runtime.ts`, `src/dash/main.ts` | modify | drop `probe`/`probeCameras`, take a `feeds` message |
| `web/admin/app.js`, `web/dash/app.js` | modify | new status text; tiles keep playing while a reason shows |
| `scripts/nas/pattern-cam.yaml`, `scripts/nas/pattern-cam.sh` | **create** | the synthetic test camera (a throwaway go2rtc publishing a lavfi pattern on `127.0.0.1:8654`) |
| `scripts/nas/rtsp-census.sh` | **create** | read-only per-camera connection, TIME-WAIT and SYN-rate census |
| `Dockerfile`, `docker-compose.yml`, `docker-compose.test.yml`, `package.json`, `README.md` | modify | 0.4.0, the RTSP port env, docs |
| tests: `test/source.test.ts`, `test/mp4.test.ts`, `test/admin/go2rtcWatch.test.ts`, plus updates to `test/admin/go2rtcConfig.test.ts`, `test/admin/go2rtc.test.ts`, `test/admin/bridgeRuntime.test.ts`, `test/admin/server.test.ts`, `test/dash/ipc.test.ts`, `test/dash/runtime.test.ts` | create/modify | |

---

## Phase 0: Ready the branch

### Task 0: Version bump, owner answers, optional quick mitigation

**Files:** Modify `package.json`, `docker-compose.yml`, `docker-compose.test.yml`.

- [ ] **Step 1:** Ask the owner the Open Questions (button panel, one decision per question). Record each answer as a comment on #16 under "Owner answers (plan 2026-10-20)". Pieces whose question is unanswered wait.
- [ ] **Step 2 (Q12 = a only):** quick mitigation on prod, which is a settings change, not code. Through the admin pane's Dashboard tab (signed in), set "poll seconds" from 4 to 60. Verify with `sudo ss -tn state time-wait "( dport = :554 )" | wc -l` a minute later: it should drop from about 56 to about 8.
- [ ] **Step 3:** In `package.json`, set `"version": "0.4.0"`. In `docker-compose.yml`, set `image: unscrypted:0.4.0`. In `docker-compose.test.yml`, set `image: unscrypted:0.4.0-test`.
- [ ] **Step 4:** `npm test` (all pass, nothing else changed). Commit: `chore: start 0.4.0 for one-RTSP-per-camera (#16)`.

---

## Phase 1: go2rtc restreams on loopback (check: the test instance serves the pattern camera on `127.0.0.1:8555`, and only go2rtc pulls the source)

### Task 1: go2rtc config: RTSP on loopback, restream URLs, source flags

**Files:**
- Modify: `src/admin/go2rtcConfig.ts`
- Modify: `src/admin/server.ts:468` (the feed check's source suffix)
- Test: `test/admin/go2rtcConfig.test.ts`, `test/admin/go2rtc.test.ts`

**Interfaces:**
- Produces: `interface Go2rtcPorts { api: number; webrtc: number | null; rtsp: number | null }`, `restreamUrl(rtspPort: number, stream: string): string`, `sourceSuffix(c: Pick<ResolvedCamera, "audio">): string`.

- [ ] **Step 1: Write the failing tests** (append to `test/admin/go2rtcConfig.test.ts`):

```ts
import { restreamUrl, sourceSuffix } from "../../src/admin/go2rtcConfig";

test("RTSP restream listens on loopback only when a port is given", () => {
  const on = buildGo2rtcYaml({ cameras: [cam("Cam")] } as any, { api: 1986, webrtc: 8557, rtsp: 8554 });
  assert.match(on, /rtsp:\n  listen: "127\.0\.0\.1:8554"\n/);
  const off = buildGo2rtcYaml({ cameras: [cam("Cam")] } as any, { api: 1986, webrtc: 8557, rtsp: null });
  assert.match(off, /rtsp:\n  listen: ""\n/);
});

test("restream URL is loopback rtsp with the stream name", () => {
  assert.equal(restreamUrl(8554, "garagecamtest"), "rtsp://127.0.0.1:8554/garagecamtest");
});

test("every source turns off the ONVIF backchannel; audio-less cameras are video-only", () => {
  assert.equal(sourceSuffix({ audio: false }), "#media=video#backchannel=0");
  assert.equal(sourceSuffix({ audio: true }), "#backchannel=0");
  const y = buildGo2rtcYaml({ cameras: [cam("Cam")] } as any, { api: 1, webrtc: null, rtsp: 8554 });
  assert.match(y, /cam: "rtsp:\/\/u:p@h\/11#media=video#backchannel=0"/);
  assert.match(y, /cam_sub: "rtsp:\/\/u:p@h\/12#media=video#backchannel=0"/);
});
```

  Update every existing `buildGo2rtcYaml(..., { api, webrtc })` call in that file to pass `rtsp: null`. Update any assertion that expected a bare `#media=video` ending, so it expects `#media=video#backchannel=0`. In `test/admin/go2rtc.test.ts`, change the regex in "manager with a missing binary…" to `/cam: "rtsp:\/\/h\/1#backchannel=0"/`, and its `ports` to `{ api: 1999, webrtc: null, rtsp: null }`.

  **If Q2 = (b):** drop `#backchannel=0` from these expectations and from `sourceSuffix`.

- [ ] **Step 2:** `npx tsx --test test/admin/go2rtcConfig.test.ts test/admin/go2rtc.test.ts`. Expected: FAIL (`restreamUrl` is not exported, and type errors on `rtsp`).
- [ ] **Step 3: Implement** in `src/admin/go2rtcConfig.ts`:

```ts
export interface Go2rtcPorts { api: number; webrtc: number | null; rtsp: number | null }

/** go2rtc's loopback restream address for one stream (HomeKit's ffmpeg reads this). */
export function restreamUrl(rtspPort: number, stream: string): string {
  return `rtsp://127.0.0.1:${rtspPort}/${stream}`;
}

/** go2rtc source flags: video-only cameras get #media=video; nobody uses two-way audio (Q2). */
export function sourceSuffix(c: Pick<ResolvedCamera, "audio">): string {
  return (c.audio ? "" : "#media=video") + "#backchannel=0";
}
```

  In `buildGo2rtcYaml`, replace the two `rtsp:` lines with:

```ts
    "rtsp:",
    // Loopback only: HomeKit's ffmpeg pipelines re-stream from here (#16). Never on the LAN.
    `  listen: ${q(ports.rtsp ? `127.0.0.1:${ports.rtsp}` : "")}`,
```

  Replace `const suffix = c.audio ? "" : "#media=video";` with `const suffix = sourceSuffix(c);`. Update the file's header comment: "go2rtc serves the admin pane's previews, the dashboard, and (since 0.4.0) HomeKit's pipelines through its loopback RTSP restream." In `src/admin/server.ts`, change `cam.rtspMain + (cam.audio ? "" : "#media=video")` to `cam.rtspMain + sourceSuffix(cam)` and import `sourceSuffix` from `./go2rtcConfig`.
- [ ] **Step 4:** Run the two test files again. Expected: PASS. Then `npm run typecheck`. Expected: errors only where `Go2rtcPorts` is built without `rtsp` (`src/bridgeRuntime.ts`), which Task 2 fixes. If you need a green typecheck before committing, add `rtsp: null` there now.
- [ ] **Step 5: Commit** `feat(go2rtc): loopback RTSP restream and backchannel off in the generated config (#16)`.

### Task 2: Wire the RTSP port through env, compose and the image

**Files:** Modify `src/index.ts`, `src/bridgeRuntime.ts` (the `RuntimeOptions.go2rtc` type and the `Go2rtcManager` construction), `Dockerfile`, `docker-compose.yml`, `docker-compose.test.yml`. Test: `test/admin/bridgeRuntime.test.ts` (the setup gets `rtspPort: null`).

**Interfaces:**
- Produces: `RuntimeOptions.go2rtc.rtspPort: number | null`. Env `UNSCRYPTED_GO2RTC_RTSP_PORT` (default 8554). `UNSCRYPTED_GO2RTC_RTSP=off` turns the restream off, and HomeKit then stays direct.

- [ ] **Step 1:** In `src/index.ts`, move the three go2rtc `envPort` lines (`go2rtcApi`, `go2rtcWebrtc`, and a new `go2rtcRtsp`) **above the camera loop**, because the selector in Task 7 needs them before cameras exist:

```ts
  const go2rtcApi = envPort("UNSCRYPTED_GO2RTC_API_PORT", 1986, log);
  const go2rtcWebrtc = envPort("UNSCRYPTED_GO2RTC_WEBRTC_PORT", 8557, log);
  const go2rtcRtsp = envPort("UNSCRYPTED_GO2RTC_RTSP_PORT", 8554, log);
  const go2rtcEnabled = process.env.UNSCRYPTED_GO2RTC !== "off" && go2rtcApi.error === null;
  // Loopback restream for HomeKit's pipelines (#16). Off = HomeKit reads cameras directly (0.3.0 behaviour).
  const rtspPort = go2rtcEnabled && process.env.UNSCRYPTED_GO2RTC_RTSP !== "off" && go2rtcRtsp.error === null ? go2rtcRtsp.port : null;
```

  In the `go2rtc:` block of `new BridgeRuntime({...})`, use `enabled: go2rtcEnabled` and add `rtspPort`.
- [ ] **Step 2:** In `src/bridgeRuntime.ts`, add `rtspPort: number | null` to `RuntimeOptions.go2rtc`. In `start()`, build the manager with `ports: { api: g.apiPort, webrtc: g.webrtcPort, rtsp: g.rtspPort }`. In the test helper `setup()` in `test/admin/bridgeRuntime.test.ts`, add `rtspPort: null` to `go2rtc`.
- [ ] **Step 3:** In the `Dockerfile` `ENV` block, add `UNSCRYPTED_GO2RTC_RTSP_PORT=8554 \`. Change the go2rtc comment to "go2rtc (HomeKit's single camera client, feed checks, previews, the dashboard)". In `docker-compose.yml`'s environment, add:

```yaml
      # go2rtc's RTSP restream, 127.0.0.1 only: HomeKit's ffmpeg reads cameras through it (#16).
      - UNSCRYPTED_GO2RTC_RTSP_PORT=8554
```

  In `docker-compose.test.yml`, add `- UNSCRYPTED_GO2RTC_RTSP_PORT=8555`.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: go2rtc RTSP port env (prod 8554, test 8555, loopback) (#16)`.

### Task 2b: Deploy to the test instance (repeat at the end of each phase)

- [ ] **Step 1: Back up the test checkout** (first time only): `cp -a "$HOME/unscrypted-test/config" "$HOME/unscrypted-test/data/dash" "$HOME/unscrypted-backups/$(date +%Y%m%d-%H%M%S)-test-pre-0.4.0/"`. Make the folder with `mkdir -p` first.
- [ ] **Step 2: Pattern-only test config** (first time only, after Task 3 exists). Write a new `~/unscrypted-test/config/config.json` with the **same `bridge` block** as the backup, plus only the two pattern cameras from Task 3 Step 3, then `chmod 600` it. Set the test dash settings to show only `PatternCam` and `PatternCam2`. **The test instance must never pull the real cameras** (Global Constraints).
- [ ] **Step 3: Copy the branch** with `scp -r` of `src`, `web`, `scripts`, `package.json`, `package-lock.json`, `tsconfig.json`, `Dockerfile`, `docker-compose.yml` and `docker-compose.test.yml` into `~/unscrypted-test/`. Check line endings on the shell scripts: `python3 -c "import sys;print(open(sys.argv[1],'rb').read().count(b'\r'))" ~/unscrypted-test/scripts/nas/pattern-cam.sh` must print `0`. If not, convert with `sed -i 's/\r$//'`.
- [ ] **Step 4:** Start the pattern camera (Task 3 Step 4). Then: `cd "$HOME/unscrypted-test" && sudo docker compose -f docker-compose.yml -f docker-compose.test.yml -p unscrypted-test up -d --build`.
- [ ] **Step 5: Check:**
  - `sudo docker logs unscrypted-test 2>&1 | tail -40` shows go2rtc running and the admin pane on 8191.
  - `sudo ss -lntp | grep -E '127.0.0.1:(8555|1987) '` shows both owned by go2rtc.
  - Phase-specific checks are listed in each phase's title and its last task.
- [ ] **Step 6: When the phase check is done:** `sudo docker stop unscrypted-test` and `bash "$HOME/unscrypted-test/scripts/nas/pattern-cam.sh" stop`.

### Task 3: The synthetic pattern camera (test rig, no app code)

**Files:** Create `scripts/nas/pattern-cam.yaml`, `scripts/nas/pattern-cam.sh`.

The rig is a throwaway container from the already-pulled `unscrypted:0.3.0` image, which has go2rtc and ffmpeg. go2rtc runs an `exec:` source that makes a 1080p/15 fps H.264 test pattern (no B-frames, 2 s GOP) only while something pulls it, and serves it at `rtsp://127.0.0.1:8654/pattern`. It behaves like a camera, and counting connections to `:8654` proves "one client".

- [ ] **Step 1: Create `scripts/nas/pattern-cam.yaml`:**

```yaml
# Synthetic "camera" for unscrypted-test (#16). Loopback only. Never point prod at it.
api:
  listen: "127.0.0.1:1988"
rtsp:
  listen: "127.0.0.1:8654"
webrtc:
  listen: ""
log:
  level: info
streams:
  pattern: "exec:ffmpeg -hide_banner -loglevel error -re -f lavfi -i testsrc2=size=1920x1080:rate=15 -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -pix_fmt yuv420p -bf 0 -g 30 -f rtsp {output}"
  pattern_sub: "exec:ffmpeg -hide_banner -loglevel error -re -f lavfi -i testsrc2=size=640x360:rate=15 -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -pix_fmt yuv420p -bf 0 -g 30 -f rtsp {output}"
```

- [ ] **Step 2: Create `scripts/nas/pattern-cam.sh`:**

```bash
#!/bin/bash
# Start/stop/status the synthetic pattern camera for unscrypted-test (#16).
# Usage: bash pattern-cam.sh start|stop|status   (run from anywhere; /tmp is noexec, so always "bash ...")
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=unscrypted-pattern-cam
IMAGE=unscrypted:0.3.0
case "${1:-}" in
  start)
    if sudo docker ps --format '{{.Names}}' | grep -qx "$NAME"; then echo "$NAME already running"; exit 0; fi
    if sudo ss -lnt | grep -qE '127\.0\.0\.1:(8654|1988) '; then
      echo "ports 8654/1988 are taken by something else; not starting. Check: sudo ss -lntp | grep -E ':(8654|1988) '" >&2; exit 1
    fi
    sudo docker run -d --rm --name "$NAME" --network host \
      -v "$HERE/pattern-cam.yaml:/pattern-cam.yaml:ro" --entrypoint /usr/local/bin/go2rtc "$IMAGE" -config /pattern-cam.yaml
    echo "$NAME started: rtsp://127.0.0.1:8654/pattern and /pattern_sub"
    ;;
  stop)
    if sudo docker ps --format '{{.Names}}' | grep -qx "$NAME"; then sudo docker stop "$NAME"; else echo "$NAME isn't running"; fi
    ;;
  status)
    echo "clients pulling the pattern (each line = one RTSP connection to :8654):"
    sudo ss -tnp state established "( dport = :8654 )" | awk 'NR>1 {print $NF}'
    ;;
  *) echo "usage: bash $0 start|stop|status" >&2; exit 2 ;;
esac
```

- [ ] **Step 3: Pattern cameras for the test config** (used in Task 2b Step 2). Two cameras, so one can act as the "unchanged" camera while the other gets edited:

```json
{ "name": "PatternCam",  "rtspMain": "rtsp://127.0.0.1:8654/pattern", "rtspSub": "rtsp://127.0.0.1:8654/pattern_sub", "hksv": true, "audio": false, "copyVideo": true },
{ "name": "PatternCam2", "rtspMain": "rtsp://127.0.0.1:8654/pattern", "hksv": true, "audio": false, "copyVideo": true }
```

  (Both pull the same pattern stream, which is fine for a synthetic source.)
- [ ] **Step 4: Check on the NAS:** `bash "$HOME/unscrypted-test/scripts/nas/pattern-cam.sh" start`. Then `sudo docker exec unscrypted-pattern-cam ffmpeg -hide_banner -rtsp_transport tcp -i rtsp://127.0.0.1:8654/pattern -frames:v 30 -f null - 2>&1 | tail -2`. Expected: `frame=   30`, no errors. `bash … status` while it runs shows one line.
- [ ] **Step 5: Commit** `test: synthetic pattern camera for the test instance (#16)`.

---

## Phase 2: Prove the HKSV pipeline through the restream (check: `--selftest --source rtsp://127.0.0.1:8555/patterncam` passes inside `unscrypted-test`)

### Task 4: Fragment inspection and the `--selftest --source` mode

**Files:**
- Modify: `src/mp4.ts` (add `inspectFragment`, `videoTimescale`), `src/prebuffer.ts` (extract and export `buildPrebufferArgs`), `src/selftest.ts`, `src/index.ts` (argv)
- Test: `test/mp4.test.ts` (create), `test/prebufferArgs.test.ts` (create)

**Interfaces:**
- Produces: `interface FragmentInfo { baseMediaDecodeTime: number | null; firstSampleIsSync: boolean | null; hasCompositionOffsets: boolean; sampleCount: number }`, `inspectFragment(fragment: Buffer): FragmentInfo`, `videoTimescale(init: Buffer): number | null`, `buildPrebufferArgs(cam: Pick<ResolvedCamera, "copyVideo" | "audio">, inputUrl: string): string[]`, `runSelfTest(ffmpegPath, log, opts?: { source?: string; seconds?: number; audio?: boolean }): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests.** `test/mp4.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectFragment, videoTimescale } from "../src/mp4";

const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, "ascii");
  return Buffer.concat([h, body]);
};
const u32 = (...n: number[]) => { const b = Buffer.alloc(4 * n.length); n.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
const SYNC = 0x02000000, NON_SYNC = 0x01010000;

function frag(opts: { tfdt: number; firstFlags: number; cts?: number[] }) {
  const tfhd = box("tfhd", u32(0x020000, 1));                          // flags: default-base-is-moof, track 1
  const tfdt = box("tfdt", u32(0x01000000), Buffer.from([0, 0, 0, 0]), u32(opts.tfdt)); // v1, 64-bit
  const n = opts.cts ? opts.cts.length : 2;
  const flags = 0x01 | 0x04 | 0x100 | 0x200 | (opts.cts ? 0x800 : 0);
  const samples = Array.from({ length: n }, (_, i) => Buffer.concat([u32(6000, 100), ...(opts.cts ? [u32(opts.cts[i])] : [])]));
  const trun = box("trun", u32(flags, n, 0, opts.firstFlags), ...samples);
  return Buffer.concat([box("moof", box("mfhd", u32(0, 1)), box("traf", tfhd, tfdt, trun)), box("mdat", Buffer.alloc(4))]);
}

test("reads decode time, keyframe start and composition offsets from a fragment", () => {
  const ok = inspectFragment(frag({ tfdt: 0, firstFlags: SYNC }));
  assert.deepEqual(ok, { baseMediaDecodeTime: 0, firstSampleIsSync: true, hasCompositionOffsets: false, sampleCount: 2 });
  assert.equal(inspectFragment(frag({ tfdt: 90000, firstFlags: NON_SYNC })).firstSampleIsSync, false);
  assert.equal(inspectFragment(frag({ tfdt: 0, firstFlags: SYNC, cts: [0, 3000] })).hasCompositionOffsets, true);
  assert.equal(inspectFragment(frag({ tfdt: 0, firstFlags: SYNC, cts: [0, 0] })).hasCompositionOffsets, false);
});

test("garbage in, nulls out (never throws)", () => {
  assert.deepEqual(inspectFragment(Buffer.from("nonsense")), { baseMediaDecodeTime: null, firstSampleIsSync: null, hasCompositionOffsets: false, sampleCount: 0 });
});

test("finds the video track's timescale in the init segment", () => {
  const mdhd = box("mdhd", u32(0, 0, 0, 90000, 0));                     // v0: ctime, mtime, timescale, duration
  const hdlr = box("hdlr", u32(0, 0), Buffer.from("vide"), Buffer.alloc(12));
  const init = Buffer.concat([box("ftyp", Buffer.from("isom")), box("moov", box("trak", box("mdia", mdhd, hdlr)))]);
  assert.equal(videoTimescale(init), 90000);
});
```

  `test/prebufferArgs.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrebufferArgs } from "../src/prebuffer";

test("prebuffer args: the input URL is the only per-source change, with a socket timeout", () => {
  const a = buildPrebufferArgs({ copyVideo: true, audio: false }, "rtsp://127.0.0.1:8554/garagecamtest");
  const i = a.indexOf("-i");
  assert.equal(a[i + 1], "rtsp://127.0.0.1:8554/garagecamtest");
  assert.deepEqual(a.slice(i - 4, i), ["-rtsp_transport", "tcp", "-timeout", "10000000"]);
  assert.ok(a.includes("frag_keyframe+empty_moov+default_base_moof"));
  assert.deepEqual(a.slice(a.indexOf("-c:v"), a.indexOf("-c:v") + 2), ["-c:v", "copy"]);
  assert.ok(a.includes("-an"));
  assert.equal(a[a.length - 1], "pipe:1");
  const direct = buildPrebufferArgs({ copyVideo: true, audio: false }, "rtsp://u:p@10.0.1.3:554/11");
  assert.deepEqual(direct.filter((x) => !x.startsWith("rtsp://")), a.filter((x) => !x.startsWith("rtsp://")));
});
```

- [ ] **Step 2:** `npx tsx --test test/mp4.test.ts test/prebufferArgs.test.ts`. Expected: FAIL (the functions aren't exported).
- [ ] **Step 3: Implement in `src/mp4.ts`** (append; read-only, never throws):

```ts
export interface FragmentInfo { baseMediaDecodeTime: number | null; firstSampleIsSync: boolean | null; hasCompositionOffsets: boolean; sampleCount: number }

interface Span { type: string; start: number; end: number }
/** Child boxes of [start, end). Stops quietly at anything malformed. */
function children(buf: Buffer, start: number, end: number): Span[] {
  const out: Span[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    }
    if (size < header || p + size > end) break;
    out.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return out;
}

const NON_SYNC = 0x00010000;

/** Decode time, keyframe start and B-frame evidence of the first track in a moof+mdat fragment. */
export function inspectFragment(fragment: Buffer): FragmentInfo {
  const info: FragmentInfo = { baseMediaDecodeTime: null, firstSampleIsSync: null, hasCompositionOffsets: false, sampleCount: 0 };
  try {
    const moof = children(fragment, 0, fragment.length).find((b) => b.type === "moof");
    const traf = moof && children(fragment, moof.start, moof.end).find((b) => b.type === "traf");
    if (!traf) return info;
    let defaultFlags: number | null = null;
    for (const b of children(fragment, traf.start, traf.end)) {
      const vf = fragment.readUInt32BE(b.start);
      const version = vf >>> 24;
      const flags = vf & 0xffffff;
      let p = b.start + 4;
      if (b.type === "tfhd") {
        p += 4;                       // track_ID
        if (flags & 0x01) p += 8;     // base_data_offset
        if (flags & 0x02) p += 4;     // sample_description_index
        if (flags & 0x08) p += 4;     // default_sample_duration
        if (flags & 0x10) p += 4;     // default_sample_size
        if (flags & 0x20) defaultFlags = fragment.readUInt32BE(p);
      } else if (b.type === "tfdt") {
        info.baseMediaDecodeTime = version === 1 ? Number(fragment.readBigUInt64BE(p)) : fragment.readUInt32BE(p);
      } else if (b.type === "trun") {
        const count = fragment.readUInt32BE(p); p += 4;
        info.sampleCount = count;
        if (flags & 0x01) p += 4;     // data_offset
        let first: number | null = null;
        if (flags & 0x04) { first = fragment.readUInt32BE(p); p += 4; }
        for (let i = 0; i < count; i++) {
          if (flags & 0x100) p += 4;
          if (flags & 0x200) p += 4;
          let sf: number | null = null;
          if (flags & 0x400) { sf = fragment.readUInt32BE(p); p += 4; }
          if (flags & 0x800) { if (fragment.readInt32BE(p) !== 0) info.hasCompositionOffsets = true; p += 4; }
          if (i === 0 && first === null) first = sf;
        }
        const f0 = first ?? defaultFlags;
        info.firstSampleIsSync = f0 === null ? null : (f0 & NON_SYNC) === 0;
      }
    }
  } catch {
    // A truncated box: report what was read so far. The selftest treats nulls as failures, loudly.
  }
  return info;
}

/** Timescale (ticks per second) of the first video track in an ftyp+moov init segment. */
export function videoTimescale(init: Buffer): number | null {
  try {
    const moov = children(init, 0, init.length).find((b) => b.type === "moov");
    if (!moov) return null;
    for (const trak of children(init, moov.start, moov.end).filter((b) => b.type === "trak")) {
      const mdia = children(init, trak.start, trak.end).find((b) => b.type === "mdia");
      if (!mdia) continue;
      const kids = children(init, mdia.start, mdia.end);
      const hdlr = kids.find((b) => b.type === "hdlr");
      const mdhd = kids.find((b) => b.type === "mdhd");
      if (!hdlr || !mdhd || init.toString("ascii", hdlr.start + 8, hdlr.start + 12) !== "vide") continue;
      const v = init.readUInt8(mdhd.start);
      return init.readUInt32BE(mdhd.start + (v === 1 ? 20 : 12));
    }
  } catch {
    // malformed init: null makes the selftest fail with "no video timescale"
  }
  return null;
}
```

  (The two `catch` blocks are deliberate: the function's contract is to return what it could read, and the caller fails loudly on nulls. Each has a comment saying so.)
- [ ] **Step 4: Implement `buildPrebufferArgs` in `src/prebuffer.ts`.** Move the body of `private buildArgs()` into an exported module-level function with this signature. Change `"-rtsp_transport", "tcp", "-i", cam.rtspMain` to:

```ts
    "-rtsp_transport",
    "tcp",
    // Socket I/O timeout (µs): a wedged go2rtc or camera makes ffmpeg exit, so the prebuffer restarts instead of hanging.
    "-timeout",
    "10000000",
    "-i",
    inputUrl,
```

  Keep `private buildArgs(url: string) { return buildPrebufferArgs(this.camera, url); }` for now. Task 7 changes the caller.
- [ ] **Step 5: Extend `src/selftest.ts`.** Add `opts: { source?: string; seconds?: number; audio?: boolean } = {}` to `runSelfTest`. When `opts.source` is set, use `const args = buildPrebufferArgs({ copyVideo: true, audio: opts.audio ?? false }, opts.source); args.splice(args.length - 1, 0, "-t", String(opts.seconds ?? 12));` instead of the lavfi args. Log `=== unscrypted self-test: <redactUrl(source)> -> prebuffer pipeline -> fMP4 checks ===`. Collect `const infos: FragmentInfo[] = []` in the fragment callback (`infos.push(inspectFragment(fragment))`), keep the init segment, and after exit evaluate:

```ts
  const problems: string[] = [];
  const ts = init ? videoTimescale(init) : null;
  if (!init) problems.push("no init segment (ftyp+moov): ffmpeg never got a usable stream");
  else if (!init.includes(Buffer.from("avcC"))) problems.push("the init segment has no avcC (H.264 setup data): HomeKit can't decode it");
  if (ts === null) problems.push("no video timescale in the init segment");
  if (infos.length < 2) problems.push(`only ${infos.length} fragment(s); expected at least 2 in ${seconds}s`);
  const notKey = infos.findIndex((f) => f.firstSampleIsSync !== true);
  if (notKey >= 0) problems.push(`fragment #${notKey + 1} doesn't start on a keyframe: HomeKit needs every fragment to`);
  if (infos.some((f) => f.hasCompositionOffsets)) problems.push("B-frames found (non-zero composition offsets): HomeKit recording needs a stream without them");
  const t0 = infos[0]?.baseMediaDecodeTime;
  if (ts && (t0 === null || t0 === undefined || t0 > ts / 2)) problems.push(`the first fragment's decode time is ${t0} ticks, not ~0: timestamps don't start at zero`);
  for (let i = 1; i < infos.length; i++) {
    if ((infos[i].baseMediaDecodeTime ?? -1) <= (infos[i - 1].baseMediaDecodeTime ?? -1)) { problems.push(`decode time went backwards at fragment #${i + 1}`); break; }
  }
  if (ts && infos.length >= 2) {
    const longest = Math.max(...infos.slice(1).map((f, i) => ((f.baseMediaDecodeTime ?? 0) - (infos[i].baseMediaDecodeTime ?? 0)) / ts));
    log.info(`  longest fragment: ${longest.toFixed(2)} s`);
    if (longest > 4.0) log.warn(`  fragments run up to ${longest.toFixed(2)} s, longer than HomeKit's 4 s: the camera's keyframe interval is long (a camera setting, not the restream). Recording may still work; shorten the I-frame interval if clips fail.`);
  }
  const ok = code === 0 && problems.length === 0;
  if (ok) log.info(`SELF-TEST PASSED: ${infos.length} keyframe-aligned fragments, timestamps from zero, no B-frames, avcC present.`);
  else log.error(`SELF-TEST FAILED (ffmpeg exit ${code}):\n  - ${problems.join("\n  - ") || "ffmpeg exited non-zero; see its stderr above"}`);
  return ok;
```

  Run the same checks for the existing lavfi path too (it uses `-g 30` with no B-frames, so it must pass). That keeps one code path.
- [ ] **Step 6: Wire argv in `src/index.ts`:**

```ts
const argValue = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
...
  if (selftest) {
    const secs = Number(argValue("--seconds") ?? 12);
    const ok = await runSelfTest(config.ffmpegPath, log, { source: argValue("--source"), seconds: Number.isFinite(secs) && secs > 0 ? secs : 12, audio: argv.includes("--audio") });
    process.exit(ok ? 0 : 1);
  }
```

  **Contingency (only if Step 8 fails with "timestamps don't start at zero"):** add `"-avoid_negative_ts", "make_zero"` right after `"-fflags", "+genpts"` in `buildPrebufferArgs`, add that pair to the Step 1 test's expectations, and re-run.
- [ ] **Step 7:** `npm test && npm run typecheck`. Expected: PASS. If ffmpeg is installed locally, also run `npm run selftest`. Expected: PASSED.
- [ ] **Step 8: Live check** (Task 2b deploy first; the pattern camera running):
  - `sudo docker exec unscrypted-test node dist/index.js --selftest --source rtsp://127.0.0.1:8555/patterncam --seconds 12`. Expected: `SELF-TEST PASSED`, about 6 fragments, longest about 2.00 s.
  - While it runs, `bash …/pattern-cam.sh status` shows **exactly one** client (go2rtc in `unscrypted-test`). Repeat with two selftests at once (two `docker exec`s in parallel). Still exactly one client.
- [ ] **Step 9: Commit** `feat(selftest): check the prebuffer pipeline through any RTSP source (keyframes, tfdt, B-frames) (#16)`.

---

## Phase 3: The source selector and the go2rtc watcher (check: on the test instance, killing go2rtc flips the pattern camera's buffer to direct after 15 s, and it comes back after 2 min)

### Task 5: `SourceSelector` with hysteresis

**Files:** Create `src/source.ts`, `test/source.test.ts`.

**Interfaces:**
- Produces:

```ts
export type FeedVia = "go2rtc" | "camera";
export type SourceMode = "go2rtc" | "direct" | "off";
export interface FeedChoice { url: string; via: FeedVia }
export type FeedPicker = (which: "main" | "sub") => FeedChoice | null;
export interface Go2rtcHealth { supervisor: string; apiOk: boolean; rtspOk: boolean; at: number; error: string | null }
export interface SourceState { mode: SourceMode; since: number; reason: string | null; downSince: number | null; healthySince: number | null; unhealthySince: number | null; returnAt: number | null }
export interface SourceTimings { downGraceMs: number; healthyForMs: number; minDirectMs: number }
export const DEFAULT_TIMINGS: SourceTimings;
export function isHealthy(h: Go2rtcHealth): boolean;
export function nextSourceState(s: SourceState, h: Go2rtcHealth, t: SourceTimings): SourceState;
export function sourceText(s: SourceState, clock: (ms: number) => string): string;
export function directPicker(cam: Pick<ResolvedCamera, "rtspMain" | "rtspSub">): FeedPicker;
export class SourceSelector {
  constructor(o: { rtspPort: number | null; offReason?: string; log: Logger; timings?: SourceTimings; now?: () => number });
  setCameras(cams: Pick<ResolvedCamera, "name" | "rtspSub">[]): void;
  update(h: Go2rtcHealth): void;
  state(): SourceState;
  picker(cam: Pick<ResolvedCamera, "name" | "rtspMain" | "rtspSub">): FeedPicker;
  onChange(cb: () => void): () => void;
}
```

- [ ] **Step 1: Write the failing tests** (`test/source.test.ts`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSourceState, SourceState, DEFAULT_TIMINGS as T, Go2rtcHealth, SourceSelector, sourceText } from "../src/source";
import { Logger, setLogLevel } from "../src/logger";

setLogLevel("error");
const up = (at: number): Go2rtcHealth => ({ supervisor: "running", apiOk: true, rtspOk: true, at, error: null });
const down = (at: number): Go2rtcHealth => ({ supervisor: "backoff", apiOk: false, rtspOk: false, at, error: "go2rtc isn't running (backoff: exited with code 1)" });
const boot: SourceState = { mode: "go2rtc", since: 0, reason: null, downSince: null, healthySince: null, unhealthySince: 0, returnAt: null };
const run = (s: SourceState, steps: Go2rtcHealth[]) => steps.reduce((acc, h) => nextSourceState(acc, h, T), s);
const every5s = (from: number, to: number, f: (t: number) => Go2rtcHealth) => { const o = []; for (let t = from; t <= to; t += 5000) o.push(f(t)); return o; };

test("a short go2rtc blip (a reload) doesn't switch", () => {
  const s = run(boot, [up(5000), down(10_000), down(15_000), up(20_000)]);
  assert.equal(s.mode, "go2rtc");
});

test("down for 15 s switches to direct, with the reason and when it went down", () => {
  const s = run(boot, [up(5000), ...every5s(10_000, 25_000, down)]);
  assert.equal(s.mode, "direct");
  assert.equal(s.downSince, 10_000);
  assert.match(s.reason!, /backoff/);
});

test("comes back only after 60 s healthy AND 2 min in direct", () => {
  let s = run(boot, [up(5000), ...every5s(10_000, 25_000, down)]);            // direct since 25 s
  s = run(s, every5s(30_000, 100_000, up));                                     // healthy since 30 s
  assert.equal(s.mode, "direct", "healthy 70 s but only 75 s in direct");
  assert.equal(s.returnAt, 145_000);
  s = run(s, every5s(105_000, 145_000, up));
  assert.equal(s.mode, "go2rtc");
});

test("a crash-looping go2rtc (up 30 s, down 5 s) stays direct", () => {
  let s = run(boot, [up(5000), ...every5s(10_000, 25_000, down)]);
  for (let t = 30_000; t < 600_000; t += 35_000) s = run(s, [...every5s(t, t + 25_000, up), down(t + 30_000)]);
  assert.equal(s.mode, "direct");
});

test("never healthy after boot: direct 15 s in", () => {
  assert.equal(run(boot, every5s(5000, 15_000, down)).mode, "direct");
});

test("off mode never changes, and the selector always picks the camera", () => {
  const sel = new SourceSelector({ rtspPort: null, offReason: "go2rtc is switched off in this instance (UNSCRYPTED_GO2RTC=off)", log: new Logger("t"), now: () => 0 });
  sel.update(up(1));
  assert.equal(sel.state().mode, "off");
  sel.setCameras([{ name: "Cam", rtspSub: undefined }]);
  assert.deepEqual(sel.picker({ name: "Cam", rtspMain: "rtsp://u:p@h/11" })("main"), { url: "rtsp://u:p@h/11", via: "camera" });
});

test("picker: restream in go2rtc mode, camera in direct mode, null for a missing sub; listeners hear switches", () => {
  let now = 0;
  const sel = new SourceSelector({ rtspPort: 8554, log: new Logger("t"), now: () => now });
  sel.setCameras([{ name: "Garage Cam", rtspSub: "rtsp://u:p@h/12" }, { name: "NoSub" }]);
  const pick = sel.picker({ name: "Garage Cam", rtspMain: "rtsp://u:p@h/11", rtspSub: "rtsp://u:p@h/12" });
  assert.deepEqual(pick("main"), { url: "rtsp://127.0.0.1:8554/garage_cam", via: "go2rtc" });
  assert.deepEqual(pick("sub"), { url: "rtsp://127.0.0.1:8554/garage_cam_sub", via: "go2rtc" });
  assert.equal(sel.picker({ name: "NoSub", rtspMain: "rtsp://x/1" })("sub"), null);
  let heard = 0; sel.onChange(() => heard++);
  for (now = 5000; now <= 20_000; now += 5000) sel.update(down(now));
  assert.equal(heard, 1);
  assert.deepEqual(pick("main"), { url: "rtsp://u:p@h/11", via: "camera" });
});

test("status text says direct, why and since when, in plain words", () => {
  const s = run(boot, [up(5000), ...every5s(10_000, 25_000, down)]);
  const txt = sourceText(s, (ms) => `<${ms}>`);
  assert.match(txt, /^HomeKit is reading the cameras directly because go2rtc is down \(since <10000>\)/);
  assert.match(txt, /switches back on its own/);
  assert.match(sourceText({ ...boot, unhealthySince: null }, String), /through go2rtc/);
});
```

- [ ] **Step 2:** `npx tsx --test test/source.test.ts`. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement `src/source.ts`:**

```ts
/**
 * Where HomeKit's ffmpeg pipelines read a camera from (#16): go2rtc's loopback restream normally,
 * the camera itself while go2rtc is down. The switch has hysteresis so a crash-looping go2rtc
 * can't make HomeKit flap. Pure decision logic plus a small stateful wrapper; no I/O.
 */
import { Logger } from "./logger";
import { ResolvedCamera } from "./config";
import { restreamUrl, streamNames } from "./admin/go2rtcConfig";

export type FeedVia = "go2rtc" | "camera";
export type SourceMode = "go2rtc" | "direct" | "off";
export interface FeedChoice { url: string; via: FeedVia }
export type FeedPicker = (which: "main" | "sub") => FeedChoice | null;
export interface Go2rtcHealth { supervisor: string; apiOk: boolean; rtspOk: boolean; at: number; error: string | null }
export interface SourceState { mode: SourceMode; since: number; reason: string | null; downSince: number | null; healthySince: number | null; unhealthySince: number | null; returnAt: number | null }
export interface SourceTimings { downGraceMs: number; healthyForMs: number; minDirectMs: number }
export const DEFAULT_TIMINGS: SourceTimings = { downGraceMs: 15_000, healthyForMs: 60_000, minDirectMs: 120_000 };

export const isHealthy = (h: Go2rtcHealth) => h.supervisor === "running" && h.apiOk && h.rtspOk;

export function nextSourceState(s: SourceState, h: Go2rtcHealth, t: SourceTimings): SourceState {
  if (s.mode === "off") return s;
  const ok = isHealthy(h);
  const now = h.at;
  const healthySince = ok ? (s.healthySince ?? now) : null;
  const unhealthySince = ok ? null : (s.unhealthySince ?? now);
  if (s.mode === "go2rtc") {
    if (!ok && now - unhealthySince! >= t.downGraceMs) {
      return { mode: "direct", since: now, reason: h.error ?? "go2rtc isn't healthy", downSince: unhealthySince, healthySince, unhealthySince, returnAt: null };
    }
    return { ...s, healthySince, unhealthySince };
  }
  // direct
  if (!ok) return { ...s, reason: h.error ?? s.reason, healthySince, unhealthySince, returnAt: null };
  const returnAt = Math.max(healthySince! + t.healthyForMs, s.since + t.minDirectMs);
  if (now >= returnAt) return { mode: "go2rtc", since: now, reason: null, downSince: null, healthySince, unhealthySince: null, returnAt: null };
  return { ...s, healthySince, unhealthySince, returnAt };
}

/** Plain-words status line. `clock` formats a time (the admin UI swaps in the viewer's local time). */
export function sourceText(s: SourceState, clock: (ms: number) => string): string {
  if (s.mode === "off") {
    return `HomeKit reads the cameras directly: ${s.reason ?? "go2rtc is switched off in this instance"}. Each HomeKit stream is its own connection to the camera.`;
  }
  if (s.mode === "direct") {
    const back = s.returnAt
      ? `go2rtc is healthy again; HomeKit switches back to it at ${clock(s.returnAt)} if it stays healthy.`
      : "HomeKit switches back on its own once go2rtc has been healthy for a minute.";
    return `HomeKit is reading the cameras directly because go2rtc is down (since ${clock(s.downSince ?? s.since)}): ${s.reason}. Cameras may see an extra connection each until go2rtc is back. ${back}`;
  }
  return "HomeKit reads every camera through go2rtc: one connection per camera stream.";
}

export function directPicker(cam: Pick<ResolvedCamera, "rtspMain" | "rtspSub">): FeedPicker {
  return (which) => {
    const url = which === "main" ? cam.rtspMain : cam.rtspSub;
    return url ? { url, via: "camera" } : null;
  };
}

const dur = (ms: number) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`; };

export class SourceSelector {
  private st: SourceState;
  private names = new Map<string, { main: string; sub?: string }>();
  private readonly listeners = new Set<() => void>();
  private readonly timings: SourceTimings;
  private readonly now: () => number;

  constructor(private readonly o: { rtspPort: number | null; offReason?: string; log: Logger; timings?: SourceTimings; now?: () => number }) {
    this.timings = o.timings ?? DEFAULT_TIMINGS;
    this.now = o.now ?? Date.now;
    const t = this.now();
    this.st = o.rtspPort
      ? { mode: "go2rtc", since: t, reason: null, downSince: null, healthySince: null, unhealthySince: t, returnAt: null }
      : { mode: "off", since: t, reason: o.offReason ?? "go2rtc's RTSP restream is switched off in this instance", downSince: null, healthySince: null, unhealthySince: null, returnAt: null };
  }

  setCameras(cams: Pick<ResolvedCamera, "name" | "rtspSub">[]): void { this.names = streamNames(cams); }
  state(): SourceState { return { ...this.st }; }

  update(h: Go2rtcHealth): void {
    const prev = this.st;
    this.st = nextSourceState(prev, h, this.timings);
    if (prev.mode === this.st.mode) return;
    if (this.st.mode === "direct") {
      this.o.log.warn(`HomeKit now reads the cameras directly: go2rtc is down (${this.st.reason}) since ${new Date(this.st.downSince ?? this.st.since).toISOString()}. ` +
        `Cameras may see an extra connection each until it's back; HomeKit switches back on its own once go2rtc has been healthy for ${this.timings.healthyForMs / 1000} s.`);
    } else {
      this.o.log.info(`HomeKit is reading the cameras through go2rtc again (it was direct for ${dur(this.st.since - prev.since)}).`);
    }
    for (const cb of this.listeners) {
      try { cb(); } catch (err) { this.o.log.error(`a source-change listener threw (the others still ran): ${(err as Error).stack ?? err}`); }
    }
  }

  picker(cam: Pick<ResolvedCamera, "name" | "rtspMain" | "rtspSub">): FeedPicker {
    const direct = directPicker(cam);
    return (which) => {
      const d = direct(which);
      if (!d) return null;
      const n = this.names.get(cam.name);
      const stream = which === "main" ? n?.main : n?.sub;
      if (this.st.mode !== "go2rtc" || !this.o.rtspPort || !stream) return d;
      return { url: restreamUrl(this.o.rtspPort, stream), via: "go2rtc" };
    };
  }

  onChange(cb: () => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
}
```

- [ ] **Step 4:** `npx tsx --test test/source.test.ts`. Expected: PASS. Then `npm test`.
- [ ] **Step 5: Live-view startup measurement** on the pattern camera (test instance). It answers the latency question before HomeKit is involved:
  - `sudo docker exec unscrypted-test bash -c 'for u in rtsp://127.0.0.1:8654/pattern rtsp://127.0.0.1:8555/patterncam; do s=$(date +%s%N); ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i $u -frames:v 1 -f null -; echo "$u first frame after $(( ($(date +%s%N)-s)/1000000 )) ms"; done'`. Run it once with nothing else watching (go2rtc opens a fresh producer), and once while a selftest holds the producer open (a mid-GOP join).
  - Record the four numbers on #16. With a 2 s GOP, expect the mid-GOP join to take up to about 2 s.
- [ ] **Step 6: Commit** `feat: source selector with hysteresis for HomeKit's camera input (#16)`.

### Task 6: `Go2rtcWatcher`: health and per-stream feed state

**Files:**
- Create: `src/admin/go2rtcWatch.ts`, `test/admin/go2rtcWatch.test.ts`
- Modify: `src/admin/go2rtc.ts` (`Go2rtcClient.streams()`, producer-error capture, YAML-unchanged skip)

**Interfaces:**
- Consumes: `Go2rtcHealth` (Task 5), `Go2rtcClient`, `ChildStatus`.
- Produces:

```ts
export type FeedState = "streaming" | "starting" | "stalled" | "down" | "idle" | "unknown";
export interface FeedStatus { state: FeedState; since: number; reason: string | null; lastVideoAt: number | null; consumers: number }
export interface StreamSample { consumers: number; connected: boolean; bytes: number | null }
export function parseStreams(json: unknown): Map<string, StreamSample>;
export function nextFeed(prev: { feed: FeedStatus; bytes: number | null } | undefined, sample: StreamSample | undefined, now: number, go2rtcOk: boolean, lastError: string | null): { feed: FeedStatus; bytes: number | null };
export class Go2rtcWatcher {
  constructor(o: { client: Go2rtcClient; rtspPort: number | null; supervisor: () => ChildStatus; lastError: (stream: string) => string | null; known?: () => Set<string>; log: Logger; intervalMs?: number; onHealth: (h: Go2rtcHealth) => void });
  start(): void; stop(): void; tick(): Promise<void>;
  feeds(): Map<string, FeedStatus>;
  health(): Go2rtcHealth | null;
}
```

  In `go2rtc.ts`: `Go2rtcClient.streams(): Promise<unknown>`. `Go2rtcManager.producerError(maskedUrl: string): { error: string; at: number } | null`. `reload(cfg, opts?: { force?: boolean }): Promise<{ restarted: boolean }>`. Exported `producerErrorFromLine(line: string): { url: string; error: string } | null`.

- [ ] **Step 1: Write the failing tests** (`test/admin/go2rtcWatch.test.ts`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { AddressInfo } from "net";
import { parseStreams, nextFeed, Go2rtcWatcher } from "../../src/admin/go2rtcWatch";
import { Go2rtcClient, producerErrorFromLine } from "../../src/admin/go2rtc";
import { Logger, setLogLevel } from "../../src/logger";

setLogLevel("error");
// Shape seen on prod 0.3.0 (2026-10-20): connected producers carry remote_addr + bytes_recv, idle ones only a url.
const sample = (bytes: number | null, consumers = 1) => ({
  garagecamtest: { producers: [bytes === null ? { url: "rtsp://u:p@h/11" } : { url: "rtsp://u:p@h/11", remote_addr: "10.0.1.3:554", bytes_recv: bytes }],
    consumers: Array.from({ length: consumers }, () => ({ type: "webrtc" })) },
});

test("parseStreams keeps only counts and byte totals, never URLs", () => {
  const m = parseStreams(sample(1234, 2));
  assert.deepEqual(m.get("garagecamtest"), { consumers: 2, connected: true, bytes: 1234 });
  assert.ok(!JSON.stringify([...m]).includes("rtsp://"));
  assert.deepEqual(parseStreams(sample(null, 0)).get("garagecamtest"), { consumers: 0, connected: false, bytes: null });
  assert.equal(parseStreams("nonsense").size, 0);
});

test("feed states: streaming, stalled after 10 s without bytes, idle, starting then down with the reason", () => {
  let r = nextFeed(undefined, { consumers: 1, connected: true, bytes: 100 }, 0, true, null);
  r = nextFeed(r, { consumers: 1, connected: true, bytes: 200 }, 5000, true, null);
  assert.equal(r.feed.state, "streaming"); assert.equal(r.feed.lastVideoAt, 5000);
  r = nextFeed(r, { consumers: 1, connected: true, bytes: 200 }, 10_000, true, null);
  assert.equal(r.feed.state, "streaming", "5 s without new bytes is still streaming");
  r = nextFeed(r, { consumers: 1, connected: true, bytes: 200 }, 15_000, true, null);
  assert.equal(r.feed.state, "stalled"); assert.match(r.feed.reason!, /stopped sending video/);
  r = nextFeed(r, { consumers: 0, connected: false, bytes: null }, 20_000, true, null);
  assert.equal(r.feed.state, "idle"); assert.equal(r.feed.lastVideoAt, 5000);
  r = nextFeed(r, { consumers: 1, connected: false, bytes: null }, 25_000, true, "EOF");
  assert.equal(r.feed.state, "starting");
  r = nextFeed(r, { consumers: 1, connected: false, bytes: null }, 35_000, true, 'dial tcp 10.0.1.3:554: connect: connection refused');
  assert.equal(r.feed.state, "down"); assert.match(r.feed.reason!, /refused/); assert.equal(r.feed.since, 35_000);
  r = nextFeed(r, undefined, 40_000, false, null);
  assert.equal(r.feed.state, "unknown"); assert.match(r.feed.reason!, /go2rtc is down/);
});

test("producer error lines are parsed from masked go2rtc log lines", () => {
  const line = 'INF 19:24:21.191 WRN github.com/AlexxIT/go2rtc/internal/streams/producer.go:170 > error="read tcp 10.0.1.78:42954->10.0.1.3:554: i/o timeout" url=rtsp://admin:***@10.0.1.3:554/11#media=video';
  assert.deepEqual(producerErrorFromLine(line), { error: "read tcp 10.0.1.78:42954->10.0.1.3:554: i/o timeout", url: "rtsp://admin:***@10.0.1.3:554/11" });
  assert.equal(producerErrorFromLine("INF something else"), null);
});

test("watcher: healthy only when the supervisor runs, the API answers and the RTSP port accepts", async () => {
  const api = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(sample(10))); });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  const rtsp = http.createServer(); // any listener stands in for go2rtc's RTSP accept
  await new Promise<void>((r) => rtsp.listen(0, "127.0.0.1", () => r()));
  const seen: any[] = [];
  let state = "running";
  const w = new Go2rtcWatcher({ client: new Go2rtcClient(`http://127.0.0.1:${(api.address() as AddressInfo).port}`, 3000),
    rtspPort: (rtsp.address() as AddressInfo).port, supervisor: () => ({ state } as any), lastError: () => null,
    log: new Logger("t"), onHealth: (h) => seen.push(h) });
  try {
    await w.tick();
    assert.equal(seen.at(-1).apiOk && seen.at(-1).rtspOk && seen.at(-1).supervisor === "running", true);
    assert.equal(w.feeds().get("garagecamtest")!.state, "starting"); // first sample: no growth seen yet
    state = "backoff";
    await w.tick();
    assert.equal(seen.at(-1).supervisor, "backoff");
    assert.match(seen.at(-1).error, /isn't running/);
    rtsp.close();
    state = "running";
    await w.tick();
    assert.equal(seen.at(-1).rtspOk, false);
    assert.match(seen.at(-1).error, /RTSP/);
  } finally { api.close(); rtsp.close(); }
});
```

  In `test/admin/go2rtc.test.ts`, add a test that `reload` with an unchanged YAML resolves `{ restarted: false }` and doesn't restart (count `start()` calls through a fake `binary` that's a tiny node script, the way the existing manager tests do, or assert on `status().restarts`).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement `src/admin/go2rtcWatch.ts`:**

```ts
/**
 * Reads go2rtc's own state every few seconds, over loopback only, never a camera (#16):
 * health (supervisor running + API answers + RTSP port accepts) drives the HomeKit source
 * selector; /api/streams gives each stream's producer state, which replaces the TCP camera probes.
 */
import * as net from "net";
import { Logger } from "../logger";
import { ChildStatus } from "./supervisor";
import { Go2rtcClient, explainGo2rtcFailure } from "./go2rtc";
import { Go2rtcHealth } from "../source";

export type FeedState = "streaming" | "starting" | "stalled" | "down" | "idle" | "unknown";
export interface FeedStatus { state: FeedState; since: number; reason: string | null; lastVideoAt: number | null; consumers: number }
export interface StreamSample { consumers: number; connected: boolean; bytes: number | null }

const STALL_MS = 10_000;
const DOWN_MS = 10_000;

export function parseStreams(json: unknown): Map<string, StreamSample> {
  const out = new Map<string, StreamSample>();
  if (!json || typeof json !== "object") return out;
  for (const [name, s] of Object.entries(json as Record<string, any>)) {
    const prods: any[] = Array.isArray(s?.producers) ? s.producers : [];
    const live = prods.find((p) => typeof p?.remote_addr === "string" || typeof p?.bytes_recv === "number");
    out.set(name, { consumers: Array.isArray(s?.consumers) ? s.consumers.length : 0, connected: Boolean(live),
      bytes: typeof live?.bytes_recv === "number" ? live.bytes_recv : null });
  }
  return out;
}

export function nextFeed(prev: { feed: FeedStatus; bytes: number | null } | undefined, sample: StreamSample | undefined,
  now: number, go2rtcOk: boolean, lastError: string | null): { feed: FeedStatus; bytes: number | null } {
  const lastVideoAt = prev?.feed.lastVideoAt ?? null;
  const mk = (state: FeedState, reason: string | null, extra: Partial<FeedStatus> = {}, bytes: number | null = null) => ({
    feed: { state, reason, lastVideoAt, consumers: sample?.consumers ?? 0, since: prev && prev.feed.state === state ? prev.feed.since : now, ...extra },
    bytes,
  });
  if (!go2rtcOk) return mk("unknown", "go2rtc is down, so the camera's state can't be read");
  if (!sample) return mk("unknown", "go2rtc doesn't know this stream yet (a config change may still be loading)");
  if (sample.consumers === 0) return mk("idle", null);
  if (sample.connected) {
    const grew = sample.bytes !== null && prev?.bytes !== null && prev?.bytes !== undefined && sample.bytes > prev.bytes;
    if (grew) return mk("streaming", null, { lastVideoAt: now }, sample.bytes);
    const quietFor = now - (lastVideoAt ?? prev?.feed.since ?? now);
    if (prev?.feed.state === "streaming" && quietFor < STALL_MS) return { feed: { ...prev.feed, consumers: sample.consumers }, bytes: sample.bytes };
    if (!prev || prev.bytes === null || prev.feed.state === "starting") return mk("starting", null, {}, sample.bytes);
    return mk("stalled", "The camera is connected but stopped sending video", {}, sample.bytes);
  }
  const waiting = prev && (prev.feed.state === "starting" || prev.feed.state === "down") ? prev.feed.since : now;
  if (now - waiting < DOWN_MS && prev?.feed.state !== "down") return { feed: { ...mk("starting", null).feed, since: waiting }, bytes: null };
  const why = lastError ? explainGo2rtcFailure(lastError).happened : "no error reported yet";
  return mk("down", `go2rtc can't get video from the camera: ${why}`);
}

const tcpOk = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port, timeout: 1000 });
  const done = (ok: boolean) => { s.destroy(); resolve(ok); };
  s.once("connect", () => done(true)); s.once("timeout", () => done(false)); s.once("error", () => done(false));
});

export class Go2rtcWatcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private last: Go2rtcHealth | null = null;
  private readonly state = new Map<string, { feed: FeedStatus; bytes: number | null }>();

  constructor(private readonly o: { client: Go2rtcClient; rtspPort: number | null; supervisor: () => ChildStatus;
    lastError: (stream: string) => string | null; known?: () => Set<string>; log: Logger; intervalMs?: number; onHealth: (h: Go2rtcHealth) => void }) {}

  start(): void { if (!this.timer) { this.timer = setInterval(() => void this.tick(), this.o.intervalMs ?? 5000); void this.tick(); } }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  health(): Go2rtcHealth | null { return this.last; }
  feeds(): Map<string, FeedStatus> { return new Map([...this.state].map(([k, v]) => [k, v.feed])); }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const now = Date.now();
    try {
      const sup = this.o.supervisor();
      let streams: Map<string, StreamSample> | null = null;
      let error: string | null = null;
      if (sup.state !== "running") error = `go2rtc isn't running (${sup.state}${sup.lastError ? `: ${sup.lastError}` : ""})`;
      try { streams = parseStreams(await this.o.client.streams()); }
      catch (err) { error ??= `go2rtc's API didn't answer: ${(err as Error).message}`; }
      const rtspOk = this.o.rtspPort ? await tcpOk(this.o.rtspPort) : false;
      if (this.o.rtspPort && !rtspOk) error ??= `go2rtc's RTSP restream isn't accepting connections on 127.0.0.1:${this.o.rtspPort}`;
      const h: Go2rtcHealth = { supervisor: sup.state, apiOk: streams !== null, rtspOk, at: now, error };
      const ok = h.supervisor === "running" && h.apiOk;
      const names = new Set([...(streams?.keys() ?? []), ...this.state.keys()]);
      for (const n of names) {
        if (n.startsWith("check_")) continue;   // feed-check temp streams aren't cameras
        this.state.set(n, nextFeed(this.state.get(n), streams?.get(n), now, ok, this.o.lastError(n)));
      }
      const known = this.o.known?.();
      if (known) for (const k of [...this.state.keys()]) if (!known.has(k) && !streams?.has(k)) this.state.delete(k);
      this.last = h;
      this.o.onHealth(h);
    } catch (err) {
      this.o.log.error(`go2rtc health check failed unexpectedly (HomeKit keeps its current source): ${(err as Error).stack ?? err}`);
    } finally {
      this.busy = false;
    }
  }
}
```

  Streams that leave go2rtc's config disappear from `/api/streams`. Drop any `state` key absent from **both** the latest `/api/streams` and the bridge's current stream names: give `tick` an optional `known: () => Set<string>` in the options, and delete the keys outside it after each tick. Add one test line for that.
- [ ] **Step 4: Extend `src/admin/go2rtc.ts`:**

```ts
const PRODUCER_ERR = /producer\.go:\d+ > error=("[^"]*"|\S+) url=(\S+)/;
/** go2rtc's "can't get video" log line, already masked by maskSecretsInLine. */
export function producerErrorFromLine(line: string): { url: string; error: string } | null {
  const m = PRODUCER_ERR.exec(line);
  return m ? { error: m[1].replace(/^"|"$/g, ""), url: m[2].replace(/#.*$/, "") } : null;
}
```

  - In the manager's `pipe`, after masking: `const pe = producerErrorFromLine(masked); if (pe) this.producerErrors.set(pe.url, { error: pe.error, at: Date.now() });`.
  - Add `producerError(maskedUrl)`, which returns the entry only if it's under 60 s old.
  - `writeYaml` returns `changed: boolean` (compare against `this.lastYaml`).
  - `reload(cfg, { force })` skips the stop/start when `!changed && !force && this.sup.status().state === "running"`, and returns `{ restarted }`.
  - `Go2rtcClient.streams()`: `const r = await this.req("GET", "/api/streams"); if (r.status !== 200) throw new Error(\`HTTP ${r.status}\`); return JSON.parse(r.body.toString());`.
  - Update the header comment: go2rtc is now in HomeKit's path, with the fallback described in `src/source.ts`.
- [ ] **Step 5:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(go2rtc): watcher for health and per-stream feed state from /api/streams (#16)`.

### Task 7: The bridge drives the selector and the HomeKit pipelines read through it

**Files:**
- Modify: `src/index.ts`, `src/camera.ts`, `src/prebuffer.ts`, `src/recordingDelegate.ts`, `src/bridgeRuntime.ts`
- Test: `test/admin/bridgeRuntime.test.ts`, `test/camera.test.ts` (create)

**Interfaces:**
- Consumes: `SourceSelector`, `FeedPicker`, `directPicker` (Task 5), `Go2rtcWatcher` (Task 6), `buildPrebufferArgs` (Task 4).
- Produces:
  - `new UnscryptedCamera(camera, ffmpegPath, log, sources?: SourceSelector)`
  - `UnscryptedCamera.startPrebufferForTest(): boolean`
  - `snapshotStatus().prebuffer: PrebufferStatus | null`
  - `interface PrebufferStatus { running: boolean; via: FeedVia | null; lastFragmentAt: number | null }`
  - `Prebuffer.restart()`, `Prebuffer.currentVia()`, `Prebuffer.status()`
  - `RecordingDelegate.activeClips(): number`
  - `RuntimeOptions.sources?: SourceSelector`

- [ ] **Step 1: Write the failing tests.** `test/camera.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { UnscryptedCamera } from "../src/camera";
import { SourceSelector } from "../src/source";
import { Logger, setLogLevel } from "../src/logger";

setLogLevel("error");
const cam = () => ({ name: "Garage", rtspMain: "rtsp://u:p@10.0.1.3:554/11", rtspSub: "rtsp://u:p@10.0.1.3:554/12", hksv: true,
  prebufferSeconds: 4, maxRecordingSeconds: 60, copyVideo: true, audio: false, manufacturer: "x", model: "y", serialNumber: "z" }) as any;

test("a running prebuffer re-points when the source mode flips, but waits for an active clip", () => {
  let now = 0;
  const sel = new SourceSelector({ rtspPort: 8554, log: new Logger("t"), now: () => now });
  const c = cam(); sel.setCameras([c]);
  const ucam = new UnscryptedCamera(c, "ffmpeg-not-run", new Logger("t"), sel);
  const pb = (ucam as any).prebuffer;
  let restarts = 0;
  pb.isRunning = () => true; pb.currentVia = () => "go2rtc"; pb.restart = () => { restarts++; };
  const rec = (ucam as any).recordingDelegate; let clips = 1; rec.activeClips = () => clips;
  for (now = 5000; now <= 20_000; now += 5000) sel.update({ supervisor: "backoff", apiOk: false, rtspOk: false, at: now, error: "down" });
  assert.equal(restarts, 0, "a clip is recording: wait");
  clips = 0;
  (ucam as any).syncPrebufferSource();
  assert.equal(restarts, 1);
  ucam.shutdown();
});
```

  In `test/admin/bridgeRuntime.test.ts`: remove the `probeRtsp` import and its tests. Add a test that `status().cameras[0]` has `via: "camera"` and `feed: null` when go2rtc is disabled, and that `status().homekitSource.mode === "off"`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: `src/recordingDelegate.ts`:** add `activeClips(): number { return this.closeSignals.size; }`.
- [ ] **Step 4: `src/prebuffer.ts`:**
  - The constructor gets a 4th param `private readonly pick: FeedPicker = directPicker(camera)`.
  - Add `private via: FeedVia | null = null; private lastFragmentAt: number | null = null;`.
  - In `spawn`: `const feed = this.pick("main"); if (!feed) { this.log.error("prebuffer has no main stream URL; recording won't work for this camera until config.json gives one"); return; }`, then `const args = buildPrebufferArgs(this.camera, feed.url); this.via = feed.via;`. Make the start log line `prebuffer running (${secs}s window, video ${copy|transcode}, reading ${feed.via === "go2rtc" ? "through go2rtc" : "the camera directly"})`.
  - In `onFragment`, set `this.lastFragmentAt = now`. Clear `via` in `stop()` and on exit.
  - Add:

```ts
  currentVia(): FeedVia | null { return this.ffmpeg ? this.via : null; }
  status(): { running: boolean; via: FeedVia | null; lastFragmentAt: number | null } {
    return { running: this.ffmpeg !== null, via: this.currentVia(), lastFragmentAt: this.lastFragmentAt };
  }
  /** Stop and start again now (picks the current source). No-op unless it should be running. */
  restart(): void {
    if (!this.wantRunning) return;
    this.stop();
    void this.start();
  }
```

  Delete `private buildArgs`.
- [ ] **Step 5: `src/camera.ts`:**
  - The constructor gets `sources?: SourceSelector`, and sets `this.pick = sources ? sources.picker(camera) : directPicker(camera)`. The picker closes over the same `camera` object that `reconfigure` mutates, so URL edits apply on the next spawn.
  - Pass `this.pick` to `new Prebuffer(camera, ffmpegPath, log.child("prebuffer"), this.pick)` and `new StreamingDelegate(camera, ffmpegPath, log.child("stream"), this.pick)`. Task 8 adds the StreamingDelegate param, so until then pass it and add the param as unused.
  - Subscribe with `this.offSource = sources?.onChange(() => this.syncPrebufferSource())`.
  - Add:

```ts
  private syncTimer: NodeJS.Timeout | null = null;
  private syncPrebufferSource(): void {
    const pb = this.prebuffer;
    if (!pb?.isRunning()) return;
    const want = this.pick("main")?.via;
    if (!want || want === pb.currentVia()) return;
    const where = want === "go2rtc" ? "go2rtc" : "the camera directly";
    if ((this.recordingDelegate?.activeClips() ?? 0) > 0) {
      if (!this.syncTimer) {
        this.log.info(`recording buffer will switch to reading ${where} as soon as the clip being recorded ends`);
        this.syncTimer = setInterval(() => {
          if ((this.recordingDelegate?.activeClips() ?? 0) === 0) { clearInterval(this.syncTimer!); this.syncTimer = null; this.syncPrebufferSource(); }
        }, 2000);
      }
      return;
    }
    this.log.info(`recording buffer switching to reading ${where} (the next few seconds of pre-roll are lost)`);
    pb.restart();
  }

  /** Test instance only (HomeKit off): run the recording buffer without HomeKit asking, to check the restream. */
  startPrebufferForTest(): boolean {
    if (!this.prebuffer) return false;
    void this.prebuffer.start();
    return true;
  }
```

  - In `snapshotStatus()`, add `prebuffer: this.prebuffer?.status() ?? null`.
  - In `shutdown()`, add `this.offSource?.(); if (this.syncTimer) clearInterval(this.syncTimer);`.
- [ ] **Step 6: `src/index.ts`.** Build the selector **before the camera loop**:

```ts
  const sources = new SourceSelector({
    rtspPort, log: log.child("source"),
    offReason: !go2rtcEnabled ? "go2rtc is switched off in this instance (UNSCRYPTED_GO2RTC=off)"
      : process.env.UNSCRYPTED_GO2RTC_RTSP === "off" ? "go2rtc's RTSP restream is switched off (UNSCRYPTED_GO2RTC_RTSP=off)"
      : go2rtcRtsp.error ?? undefined,
  });
  sources.setCameras(config.cameras);
```

  - Construct cameras with `new UnscryptedCamera(camConfig, config.ffmpegPath, log, sources)`, and pass `sources` to `BridgeRuntime`.
  - In the HAP-off branch, after the warning:

```ts
    const want = (process.env.UNSCRYPTED_TEST_PREBUFFER ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (want.length) {
      const started = cameras.filter((c) => (want.includes("all") || want.includes(c.name)) && c.startPrebufferForTest()).map((c) => c.name);
      const missing = want.filter((n) => n !== "all" && !started.includes(n));
      log.warn(`test instance: recording buffer started without HomeKit for ${started.join(", ") || "no camera"} (UNSCRYPTED_TEST_PREBUFFER), to check the go2rtc restream` +
        (missing.length ? `; not started for ${missing.join(", ")} (no such camera, or HKSV is off for it)` : ""));
    }
```

  `UNSCRYPTED_TEST_PREBUFFER` is ignored with HAP on. Add one line at startup: if it's set while HAP is on, `log.warn("UNSCRYPTED_TEST_PREBUFFER is ignored: HomeKit is on, and HomeKit decides when recording buffers run")`.
- [ ] **Step 7: `src/bridgeRuntime.ts`:**
  - `RuntimeOptions.sources?: SourceSelector`. In the constructor: `this.sources = o.sources ?? new SourceSelector({ rtspPort: null, log: o.log, offReason: "no source selector was given" }); this.sources.setCameras(o.config.cameras);`.
  - In `start()`, once `this.go2rtc` exists:

```ts
      const masked = () => new Map(this.config.cameras.flatMap((c) => {
        const n = streamNames(this.config.cameras).get(c.name)!;
        const m: [string, string][] = [[n.main, maskSecretsInLine(c.rtspMain)]];
        if (n.sub && c.rtspSub) m.push([n.sub, maskSecretsInLine(c.rtspSub)]);
        return m;
      }));
      this.watcher = new Go2rtcWatcher({
        client: new Go2rtcClient(this.go2rtc.apiBase(), 3000), rtspPort: g.rtspPort,
        supervisor: () => this.go2rtcStatus(), log: log.child("go2rtc-watch"),
        lastError: (stream) => { const u = masked().get(stream); return u ? this.go2rtc?.producerError(u)?.error ?? null : null; },
        known: () => new Set([...streamNames(this.config.cameras).values()].flatMap((n) => [n.main, ...(n.sub ? [n.sub] : [])])),
        onHealth: (h) => { this.sources.update(h); },
      });
      this.watcher.start();
```

  - **Delete** `probeAll`, `probing`, `reach`, the `setInterval(() => void this.probeAll(), 30_000)`, the initial `void this.probeAll()`, the exported `probeRtsp`, and the `net` import.
  - In `applyCamera`, after `this.config = {...}`: `this.sources.setCameras(this.config.cameras);`. Change the reload call to `const r = await this.go2rtc.reload(this.config);`, and when `r.restarted` add to `message`: ` go2rtc restarted to pick up the change, so every camera's recording buffer restarts (a few seconds of pre-roll are lost, and a clip being recorded right now is cut short).` (per Q4; if Q4 = (b), Task 16 replaces this).
  - The `reload-go2rtc` handler uses `reload(this.config, { force: true })` with the message `go2rtc restarted. HomeKit's recording buffers reconnect within about 5 s; a clip being recorded right now was cut short.`.
  - In `stop()`, `this.watcher?.stop()`.
- [ ] **Step 8:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 9: Live check on the test instance** (Task 2b; in the test compose override add `- UNSCRYPTED_TEST_PREBUFFER=PatternCam`):
  1. `sudo docker logs unscrypted-test 2>&1 | grep -E "PatternCam.*prebuffer running"` shows `reading through go2rtc`. `bash …/pattern-cam.sh status` shows **one** client.
  2. **Fallback drill:** `sudo docker exec unscrypted-test pkill -STOP -x go2rtc` (freezes go2rtc; the API times out). Within about 20 s the log has `HomeKit now reads the cameras directly…`, then `recording buffer switching to reading the camera directly`. `pattern-cam.sh status` shows the test **node/ffmpeg** as a client. The admin Status page at `:8191` shows the amber notice (after Task 9). Then `pkill -CONT -x go2rtc`. About 2 min after the switch the log has `…through go2rtc again (it was direct for 2m0s)`, the buffer re-points, and `status` shows one client again.
  3. **Crash loop:** in a scratch shell, run `for i in $(seq 1 10); do sudo docker exec unscrypted-test pkill -x go2rtc; sleep 20; done` (about 3 min). The log shows exactly **one** switch to direct and no flip-backs during the loop. It returns about 2 min after the loop ends.
  4. **Reload doesn't flip:** in the pane, save PatternCam2 with a changed URL path. The log shows a go2rtc restart and **no** "now reads the cameras directly".
- [ ] **Step 10: Commit** `feat: HomeKit's recording buffer reads through go2rtc, with a health-checked fallback (#16)`.

### Task 8: Live view and snapshots through the selector

**Files:** Modify `src/streamingDelegate.ts`. Test: `test/streamingDelegate.test.ts` (create).

**Interfaces:**
- Consumes: `FeedPicker`.
- Produces: `StreamingDelegate(camera, ffmpegPath, log, pick?: FeedPicker)`. Exported pure builders `buildLiveInputArgs(feed: FeedChoice): string[]` and `buildSnapshotArgs(feed: FeedChoice, width: number, height: number): string[]` (so the input change is testable without HomeKit).

- [ ] **Step 1: Write the failing test:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLiveInputArgs, buildSnapshotArgs } from "../src/streamingDelegate";

test("live view and snapshot read the chosen feed over TCP with a socket timeout", () => {
  const f = { url: "rtsp://127.0.0.1:8554/garagecamtest", via: "go2rtc" as const };
  assert.deepEqual(buildLiveInputArgs(f), ["-hide_banner", "-loglevel", "warning", "-rtsp_transport", "tcp", "-timeout", "10000000", "-i", f.url]);
  const s = buildSnapshotArgs(f, 640, 360);
  assert.equal(s[s.indexOf("-i") + 1], f.url);
  assert.ok(s.includes("scale=640:360:force_original_aspect_ratio=decrease"));
});
```

- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Export `buildLiveInputArgs` (the first nine args of today's live view, plus `-timeout 10000000` before `-i`) and `buildSnapshotArgs` (today's snapshot args with `-timeout 10000000` added and the chosen URL).
  - In `startStream`: `const feed = this.pick("main"); if (!feed) { callback(new Error("no main stream URL configured")); return; }`, then `const args = [...buildLiveInputArgs(feed)];`, followed by the unchanged video/audio/SRTP args. The start log line becomes `live stream started for ${name} (reading ${feed.via === "go2rtc" ? "through go2rtc" : "the camera directly"})`.
  - Snapshots, per Q1 (a): `const feed = this.pick("main")!`. While the main producer is already open (recording cameras), that's **no new camera connection**. Add a 10 s cache and single-flight keyed by `${width}x${height}`:

```ts
  private snapCache = new Map<string, { at: number; buf: Buffer }>();
  private snapInflight = new Map<string, Promise<Buffer>>();
  private async takeSnapshot(request: SnapshotRequest): Promise<Buffer> {
    const key = `${request.width}x${request.height}`;
    const hit = this.snapCache.get(key);
    if (hit && Date.now() - hit.at < 10_000) return hit.buf;
    const running = this.snapInflight.get(key);
    if (running) return running;
    const p = this.snapshotNow(request).then((buf) => { this.snapCache.set(key, { at: Date.now(), buf }); return buf; })
      .finally(() => this.snapInflight.delete(key));
    this.snapInflight.set(key, p);
    return p;
  }
```

  `snapshotNow` is today's `takeSnapshot` body with `buildSnapshotArgs(this.pick("main")!, …)`. A failure isn't cached: the next request tries again, and the existing `snapshot failed:` warning still logs. **If Q1 = (b)** (after Task 15 passes for that model): use `this.pick("sub") ?? this.pick("main")!`. **If Q1 = (c):** use `directPicker(this.camera)("sub") ?? directPicker(this.camera)("main")!` and drop the cache.
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Live check (test instance):** with HAP off there's no HomeKit live view. Check the snapshot path by running the exact args: `sudo docker exec unscrypted-test node -e "const {buildSnapshotArgs}=require('/app/dist/streamingDelegate');console.log(buildSnapshotArgs({url:'rtsp://127.0.0.1:8555/patterncam',via:'go2rtc'},640,360).join(' '))"`. Then run ffmpeg with those args, saving to `/tmp/s.jpg` inside the container, and check that `ls -l /tmp/s.jpg` is > 5 KB. `pattern-cam.sh status`: still one client.
- [ ] **Step 6: Commit** `feat: live view and snapshots read through go2rtc (snapshot cache 10 s) (#16)`.

---

## Phase 4: Status from go2rtc, no more probes (check: the test dash and pane show feed state with zero TCP probes; on prod later, TIME-WAIT drops to about 0)

### Task 9: The admin Status page shows feed state and the HomeKit source

**Files:**
- Modify: `src/admin/ipc.ts`, `src/bridgeRuntime.ts` (`status()`), `src/admin/server.ts` (`statusNotices`), `web/admin/app.js` (`reachText` → `feedText`, the notice time tokens)
- Test: `test/admin/bridgeRuntime.test.ts`, `test/admin/server.test.ts`

**Interfaces:**
- Produces, in `ipc.ts`:

```ts
import { FeedStatus } from "./go2rtcWatch";
import { FeedVia, SourceState } from "../source";
export interface CameraStatus {
  name: string; stream: string; hksv: boolean; motionKind: MotionKind;
  feed: FeedStatus | null; subFeed: FeedStatus | null; via: FeedVia;
  prebuffer: { running: boolean; via: FeedVia | null; lastFragmentAt: number | null } | null;
  liveSessions: number; recordingActive: boolean; motionActive: boolean; lastMotionAt: number | null;
  pendingRestart: boolean;
}
export interface BridgeStatus { /* existing fields */ homekitSource: SourceState & { text: string } }
```

  (`reachable`, `reachableCheckedAt` and `reachError` are removed.)

- [ ] **Step 1: Write the failing tests.**
  - `bridgeRuntime.test.ts`: with the default (off) selector, `status().homekitSource.text` matches `/HomeKit reads the cameras directly/`, and `cameras[0]` has no `reachable` key.
  - `server.test.ts`: when the fake bridge status has `homekitSource.mode = "direct"`, `GET /api/status` → `notices` contains a string matching `/HomeKit is reading the cameras directly because go2rtc is down \(since \{\{t:\d+\}\}\)/`. When the mode is `"go2rtc"`, no such notice appears.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `status()` fills `feed: this.watcher?.feeds().get(n.main) ?? null`, `subFeed`, `via: this.sources.picker(rc)("main")?.via ?? "camera"`, `prebuffer: s?.prebuffer ?? null`, and `homekitSource: { ...this.sources.state(), text: sourceText(this.sources.state(), (ms) => \`{{t:${ms}}}\`) }`.
  - `statusNotices` pushes `s.homekitSource.text` when `s.homekitSource.mode !== "go2rtc"`.
  - Change the existing go2rtc-not-running notice to: `go2rtc is ${state}…: snapshots in the pane, feed checks, live previews and the dashboard's video are unavailable. HomeKit falls back to reading the cameras directly after 15 s (see the line above).` (It no longer says "HomeKit is unaffected", which isn't true any more.)
- [ ] **Step 4: `web/admin/app.js`:**
  - Add `const localTimes = (s) => s.replace(/\{\{t:(\d+)\}\}/g, (_, ms) => new Date(Number(ms)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));` and wrap the notice text in `msgBox("amber", localTimes(n))` (line ~556).
  - Replace `reachText` with:

```js
const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function feedText(f) {
  if (!f) return el("span", { class: "muted" }, "unknown: go2rtc isn't running, so the camera's state can't be read");
  switch (f.state) {
    case "streaming": return el("span", { class: "good" }, `video flowing (${f.consumers} viewer${f.consumers === 1 ? "" : "s"} through go2rtc)`);
    case "starting": return el("span", { class: "muted" }, "connecting…");
    case "idle": return el("span", { class: "muted" }, f.lastVideoAt ? `idle: nobody is watching (last video ${t(f.lastVideoAt)})` : "idle: nobody has watched it since the bridge started");
    case "stalled": case "down": return el("span", { class: "badtext" }, `${f.reason} (since ${t(f.since)})`);
    default: return el("span", { class: "muted" }, f.reason || "unknown");
  }
}
const viaText = (v) => (v === "go2rtc" ? "through go2rtc" : "the camera directly");
```

  - Replace `add("Network", reachText(s))` with `add("Video", feedText(s.feed))`, plus `if (s.subFeed) add("Sub stream", feedText(s.subFeed))`, `add("HomeKit reads", viaText(s.via))`, and:

```js
    if (s.prebuffer) add("Recording buffer", s.prebuffer.running
      ? `running, reading ${viaText(s.prebuffer.via)}${s.prebuffer.lastFragmentAt ? `, last fragment ${Math.round((Date.now() - s.prebuffer.lastFragmentAt) / 1000)} s ago` : ", no video yet"}`
      : "off (HomeKit hasn't turned recording on)");
```

  - In the status section's header area, add a quiet line `el("p", { class: "muted" }, localTimes(s.homekitSource.text))` when the mode is `"go2rtc"`.
- [ ] **Step 5:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(admin): Status shows go2rtc feed state and where HomeKit reads from, in plain words (#16)`.

### Task 10: The dashboard takes feed state from the bridge and stops probing

**Files:**
- Modify: `src/dash/ipc.ts`, `src/dash/runtime.ts`, `src/dash/main.ts`, `src/bridgeRuntime.ts` (`pushDash`), `web/dash/app.js` (`render`)
- Test: `test/dash/ipc.test.ts`, `test/dash/runtime.test.ts`

**Interfaces:**
- Produces:
  - `interface DashCamera { name: string; main: string; sub: string | null }` (`probe` is removed)
  - `interface DashFeed { state: FeedState; up: boolean; reason: string | null; since: number }`
  - the `ToDash` union adds `{ type: "feeds"; feeds: Record<string, DashFeed> }`
  - `DashRuntime.setFeeds(f: Record<string, DashFeed>)`
  - exported pure `dashFeed(f: FeedStatus | undefined, go2rtcOk: boolean): DashFeed`, in `src/dash/ipc.ts`

- [ ] **Step 1: Write the failing tests.**
  - `test/dash/ipc.test.ts`: change the `dashCameras` expectation to `{ name, main, sub }` with **no** `probe` key, and assert `!JSON.stringify(out).includes("10.0.1.")`.
  - Add a test for `dashFeed`:

```ts
test("dash feed reasons are plain and never carry an address", () => {
  const down = dashFeed({ state: "down", since: 5, reason: "go2rtc can't get video from the camera: dial tcp 10.0.1.3:554: connect: connection refused", lastVideoAt: null, consumers: 1 }, true);
  assert.deepEqual(down, { state: "down", up: false, reason: "Camera not sending video: go2rtc can't connect to it", since: 5 });
  assert.equal(dashFeed({ state: "idle", since: 1, reason: null, lastVideoAt: null, consumers: 0 }, true).up, true, "idle tiles must start playing");
  assert.equal(dashFeed(undefined, false).state, "unknown");
  assert.equal(checkToDash({ type: "feeds", feeds: {} }).type, "feeds");
});
```

  - `test/dash/runtime.test.ts`: replace the probe tests with one that `rt.setFeeds({ dogcamtest: {...} })` shows in `state().cameras.dogcamtest`, that a tile using `stream: "sub"` reads `feeds[cam.sub]`, and that a shown camera with no feed entry reads `{ state: "unknown", up: true, reason: null }`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `dashFeed`:

```ts
const DASH_REASON: Record<string, string> = {
  down: "Camera not sending video: go2rtc can't connect to it",
  stalled: "Camera connected but stopped sending video",
};
export function dashFeed(f: FeedStatus | undefined, go2rtcOk: boolean): DashFeed {
  if (!f || !go2rtcOk) return { state: "unknown", up: true, reason: null, since: f?.since ?? Date.now() };
  const bad = f.state === "down" || f.state === "stalled";
  return { state: f.state, up: !bad, reason: bad ? DASH_REASON[f.state] : null, since: f.since };
}
```

  (Fixed strings: nothing from go2rtc's log, so no address can leak into the open dash.)
  - `DashRuntime`: delete `probeCameras` and the `tcpProbe` import (keep `ServiceWatcher`, `LightNode`). Keep `private feeds: Record<string, DashFeed> = {}` with `setFeeds()`. In `state()`, use `cameras: Object.fromEntries(this.shown().map((x) => [x.cam.main, this.feeds[x.stream] ?? { state: "unknown", up: true, reason: null, since: Date.now() }]))`.
  - `main.ts`: delete `probeLoop` and its timer. In the message handler, add `else if (m.type === "feeds") rt.setFeeds(m.feeds);`.
  - `bridgeRuntime.pushDash`: add `msgs.push({ type: "feeds", feeds: Object.fromEntries([...allowedStreams].map((s) => [s, dashFeed(this.watcher?.feeds().get(s), ok)])) })`, where `ok` = the watcher's last health being healthy.
  - `web/dash/app.js` `render(t)`: replace the `if (!st) … else if (!st.up) { stopStream(t); … }` branches with:

```js
  if (!st) {
    if (!t.el) startStream(t);
    why = "Checking the camera…"; badge = "checking…";
  } else if (!st.up) {
    // Keep the player: it is go2rtc's only reason to keep retrying this camera (one client, about every 15 s).
    if (!t.el) startStream(t);
    why = `${st.reason || "Camera not sending video"} since ${clockTime(st.since)}.`;
    badge = "offline";
  } else {
```

  The `else` branch stays as it is (it already starts the stream and handles "video server restarting" and "no picture in 15 s").
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: PASS. Also `grep -rn "probeCameras\|probeRtsp\|tcpProbe(cam" src` → only `tcpProbe` in `src/dash/services.ts` (the service lights).
- [ ] **Step 5: Live check (test instance):** open `http://10.0.1.78:8181` with only the pattern cameras shown. The tiles play.
  - `sudo ss -tn state time-wait "( dport = :8654 )" | wc -l` stays at 0-1 over 2 minutes (no probes).
  - `bash pattern-cam.sh stop`: within about 15 s the tile says "Camera not sending video: go2rtc can't connect to it since …", and the pane shows `down` with the reason (connection refused).
  - `start` again: the tile recovers on its own within about 15-30 s.
- [ ] **Step 6: Commit** `feat(dash): camera status from go2rtc, TCP probes removed (#16)`.

### Task 11: The admin feed check reuses the configured stream

**Files:** Modify `src/admin/server.ts` (the `/api/cameras/check` handlers), `web/admin/app.js` (`checkFeed`). Test: `test/admin/server.test.ts`.

**Interfaces:**
- Produces: `POST /api/cameras/check` → `{ ok: true, reused: boolean, stream: string | null, frameUrl: "/api/cameras/check/<token>/frame.jpg", wsUrl: string | null }`. New `GET /api/cameras/check/<token>/frame.jpg` (signed in), which serves the in-memory JPEG for 5 min.

- [ ] **Step 1: Write the failing tests** (`server.test.ts`; the fake go2rtc there records `PUT`/`DELETE`/`GET` calls):
  - An unchanged existing camera (`{ name: "Garage", edit: {} }`) → `reused: true`, `stream: "garage"`, `wsUrl: "/go2rtc/api/ws?src=garage"`. The fake go2rtc saw **no PUT** and **no DELETE**, and one `GET /api/frame.jpeg?src=garage`.
  - An edited URL (`edit: { rtspMain: "rtsp://u:p@10.0.0.9/11" }`) → `reused: false`, `wsUrl: null`. The fake saw `PUT … name=check_…`, then `GET frame`, then `DELETE … src=check_…`, **all before the response**.
  - A new camera (`name` absent) behaves like the edited case.
  - `GET` on the returned `frameUrl` → 200 `image/jpeg` with the fake's bytes. An unknown token → 404 with the four-part error. Signed out → 401.
  - When the temp stream's frame fails, the temp stream is still deleted, and the error is the existing plain-words one.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement** in the `POST /api/cameras/check` handler, after `cam` is resolved:

```ts
        let current: ResolvedCamera | undefined;
        try { current = name ? resolvedCamera(readRawConfig(d.configPath), name) : undefined; } catch { current = undefined; /* stored config doesn't resolve: treat as edited */ }
        const unchanged = Boolean(current && current.rtspMain === cam.rtspMain && current.audio === cam.audio);
        const configured = unchanged ? streamNames(readRawConfig(d.configPath).cameras.map((c) => resolvedCamera(readRawConfig(d.configPath), c.name)!)).get(name!)?.main : undefined;
        const token = crypto.randomBytes(8).toString("hex");
        let jpeg: Buffer;
        if (configured && d.bridge.status()?.cameras.some((c) => c.stream === configured)) {
          // Same feed as the running camera: ask go2rtc for a frame from the stream it already has. No new camera session.
          try { jpeg = await g2.frame(configured); }
          catch (err) { const ex = explainGo2rtcFailure((err as Error).message); throw new UserError({ attempted, happened: ex.happened, changed: "Nothing was saved; this was only a test.", next: ex.next }, 502); }
          checkFrames.set(token, { jpeg, at: Date.now() });
          return json(res, 200, { ok: true, reused: true, stream: configured, frameUrl: `/api/cameras/check/${token}/frame.jpg`, wsUrl: `/go2rtc/api/ws?src=${configured}` });
        }
        // A new or edited address: one short test session, closed as soon as one frame arrives (the cameras tolerate ~one client).
        const stream = `check_${crypto.randomBytes(4).toString("hex")}`;
        try { await g2.addTempStream(stream, cam.rtspMain + sourceSuffix(cam)); }
        catch (err) { throw new UserError({ attempted, happened: `go2rtc wouldn't take the test stream: ${(err as Error).message}`, changed: "Nothing was saved; this was only a test.", next: "Try again; if it repeats, check `docker logs unscrypted` for go2rtc lines." }, 502); }
        try {
          jpeg = await g2.frame(stream);
        } catch (err) {
          const ex = explainGo2rtcFailure((err as Error).message);
          throw new UserError({ attempted, happened: ex.happened, changed: "Nothing was saved; this was only a test. The test connection was closed.", next: ex.next }, 502);
        } finally {
          await g2.removeStream(stream).catch((err) => log.warn(`couldn't remove feed-check stream ${stream} from go2rtc (it holds one extra camera session until go2rtc restarts): ${(err as Error).message}`));
        }
        checkFrames.set(token, { jpeg, at: Date.now() });
        return json(res, 200, { ok: true, reused: false, stream: null, frameUrl: `/api/cameras/check/${token}/frame.jpg`, wsUrl: null });
```

  - Simplify the `configured` lookup by computing `const raw = readRawConfig(d.configPath)` once and using the same `streamNames(...)` call `GET /api/cameras` uses. **Don't read the file three times.** Above, the shape is shown, not the final form.
  - `checkFrames` is a `Map<string, { jpeg: Buffer; at: number }>`. A 60 s interval (`unref`) prunes entries older than 5 min, and the map is capped at 20 entries (oldest out).
  - Add the GET route `^/api/cameras/check/([0-9a-f]{16})/frame\.jpg$`. It goes behind the same auth as the other `/api/` routes, answers with `content-type: image/jpeg` and `cache-control: no-store`, and returns a 404 `UserError` "That test frame has expired (they're kept 5 minutes). Run the check again." for an unknown token.
  - The `tempStreams` map and its 5-minute timer are no longer needed: delete them. `DELETE /api/cameras/check/:stream` stays, returning `{ ok: true, message: "Nothing to close: feed checks close their test connection right away." }` (old pages may still call it).
- [ ] **Step 4: `web/admin/app.js` `checkFeed`:** the tile uses `src: r.frameUrl`. The message:
  - `r.reused`: "The feed works: go2rtc got a frame from the stream it already has (no extra connection to the camera). Nothing was saved."
  - otherwise: "The feed works: go2rtc got a frame. The test connection to the camera was closed right away (these cameras tolerate about one viewer). Nothing was saved. Save the camera to get a live preview."

  The "Watch live" button is shown only when `r.wsUrl`. "Close preview" just clears the tile (no DELETE call).
- [ ] **Step 5:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Live check (test instance):**
  - "Check feed" on the unchanged PatternCam while its buffer runs: `pattern-cam.sh status` shows **one** client before, during and after, and go2rtc's log shows no `check_` stream.
  - Edit PatternCam2's path to `/pattern_sub` without saving, and "Check feed". Two clients appear briefly (each `status` run during the check), then back to one within 2 s.
  - `curl -s http://127.0.0.1:1987/api/streams` inside the container (`node -e` fetch) shows no `check_` stream left.
- [ ] **Step 7: Commit** `feat(admin): feed check reuses the running stream; test streams close right after one frame (#16)`.

---

## Phase 5: Package, review, PR (check: a test soak with the pattern camera, then a PR the owner can merge)

### Task 12: Docs, census script, soak on test

**Files:** Modify `README.md`, `Dockerfile` (comments), `docker-compose*.yml` (comments). Create `scripts/nas/rtsp-census.sh`.

- [ ] **Step 1: `scripts/nas/rtsp-census.sh`** (read-only; prints IPs and process names only):

```bash
#!/bin/bash
# Read-only RTSP census for #16: who holds connections to each camera's :554, how many closed in
# the last ~60 s, and how many NEW connections start in N seconds. Never prints URLs or passwords.
# Usage: bash rtsp-census.sh [seconds=20]   (always "bash ...": /tmp on the NAS is noexec)
set -euo pipefail
SECS=${1:-20}
echo "== $(date -Is) established to :554 (count, camera IP, process) =="
sudo ss -tnp state established "( dport = :554 )" | awk 'NR>1 {split($4,a,":"); p=$NF; sub(/^users:\(\("/,"",p); sub(/".*/,"",p); print a[1], p}' | sort | uniq -c
echo "== TIME-WAIT to :554 (closed in the last ~60 s) =="
sudo ss -tn state time-wait "( dport = :554 )" | awk 'NR>1 {split($4,a,":"); print a[1]}' | sort | uniq -c
echo "== new connections (SYN) to :554 in ${SECS} s =="
out=$(mktemp); err=$(mktemp)
set +e
sudo timeout "$SECS" tcpdump -l -nn -q -i any "tcp dst port 554 and tcp[tcpflags] & (tcp-syn|tcp-ack) == tcp-syn" >"$out" 2>"$err"
rc=$?
set -e
if [ "$rc" != 124 ] && [ "$rc" != 0 ]; then echo "tcpdump failed (exit $rc): $(tail -1 "$err")" >&2; rm -f "$out" "$err"; exit 1; fi
grep -oE '> [0-9.]+\.554' "$out" | sed -E 's/^> //; s/\.554$//' | sort | uniq -c
echo "(total SYNs: $(grep -c ' > ' "$out" || [ $? = 1 ]))"
rm -f "$out" "$err"
```

  (`timeout` exits 124 when it ends tcpdump on schedule, which is the normal case. Any other non-zero exit fails loudly. The `grep -c … || [ $? = 1 ]` treats "zero matches" (exit 1) as 0, not as an error.) Check it with `bash -n scripts/nas/rtsp-census.sh`.
- [ ] **Step 2: README.**
  - Update the architecture diagram: Camera → go2rtc (one connection per stream) → loopback RTSP → ffmpeg (prebuffer / live / snapshot), dashboard and pane.
  - Add a "One connection per camera" section: why (the cameras tolerate about one client); the restream on `127.0.0.1:8554` (`UNSCRYPTED_GO2RTC_RTSP_PORT`, `UNSCRYPTED_GO2RTC_RTSP=off`); the fallback and its timings; what the Status lines mean; "a camera save restarts go2rtc, which restarts recording buffers for a few seconds" (per Q4).
  - Rewrite line 182's go2rtc bullet (it's now in HomeKit's path).
  - Ports table: add `8554/tcp` (go2rtc RTSP restream, `127.0.0.1` only); the test row gets `RTSP 127.0.0.1:8555`.
  - Selftest: `node dist/index.js --selftest --source <rtsp url> [--seconds 12] [--audio]`.
  - Test rig: `scripts/nas/pattern-cam.sh` and `UNSCRYPTED_TEST_PREBUFFER`.
- [ ] **Step 3:** `npm test && npm run typecheck && npm run build`.
- [ ] **Step 4: Soak on test** (Task 2b, with `UNSCRYPTED_TEST_PREBUFFER=PatternCam` and the test dash open in a browser tab) for **at least 4 hours**:
  - `sudo docker logs unscrypted-test --since 4h 2>&1 | grep -c "prebuffer ffmpeg exited"` → 0.
  - `pattern-cam.sh status` → one client at every check (every 30 min).
  - `docker stats --no-stream unscrypted-test`: memory steady.
  - Producer lifetime: close the dash tab and set `UNSCRYPTED_TEST_PREBUFFER=` (empty; restart the test container). Within 5 s of the last consumer leaving, `pattern-cam.sh status` shows **zero** clients. Record the linger time on #16.
- [ ] **Step 5: Commit** `docs: one connection per camera; census script (#16)`.

### Task 13: Review and PR

- [ ] **Step 1:** Run superpowers:requesting-code-review on `git diff main`, focused on:
  - no camera URL with credentials in any log line (`spawnFfmpeg`'s debug arg log prints restream URLs, which are loopback with no credentials, but the fallback prints camera URLs at debug, as 0.3.0 already does; see Follow-ups);
  - no `catch {}` without a comment and a loud consequence;
  - the dash never receives addresses;
  - the selector can't flap;
  - feed-check temp streams are always deleted.
- [ ] **Step 2:** `git diff main --stat` shows no whole-file rewrites (CRLF). Push `feat/one-rtsp-16`. Open the PR "One camera, one caller: go2rtc is the only RTSP client (closes #16)", with the attribution line, the test numbers from Tasks 4, 5, 7, 10, 11 and 12, and the prod plan (Task 14). Ask the owner to confirm the merge with the button panel. **No merge without that.**
- [ ] **Step 3:** `sudo docker stop unscrypted-test` and `bash pattern-cam.sh stop` (no standing dev instance).

---

## Phase 6: Prod (after the merge go-ahead)

### Task 14: Deploy 0.4.0 to prod and verify

- [ ] **Step 1: Baseline, before anything changes** (read-only): `scp scripts/nas/rtsp-census.sh` to `/tmp/` on the NAS, then `bash /tmp/rtsp-census.sh 20` **three times, 5 minutes apart**. Save the outputs to the PR as the "before" numbers. Expected, roughly like the Findings: GarageCamTest at 2 established, TIME-WAIT about 18 on .3/.4/.99, and a few SYNs per 20 s per shown camera. (If Q12 = a moved `pollSeconds` to 60, the numbers are lower; note that.)
- [ ] **Step 2: Choose a quiet moment** (no one watching the cameras, and ideally little motion). **Tell the owner first:** "Deploying 0.4.0: Home shows cameras as No Response for about 30 s, and recording restarts."
- [ ] **Step 3: Back up:** `B="$HOME/unscrypted-backups/$(date +%Y%m%d-%H%M%S)-pre-0.4.0"; mkdir -p "$B" && cp -a "$HOME/unscrypted/config" "$HOME/unscrypted/data" "$HOME/unscrypted/docker-compose.yml" "$B/"`. Then `sudo docker image inspect unscrypted:0.3.0 >/dev/null && echo "rollback image present"`. **Don't remove the 0.3.0 image.**
- [ ] **Step 4: Deploy:** copy the merged files into `~/unscrypted` (as for 0.3.0: `src`, `web`, `scripts`, `package*.json`, `tsconfig.json`, `Dockerfile`, `docker-compose.yml`), then `cd "$HOME/unscrypted" && sudo docker compose up -d --build`. Then verify in `sudo docker logs unscrypted 2>&1 | tail -80`:
  - the same `HAP pairing state: /data/persist` and the same bridge name and username (no new identity);
  - go2rtc running;
  - `sudo ss -lntp | grep 127.0.0.1:8554` owned by go2rtc;
  - for each recording camera, `prebuffer running (…, reading through go2rtc)`.
- [ ] **Step 5: Home check (owner):** all five cameras are present in the Home app, with no re-pair prompt. Live view opens on GarageCamTest and Couch Cam. Ask the owner whether the picture appears about as fast as before (the GOP-join question).
- [ ] **Step 6: Recording check:** after the next motion on GarageCamTest or OnvifCamTest, the log shows `recording stream N requested`, then `recording stream N finished (K fragments)` with K ≥ 3. **No** `prebuffer has no data after warm-up`. The clip appears in the Home app with pre-roll. Over the first hour, `grep -c "recording stream .* requested"` and the average fragments per clip should look like the Findings' (Garage about 6.3, Onvif about 5.4).
- [ ] **Step 7: Run the selftest against prod's restream** for one recording camera. That's no new camera connection: the producer is already open for its buffer. `sudo docker exec unscrypted node dist/index.js --selftest --source rtsp://127.0.0.1:8554/garagecamtest --seconds 12` → PASSED. Record the longest fragment.
- [ ] **Step 8: After, 30 min in:** `bash "$HOME/unscrypted/scripts/nas/rtsp-census.sh" 20` three times, 5 minutes apart. Expected:
  - every camera IP has only `go2rtc` connections, at most one per stream in use (main; sub only where a tile or the pane uses it);
  - **no** `ffmpeg` and **no** `node` rows;
  - TIME-WAIT near 0;
  - SYNs per 20 s near 0 (only when a viewer starts).

  Post before/after on #16.
- [ ] **Step 9: Couch Cam** (Findings 4): note its feed state on the Status page, and whether snapshot timeouts stop (`grep -c "Couch Cam.*snapshot failed"` over 6 h, compared with 13 before).
- [ ] **Step 10: Fallback drill on prod, [owner go-ahead] only.** It briefly doubles each recording camera's connections. `sudo docker exec unscrypted pkill -STOP -x go2rtc` for 60 s, then `-CONT`. Expected:
  - the log switches to direct at about 15 s, and the Status notice reads as specified;
  - recording keeps working (a motion clip during the 2-3 min completes);
  - the switch back happens about 2 min later.

  Skip it if the owner prefers to trust the test-instance drill.
- [ ] **Step 11: Rollback** (if Home misbehaves): restore `docker-compose.yml` from `$B`, then `cd "$HOME/unscrypted" && sudo docker compose up -d` **without `--build`** (it runs the existing `unscrypted:0.3.0` image). `./data` and the pairing are untouched either way. 0.3.0 ignores the new env var.
- [ ] **Step 12:** Update quest-log, and comment the results on #16.

### Task 15: Main-vs-sub concurrency test, one camera at a time [owner go-ahead at run time]

Goal: find out, per camera model, whether a camera serves its main and sub streams to go2rtc **at the same time** without refusing or dropping one. That decides whether dashboard tiles (and Q1's snapshot) may use sub.

- [ ] **Step 1: Ask the owner for the go-ahead, the cameras and the moment** (Q9). Say plainly: "For about 3 minutes, <camera> gets a second connection (its sub stream). If it's a recording camera, its recording may drop for a few seconds."
- [ ] **Step 2: Record the before state** for that camera: `rtsp-census.sh 20`, plus its Status line.
- [ ] **Step 3: Open both through go2rtc** from inside the container. These are go2rtc consumers, so go2rtc opens the producers:

```bash
sudo docker exec unscrypted bash -c 'for s in <slug> <slug>_sub; do ffmpeg -hide_banner -loglevel warning -rtsp_transport tcp -timeout 10000000 -i rtsp://127.0.0.1:8554/$s -t 180 -f null - > /tmp/cc_$s.log 2>&1 & done; wait; tail -3 /tmp/cc_*.log'
```

  Here `<slug>` is the camera's main stream name from the Status page (e.g. `backyardcamtest`, `couch_cam`).
- [ ] **Step 4: While it runs:** take `rtsp-census.sh 20` once a minute (expect 2 go2rtc connections to that IP), and grep go2rtc's lines for that IP's errors: `sudo docker logs --since 4m unscrypted 2>&1 | grep -E "producer.go.*@<ip>"`. Afterwards, each `/tmp/cc_*.log` should end with no error and about 180 s of frames. A refused or dropped stream shows up as `EOF`, `i/o timeout`, `connection refused`, or an ffmpeg exit before 180 s. If the camera records, also check its `prebuffer ffmpeg exited` count over that window.
- [ ] **Step 5: Record the result** in a table on #16 and in the README's "One connection per camera" section: `model | camera tested | main+sub together: OK / drops <which> after <n> s / refuses | date`. Do Foscam FI9803P V2 (Couch Cam) and the XM model (one camera; a second XM camera is optional to confirm).
- [ ] **Step 6:** `rm -f /tmp/cc_*.log` in the container. Re-run the census: back to the Step 2 state.

### Task 16 (gated): Act on the main/sub result (Q10) and Q4 (b)

- [ ] **If a model failed and Q10 = (a):**
  - Add `subConcurrentOk?: boolean` per camera model in a small table in `src/dash/settings.ts` (keyed by `model`, from Task 15's result). The dashboard settings save refuses `stream: "sub"` for such a camera with the four-part error: "<label>'s camera model (<model>) drops a stream when main and sub are open together (tested <date>), and HomeKit already holds its main stream, so the tile has to use main."
  - The Settings page shows the sub option greyed out with that reason, not hidden (owner rule).
  - Write the tests first, as in Task 10.
- [ ] **If both models pass:** nothing changes in code. The default stays `main`. Note on #16 that sub is safe for those models.
- [ ] **If Q4 = (b):** file it as its own issue ("go2rtc per-stream live update instead of a restart"), with a plan of its own. It's not part of 0.4.0.

---

## Owner decisions (final, from the brief and #16)

- One RTSP connection per camera stream, held by go2rtc. Everything else re-streams from `127.0.0.1`.
- Fallback: yes, with hysteresis.
- Main vs sub: "Not sure, find out", via Task 15 with a go-ahead at run time.
- Dashboard status comes from go2rtc. TCP probing is removed.
- Feed check: reuse the configured stream; a temp stream only for new or edited URLs, closed right after.
- Names, bridge identity and pairing are unchanged. The dash is watch-only, the admin signed in. Live video stays WebRTC.
- No standing dev instance: start `unscrypted-test` on demand and stop it after.

## Open questions for the owner

Each one is held until answered. "(recommended)" marks the planner's pick.

1. **Snapshots** (Home app thumbnails; today each one opens the camera's sub stream directly). (a) Through go2rtc from the main stream, with a 10 s cache. That's no new connection on recording cameras, and one short shared one on the others **(recommended)**. (b) Through go2rtc from the sub stream, only for models that pass Task 15. (c) Leave them direct, as today.
2. **`#backchannel=0` on every go2rtc source** (stops go2rtc asking cameras for a two-way-audio channel, which nothing here uses). (a) Yes **(recommended)**. (b) No.
3. **Per-camera fallback.** go2rtc is up, but can't get video from one camera. (a) No: fall back only when go2rtc itself is down. A camera that's down for go2rtc is almost always down for a direct read too, and a second client is what the cameras hate **(recommended)**. (b) Yes: after 3 failures in 2 minutes, that camera alone goes direct for 10 minutes.
4. **go2rtc restarts now interrupt recording.** Saving a camera (or "Restart go2rtc") restarts go2rtc, and every recording buffer restarts with it (a few seconds of pre-roll lost, and a clip in progress cut short). (a) Accept it: restart only when go2rtc's config text actually changed, and say so in the save message **(recommended)**. (b) Build a per-stream live update through go2rtc's API instead, as a separate issue after 0.4.0.
5. **"Up?" for idle cameras** (nobody watching, so there's no connection to look at). (a) Show "idle: nobody is watching (last video 7:42 PM)", with no checks at all **(recommended)**. (b) Also show the motion source's health (Foscam CGI / ONVIF already talk to the camera, so it costs no RTSP). (c) A light frame grab every 10 minutes (opens a camera session; not recommended).
6. **Feed check of a new or edited URL.** (a) A still frame only; the test connection closes right after (your words) **(recommended)**. (b) Also allow a 60-second live preview before it closes.
7. **A password on the loopback RTSP restream.** (a) None: it's `127.0.0.1` only, like go2rtc's API, which can already add streams **(recommended)**. (b) A random password at each start.
8. **Fallback timings.** (a) Switch to direct after 15 s down; return after 60 s healthy and at least 2 min direct **(recommended)**. (b) Other numbers.
9. **The main+sub test: which cameras, and when.** (a) BackyardCamTest (XM) and Couch Cam (Foscam): neither had recording on in the last 6 h of logs, so HomeKit recording isn't touched. One at a time, at a moment you pick **(recommended)**. (b) You pick the cameras.
10. **The dash stream policy after the test.** (a) A model that fails can't use sub on the dashboard: Settings greys it out with the reason. Models that pass keep main by default, and sub is allowed **(recommended)**. (b) Switch tiles to sub by default where it passes.
11. **Prod fallback drill (Task 14 Step 10).** (a) Skip it on prod and trust the test-instance drill **(recommended)**. (b) Run it once at a quiet moment.
12. **Quick mitigation now.** Raise prod's dashboard poll from 4 s to 60 s today, before 0.4.0 lands. It cuts the probe churn about 15x, and status lights update once a minute. (a) Yes **(recommended)**. (b) No, wait for 0.4.0.

## Follow-up issues to file (not in this plan)

- `spawnFfmpeg` logs every ffmpeg command at debug, including camera URLs with passwords (fallback/direct mode, and all of 0.3.0). Mask with `redactUrl` before logging.
- (if Q4 = b) Per-stream go2rtc updates through its API, so a camera save doesn't restart every recording buffer.
- (if Q5 = b) Motion-source health as a liveness signal for idle cameras.
- The snapshot could come from the prebuffer's latest fragment (zero network) on recording cameras.
- Couch Cam's half-open go2rtc socket (Findings 4), if it survives 0.4.0.

## Self-review against the spec

- go2rtc is the only client, with RTSP on loopback: Tasks 1, 2, 7, 8 (prebuffer, live view, snapshot) and 11 (feed check). Checked by the census (Task 14 Step 8) and `pattern-cam.sh status`.
- Fallback with hysteresis, plain logs and a Status line: Tasks 5, 6, 7 and 9, with drills in Task 7 Step 9 and Task 14 Step 10.
- Main vs sub, an explicit owner-gated test per model: Tasks 15 and 16.
- Dash "up?" from go2rtc, `probeCameras` removed (and the bridge's `probeAll`): Tasks 6, 9 and 10.
- Feed check reuse, temp stream only for new or edited URLs and closed right after: Task 11.
- HKSV correctness (keyframes, 4 s, tfdt from 0, no B-frames, the exact ffmpeg change, why TCP on loopback is safe): the "HKSV correctness" section, plus Task 4 and Task 14 Steps 6-7.
- Live latency: its section, plus Task 5 Step 5 and Task 14 Step 5.
- Producer lifetime and idle status: its section, plus Tasks 6 and 12 Step 4, and Q5.
- Testing: the test instance (HAP off, pattern camera, `UNSCRYPTED_TEST_PREBUFFER`, selftest), and prod with a backup, the 0.3.0 image kept, "recording stream requested", connection counts and the SYN rate before and after. Tasks 2b, 12, 14.
- Phases end with checks; version 0.4.0 (Task 0). Owner rules are in Global Constraints.
