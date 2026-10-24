#!/bin/bash
# ipvlan shim: lets the NAS host (and host-networked containers like unscrypted) reach the
# containers on the questlog-lan ipvlan network, which the host can't talk to directly.
# hooptiej/unscrypted#11
#
#   ipvlan-shim.sh            apply: make the shim interface, address and routes (idempotent, runs at every boot)
#   ipvlan-shim.sh status     say what's there and what's missing (interface, address, routes, the boot entry); exit 1 if anything is
#   ipvlan-shim.sh install [DIR]
#                             copy this script to DIR (default: a nas-scripts folder next to this checkout's parent)
#                             and register it as a TrueNAS post-init command through midclt, so it survives a
#                             reboot (the interface and routes are runtime state and vanish otherwise). Idempotent:
#                             an existing entry is updated in place. Then applies.
#
# Before using it on another install, edit PARENT, ADDR (check it's free on the whole LAN and reserve it in
# DHCP) and APPS. Needs root (sudo) for apply/install.
set -euo pipefail
PARENT=enp2s0
SHIM=ipvlshim
ADDR=10.0.1.249/32
# ipvlan app addresses (questlog-lan). Only these get routed through the shim.
APPS="10.0.1.240 10.0.1.241 10.0.1.242 10.0.1.243 10.0.1.244 10.0.1.245 10.0.1.246 10.0.1.250"
COMMENT="ipvlan shim: host -> questlog-lan apps (hooptiej/unscrypted#11)"

die() { echo "ipvlan-shim: $*" >&2; exit 1; }

apply() {
  if ! ip link show "$SHIM" >/dev/null 2>&1; then
    ip link add "$SHIM" link "$PARENT" type ipvlan mode l2 || die "couldn't add $SHIM on $PARENT (is PARENT right? ip link show)"
  fi
  ip addr show dev "$SHIM" | grep -q "inet ${ADDR%/*}/" || ip addr add "$ADDR" dev "$SHIM"
  ip link set "$SHIM" up
  for a in $APPS; do
    ip route replace "$a/32" dev "$SHIM"
  done
  echo "ipvlan shim $SHIM up on $PARENT with $ADDR; routes for: $APPS"
}

# The post-init entry's id, or nothing. midclt is TrueNAS's middleware client; absent elsewhere.
boot_entry_id() {
  command -v midclt >/dev/null 2>&1 || return 0
  midclt call initshutdownscript.query 2>/dev/null | python3 -c '
import json, sys
for e in json.load(sys.stdin):
    if "ipvlan shim" in (e.get("comment") or "") or "ipvlan-shim.sh" in (e.get("command") or ""):
        print(e["id"]); break
' 2>/dev/null || true
}

status() {
  local missing=0
  if ip link show "$SHIM" >/dev/null 2>&1; then echo "ok       interface $SHIM exists (parent $PARENT)"; else echo "MISSING  interface $SHIM (run: sudo $0)"; missing=1; fi
  if ip addr show dev "$SHIM" 2>/dev/null | grep -q "inet ${ADDR%/*}/"; then echo "ok       address $ADDR on $SHIM"; else echo "MISSING  address $ADDR on $SHIM"; missing=1; fi
  for a in $APPS; do
    if ip route show "$a/32" 2>/dev/null | grep -q "dev $SHIM"; then echo "ok       route $a via $SHIM"; else echo "MISSING  route $a via $SHIM"; missing=1; fi
  done
  if ! command -v midclt >/dev/null 2>&1; then
    echo "n/a      boot entry: not a TrueNAS host (no midclt); make sure something runs '$0' at boot"
  else
    local id; id=$(boot_entry_id)
    if [ -n "$id" ]; then
      local line; line=$(midclt call initshutdownscript.query "[[\"id\",\"=\",$id]]" | python3 -c '
import json, sys
e = json.load(sys.stdin)[0]
print(("enabled" if e.get("enabled") else "DISABLED") + " " + (e.get("when") or "?") + " " + (e.get("command") or e.get("script") or "?"))')
      case "$line" in
        "enabled POSTINIT "*) echo "ok       boot entry #$id: $line" ;;
        *) echo "WRONG    boot entry #$id: $line (want enabled, POSTINIT; run: sudo $0 install)"; missing=1 ;;
      esac
    else
      echo "MISSING  boot entry (TrueNAS post-init command); the shim would vanish on reboot. Run: sudo $0 install"; missing=1
    fi
  fi
  if [ "$missing" -ne 0 ]; then echo "ipvlan-shim: something is missing (see above)"; return 1; fi
  echo "ipvlan-shim: all present; survives a reboot"
}

install() {
  command -v midclt >/dev/null 2>&1 || die "install needs TrueNAS's midclt (not found); register '$0' to run at boot by hand instead"
  local self; self=$(readlink -f "$0")
  local dir="${1:-$(dirname "$(dirname "$(dirname "$(dirname "$self")")")")/nas-scripts}"
  mkdir -p "$dir"
  local dest="$dir/ipvlan-shim.sh"
  if [ "$dest" != "$self" ]; then cp "$self" "$dest"; chmod 755 "$dest"; echo "copied to $dest"; fi
  local cmd="bash '$dest'"
  local id; id=$(boot_entry_id)
  local body="{\"type\":\"COMMAND\",\"command\":$(printf '%s' "$cmd" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),\"when\":\"POSTINIT\",\"enabled\":true,\"timeout\":30,\"comment\":\"$COMMENT\"}"
  if [ -n "$id" ]; then
    midclt call initshutdownscript.update "$id" "$body" >/dev/null || die "midclt couldn't update post-init entry #$id"
    echo "updated TrueNAS post-init entry #$id: $cmd"
  else
    id=$(midclt call initshutdownscript.create "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])') || die "midclt couldn't create the post-init entry"
    echo "created TrueNAS post-init entry #$id: $cmd"
  fi
  bash "$dest"
}

case "${1:-apply}" in
  apply) apply ;;
  status) status ;;
  install) shift; install "$@" ;;
  *) die "unknown command '$1' (apply | status | install [DIR])" ;;
esac
