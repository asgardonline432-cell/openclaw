#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────────
# E2E smoke test: local-external-cron-scheduler extension (Docker)
#
# Tests the cron_changed hook and the local-external-cron-scheduler extension
# inside a Docker container. Verifies all cron job lifecycle events produce
# correct JSON state file updates.
#
# Usage:
#   bash scripts/e2e/external-cron-scheduler-docker.sh
#
# Environment:
#   OPENCLAW_IMAGE / OPENCLAW_DOCKER_E2E_IMAGE — pre-built Docker image to use
#   OPENCLAW_SKIP_DOCKER_BUILD=1               — skip image build (reuse existing)
#   CRON_INTERVAL_MS                           — cron interval for fire test
#                                                (default: 10000 = 10s)
# ────────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-ext-cron-scheduler-e2e" OPENCLAW_IMAGE)"
PORT="18789"
TOKEN="ext-cron-e2e-$(date +%s)-$$"
CONTAINER_NAME="openclaw-ext-cron-scheduler-e2e-$$"
CLIENT_LOG="$(mktemp -t openclaw-ext-cron-client-log.XXXXXX)"
CRON_INTERVAL_MS="${CRON_INTERVAL_MS:-10000}"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$CLIENT_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" external-cron-scheduler

echo "Running in-container external-cron-scheduler smoke..."
set +e
docker run --rm \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  -e "OPENCLAW_STATE_DIR=/tmp/openclaw-state" \
  -e "OPENCLAW_CONFIG_PATH=/tmp/openclaw-state/openclaw.json" \
  -e "GW_URL=ws://127.0.0.1:$PORT" \
  -e "GW_TOKEN=$TOKEN" \
  -e "CRON_INTERVAL_MS=$CRON_INTERVAL_MS" \
  -e "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
    entry=dist/index.mjs
    [ -f \"\$entry\" ] || entry=dist/index.js

    # ── Mock OpenAI server ──────────────────────────────────────────────
    export MOCK_PORT=44081
    export SUCCESS_MARKER=OPENCLAW_EXT_CRON_E2E_OK
    export MOCK_REQUEST_LOG=/tmp/ext-cron-mock-openai-requests.jsonl
    export OPENCLAW_DOCKER_OPENAI_BASE_URL=\"http://127.0.0.1:\$MOCK_PORT/v1\"
    node scripts/e2e/mock-openai-server.mjs >/tmp/ext-cron-mock-openai.log 2>&1 &
    mock_pid=\$!

    # ── Seed config ─────────────────────────────────────────────────────
    node --import tsx scripts/e2e/external-cron-scheduler-seed.ts >/tmp/ext-cron-seed.log

    # ── Start gateway ───────────────────────────────────────────────────
    node \"\$entry\" gateway --port $PORT --bind loopback --allow-unconfigured >/tmp/ext-cron-gateway.log 2>&1 &
    gateway_pid=\$!

    cleanup_inner() {
      kill \"\$mock_pid\" >/dev/null 2>&1 || true
      kill \"\$gateway_pid\" >/dev/null 2>&1 || true
      wait \"\$mock_pid\" >/dev/null 2>&1 || true
      wait \"\$gateway_pid\" >/dev/null 2>&1 || true
    }
    dump_logs_on_error() {
      status=\$?
      if [ \"\$status\" -ne 0 ]; then
        echo '=== Gateway log (last 80 lines) ==='
        tail -n 80 /tmp/ext-cron-gateway.log 2>/dev/null || true
        echo '=== Seed log ==='
        cat /tmp/ext-cron-seed.log 2>/dev/null || true
        echo '=== Mock OpenAI log ==='
        cat /tmp/ext-cron-mock-openai.log 2>/dev/null || true
      fi
      cleanup_inner
      exit \"\$status\"
    }
    trap cleanup_inner EXIT
    trap dump_logs_on_error ERR

    # ── Wait for mock ───────────────────────────────────────────────────
    for _ in \$(seq 1 80); do
      if node -e \"fetch('http://127.0.0.1:' + process.env.MOCK_PORT + '/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"; then
        break
      fi
      sleep 0.1
    done
    node -e \"fetch('http://127.0.0.1:' + process.env.MOCK_PORT + '/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"

    # ── Wait for gateway ────────────────────────────────────────────────
    gateway_ready=0
    for _ in \$(seq 1 300); do
      if grep -q '\[gateway\] ready' /tmp/ext-cron-gateway.log 2>/dev/null; then
        gateway_ready=1
        break
      fi
      sleep 0.25
    done
    if [ \"\$gateway_ready\" -ne 1 ]; then
      echo 'Gateway did not become ready'
      tail -n 120 /tmp/ext-cron-gateway.log 2>/dev/null || true
      exit 1
    fi

    # ── Run client tests ────────────────────────────────────────────────
    node --import tsx scripts/e2e/external-cron-scheduler-docker-client.ts
  " >"$CLIENT_LOG" 2>&1
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker external-cron-scheduler smoke failed"
  cat "$CLIENT_LOG"
  exit "$status"
fi

# Show test output on success too
cat "$CLIENT_LOG"
echo ""
echo "OK"
