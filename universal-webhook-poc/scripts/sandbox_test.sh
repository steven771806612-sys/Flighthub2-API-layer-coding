#!/usr/bin/env bash
set -euo pipefail

################################################################################
# Universal Webhook POC (Redis Streams raw queue) - Sandbox E2E Test Script
#
# What it tests:
# 1) Start Redis (if needed)
# 2) Bootstrap default mapping + FlightHub2 config into Redis
# 3) Configure inbound auth for source=flighthub2 (static token)
# 4) Start API (FastAPI) + 2 Worker consumers
# 5) Verify inbound auth gate: unauth=401, wrong=401, ok=200
# 6) Verify raw queue grows and workers consume + push
#
# Notes:
# - POC decides `source` ONLY from request body.
# - Queue backend is Redis Streams only (single raw stream uw:webhook:raw).
# - FlightHub2 auth trio is maintained via Redis key uw:fhcfg:{source}.
################################################################################

PROJECT_DIR="/mnt/user-data/outputs/universal-webhook-poc"
cd "$PROJECT_DIR"

mkdir -p logs

echo "[1/7] (Optional) Install runtime deps (idempotent)"
# If your sandbox already has these, they will be skipped quickly.
if ! command -v redis-cli >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq redis-server redis-tools curl jq
fi

if ! python3 -c "import fastapi,uvicorn,redis,httpx,jsonpath_ng,pydantic_settings" >/dev/null 2>&1; then
  python3 -m pip install --quiet --no-input fastapi "uvicorn[standard]" redis httpx jsonpath-ng pydantic-settings
fi

echo "[2/7] Start Redis (daemon)"
redis-server --daemonize yes >/dev/null 2>&1 || true
redis-cli ping

echo "[3/7] Bootstrap Redis default mapping + FlightHub2 config"
python3 scripts/bootstrap_redis.py

echo "[4/7] Configure inbound auth for source=flighthub2 (static token)"
# Change this token anytime; input sources must send it in header X-MW-Token.
INBOUND_TOKEN="demo-in-token"
redis-cli set "uw:srcauth:flighthub2" "{\"enabled\":true,\"mode\":\"static_token\",\"header_name\":\"X-MW-Token\",\"token\":\"${INBOUND_TOKEN}\"}" >/dev/null

# OPTIONAL: If you want to protect admin endpoints, export ADMIN_TOKEN before start.
# Example:
#   export ADMIN_TOKEN="admin-secret"
# Then UI/POST admin calls must include header: X-Admin-Token: admin-secret

echo "[5/7] Stop previous API/Workers (if any), then start fresh"
# stop API
if [ -f logs/api.pid ]; then
  kill "$(cat logs/api.pid)" >/dev/null 2>&1 || true
fi
# stop workers (new style)
if [ -f logs/worker-1.pid ]; then kill "$(cat logs/worker-1.pid)" >/dev/null 2>&1 || true; fi
if [ -f logs/worker-2.pid ]; then kill "$(cat logs/worker-2.pid)" >/dev/null 2>&1 || true; fi
# stop legacy worker pid
if [ -f logs/worker.pid ]; then
  kill "$(cat logs/worker.pid)" >/dev/null 2>&1 || true
fi

sleep 0.6
rm -f logs/api.log logs/worker*.log

# Start API
bash scripts/run_api.sh

# Start workers (2 consumers)
bash scripts/run_worker.sh

# Wait API ready
for i in {1..30}; do
  if curl -s -o /dev/null -m 1 http://127.0.0.1:8000/docs; then
    break
  fi
  sleep 0.2
  if [ "$i" -eq 30 ]; then
    echo "ERROR: API not ready on 127.0.0.1:8000" >&2
    tail -n 200 logs/api.log || true
    exit 1
  fi
done

echo "[6/7] Run inbound auth gate tests"
code_unauth=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST http://127.0.0.1:8000/webhook \
  -H 'Content-Type: application/json' \
  -d '{"source":"flighthub2","webhook_event":{}}')

code_wrong=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST http://127.0.0.1:8000/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-MW-Token: wrong' \
  -d '{"source":"flighthub2","webhook_event":{}}')

code_ok=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST http://127.0.0.1:8000/webhook \
  -H 'Content-Type: application/json' \
  -H "X-MW-Token: ${INBOUND_TOKEN}" \
  -d '{"source":"flighthub2","webhook_event":{"timestamp":"2026-03-18T01:30:00Z","creator_id":"demo_user","latitude":22.543096,"longitude":114.057865,"level":"warning","description":"sandbox e2e test"}}')

echo "Expect: unauth=401 wrong=401 ok=200"
echo "Result: unauth=${code_unauth} wrong=${code_wrong} ok=${code_ok}"

if [ "$code_unauth" != "401" ] || [ "$code_wrong" != "401" ] || [ "$code_ok" != "200" ]; then
  echo "ERROR: inbound auth gate test failed" >&2
  echo "--- api.log"; tail -n 200 logs/api.log || true
  exit 2
fi

echo "[7/7] Verify raw queue + worker consumption"
len=$(redis-cli xlen uw:webhook:raw)
echo "raw stream len (uw:webhook:raw) = ${len}"

echo "-- latest 3 raw entries"
redis-cli xrange uw:webhook:raw - + COUNT 3 || true

# Give workers a moment to consume
sleep 2

echo "-- worker logs (tail)"
echo "--- worker-1.log"; tail -n 120 logs/worker-1.log 2>/dev/null || true
echo "--- worker-2.log"; tail -n 120 logs/worker-2.log 2>/dev/null || true

echo
echo "DONE. Useful endpoints:"
echo "- GUI:  http://127.0.0.1:8000/ui/"
echo "- Docs: http://127.0.0.1:8000/docs"
echo
echo "To change inbound auth token for flighthub2:"
echo "  redis-cli set uw:srcauth:flighthub2 '{\"enabled\":true,\"mode\":\"static_token\",\"header_name\":\"X-MW-Token\",\"token\":\"NEW\"}'"
