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
| `motionCooldownMs` | Hold the MotionSensor "on" this long after the last trigger (default `8000`). |
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

Runs ffmpeg against a generated test pattern through the real fragmented-MP4 → parser pipeline (the core of the prebuffer/recording path) and reports whether it produced a parseable init segment and keyframe fragments. Requires ffmpeg; it exits non-zero and says so if ffmpeg is missing (it never fakes success).

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
| `./data` | `/data` | `persist/`: the HAP pairing keys. **Never delete it**: losing it makes Home see a new, unpaired bridge, and every camera has to be re-added (losing rooms and recording settings). Back it up. Also `admin-session.key`, the admin pane's sign-in key (made on first start, mode 600; deleting it only signs everyone out). |
| `./secrets` | `/run/secrets` (read-only) | `admin_password`: one line, the admin pane's password (gitignored, mode 600). |

The container's `UNSCRYPTED_PERSIST_DIR=/data/persist` overrides any `persistDir` in `config.json`. If the keys are found in the ignored `persistDir` while `/data/persist` is empty, the bridge refuses to start and says which files to copy where, rather than starting as a new bridge (#4).

**Upgrading from 0.1.0** (config mounted as a single file, keys possibly in an anonymous volume at `/config/persist`): back up the keys from the running container first, then move `config.json` into `./config/` and copy the keys into `./data/persist/` before the first start of the new version. Check `docker inspect unscrypted` for a volume mounted at `/config`.

## Admin pane

A small web page for the cameras, served by the same container: `http://<host>:8190` (on the NAS, `http://10.0.1.78:8190`).

- **Sign-in:** the password is the one line in `./secrets/admin_password`. Sessions last 30 days and survive restarts (the signing key is kept in `./data/admin-session.key`). Five wrong passwords from one computer pause sign-in there for 5 minutes. If the password file is missing or empty, or the key file is unreadable or the wrong size, the pane says so and what to do; the HomeKit bridge keeps running either way.
- **What it does:** list cameras (passwords are never sent to the browser; they show as set, and URLs show `rtsp://user:***@host/...`), check a feed (a test frame through the bundled go2rtc), a live preview (MSE), edit a camera, add a camera, and show the pairing code and bridge status.
- **How changes take effect:** logins, stream addresses and motion timings apply live to that one camera. New cameras are added live. Changes that Home itself sees (HKSV on/off, prebuffer, motion source type, model) are saved and wait for **Restart bridge** (about 30 seconds of "No Response" in Home).
- **Don't rename cameras.** A camera's name is its identity in Home: renaming it would make Home see a new camera and drop the old one's room, settings and recordings. The pane refuses renames and warns that a new camera's name is permanent. Don't rename them by hand in `config.json` either.
- **go2rtc** (1.9.14, pinned by version and SHA-256 in the Dockerfile) runs inside the container for feed checks and previews only. Its API listens on `127.0.0.1` and is reached only through the signed-in pane. HomeKit streaming doesn't use it.
- The admin pane and go2rtc run as supervised child processes: if either crashes it's restarted with backoff (1 s doubling to 60 s), and HomeKit is unaffected.

### Ports

| Port | What | Where it listens |
|---|---|---|
| `51826/tcp` | HomeKit (HAP), `config.bridge.port` | all interfaces |
| `8190/tcp` | Admin pane (`UNSCRYPTED_ADMIN_PORT`) | all interfaces |
| `1986/tcp` | go2rtc API (`UNSCRYPTED_GO2RTC_API_PORT`) | `127.0.0.1` only |
| `8099-8102/tcp` | ONVIF push notifications (`onvif.notifyPort`) | all interfaces |
| Test instance | admin `8191`, go2rtc API `127.0.0.1:1987`, no HomeKit | |

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
