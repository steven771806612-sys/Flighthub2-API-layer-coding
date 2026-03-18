# ═══════════════════════════════════════════════════════════════════
# Stage 1 — Python 依赖安装
# ═══════════════════════════════════════════════════════════════════
FROM python:3.12-slim AS py-builder

WORKDIR /build

COPY requirements.txt .

RUN pip install --upgrade pip --quiet && \
    pip install --prefix=/install -r requirements.txt --quiet

# ═══════════════════════════════════════════════════════════════════
# Stage 2 — React 前端构建
#   WORKDIR = /workspace/frontend
#   vite outDir = ../app/static/console → /workspace/app/static/console
# ═══════════════════════════════════════════════════════════════════
FROM node:20-slim AS fe-builder

WORKDIR /workspace/frontend

# 先复制 package 文件（利用 layer cache）
COPY frontend/package.json frontend/package-lock.json ./

# 使用 npm install 代替 npm ci --prefer-offline，避免缓存丢失报错
RUN npm install --prefer-offline 2>/dev/null || npm install

# 复制全部前端源码
COPY frontend/ ./

# 确保输出目录存在
RUN mkdir -p /workspace/app/static/console

# 构建 — vite 将产物写入 /workspace/app/static/console
RUN npm run build

# 验证产物（构建失败则 Docker build 中止）
RUN echo "=== fe-builder: built assets ===" && ls -la /workspace/app/static/console/

# ═══════════════════════════════════════════════════════════════════
# Stage 3 — 最终运行镜像
# ═══════════════════════════════════════════════════════════════════
FROM python:3.12-slim

# 最小系统依赖
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# 从 py-builder 安装 Python 包
COPY --from=py-builder /install /usr/local

# 创建运行时目录
RUN mkdir -p /var/log/supervisor /app/logs

WORKDIR /app

# 复制后端源码（不含 static/console，由 fe-builder 产物覆盖）
COPY app/     ./app/
COPY worker/  ./worker/
COPY scripts/ ./scripts/
COPY deploy/  ./deploy/

# 从 fe-builder 复制前端产物 → /app/app/static/console/
COPY --from=fe-builder /workspace/app/static/console/ ./app/static/console/

# 验证控制台文件
RUN echo "=== runtime: console assets ===" && ls -la /app/app/static/console/

# 赋予 entrypoint 可执行权限
RUN chmod +x /app/deploy/entrypoint.sh

# Railway 动态注入 $PORT（此处仅作文档用途）
EXPOSE 8000

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    PORT=8000 \
    REDIS_URL=redis://127.0.0.1:6379/0

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
