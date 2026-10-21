#!/bin/bash
# Read-only RTSP census for #16: who holds connections to each camera's :554, how many closed in
# the last ~60 s, and how many NEW connections start in N seconds. Never prints URLs or passwords.
# Usage: bash rtsp-census.sh [seconds=20] [port=554]   (always "bash ...": /tmp on the NAS is noexec)
# The port argument lets the test rig be counted the same way (the pattern camera is on 8654).
set -euo pipefail
SECS=${1:-20}
PORT=${2:-554}
case "$SECS$PORT" in *[!0-9]*) echo "usage: bash $0 [seconds] [port] (both whole numbers); got '$SECS' '$PORT'" >&2; exit 2 ;; esac
for t in ss tcpdump timeout; do
  if ! command -v "$t" >/dev/null 2>&1 && ! sudo sh -c "command -v $t" >/dev/null 2>&1; then
    echo "census not run: '$t' isn't installed on this machine" >&2; exit 1
  fi
done
echo "== $(date -Is) established to :$PORT (count, camera IP, process) =="
sudo ss -tnp state established "( dport = :$PORT )" | awk 'NR>1 {n=split($4,a,":"); ip=a[1]; for(i=2;i<n;i++) ip=ip":"a[i]; p=$NF; sub(/^users:\(\("/,"",p); sub(/".*/,"",p); if (p=="") p="(no process: another namespace)"; print ip, p}' | sort | uniq -c
echo "== TIME-WAIT to :$PORT (closed in the last ~60 s) =="
sudo ss -tn state time-wait "( dport = :$PORT )" | awk 'NR>1 {n=split($4,a,":"); ip=a[1]; for(i=2;i<n;i++) ip=ip":"a[i]; print ip}' | sort | uniq -c
echo "== new connections (SYN) to :$PORT in ${SECS} s =="
out=$(mktemp); err=$(mktemp)
trap 'rm -f "$out" "$err"' EXIT
set +e
sudo timeout "$SECS" tcpdump -l -nn -q -i any "tcp dst port $PORT and tcp[tcpflags] & (tcp-syn|tcp-ack) == tcp-syn" >"$out" 2>"$err"
rc=$?
set -e
# timeout exits 124 when it ends tcpdump on schedule (the normal case); anything else is a real failure.
if [ "$rc" != 124 ] && [ "$rc" != 0 ]; then echo "tcpdump failed (exit $rc): $(tail -1 "$err")" >&2; exit 1; fi
grep -oE "> [0-9.]+\.$PORT" "$out" | sed -E "s/^> //; s/\.$PORT\$//" | sort | uniq -c || [ $? = 1 ]
# grep exits 1 for "no matches", which here just means zero new connections.
total=$(grep -c ' > ' "$out" || [ $? = 1 ])
echo "(total SYNs: ${total:-0})"
