#!/usr/bin/env bash
set -euo pipefail
cd /mnt/user-data/outputs/universal-webhook-poc
export PYTHONPATH=/mnt/user-data/outputs/universal-webhook-poc
export PYTHONUNBUFFERED=1
# Start 2 consumers by default (can be changed by editing this script)
STREAM_GROUP=${STREAM_GROUP:-uw-worker-group}
STREAM_KEY_RAW=${STREAM_KEY_RAW:-uw:webhook:raw}

nohup env STREAM_CONSUMER=worker-1 STREAM_GROUP="$STREAM_GROUP" STREAM_KEY_RAW="$STREAM_KEY_RAW" python3 -u worker/worker.py > logs/worker-1.log 2>&1 &
echo $! > logs/worker-1.pid

nohup env STREAM_CONSUMER=worker-2 STREAM_GROUP="$STREAM_GROUP" STREAM_KEY_RAW="$STREAM_KEY_RAW" python3 -u worker/worker.py > logs/worker-2.log 2>&1 &
echo $! > logs/worker-2.pid
sleep 0.3
echo "Workers started pid1=$(cat logs/worker-1.pid) pid2=$(cat logs/worker-2.pid)"
