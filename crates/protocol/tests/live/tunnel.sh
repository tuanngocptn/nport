#!/usr/bin/env bash
# Expose a local port through a real *.nport.link URL using the Phase 1 spike.
#
#   ./crates/protocol/tests/live/tunnel.sh 3008 [subdomain] [seconds]
#
# Provisions a tunnel through the **live v2 API**, runs the spike against it, and deletes
# the tunnel on exit. This is a manual live-edge driver, not a test — `cargo test` never
# runs it.
#
# Three things it is careful about, each learned the hard way:
#
#   * The token travels in the environment, never in argv. `ps` shows argv to every local
#     user, which is exactly the v2 defect this rewrite exists to fix.
#   * DNS is polled before printing the URL. The v2 create call returns 6-18 s before the
#     record resolves, and the record is proxied, so `dig CNAME` answers nothing while A
#     records do.
#   * Cleanup runs from a trap, so Ctrl+C still deletes the tunnel. A leaked lease holds
#     the subdomain until v2's 4-hour expiry.
#
# HTTP only for now. WebSocket is spike sub-step 6 (docs/ROADMAP.md).

set -uo pipefail

PORT="${1:-}"
SUBDOMAIN="${2:-spike}"
SECONDS_TO_SERVE="${3:-300}"
API="${NPORT_BACKEND:-https://api.nport.link}"

if [ -z "$PORT" ]; then
  echo "usage: $0 <local-port> [subdomain] [seconds]" >&2
  exit 64
fi

for tool in curl jq dig; do
  command -v "$tool" >/dev/null || { echo "need $tool on PATH" >&2; exit 69; }
done

ROOT=$(git rev-parse --show-toplevel) || exit 69
cd "$ROOT" || exit 69
export PATH="$HOME/.cargo/bin:$PATH"

# Fail before provisioning anything if the local port is dead.
if ! nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  echo "nothing is listening on 127.0.0.1:$PORT — start your server first" >&2
  exit 69
fi
echo "local server on :$PORT is up"

echo "building the spike…"
cargo build --quiet -p nport-protocol --example spike || exit 70

RESPONSE=$(curl -sS --max-time 60 -X POST "$API" \
  -H 'content-type: application/json' \
  -d "{\"subdomain\":\"$SUBDOMAIN\"}")
TUNNEL_ID=$(printf '%s' "$RESPONSE" | jq -r '.tunnelId // empty')
if [ -z "$TUNNEL_ID" ]; then
  # v2 returns its taxonomy as a string inside a 500 (defect R1), so there is nothing
  # better to branch on than the message.
  echo "could not create the tunnel:" >&2
  printf '%s' "$RESPONSE" | jq -r '.error // .message // "unparseable response"' >&2
  exit 70
fi
echo "tunnel $TUNNEL_ID"

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
  # Capture the address from the lookup that succeeded. Re-querying afterwards raced and
  # printed an empty hint.
  EDGE_IP=$(dig +short @1.1.1.1 "$SUBDOMAIN.nport.link" A 2>/dev/null | grep -E '^[0-9]' | head -1)
  [ -n "$EDGE_IP" ] && break
  printf '.'
  sleep 1
done
echo
[ -n "$EDGE_IP" ] || { echo "the record never resolved" >&2; exit 70; }
cat <<INFO

  https://$SUBDOMAIN.nport.link  →  127.0.0.1:$PORT

  Serving for ${SECONDS_TO_SERVE}s. Ctrl+C to stop early.

  The first request or two may return 530 (Cloudflare error 1033) while the edge
  starts routing to the new connection — retry, it clears in a second or two.

  If your machine cached the NXDOMAIN from before this record existed, bypass the
  system resolver:
    curl --resolve $SUBDOMAIN.nport.link:443:$EDGE_IP https://$SUBDOMAIN.nport.link/

INFO

NPORT_TUNNEL_TOKEN=$(printf '%s' "$RESPONSE" | jq -r '.tunnelToken') \
  NPORT_SPIKE_ORIGIN="$PORT" \
  NPORT_SPIKE_SERVE_SECS="$SECONDS_TO_SERVE" \
  ./target/debug/examples/spike
