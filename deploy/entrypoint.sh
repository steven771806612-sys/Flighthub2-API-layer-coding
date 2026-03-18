#!/bin/bash
# entrypoint.sh — Railway-compatible startup script
# 故意不使用 set -e，每步单独处理，避免非致命失败杀死容器

# ── 1. 诊断信息 ──────────────────────────────────────────────────────────────
echo "================================================================"
echo "[entrypoint] Universal Webhook Middleware — startup"
echo "[entrypoint] Date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "[entrypoint] PORT=${PORT:-<not set>}"
echo "----------------------------------------------------------------"
echo "[entrypoint] All REDIS-related env vars:"
env | grep -iE '^REDIS' | sed 's/=.*/=***/' || echo "  (none found)"
echo "================================================================"

# ── 2. 解析 REDIS_URL（兼容 Railway 所有可能的变量名）────────────────────────
REDIS_URL_RESOLVED=$(python3 - <<'PYEOF'
import os, sys

# Railway 可能注入的所有 Redis 变量名
candidates = [
    "REDIS_URL",
    "REDIS_PRIVATE_URL",
    "REDIS_PUBLIC_URL",
    "REDISURL",
    "REDIS_TLS_URL",
]

for key in candidates:
    val = os.environ.get(key, "").strip()
    if val:
        print(f"[entrypoint] found Redis URL in env var: {key}", file=sys.stderr)
        print(val)   # stdout → 由 bash 捕获
        sys.exit(0)

print("[entrypoint] WARNING: no Redis env var found, falling back to localhost", file=sys.stderr)
print("redis://127.0.0.1:6379/0")
PYEOF
)

export REDIS_URL="${REDIS_URL_RESOLVED}"
# 打印脱敏的 URL（只显示前 40 字符）
echo "[entrypoint] REDIS_URL = ${REDIS_URL:0:40}..."

# ── 3. 确定并 export PORT（Railway 动态注入 $PORT，未设置时默认 8000）───────────
export PORT="${PORT:-8000}"
echo "[entrypoint] API PORT = ${PORT}"

# ── 4. 等待 Redis 就绪（最多 90 次，每次 2s = 最长 3 分钟）──────────────────
echo "[entrypoint] Waiting for Redis to become ready..."

MAX_TRIES=90
REDIS_READY=0

for i in $(seq 1 ${MAX_TRIES}); do
    RESULT=$(python3 - <<PYEOF 2>&1
import redis, os, sys
url = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")
try:
    r = redis.from_url(url, socket_connect_timeout=3, socket_timeout=3)
    r.ping()
    r.close()
    print("OK")
    sys.exit(0)
except Exception as e:
    print(f"ERR: {e}")
    sys.exit(1)
PYEOF
    )
    if echo "$RESULT" | grep -q "^OK"; then
        echo "[entrypoint] Redis ready ✓ (attempt ${i}/${MAX_TRIES})"
        REDIS_READY=1
        break
    fi
    echo "[entrypoint] attempt ${i}/${MAX_TRIES}: ${RESULT}"
    sleep 2
done

if [ "$REDIS_READY" -ne 1 ]; then
    echo "[entrypoint] FATAL: Redis not reachable after ${MAX_TRIES} attempts" >&2
    echo "[entrypoint] Last result: ${RESULT}" >&2
    echo "[entrypoint] Current REDIS_URL: ${REDIS_URL:0:60}" >&2
    echo "[entrypoint] Please verify Redis service is linked in Railway dashboard" >&2
    exit 1
fi

# ── 5. 引导 Redis 默认配置（幂等，失败不阻断启动）───────────────────────────
echo "[entrypoint] Running Redis bootstrap..."
cd /app || true
if python3 scripts/bootstrap_redis.py 2>&1; then
    echo "[entrypoint] Bootstrap OK ✓"
else
    echo "[entrypoint] Bootstrap WARNING: non-fatal, continuing..." >&2
fi

# ── 6. 启动 supervisord（前台运行，接管所有子进程）─────────────────────────
echo "[entrypoint] Starting supervisord (PORT=${PORT})..."
exec supervisord -c /app/deploy/supervisord.conf
