# FlightHub Webhook Transformer

> 针对 **DJI FlightHub2** 场景设计的通用 Webhook 中间件。支持多输入源先经过**入站鉴权**（static token），通过后进入 Redis Streams 队列，由 Worker 完成 **5 级处理管道**（展平 → 适配 → 映射 → 富化 → 模板渲染）后转发至 FlightHub2 工作流触发接口。

| 组件 | 技术 |
|------|------|
| API 层 | FastAPI + Uvicorn |
| 消息队列 | Redis Streams |
| Worker | Python asyncio + httpx |
| 配置存储 | Redis（热更新，无需重启）|
| 管理界面 | React 控制台 `/console` + Swagger `/docs` |
| 容器化 | Docker 多阶段构建 + supervisord（API + 2 × Worker 同镜像）|

---

## 系统架构

```
┌──────────────────────────────────────────────────────────────────┐
│                       外部系统 (webhook 发送方)                    │
│          HTTP POST /webhook                                       │
│          Header: X-MW-Token: <inbound-token>                     │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                   FastAPI  (Uvicorn · port 8000)                  │
│                                                                   │
│  ① 入站鉴权  →  uw:srcauth:{source}  (static_token / disabled)   │
│  ② 入队     →  Redis Stream  uw:webhook:raw                       │
│  ③ Admin API (/admin/*)  →  配置 CRUD                             │
│  ④ React 控制台 静态托管  /console                                 │
└──────────────────────┬───────────────────────────────────────────┘
                       │  Redis Stream Consumer Group
         ┌─────────────┴─────────────┐
         ▼                           ▼
  Worker-1                     Worker-2
  ┌─────────────────────────────────────────────────────────────┐
  │  STEP 1  flatten_json()    嵌套 JSON → dot-notation 扁平字典  │
  │  STEP 2  apply_adapter()   字段别名归一化 (uw:adapter:{src})  │
  │  STEP 3  apply_mappings()  JSONPath/DSL → 统一字段            │
  │  STEP 4  enrich()          设备元数据注入 (uw:device:{id})    │
  │  STEP 5  render_obj()      Mustache 模板渲染                  │
  │  STEP 6  push_flighthub()  HTTP POST → FlightHub2 API        │
  │          ↑ 指数退避重试 (max_retries / backoff)               │
  └─────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  DJI FlightHub2 API                                               │
│  https://es-flight-api-us.djigate.com/openapi/v0.1/workflow      │
└──────────────────────────────────────────────────────────────────┘
```

---

## Worker 管道详解

### 处理阶段对比（旧版 vs 新版）

| 阶段 | 旧版（1 步）| 新版（5 步）|
|------|------------|------------|
| 数据预处理 | — | `flatten_json()` 展平嵌套 JSON |
| 字段归一化 | — | `apply_adapter()` 别名映射 |
| 字段映射 | `apply_mappings()` | `apply_mappings()` + `flat_event` 参数 |
| 设备富化 | — | `enrich()` 注入设备位置/型号 |
| 模板渲染 | `render_obj()` | `render_obj()`（不变）|

### Mapping DSL 关键字速查

| 关键字 | 作用 | 示例值 |
|--------|------|--------|
| `src` | JSONPath 路径（旧格式，向后兼容）| `"$.level"` |
| `from` | 多路径取第一个非空（新格式）| `["Event.Level", "severity"]` |
| `default` | 所有路径为空时的回退值 | `"info"` |
| `cases` | 条件覆写 | `{"if": "$.level == 'critical'", "then": 3}` |
| `transform` | 内置函数 | `"upper"` / `"lower"` / `"strip"` / `"int"` / `"float"` |
| `type` | 类型转换 | `"string"` / `"float"` / `"bool"` |
| `dst` | 输出字段名 | `"event_level"` |
| `required` | 缺失时丢弃整条消息 | `true` |

---

## 功能入口

