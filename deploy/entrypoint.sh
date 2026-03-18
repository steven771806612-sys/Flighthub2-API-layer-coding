#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────────────
# entrypoint.sh
# 用 Python 直接测试 Redis 连通性，完全不依赖 redis-cli
# 自动探测 Railway 所有可能的 Redis 环境变量名
# ─────────────────────────────────────────────────────────────────

echo "[entrypoint] === environment variables (REDIS related) ==="
env | grep -iE 'redis|REDIS' | sed 's/=.*/=***/' || echo "(none found)"
echo "[entrypoint] PORT=${PORT:-8000}"
echo "========================================================="

# ─── 用 Python 探测并等待 Redis ───────────────────────────────
python3 - <<'PYEOF'
import os, time, sys, urllib.parse

# Railway 可能注入的所有 Redis URL 变量名（按优先级排序）
candidates = [
    "REDIS_URL",
    "REDIS_PRIVATE_URL",
    "REDIS_PUBLIC_URL",
    "REDISURL",
    "REDIS_TLS_URL",
]

redis_url = None
for key in candidates:
    val = os.environ.get(key)
    if val:
        print(f"[entrypoint] using {key}={val[:30]}...")
        redis_url = val
        break

if not redis_url:
    print("[entrypoint] WARNING: no Redis URL env var found, falling back to 127.0.0.1:6379")
    redis_url = "redis://127.0.0.1:6379/0"

# 写回供 bash 后续使用
with open("/tmp/redis_url.env", "w") as f:
    f.write(f"RESOLVED_REDIS_URL={redis_url}\n")

# 等待 Redis 连通
try:
    import redis as redis_lib
except ImportError:
    print("[entrypoint] redis package not found, skipping wait")
    sys.exit(0)

print(f"[entrypoint] waiting for Redis at {redis_url[:40]}...")
for attempt in range(1, 61):
    try:
        r = redis_lib.from_url(redis_url, socket_connect_timeout=3, socket_timeout=3, decode_responses=True)
        r.ping()
        print(f"[entrypoint] Redis ready (attempt {attempt})")
        r.close()
        sys.exit(0)
    except Exception as e:
        print(f"[entrypoint] attempt {attempt}/60: {e}")
        time.sleep(1)

print("[entrypoint] ERROR: Redis not ready after 60s", file=sys.stderr)
sys.exit(1)
PYEOF

# ─── 加载解析出的 REDIS_URL ───────────────────────────────────
if [ -f /tmp/redis_url.env ]; then
  source /tmp/redis_url.env
  export REDIS_URL="${RESOLVED_REDIS_URL}"
  echo "[entrypoint] REDIS_URL set to ${REDIS_URL:0:40}..."
fi

# ─── 引导 Redis 默认配置（幂等）────────────────────────────────
echo "[entrypoint] bootstrapping Redis default config ..."
python3 scripts/bootstrap_redis.py && echo "[entrypoint] bootstrap OK" \
  || echo "[entrypoint] bootstrap warning (non-fatal)"

# ─── 启动 supervisord ──────────────────────────────────────────
PORT="${PORT:-8000}"
echo "[entrypoint] starting supervisord (API port=${PORT}) ..."
exec supervisord -c /app/deploy/supervisord.conf
