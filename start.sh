#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# The BFF proxies /api/* to the Chemclaw3 FastAPI service
export CHEMCLAW_API_URL="${CHEMCLAW_API_URL:-http://127.0.0.1:8000}"
export AUTH_MODE="${AUTH_MODE:-dev}"
export BIND_HOST="${BIND_HOST:-0.0.0.0}"
# This script's whole purpose is a reachable dev instance on Replit, so dev auth on a non-loopback
# bind is the intent rather than an accident — and `validateConfig` now refuses to start without
# this said out loud. Overridable, so pointing start.sh at a real tenant does not carry the opt-out
# along with it.
export ALLOW_INSECURE_AUTH="${ALLOW_INSECURE_AUTH:-true}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export APP_VERSION="${APP_VERSION:-dev}"
export SSE_HEARTBEAT_MS="${SSE_HEARTBEAT_MS:-15000}"
export UPSTREAM_CONNECT_TIMEOUT_MS="${UPSTREAM_CONNECT_TIMEOUT_MS:-10000}"
# PORT is assigned by Replit or falls back to 8100
export PORT="${PORT:-8099}"

# Tell the BFF where its built client assets are
export CLIENT_DIR="$SCRIPT_DIR/dist/client"

# Build client if not already built. ALLOW_DEV_AUTH tracks AUTH_MODE: a production bundle only
# carries the no-token provider when this script is actually going to select it, so a start.sh run
# against a real tenant produces a bundle with no dev provider in it at all.
if [ ! -d "$CLIENT_DIR" ]; then
  echo "Building client assets..."
  if [ "$AUTH_MODE" = "dev" ]; then
    ALLOW_DEV_AUTH=true npm run build:client
  else
    npm run build:client
  fi
fi

echo "Starting Chemclaw3 UI (BFF) on http://${BIND_HOST}:${PORT}"
echo "  Proxying /api -> ${CHEMCLAW_API_URL}"
echo "  Auth mode    : ${AUTH_MODE}"

# Node 22+ strips TypeScript types natively — no build step needed for the server
exec node --experimental-strip-types server/index.ts