| 路径 | 方法 | 说明 |
|------|------|------|
| `/webhook` | POST | 入站 webhook（需带 `X-MW-Token`）|
| `/console` | GET | React 管理控制台（主界面）|
| `/ui/` | GET | 轻量 HTML 控制台（备用）|
| `/docs` | GET | FastAPI Swagger 文档 |
| `/admin/source/list` | POST | 列出所有 source |
| `/admin/source/init` | POST | 初始化新 source |
| `/admin/source/auth/get` | POST | 读取入站鉴权配置 |
| `/admin/source/auth/set` | POST | 设置入站鉴权配置 |
| `/admin/mapping/get` | POST | 读取字段映射配置 |
| `/admin/mapping/set` | POST | 设置字段映射配置 |
| `/admin/flighthub/get` | POST | 读取 FlightHub2 三件套配置 |
| `/admin/flighthub/set` | POST | 设置 FlightHub2 三件套配置 |
| `/admin/token/extract` | POST | 提取粘贴文本中的 Token 字段 |

> Admin 接口若设置了 `ADMIN_TOKEN` 环境变量，需在请求头携带 `X-Admin-Token`。

---

## Redis 数据模型

| 键名 | 内容 | 写入时机 |
|------|------|----------|
| `uw:srcauth:{source}` | 入站鉴权配置（enabled / header_name / token）| Admin API / 首次部署 |
| `uw:map:{source}` | JSONPath / DSL 字段映射规则列表 | Admin API / 控制台 |
| `uw:fhcfg:{source}` | FlightHub2 endpoint / headers / template_body / retry_policy | Admin API / 控制台 |
| `uw:adapter:{source}` | 字段别名归一化规则（`{"fields": {...}}`）| Admin API / 手动写入 |
| `uw:device:{device_id}` | 设备元数据（location / model / site）| 设备注册时写入 |
| `uw:webhook:raw` | Redis Stream（消息队列主体）| API 层自动写入 |

### Adapter 配置示例（`uw:adapter:flighthub2`）

```json
{
  "fields": {
    "event.name":  ["Event.Name", "eventType", "type"],
    "device.id":   ["Event.Source.Id", "deviceId", "device_id"],
    "event.level": ["Event.Level", "severity", "level"]
  }
}
```

### Device 元数据示例（`uw:device:DJI-001`）

```json
{
  "device_id": "DJI-001",
  "model":     "Matrice 300 RTK",
  "site":      "SZ-HQ",
  "location":  {"lat": 22.543096, "lng": 114.057865, "alt": 120}
}
```

---

## 部署方式

### 方式一：Railway（推荐）

