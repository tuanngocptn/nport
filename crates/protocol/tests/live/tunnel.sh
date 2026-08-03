#!/usr/bin/env bash
# Expose a local port through a real *.nport.link URL using the Phase 1 spike.
#
#   ./crates/protocol/tests/live/tunnel.sh 3008 [subdomain] [seconds]
#   ./crates/protocol/tests/live/tunnel.sh builtin ws-spike 180
#
# `builtin` skips the port probe and uses the spike's own origin: a fixed body over HTTP and
# an echo over WebSocket. That is what the `ws_client` example needs — G1 criterion 3.
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
# HTTP and WebSocket. TCP is out of scope for 3.0 (ADR-0020).

set -uo pipefail

PORT="${1:-}"
SUBDOMAIN="${2:-spike}"
SECONDS_TO_SERVE="${3:-300}"
API="${NPORT_BACKEND:-https://api.nport.link}"

if [ -z "$PORT" ]; then
  echo "usage: $0 <local-port|builtin> [subdomain] [seconds]" >&2
  exit 64
fi

for tool in curl jq dig; do
  command -v "$tool" >/dev/null || { echo "need $tool on PATH" >&2; exit 69; }
done

ROOT=$(git rev-parse --show-toplevel) || exit 69
cd "$ROOT" || exit 69
export PATH="$HOME/.cargo/bin:$PATH"

# Fail before provisioning anything if the local port is dead.
if [ "$PORT" = "builtin" ]; then
  echo "using the spike's built-in origin (http fixed body + websocket echo)"
else
  if ! nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
    echo "nothing is listening on 127.0.0.1:$PORT — start your server first" >&2
    exit 69
  fi
  echo "local server on :$PORT is up"
fi

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
if [ "$PORT" = "builtin" ]; then
  TARGET="the spike's built-in origin"
else
  TARGET="127.0.0.1:$PORT"
fi
cat <<INFO

  https://$SUBDOMAIN.nport.link  →  $TARGET

  Serving for ${SECONDS_TO_SERVE}s. Ctrl+C to stop early.

  WebSocket echo check, in another terminal (G1 criterion 3):
    cargo run -p nport-protocol --example ws_client -- wss://$SUBDOMAIN.nport.link/
    NPORT_WS_RESOLVE=$EDGE_IP cargo run -p nport-protocol --example ws_client -- \\
      wss://$SUBDOMAIN.nport.link/            # if your resolver cached the NXDOMAIN

  The first request or two may return 530 (Cloudflare error 1033) while the edge
  starts routing to the new connection — retry, it clears in a second or two.

  If your machine cached the NXDOMAIN from before this record existed, bypass the
  system resolver:
    curl --resolve $SUBDOMAIN.nport.link:443:$EDGE_IP https://$SUBDOMAIN.nport.link/

INFO

if [ "$PORT" = "builtin" ]; then
  # Leaving NPORT_SPIKE_ORIGIN unset is what selects the built-in origin.
  NPORT_TUNNEL_TOKEN=$(printf '%s' "$RESPONSE" | jq -r '.tunnelToken') \
    NPORT_SPIKE_SERVE_SECS="$SECONDS_TO_SERVE" \
    ./target/debug/examples/spike
else
  NPORT_TUNNEL_TOKEN=$(printf '%s' "$RESPONSE" | jq -r '.tunnelToken') \
    NPORT_SPIKE_ORIGIN="$PORT" \
    NPORT_SPIKE_SERVE_SECS="$SECONDS_TO_SERVE" \
    ./target/debug/examples/spike
fi
