#!/usr/bin/env bash
# Run the four-connection pool against a real tunnel — G1 criterion 4.
#
#   ./crates/protocol/tests/live/pool.sh builtin pool-spike
#   ./crates/protocol/tests/live/pool.sh 3021 pool-spike
#
# Same provisioning and cleanup as tunnel.sh; the difference is what it runs and for how long.
# The defaults are the criterion: 30 minutes, four connections, a forced disconnect every
# 5 minutes. Override with NPORT_POOL_MINUTES and NPORT_POOL_KILL_EVERY.
#
# The exit code is the verdict — the pool example prints a checklist and fails if any part of
# criterion 4 did not hold.

set -uo pipefail

PORT="${1:-builtin}"
SUBDOMAIN="${2:-pool-spike}"
API="${NPORT_BACKEND:-https://api.nport.link}"
export NPORT_POOL_MINUTES="${NPORT_POOL_MINUTES:-30}"
export NPORT_POOL_KILL_EVERY="${NPORT_POOL_KILL_EVERY:-300}"

for tool in curl jq dig; do
  command -v "$tool" >/dev/null || { echo "need $tool on PATH" >&2; exit 69; }
done

ROOT=$(git rev-parse --show-toplevel) || exit 69
cd "$ROOT" || exit 69
export PATH="$HOME/.cargo/bin:$PATH"

if [ "$PORT" = "builtin" ]; then
  echo "using the spike's built-in origin"
else
  if ! nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
    echo "nothing is listening on 127.0.0.1:$PORT — start your server first" >&2
    exit 69
  fi
  export NPORT_SPIKE_ORIGIN="$PORT"
  echo "local server on :$PORT is up"
fi

echo "building…"
cargo build --quiet -p nport-protocol --example pool || exit 70

RESPONSE=$(curl -sS --max-time 60 -X POST "$API" \
  -H 'content-type: application/json' \
  -d "{\"subdomain\":\"$SUBDOMAIN\"}")
TUNNEL_ID=$(printf '%s' "$RESPONSE" | jq -r '.tunnelId // empty')
if [ -z "$TUNNEL_ID" ]; then
  echo "could not create the tunnel:" >&2
  printf '%s' "$RESPONSE" | jq -r '.error // .message // "unparseable response"' >&2
  exit 70
fi
echo "tunnel $TUNNEL_ID"

# A 30-minute run is long enough that a leaked lease matters: v2 holds the subdomain for four
# hours. The trap covers Ctrl+C and any exit path.
cleanup() {
  echo
  echo "deleting the tunnel…"
  curl -sS --max-time 60 -X DELETE "$API" \
    -H 'content-type: application/json' \
    -d "{\"subdomain\":\"$SUBDOMAIN\",\"tunnelId\":\"$TUNNEL_ID\"}" |
    jq -r 'if .success then "deleted" else (.error // "delete failed") end'
}
trap cleanup EXIT INT TERM

printf 'waiting for DNS'
EDGE_IP=""
for _ in $(seq 1 60); do
  EDGE_IP=$(dig +short @1.1.1.1 "$SUBDOMAIN.nport.link" A 2>/dev/null | grep -E '^[0-9]' | head -1)
  [ -n "$EDGE_IP" ] && break
  printf '.'
  sleep 1
done
echo
[ -n "$EDGE_IP" ] || { echo "the record never resolved" >&2; exit 70; }

cat <<INFO

  https://$SUBDOMAIN.nport.link

  Running for ${NPORT_POOL_MINUTES} min. Traffic is optional — the criterion is that four
  connections stay registered across forced disconnects — but sending some proves the pool
  is actually routable throughout:

    while true; do
      curl -s -o /dev/null -w '%{http_code} ' \\
        --resolve $SUBDOMAIN.nport.link:443:$EDGE_IP https://$SUBDOMAIN.nport.link/
      sleep 5
    done

INFO

NPORT_TUNNEL_TOKEN=$(printf '%s' "$RESPONSE" | jq -r '.tunnelToken') \
  ./target/debug/examples/pool
