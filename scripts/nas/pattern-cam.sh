#!/bin/bash
# Start/stop/status the synthetic pattern camera for unscrypted-test (#16).
# Usage: bash pattern-cam.sh start|stop|status   (run from anywhere; /tmp is noexec, so always "bash ...")
# It is a throwaway go2rtc (from the already-pulled unscrypted image) serving a lavfi test pattern on
# rtsp://127.0.0.1:8654/pattern and /pattern_sub. Counting connections to :8654 proves "one client".
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=unscrypted-pattern-cam
IMAGE="${PATTERN_CAM_IMAGE:-unscrypted:0.3.0}"
case "${1:-}" in
  start)
    if sudo docker ps --format '{{.Names}}' | grep -qx "$NAME"; then echo "$NAME already running"; exit 0; fi
    if sudo ss -lnt | grep -qE '127\.0\.0\.1:(8654|1988) '; then
      echo "ports 8654/1988 are taken by something else; not starting. Check: sudo ss -lntp | grep -E ':(8654|1988) '" >&2; exit 1
    fi
    if ! sudo docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "image $IMAGE isn't on this box; nothing started. Set PATTERN_CAM_IMAGE to an unscrypted image that is (sudo docker images unscrypted)." >&2; exit 1
    fi
    sudo docker run -d --rm --name "$NAME" --network host \
      -v "$HERE/pattern-cam.yaml:/pattern-cam.yaml:ro" --entrypoint /usr/local/bin/go2rtc "$IMAGE" -config /pattern-cam.yaml
    echo "$NAME started: rtsp://127.0.0.1:8654/pattern and /pattern_sub"
    ;;
  stop)
    if sudo docker ps --format '{{.Names}}' | grep -qx "$NAME"; then sudo docker stop "$NAME"; else echo "$NAME isn't running"; fi
    ;;
  status)
    if ! sudo docker ps --format '{{.Names}}' | grep -qx "$NAME"; then echo "$NAME isn't running" >&2; exit 1; fi
    # The pattern's own encoder (an ffmpeg child of the rig's go2rtc) publishes into :8654 too; it isn't a client.
    RIG_PID="$(sudo docker inspect -f '{{.State.Pid}}' "$NAME")"
    echo "clients pulling the pattern (each line = one RTSP connection to :8654; the rig's own encoder is left out):"
    sudo ss -tnp state established "( dport = :8654 )" | awk 'NR>1' | while read -r line; do
      pid="$(sed -n 's/.*pid=\([0-9]*\).*/\1/p' <<<"$line")"
      if [ -n "$pid" ] && [ "$(ps -o ppid= -p "$pid" | tr -d ' ')" = "$RIG_PID" ]; then continue; fi
      echo "$line" | awk '{print $NF}'
    done
    ;;
  *) echo "usage: bash $0 start|stop|status" >&2; exit 2 ;;
esac
