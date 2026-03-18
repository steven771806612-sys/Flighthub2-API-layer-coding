# ─────────────────────────────────────────────────────────────────
# Stage 1: Python 依赖构建
# ─────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS py-builder

WORKDIR /build

COPY requirements.txt .

RUN pip install --upgrade pip && \
    pip install --prefix=/install -r requirements.txt

# ─────────────────────────────────────────────────────────────────
# Stage 2: Node.js 前端构建
# workdir 设为 /app（与后端一致），frontend/ 放在 /app/frontend/
# vite outDir = /app/app/static/console（绝对路径解析后）
# 改用 /build/frontend workdir 避免路径混淆
# ─────────────────────────────────────────────────────────────────
FROM node:20-slim AS fe-builder

WORKDIR /workspace

# 仅复制 package 文件，利用 Docker layer cache
COPY frontend/package.json frontend/package-lock.json ./frontend/

RUN cd frontend && npm ci --prefer-offline

# 复制全部前端源码
COPY frontend/ ./frontend/

# 临时创建 app/static 目录以满足 vite outDir 的绝对路径
RUN mkdir -p ./app/static/console

# 在 frontend/ 子目录中构建，产物输出到 ../app/static/console → /workspace/app/static/console
RUN cd frontend && npm run build

# 验证产物存在
RUN ls -la /workspace/app/static/console/

# ─────────────────────────────────────────────────────────────────
# Stage 3: 最终运行镜像
# ─────────────────────────────────────────────────────────────────
FROM python:3.12-slim

# 最小系统依赖（curl 用于容器内健康检查调试）
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# 从 py-builder 复制已安装的 Python 包
COPY --from=py-builder /install /usr/local

# 创建必要目录
RUN mkdir -p /var/log/supervisor /app/logs

WORKDIR /app

# 复制后端源码
COPY app/     ./app/
COPY worker/  ./worker/
COPY scripts/ ./scripts/
COPY deploy/  ./deploy/

# 从 fe-builder 复制前端构建产物
COPY --from=fe-builder /workspace/app/static/console/ ./app/static/console/

# 验证控制台文件存在
RUN ls -la /app/app/static/console/ 2>/dev/null || ls -la /app/static/console/

# entrypoint 可执行权限
RUN chmod +x /app/deploy/entrypoint.sh

# Railway 动态注入 $PORT
EXPOSE 8000

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    PORT=8000 \
    REDIS_URL=redis://127.0.0.1:6379/0

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
