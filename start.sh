#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# The BFF proxies /api/* to the Chemclaw3 FastAPI service
export CHEMCLAW_API_URL="${CHEMCLAW_API_URL:-http://127.0.0.1:8000}"
export AUTH_MODE="${AUTH_MODE:-dev}"
export BIND_HOST="${BIND_HOST:-0.0.0.0}"
# NOT defaulted. `validateConfig` refuses to serve AUTH_MODE=dev on a non-loopback bind unless the
# exposure is written down, and a value this script writes down for you is not a record of anyone's
# decision — it is the refusal cancelled in advance. A reachable dev instance (Replit, a shared
# box) is a deliberate thing to want, so say so when starting it:
#
#   ALLOW_INSECURE_AUTH=true ./start.sh
#
# Same for ALLOW_FRAMING, which the preview iframe needs and nothing else does.
export ALLOW_INSECURE_AUTH="${ALLOW_INSECURE_AUTH:-false}"
export ALLOW_FRAMING="${ALLOW_FRAMING:-false}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export APP_VERSION="${APP_VERSION:-dev}"
export SSE_HEARTBEAT_MS="${SSE_HEARTBEAT_MS:-15000}"
export UPSTREAM_CONNECT_TIMEOUT_MS="${UPSTREAM_CONNECT_TIMEOUT_MS:-10000}"
# PORT is assigned by Replit or falls back to 8100
export PORT="${PORT:-8099}"

# The HTML sandbox is ON by default in every other launcher (compose, `npm run dev`, the browser
# suite, kind) and deliberately OFF here, because this script is what a hosted preview (Replit)
# runs and nothing here can say reliably where the browser would reach a SECOND listener:
#
#   - the platform publishes a public hostname (REPLIT_DEV_DOMAIN, REPLIT_DOMAINS), but the sandbox
#     needs a second externally reachable port, and that mapping lives in a `.replit` `[[ports]]`
#     table this repository does not ship (and a published Replit deployment exposes one port);
#   - a guessed origin is worse than none: `localhost` is the VIEWER's own machine, so a default
#     would frame whatever the viewer runs on that port and post the artefact's HTML to it.
#
# So HTML artefacts are shown as escaped source here, and the BFF says so in one startup line. To
# run it, name both origins exactly as the browser reaches them and route a distinct hostname (or
# at least a published port) to SANDBOX_PORT (README, "HTML sandbox"):
#
#   SANDBOX_ORIGIN=https://sandbox.example APP_ORIGIN=https://ui.example SANDBOX_PORT=8100 ./start.sh
#
# ALLOW_FRAMING=true (the preview iframe) turns the sandbox off again whatever is set: a framed app
# cannot frame the sandbox, whose frame-ancestors names APP_ORIGIN alone.

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
echo "  HTML sandbox : ${SANDBOX_ORIGIN:-off on a hosted preview (HTML artefacts shown as source; README, \"HTML sandbox\")}"

# Node 22+ strips TypeScript types natively — no build step needed for the server
exec node --experimental-strip-types server/index.ts
