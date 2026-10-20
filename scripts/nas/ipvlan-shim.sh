#!/bin/bash
# ipvlan shim: lets the NAS host (and host-networked containers like unscrypted) reach the
# containers on the questlog-lan ipvlan network, which the host can't talk to directly.
# Idempotent: safe to run at every boot (TrueNAS post-init) and by hand. hooptiej/unscrypted#11
set -euo pipefail
PARENT=enp2s0
SHIM=ipvlshim
ADDR=10.0.1.249/32
# ipvlan app addresses (questlog-lan). Only these get routed through the shim.
APPS="10.0.1.240 10.0.1.241 10.0.1.242 10.0.1.243 10.0.1.244 10.0.1.245 10.0.1.246 10.0.1.250"

if ! ip link show "$SHIM" >/dev/null 2>&1; then
  ip link add "$SHIM" link "$PARENT" type ipvlan mode l2
fi
ip addr show dev "$SHIM" | grep -q "inet ${ADDR%/*}/" || ip addr add "$ADDR" dev "$SHIM"
ip link set "$SHIM" up
for a in $APPS; do
  ip route replace "$a/32" dev "$SHIM"
done
echo "ipvlan shim $SHIM up on $PARENT with $ADDR; routes for: $APPS"
