#!/usr/bin/env bash
set -euo pipefail
cd /mnt/user-data/outputs/universal-webhook-poc
export PYTHONPATH=/mnt/user-data/outputs/universal-webhook-poc
export PYTHONUNBUFFERED=1
nohup python3 -u -m uvicorn app.main:app --host 127.0.0.1 --port 8000 > logs/api.log 2>&1 &
echo $! > logs/api.pid
sleep 0.3
echo "API started pid=$(cat logs/api.pid)"