1. **注册 Railway**：访问 [railway.app](https://railway.app)，用 GitHub 账号登录
2. **新建项目**：`New Project` → `Deploy from GitHub repo` → 选择 `Flighthub2-API-layer-coding`
3. **添加 Redis**：`+ New` → `Database` → `Add Redis`，Railway 自动注入 `REDIS_URL`
4. **配置环境变量**（Variables 面板）：

   | 变量 | 说明 |
   |------|------|
   | `REDIS_URL` | Railway Redis 自动注入，无需手动填写 |
   | `ADMIN_TOKEN` | Admin 接口保护 Token（建议设置）|

5. 部署完成后，在 Settings → Networking 生成公网域名
6. **初始化入站 Token**（首次部署后执行）：
   ```bash
   curl -X POST https://your-app.railway.app/admin/source/auth/set \
     -H 'Content-Type: application/json' \
     -H 'X-Admin-Token: your-admin-token' \
     -d '{
       "source": "flighthub2",
       "auth": {
         "enabled": true,
         "mode": "static_token",
         "header_name": "X-MW-Token",
         "token": "your-strong-inbound-token"
       }
     }'
   ```

---

### 方式二：Docker Compose（本地 / 自托管）

```bash
git clone https://github.com/steven771806612-sys/Flighthub2-API-layer-coding.git
cd Flighthub2-API-layer-coding

docker compose up -d --build
docker compose logs -f app

# 初始化入站 Token
redis-cli set "uw:srcauth:flighthub2" \
  '{"enabled":true,"mode":"static_token","header_name":"X-MW-Token","token":"your-token"}'
```

访问：控制台 http://localhost:8000/console · Swagger http://localhost:8000/docs

---

### 方式三：沙盒 / 本机调试（PM2）

```bash
sudo apt-get install -y redis-server redis-tools
pip install -r requirements.txt
redis-server --daemonize yes

export PYTHONPATH=$(pwd)
python3 scripts/bootstrap_redis.py

pm2 start ecosystem.config.cjs
```

---

## 快速测试

```bash
# 无 Token → 期望 401
curl -X POST https://your-app.railway.app/webhook \
  -H 'Content-Type: application/json' \
  -d '{"source":"flighthub2","webhook_event":{}}'

# 正确 Token + 完整事件 → 期望 200
curl -X POST https://your-app.railway.app/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-MW-Token: your-inbound-token' \
  -d '{
    "source": "flighthub2",
    "webhook_event": {
      "timestamp": "2026-03-19T10:00:00Z",
      "creator_id": "pilot01",
      "latitude": 22.543096,
      "longitude": 114.057865,
      "level": "warning",
      "description": "obstacle detected"
    }
  }'
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | Redis 连接地址 |
| `PORT` | `8000` | API 监听端口 |
| `STREAM_KEY_RAW` | `uw:webhook:raw` | Redis Stream 键名 |
| `STREAM_GROUP` | `uw-worker-group` | Consumer Group 名 |
| `ADMIN_TOKEN` | _(空，不鉴权)_ | Admin 接口保护 Token |
| `DEFAULT_SOURCE` | `flighthub2` | 默认 source 名称 |

---

## 项目结构

```
.
├── app/
│   ├── main.py              # FastAPI 应用入口
│   ├── config.py            # 环境变量配置
│   ├── redis_repo.py        # Redis 数据访问层（含 adapter/device 方法）
│   ├── queue_bus.py         # Redis Stream 生产者
│   ├── mapping_engine.py    # JSONPath / DSL 字段映射（向后兼容）
│   ├── template_engine.py   # Mustache 模板渲染
│   ├── flatten.py           # ★ 嵌套 JSON → dot-notation 展平
│   ├── adapter_engine.py    # ★ 字段别名归一化层
│   ├── enrichment.py        # ★ 设备元数据富化（可选）
│   └── static/              # React 控制台编译产物
│       └── console/
├── worker/
│   └── worker.py            # Redis Stream 消费者（5 级管道）
├── frontend/                # React + TypeScript 管理控制台源码
│   ├── src/
│   │   ├── modules/         # Dashboard / Sources / Mapping / Egress / Wizard
│   │   ├── services/        # API 调用封装
│   │   ├── store/           # Zustand 状态管理
│   │   └── types/           # TypeScript 类型定义
│   └── vite.config.ts       # 构建配置（base: '/console/'）
├── scripts/
│   ├── bootstrap_redis.py   # Redis 默认配置初始化
│   └── sandbox_test.sh      # E2E 测试脚本
├── docs/
│   └── pipeline_config_examples.py  # ★ Adapter / Mapping DSL 示例配置
├── deploy/
│   ├── supervisord.conf     # 进程管理配置（api + worker-1 + worker-2）
│   └── entrypoint.sh        # Docker 启动入口（等待 Redis + 启动 supervisord）
├── Dockerfile               # 三阶段多阶段构建（py-builder / fe-builder / runtime）
├── docker-compose.yml       # 本地完整环境
├── railway.toml             # Railway 平台部署配置
├── ecosystem.config.cjs     # PM2 配置（本地调试用）
└── requirements.txt         # Python 依赖
```

> ★ 标注为本次新增模块。

---

## 部署状态

- **GitHub**: https://github.com/steven771806612-sys/Flighthub2-API-layer-coding
- **推荐托管平台**: Railway（Docker + Redis 原生支持，healthcheckTimeout: 180s）
- **最后更新**: 2026-03-19
- **当前版本**: v4（5 级 Worker 管道 + React 控制台 + Token 保存修复）

### 已完成
- [x] Railway 部署修复（supervisord 环境变量、entrypoint Redis 等待、healthcheck 超时）
- [x] Dockerfile 前端构建路径修正（base: '/console/'）
- [x] React 控制台空白页修复（Vite base 路径）
- [x] Token 保存不覆盖原值（auth/set 后端合并逻辑）
- [x] Worker 升级至 5 级处理管道（flatten → adapter → mapping → enrich → template）
- [x] 新增 Redis Key：`uw:adapter:{source}`、`uw:device:{device_id}`
- [x] 前端名称更新为 **FlightHub Webhook Transformer**

### 待办
- [ ] 控制台新增 Adapter 配置页面（前端 UI）
- [ ] 控制台新增设备管理页面（`uw:device:*` CRUD）
- [ ] Railway 生产环境部署验证
