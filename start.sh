#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# The BFF proxies /api/* to the Chemclaw3 FastAPI service
export CHEMCLAW_API_URL="${CHEMCLAW_API_URL:-http://127.0.0.1:8080}"
export AUTH_MODE="${AUTH_MODE:-dev}"
export BIND_HOST="${BIND_HOST:-0.0.0.0}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export APP_VERSION="${APP_VERSION:-dev}"
export SSE_HEARTBEAT_MS="${SSE_HEARTBEAT_MS:-15000}"
export UPSTREAM_CONNECT_TIMEOUT_MS="${UPSTREAM_CONNECT_TIMEOUT_MS:-10000}"
# PORT is assigned by Replit or falls back to 8099
export PORT="${PORT:-8099}"

# Tell the BFF where its built client assets are
export CLIENT_DIR="$SCRIPT_DIR/dist/client"

# Build client if not already built
if [ ! -d "$CLIENT_DIR" ]; then
  echo "Building client assets..."
  npm run build:client
fi

echo "Starting Chemclaw3 UI (BFF) on http://${BIND_HOST}:${PORT}"
echo "  Proxying /api -> ${CHEMCLAW_API_URL}"
echo "  Auth mode    : ${AUTH_MODE}"

# Node 22+ strips TypeScript types natively — no build step needed for the server
exec node --experimental-strip-types server/index.ts
