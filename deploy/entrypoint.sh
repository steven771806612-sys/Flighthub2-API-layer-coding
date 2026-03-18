#!/bin/bash
# entrypoint.sh — Railway-compatible startup script
# 不使用 set -e，每个步骤单独处理错误，避免非致命失败终止容器

# ── 1. 打印诊断信息 ────────────────────────────────────────────────────────────
echo "[entrypoint] ====== startup ======"
echo "[entrypoint] PORT=${PORT:-8000}"
echo "[entrypoint] REDIS env vars:"
env | grep -iE '^REDIS' | sed 's/=.*/=***/' || echo "  (none found)"
echo "[entrypoint] ====================="

# ── 2. 解析 REDIS_URL（探测所有 Railway 可能的变量名）──────────────────────────
REDIS_URL_RESOLVED=$(python3 - <<'PYEOF'
import os, sys

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
        print(f"[entrypoint] found Redis URL in {key}", file=sys.stderr)
        print(val)   # stdout → captured by bash
        sys.exit(0)

print("[entrypoint] WARNING: no Redis env var found, using default", file=sys.stderr)
print("redis://127.0.0.1:6379/0")
PYEOF
)

export REDIS_URL="${REDIS_URL_RESOLVED}"
echo "[entrypoint] REDIS_URL resolved to: ${REDIS_URL:0:50}..."

# ── 3. 等待 Redis 就绪（60次重试，每次 1s）─────────────────────────────────────
echo "[entrypoint] waiting for Redis..."

REDIS_READY=0
for i in $(seq 1 60); do
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
        echo "[entrypoint] Redis ready at attempt ${i}"
        REDIS_READY=1
        break
    fi
    echo "[entrypoint] attempt ${i}/60: ${RESULT}"
    sleep 1
done

if [ "$REDIS_READY" -ne 1 ]; then
    echo "[entrypoint] FATAL: Redis not reachable after 60s" >&2
    echo "[entrypoint] Last error: ${RESULT}" >&2
    exit 1
fi

# ── 4. 写 PORT 到 supervisord 环境变量（解决 %(ENV_PORT)s 为空的问题）───────────
RUNTIME_PORT="${PORT:-8000}"
echo "[entrypoint] API will listen on port ${RUNTIME_PORT}"

# supervisord 通过进程环境变量读取 %(ENV_PORT)s
# 必须在 exec 前 export，supervisord 会继承父进程环境
export PORT="${RUNTIME_PORT}"

# ── 5. 引导 Redis 默认配置（幂等，失败不阻断启动）───────────────────────────────
echo "[entrypoint] bootstrapping Redis defaults..."
if python3 scripts/bootstrap_redis.py; then
    echo "[entrypoint] bootstrap OK"
else
    echo "[entrypoint] bootstrap WARNING: non-fatal, continuing..." >&2
fi

# ── 6. 启动 supervisord（前台运行，接管进程生命周期）────────────────────────────
echo "[entrypoint] starting supervisord..."
exec supervisord -c /app/deploy/supervisord.conf
