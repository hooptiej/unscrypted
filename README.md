# unscrypted

A from-scratch, self-hosted bridge that exposes IP cameras to **Apple HomeKit**, including **HomeKit Secure Video (HKSV)**. It is a lean replacement for Scrypted's HomeKit plugin for the specific case of RTSP cameras (first target: Foscam).

All of the HomeKit protocol work — pairing, SRTP key exchange, the motion→recording trigger, the HDS data-stream handshake, fMP4-over-HDS delivery to iOS — is handled by the **[HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS)** library (the same one Homebridge uses). unscrypted does **not** reimplement HAP. What unscrypted adds on top:

- an **RTSP video source** per camera (via ffmpeg),
- a **motion-event source** (polls the Foscam CGI API and flips the HomeKit MotionSensor),
- an **ffmpeg fragmented-MP4 generator** where every fragment starts on a keyframe,
- a **rolling prebuffer** so recordings begin a few seconds *before* the motion trigger (HAP-NodeJS does not provide this).

It is **config-driven and multi-camera** — tested with one Foscam, but every camera is just another entry in `config.cameras`.

## Status / honesty

This is a **first working cut**. It compiles cleanly, stands up a pairable HomeKit bridge, and degrades gracefully when a camera or ffmpeg is missing. The media paths (live SRTP, snapshots, HKSV recording + prebuffer) are implemented following the established Homebridge/HAP-NodeJS patterns but **have not been verified end-to-end against a real camera and a real iPhone yet**. See [Current limitations](#current-limitations).

## How it works

```
                 ┌──────────────────── unscrypted ────────────────────┐
  Foscam CGI ───►│ MotionPoller ─► HAP MotionSensor (HKSV trigger)      │
  (port 88)      │                                                      │
                 │ RTSP main ─► ffmpeg ─► SRTP ──────► live view (HAP)   │◄── iPhone / Home app
  Camera RTSP ──►│ RTSP main ─► ffmpeg ─► fMP4 ─► Prebuffer ring ─┐      │    (pairs over mDNS)
  (port 554)     │                                               ▼      │
                 │                        RecordingDelegate ─► HKSV clip │
                 └──────────────────────────────────────────────────────┘
```

- **Live view:** on `prepareStream`, HAP hands us its SRTP keys and target address; ffmpeg emits SRTP straight to that endpoint (video copied if already H.264, audio transcoded G.711 → **Opus**). MTU 1200.
- **Recording (HKSV):** when you enable recording in the Home app, HAP calls `updateRecordingActive(true)` and unscrypted starts a continuous ffmpeg that produces fragmented MP4 (video copy, audio → **AAC**). Fragments (each starting on a keyframe) are kept in a rolling in-memory ring. On a motion trigger HAP opens a recording stream; unscrypted yields the init segment, then the buffered pre-event fragments, then live fragments until the Home app closes the stream or the max-clip cap is hit.
- **Motion:** a 1s poll of the Foscam `getDevState` CGI reads `motionDetectAlarm` (`2` = triggered). The MotionSensor is set on, then cleared after a cooldown.

## Configure

Copy the example and edit it. **`config.json` holds your camera passwords and is gitignored — never commit it.**

```bash
cp config.example.json config.json
```

Key fields (`config.example.json` has the full shape):

| Field | Meaning |
|---|---|
| `bridge.username` | A stable locally-administered MAC-style id for the bridge. Keep it constant across restarts. |
| `bridge.pin` | 8-digit HomeKit setup code, format `XXX-XX-XXX`. |
| `bridge.port` | TCP port for the HAP server (default `51826`). |
| `cameras[].name` | Unique display name in the Home app. |
| `cameras[].host` + `rtspUser`/`rtspPassword` | unscrypted assembles `rtsp://user:pass@host:554/videoMain` and `/videoSub`. Or set `rtspMain`/`rtspSub` directly. |
| `cameras[].foscam` | Foscam CGI motion source: CGI base (`http://<ip>:88`), username, password → drives the motion poller. |
| `cameras[].onvif` | ONVIF motion source (for generic/XM cameras with no Foscam CGI): `host`, `port` (default `80`; **XM cameras usually need `8080`**), `username`, `password`. See below. |
| `cameras[].prebufferSeconds` | Rolling prebuffer length (HAP requires ≥ 4). |
| `cameras[].hksv` | Enable HomeKit Secure Video recording (default `true`). |
| `cameras[].copyVideo` | `true` (default) copies the camera's H.264; set `false` to transcode (forces a 4s keyframe cadence — see caveat below). |

A camera configures **at most one** motion source — set either `foscam` or `onvif`, not both (config validation rejects both). Omit both to disable motion for that camera (live view and recording still work, but nothing flips the MotionSensor, so HKSV won't be triggered).

Secrets can also come from env (`UNSCRYPTED_BRIDGE_PIN`, `UNSCRYPTED_BRIDGE_USERNAME`); the camera passwords only come from the config file.

### Foscam FI9803P V2 reference

- RTSP main: `rtsp://<user>:<pw>@<ip>:554/videoMain` (H.264 1280×720@15, G.711/PCMU audio)
- RTSP sub: `rtsp://<user>:<pw>@<ip>:554/videoSub` (H.264 320×180@10)
- CGI: `http://<ip>:88/cgi-bin/CGIProxy.fcgi?cmd=<cmd>&usr=<user>&pwd=<pw>`

### ONVIF motion (generic / XM cameras)

For cameras that have no Foscam CGI, unscrypted subscribes to the camera's ONVIF Events service and flips the same HomeKit MotionSensor. Add an `onvif` block instead of `foscam`:

```json
{
  "name": "Garage",
  "rtspMain": "rtsp://admin:PASSWORD@10.0.1.3:554/11",
  "rtspSub": "rtsp://admin:PASSWORD@10.0.1.3:554/12",
  "audio": false,
  "onvif": {
    "host": "10.0.1.3",
    "port": 8080,
    "username": "admin",
    "password": "PASSWORD"
  }
}
```

| ONVIF field | Meaning |
|---|---|
| `host` / `port` | ONVIF device service host and port. Default port `80`. **Generic XM/Sofia cameras serve ONVIF on `8080`** (port 80 is the web UI); set it explicitly if the device service 404s. |
| `username` / `password` | ONVIF account (WS-Security digest auth). Often the same as the RTSP login. |
| `pollIntervalMs` | PullPoint long-poll window in ms (default `60000`). Ignored for push cameras. |
| `motionCooldownMs` | Hold the MotionSensor "on" this long after the last trigger (default `60000`, i.e. 60s — long enough that outdoor wind-gust gaps don't clear the sensor and flap HomeKit's event channel; see #65). |
| `notifyPort` | For push cameras (see below): TCP port the local notification receiver listens on. Default `0` (ephemeral). Set a fixed port if a firewall sits between unscrypted and the cameras. One receiver is shared across all ONVIF cameras. |
| `notifyHost` | Override the local IP advertised to the camera as the notification consumer address (default: auto-detected). Set this if auto-detection picks the wrong NIC, e.g. in Docker with a custom network. |

unscrypted tries **PullPoint** first (it long-polls the camera, no inbound server needed). If the camera doesn't implement PullPoint — many XM cameras return `ActionNotSupported` — it automatically falls back to **WS-BaseNotification push**: the camera POSTs notifications to a small HTTP receiver unscrypted hosts. The active mode is logged at startup. It accepts the `tns1:RuleEngine/CellMotionDetector/Motion` (`IsMotion`) and `tns1:VideoSource/MotionAlarm` (`State`) topics.

**Probe a camera without pairing:** `node dist/index.js --probe-onvif <host[:port]> [user] [pass]` connects, lists the camera's motion topics, subscribes, and logs motion events for 30s. If user/pass are omitted it reuses credentials from a matching camera in `config.json`. Use it to confirm a new camera's ONVIF port/auth and that motion fires before wiring it into the bridge.

Verified against a generic XM camera (admin on port 8080): PullPoint is unsupported, push works, motion arrives on `tns1:RuleEngine/CellMotionDetector/Motion` with `IsMotion=true/false`.

## Run

### Locally (dev)

```bash
npm install
npm run build
npm start            # or: npm run dev   (ts, no build step)
```

On start it prints the **HomeKit setup code and a QR code** to the log. In the iOS Home app: **Add Accessory → More options → scan the QR** (or enter the code). unscrypted advertises as a **bridge**; each camera appears as its own accessory.

> ffmpeg must be on `PATH` (or set `ffmpegPath` in the config) for live view, snapshots, and recording. Without it the bridge still publishes and pairs — it just can't show video.

### Self-test (no camera / no iPhone needed)

```bash
npm run selftest
```

Runs ffmpeg against a generated test pattern through the real fragmented-MP4 → parser pipeline (the core of the prebuffer/recording path) and checks what HomeKit Secure Video needs from every fragment: it starts on a keyframe, decode times start at zero and only increase, no B-frames, an `avcC` in the init segment, and it reports the longest fragment against HomeKit's 4 s. Requires ffmpeg; it exits non-zero and says so if ffmpeg is missing (it never fakes success).

```bash
npm run selftest -- --source rtsp://127.0.0.1:8554/<stream> [--seconds 12] [--audio]
```

The same checks against a real source, using exactly the recording buffer's ffmpeg arguments. Point it at go2rtc's loopback restream (inside the container: `node dist/index.js --selftest --source rtsp://127.0.0.1:8554/backyardcam`) to prove that recording through the restream produces what HomeKit needs.

### Docker (e.g. TrueNAS)

```bash
mkdir -p config data secrets
cp config.example.json config/config.json   # edit it
openssl rand -base64 18 > secrets/admin_password && chmod 600 secrets/admin_password   # admin pane sign-in
docker compose up -d --build
docker compose logs -f                       # watch for the pairing QR / code
```

**Host networking is required** — HomeKit discovery uses mDNS, which does not cross Docker's bridge network.

Two folders sit next to the compose file:

| Folder | Mounted at | Holds |
|---|---|---|
| `./config` | `/config` | `config.json` (camera passwords: gitignored, never commit it). |
| `./data` | `/data` | `persist/`: the HAP pairing keys. **Never delete it**: losing it makes Home see a new, unpaired bridge, and every camera has to be re-added (losing rooms and recording settings). Back it up. Also `admin-session.key`, the admin pane's sign-in key (made on first start, mode 600; deleting it only signs everyone out), and `dash/`, the dashboard's settings, fonts and photo cache. |
| `./secrets` | `/run/secrets` (read-only) | `admin_password`: one line, the admin pane's password (gitignored, mode 600). |

The container's `UNSCRYPTED_PERSIST_DIR=/data/persist` overrides any `persistDir` in `config.json`. If the keys are found in the ignored `persistDir` while `/data/persist` is empty, the bridge refuses to start and says which files to copy where, rather than starting as a new bridge (#4).

**Upgrading from 0.1.0** (config mounted as a single file, keys possibly in an anonymous volume at `/config/persist`): back up the keys from the running container first, then move `config.json` into `./config/` and copy the keys into `./data/persist/` before the first start of the new version. Check `docker inspect unscrypted` for a volume mounted at `/config`.

## Dashboard

The living-room camera dashboard (formerly the separate Homedash app) runs inside the same container, as its own supervised child process: `http://<host>:8180` (test instance: `http://10.0.1.78:8181`, tab title `Homedash - TEST`). It shows up to four live camera tiles (WebRTC, video only, straight from the bundled go2rtc), service status lights, the weather and a photo slideshow.

- **Open and watch-only, by design.** There's no sign-in: anyone on the LAN can watch the cameras, the same as Homedash. Every non-GET request gets a 405. It never sends passwords, RTSP URLs, camera IPs, the setup code or tokens, and it only opens live video for the cameras in `config.json` (at most 16 viewers at once).
- **Settings** live in `./data/dash/` (`settings.json`, `fonts/`, the photo cache) and are changed on the admin pane's settings page, behind the admin password (see [Dashboard settings](#dashboard-settings)).
- **Off switch:** `UNSCRYPTED_DASH=off`. A dashboard crash restarts only the dashboard (backoff 1 s doubling to 60 s); the HomeKit bridge and the admin pane carry on.
- **Rebuilding the image restarts HomeKit too** (a few seconds of "No Response" in Home, and any recording in progress stops). Batch dashboard changes into as few prod deploys as possible. On the test instance, `web/dash` is bind-mounted read-only, so page-only changes need no rebuild.
- **Background glow:** a soft olive wash that follows the sun along the bottom edge, warming at dawn and dusk. Two sliders under Display on the settings page tune it, each -100% to +100% (0% is the standard look). **Glow intensity** scales its strength: -100% turns it off, +100% doubles it. **Glow size** scales the ellipse, never smaller than 10% or larger than 200%. Both apply day and night for now. (hooptiej/unscrypted#25)
- **The Mac kiosk** that shows it full screen lives in [`scripts/mac-kiosk/`](scripts/mac-kiosk/).

### Its own IP address (so `http://homedash.local` works with no port)

By default the dashboard listens on every address at port 8180. To give it its own address on port 80 (prod `10.0.1.248`, `homedash.local`; test `10.0.1.249`, `homedash-test.local`):

1. **Add the address to the NAS first** (TrueNAS network settings, as a second address on the LAN interface; TrueNAS tests it and reverts on its own if you don't confirm). Reserve it in UniFi, or keep it outside the DHCP pool.
2. Set `UNSCRYPTED_DASH_HOST=10.0.1.248` and `UNSCRYPTED_DASH_PORT=80` in the compose environment, and `UNSCRYPTED_ADMIN_URL` / `UNSCRYPTED_DASH_URL` (see [Dashboard settings](#dashboard-settings)), then `docker compose up -d`.
3. The mDNS name (`homedash-mdns` publishing `homedash.local` → `.248`) and the kiosk URL don't change.

**Note:** on this NAS, `10.0.1.249` is now the ipvlan shim's address (below), not a test dashboard. There's no standing test instance; pick another free address if you ever give the test dashboard its own IP.

### Status lights for apps on an ipvlan network (the shim)

unscrypted runs with host networking, and a Linux host can't talk to its own ipvlan containers (Constructicon and Questlog sit on the `questlog-lan` ipvlan). [`scripts/nas/ipvlan-shim.sh`](scripts/nas/ipvlan-shim.sh) gives the host a small ipvlan interface (`ipvlshim`, `10.0.1.249/32`) and one `/32` route per app address, so the dashboard's http checks reach them. Nothing else on the LAN changes. The interface and routes are runtime state and vanish on reboot, so the script registers itself as a **TrueNAS post-init command**: `sudo bash scripts/nas/ipvlan-shim.sh install ~/nas-scripts` copies it to a stable folder and creates (or updates) the entry through `midclt`; `sudo bash scripts/nas/ipvlan-shim.sh status` says what's present (interface, address, every route, the boot entry) and exits non-zero if anything is missing; running it with no argument applies the shim by hand (idempotent). Before using it on another install, edit the parent interface, the shim address (check it's free on the whole LAN and reserve it in DHCP) and the app list at the top. Without the shim, set those lights to `{"kind": "blocked", "reason": "..."}` in the dashboard settings so they say why they're red. A settings file saved by 0.3.0 (before the shim) still carries the old "can't check yet" placeholder on those four lights; the dashboard swaps it back to the http checks on load and logs that it did, and the next save on the settings page writes it. (hooptiej/unscrypted#11)

If the address isn't on the NAS yet, the dashboard doesn't start and says so plainly in the log and on the admin pane's Status ("The address 10.0.1.248 isn't on this machine (EADDRNOTAVAIL)… Add 10.0.1.248 to the NAS's network"). It keeps retrying (up to once a minute) and starts on its own once the address appears. HomeKit and the admin pane are unaffected either way. HomeKit stays on the NAS's main address.

## Admin pane

A small web page for the cameras, served by the same container: `http://<host>:8190` (on the NAS, `http://10.0.1.78:8190`).

- **Sign-in:** the password is the one line in `./secrets/admin_password`. Sessions last 30 days and survive restarts (the signing key is kept in `./data/admin-session.key`). Five wrong passwords from one computer pause sign-in there for 5 minutes. If the password file is missing or empty, or the key file is unreadable or the wrong size, the pane says so and what to do; the HomeKit bridge keeps running either way.
- **Camera logins:** each camera on the Cameras tab has a **Login** row: the RTSP user name (and the Foscam CGI or ONVIF one, when the camera has those) with the password shown as `••••••••`. **👁 Show** fetches that one camera's passwords and its web UI link (opens in a new tab); **Hide**, or 60 seconds, masks them again, and each value has a **Copy** button. Nothing is fetched until you press Show, and each Show is logged by camera name only (`credentials for "<name>" shown`, never the value). **This means the admin password now guards the camera passwords too:** anyone signed in to the pane can read them, so keep `./secrets/admin_password` as private as the cameras' own logins. The open dashboard never sees any of it.
- **What it does:** list cameras (the list itself never carries passwords; they show as set, and URLs show `rtsp://user:***@host/...`; see Camera logins above for showing them), check a feed (a test frame through the bundled go2rtc), a live preview (WebRTC, the way Homedash plays these cameras: they don't play over MSE), edit a camera, add a camera, and show the pairing code and bridge status.
- **How changes take effect:** logins, stream addresses and motion timings apply live to that one camera. New cameras are added live. Changes that Home itself sees (HKSV on/off, prebuffer, motion source type, model) are saved and wait for **Restart bridge** (about 30 seconds of "No Response" in Home).
- **Removing a camera** (the Remove section at the bottom of its page) takes it out of the bridge and, live, out of Home: Home drops the camera with its HKSV recordings, its room and any automations, and the pane says so before you confirm. The camera's full entry is kept first at `./config/removed-cameras/<name>-<time>.json` (logins included, mode 0600), and the previous `config.json` in `./config/backups/`. To put it back, add it again under the same name (Home treats it as the same camera; the old recordings are gone), or paste the kept entry into `config.json` and restart. (hooptiej/unscrypted#8)
- **Don't rename cameras.** A camera's name is its identity in Home: renaming it would make Home see a new camera and drop the old one's room, settings and recordings. The pane refuses renames and warns that a new camera's name is permanent. Don't rename them by hand in `config.json` either.
- **go2rtc** (1.9.14, pinned by version and SHA-256 in the Dockerfile) runs inside the container and is each camera's **only RTSP client** (see "One connection per camera"). Its API listens on `127.0.0.1` and is reached only through the signed-in pane.
- The admin pane and go2rtc run as supervised child processes: if either crashes it's restarted with backoff (1 s doubling to 60 s), and HomeKit is unaffected.

### Dashboard settings

The living-room dashboard (Homedash, `http://<host>:8180`, test `:8181`) is open and watch-only. Its settings are a separate page on the admin pane, behind the same password: **`http://<host>:8190/dash-settings`** (test: `http://10.0.1.78:8191/dash-settings`). It's Homedash's own one-screen page: fonts, which cameras show and in what order (at most 4; a fifth is refused with a message), each tile's dashboard-only label (the HomeKit name never changes) and main or sub stream, display timings, the photo slideshow and the weather place. Saving writes `./data/dash/settings.json` (the previous copy is kept as `settings.json.bak`); the dashboard reloads with it within a few seconds.

**Fonts from Constructicon** (hooptiej/unscrypted#14): the font pickers also list the font files kept in Constructicon as brand assets, the way Homedash's did. Enter the Constructicon address on the settings page (for example `http://10.0.1.240`; it's saved with the other dashboard settings) and put a **read-only** Constructicon token, one line, in `./secrets/constructicon_token` (the `./secrets` folder is already mounted read-only at `/run/secrets`; `UNSCRYPTED_CONSTRUCTICON_TOKEN_FILE` moves it). The token is read by the admin process only and never reaches the browser or the open dashboard. Picking a Constructicon font copies it once into `data/dash/fonts` (as `cx-<slug>.<ext>`, with its name in `names.json`), so from then on it's an ordinary folder font: the dashboard keeps it when Constructicon is down. When the list can't be had (no address, no token, token refused, Constructicon unreachable), the "From Constructicon" group stays in the picker, greyed out, with the reason; the folder and system fonts work regardless.

- **The dashboard's Settings button** opens that page with `?from=dash`. Not signed in, it asks for the password first and comes straight back. From the kiosk, the page idles back to the dashboard after the fullscreen timeout and **signs that browser out**, so the living room never stays signed in.
- **Different addresses:** when the dashboard and the pane don't share a host (for example the dashboard on its own IP at port 80), set `UNSCRYPTED_ADMIN_URL` (e.g. `http://10.0.1.78:8190`, where the Settings button goes) and `UNSCRYPTED_DASH_URL` (e.g. `http://10.0.1.248/`, where the settings page sends you back). Unset, both are worked out from the browser's address and the ports. A bad value is ignored, and the dashboard says so.
- **Fonts** are files in `./data/dash/fonts` (`.otf`, `.ttf`, `.woff`, `.woff2`), with display names in `./data/dash/fonts/names.json` (`{ "<file>": "<name>" }`). **Photos** come from an iCloud shared-album link (cached in `./data/dash/cache/icloud`) or a folder.

### One connection per camera

These cameras handle one RTSP client well and several badly (stalls, dropped frames, the live view in Home spinning). So since 0.1.7 the bundled go2rtc holds the one session per camera stream, and everything else reads from go2rtc instead of the camera:

- **HomeKit's recording buffer** (HKSV pre-roll) reads `rtsp://127.0.0.1:8554/<stream>` (go2rtc's RTSP restream, loopback only, never on the LAN).
- **Snapshots** read whichever stream go2rtc is already holding (costs the camera nothing), else the sub stream, never main while a sub exists.
- **The dashboard and the admin pane's preview** already played through go2rtc (WebRTC).
- **The live view in Home** is a policy, `UNSCRYPTED_LIVE_SOURCE`: `camera` (default) opens its own camera session, which starts on a keyframe in about a second but is a second connection while someone is watching; `go2rtc` keeps one connection per camera, and a viewer joining a stream go2rtc already holds waits for the camera's next keyframe (up to one GOP: 4 s on the Boavisions, which ignore ONVIF's keyframe request).

**Fallback, loudly.** The bridge checks go2rtc every 5 s (its process, its API, its RTSP port; never a camera). If go2rtc is down for 15 s, every HomeKit pipeline reads the cameras directly and the log says so at warn level, with the reason; it switches back once go2rtc has been healthy for 60 s and at least 2 min have passed, also logged. If go2rtc is healthy but one camera's reads through it fail 3 times in 2 minutes, that camera alone goes direct for 10 minutes. A camera that is itself unreachable (go2rtc can't get video either) never triggers the fallback: a direct read would fail too, and would be a second client the moment the camera is back. The Status page says where HomeKit reads from and since when; each camera card shows go2rtc's view of its streams and where HomeKit reads it.

`UNSCRYPTED_GO2RTC_RTSP=off` turns the restream off (every pipeline reads the cameras directly, as before 0.1.7). `UNSCRYPTED_GO2RTC_RTSP_PORT` moves it (default 8554; the test instance uses 8564 because it shares the host's network).

### Ports

| Port | What | Where it listens |
|---|---|---|
| `51826/tcp` | HomeKit (HAP), `config.bridge.port` | all interfaces |
| `8190/tcp` | Admin pane (`UNSCRYPTED_ADMIN_PORT`) | all interfaces |
| `8180/tcp` | Dashboard, open and watch-only (`UNSCRYPTED_DASH_PORT`; own IP: port `80` on `UNSCRYPTED_DASH_HOST`) | all interfaces, or `UNSCRYPTED_DASH_HOST` |
| `1986/tcp` | go2rtc API (`UNSCRYPTED_GO2RTC_API_PORT`) | `127.0.0.1` only |
| `8557/tcp+udp` | go2rtc WebRTC video for the live preview (`UNSCRYPTED_GO2RTC_WEBRTC_PORT`; `UNSCRYPTED_GO2RTC_WEBRTC=off` turns the preview off) | all interfaces |
| `8554/tcp` | go2rtc RTSP restream, what HomeKit's pipelines read (`UNSCRYPTED_GO2RTC_RTSP_PORT`; `UNSCRYPTED_GO2RTC_RTSP=off` turns it off) | `127.0.0.1` only |
| `8099-8102/tcp` | ONVIF push notifications (`onvif.notifyPort`) | all interfaces |
| Test instance | admin `8191`, dashboard `8181`, go2rtc API `127.0.0.1:1987`, WebRTC `8558`, restream `127.0.0.1:8564`, no HomeKit | |

### Test instance

`docker-compose.test.yml` runs a second copy for trying changes before they reach the real bridge. It runs with **HomeKit off** (`UNSCRYPTED_HAP=off`): it never publishes a bridge and never starts motion sources, so it can't appear in the family's Home app or take prod's ONVIF port. Its page title is `unscrypted admin - TEST`.

Run it from its own folder (on the NAS, `~/unscrypted-test`), with its own `config/`, `data/` and `secrets/`:

```bash
cd ~/unscrypted-test
sudo docker compose -f docker-compose.yml -f docker-compose.test.yml -p unscrypted-test up -d --build
```

The `-p unscrypted-test` project name and the `unscrypted-test` container name keep it apart from prod. The test instance pulls the same cameras over RTSP while you use it, so each camera has one more viewer for that time.

## HomeKit codec constraints (as implemented)

| | Video | Audio |
|---|---|---|
| Live | H.264 Main (copied; levels ≤ 4.0), MTU 1200 | Opus (transcoded) |
| Recording | H.264 (copied) in fragmented MP4, keyframe-aligned | AAC-LC (transcoded) |

Max clip length is capped (~170s, HAP allows ~180). Fragment delivery is pull-paced by HAP so the prebuffer burst doesn't flood the HDS connection.

## Current limitations

These are **known and unverified** — honest about what a next session with the real Foscam + an iPhone still needs to prove:

1. **No end-to-end test yet.** Compiled and smoke-tested (publishes, pairs-ready, graceful degradation), but live view, snapshots, and HKSV recording have not been exercised against a real camera or Home app on this machine (the test Foscam is unplugged, there's no iPhone here, and ffmpeg isn't installed on the dev box).
2. **Keyframe interval / GOP caveat.** With `copyVideo: true`, a recording fragment's length equals the camera's own keyframe interval. HKSV wants fragments that start on a keyframe and are ≤ the selected fragment length (~4s). If the Foscam's I-frame interval is longer than ~4s, recording may misbehave. Fix: shorten the camera's I-frame interval in its web UI, or set `copyVideo: false` to transcode with a forced 4s GOP (costs CPU).
3. **RecordingAudioActive not honoured.** unscrypted always muxes audio into recording fragments; it logs a warning when HomeKit asks for audio-off instead of producing an audio-less pipeline.
4. **No two-way audio / talkback.**
5. **Snapshot** pulls a live frame from the sub stream each time (no cached placeholder when the camera is down — HAP just gets an error).
6. **Motion** comes from either Foscam CGI polling (1s) or an ONVIF event subscription (PullPoint long-poll, or WS-BaseNotification push), selected per camera. See the `onvif` config block.

## License

MIT.
