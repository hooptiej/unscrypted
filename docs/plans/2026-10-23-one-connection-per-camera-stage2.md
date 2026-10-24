# One camera, one caller (re-merge Stage 2): findings and measurements

**Issue:** hooptiej/unscrypted#16 (with #33 slow first frame and #35 restream stall folded in). **Version:** 0.1.7. **Base:** v0.1.6 on the 0.1.x trunk. **Prior art:** PR #32 / `a25fca9` on the archived 0.4.x line (tag `archive/0.4.3`), re-implemented here; its pure logic (source hysteresis, watcher feed states, the fMP4 fragment checks) was re-ported with its tests.

## What changed

- go2rtc serves RTSP on `127.0.0.1:8554` (`UNSCRYPTED_GO2RTC_RTSP_PORT`; test instance 8564) and is each camera's only RTSP client.
- A **source selector** (`src/source.ts`) picks every HomeKit pipeline's input at spawn time: the recording buffer and snapshots read the restream; snapshots take a stream go2rtc already holds, else sub, never main while a sub exists.
- The live view's source is a policy, `UNSCRYPTED_LIVE_SOURCE=camera|go2rtc` (default `camera`). See "The #33 trade-off".
- A **watcher** (`src/admin/go2rtcWatch.ts`) reads go2rtc's health every 5 s over loopback (process, API, RTSP port) and `/api/streams` for per-stream feed state. Fallback timings: down 15 s -> direct; back after 60 s healthy and 2 min; one camera failing 3x in 2 min -> that camera direct for 10 min; a camera outage never counts. Every switch is logged at **warn**.
- Live and snapshot ffmpeg inputs use `-fflags nobuffer -flags low_delay -probesize 32 -analyzeduration 0`; every RTSP read has a 10 s socket timeout.
- `--selftest --source <rtsp url>` runs the real recording-buffer args and checks keyframe alignment, decode time from 0, no B-frames, `avcC`, longest fragment.
- The bridge's 30 s TCP camera probe is gone; the admin pane shows go2rtc's feed state per stream, where HomeKit reads each camera, and the recording buffer's state. HAP-off test instances run buffers with `UNSCRYPTED_TEST_PREBUFFER=all`.

## Measurements (2026-10-23, `unscrypted-test`, real backyard Boavision, 1080p H.264 High 15 fps, GOP exactly 4.0 s)

All ffmpeg timings are from the NAS host through `docker exec`, which adds ~0.2 s.

**First decodable frame**

| Read | ms (raw) |
|---|---|
| Camera direct, ffmpeg default probing (what 0.1.6 live view does) | 3770-3830 |
| Camera direct, low-latency input flags (`UNSCRYPTED_LIVE_SOURCE=camera`, the 0.1.7 default) | 1050-1200 |
| Restream, fresh producer (nobody else attached), default probing | 3560-3620 |
| Restream, joining a producer the recording buffer holds, default probing | 4350-5670 |
| Restream, joining a held producer, low-latency flags (`UNSCRYPTED_LIVE_SOURCE=go2rtc`), 14 samples | 1050-3230, median ~2.0 s |

**ONVIF `SetSynchronizationPoint`** on `MainStreamProfileToken`: HTTP 200 in 10 ms, keyframe cadence unchanged (gaps 3.97-4.01 s across three mid-GOP requests). The camera ignores it, so force-IDR-on-join is not available.

**HKSV-through-restream selftest:** PASSED. 3 keyframe-aligned fragments in 14 s, first decode time 0 ticks, no composition offsets, `avcC` present, longest fragment 4.00 s (the camera's GOP; HomeKit's ceiling is 4 s).

**Census** (established TCP connections from the test container to the camera's :554; the old standalone Homedash go2rtc holds one more on every camera and is not counted):

| Open | Connections |
|---|---|
| Recording buffer only (through go2rtc) | 1 |
| + dash tile on the SUB stream (tonight's dash setting) | 2 (main + sub producers) |
| + HomeKit snapshot | 2 (rides the held sub stream) |
| + live view, `UNSCRYPTED_LIVE_SOURCE=camera` | 3 |
| + live view, `UNSCRYPTED_LIVE_SOURCE=go2rtc` | 1 |
| Recording buffer + dash tile on the MAIN stream | 1 |

So "exactly 1 with live view + HKSV + dash open" holds with the dash on main streams and the live policy `go2rtc`; the sub-stream dash is a second session by itself.

**Fallback drill** (SIGSTOP go2rtc 75 s): frozen at 22:58:50 MDT; "HomeKit now reads the cameras directly" (warn, with the reason) at +21 s; recording buffer re-pointed to the camera at +26 s; SIGCONT at +75 s; "reading the cameras through go2rtc again (it was direct for 2m0s)" at +2m18s, buffer re-pointed back within 5 ms. Census during the fallback: 1 direct ffmpeg, go2rtc's producer gone; after: back to 1 go2rtc.

**Stall soak (#35):** 10 min, a live-view-like reader on the restream and one on the camera directly, side by side (23:03-23:13 MDT): restream 5997 frames, direct 5998, 0 dropped frames each, 0 gaps over 1.5 s between frames each (from ffmpeg's half-second progress samples), no bridge warnings during the run. The real live-transcode pipeline (libx264 zerolatency to RTP, the live view's exact shape) ran 20 s on each source with the new input flags: both exit 0 (restream 258 frames after its keyframe wait, direct 300).

## The #33 trade-off

With a 4 s camera GOP and no force-IDR, a live view joining a held restream waits 0-4 s for a keyframe on top of the ~0.9 s floor. A fresh camera session starts on a keyframe. So 0.1.7 ships with one connection for everything that runs all day (the recording buffer, snapshots, the dash) and lets the owner pick the live view's source:

- `camera` (default): ~1 s to the first frame, a second connection while someone watches.
- `go2rtc`: one connection always, median ~2 s and up to ~3.2 s to the first frame.

Both beat 0.1.6's ~3.6 s. #70 proposes starting the live view from the recording buffer's cached GOP, which would give both at once.

## Known

- Boot race: the recording buffer can start ~0.4 s before go2rtc listens; it logs one warn and retries 5 s later. Failures in that window never count toward the per-camera fallback.
- The dash on sub streams is a second camera session per camera. With everything else on go2rtc the dash could go back to main streams (one session) if the kiosk can decode 1080p/4K tiles; owner's call.
