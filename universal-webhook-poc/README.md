# Universal Webhook POC

> A lightweight, self-contained proof-of-concept for the Universal Webhook Middleware.  
> Uses **Redis Streams** as the message queue (no Kafka required) so the entire stack runs in a single sandbox.

**Released:** 2026-03-18 · **Updated:** 2026-04-26  
**Parent project:** [Flighthub2-API-layer-coding](https://github.com/steven771806612-sys/Flighthub2-API-layer-coding)

---

## Overview

This POC demonstrates the core pipeline and provides a fully observable admin console:

```
External System
      │
      │  POST /webhook  (per-source X-MW-Token auth, or auth disabled)
      ▼
┌──────────────────────────────────────────────────┐
│  FastAPI  (Uvicorn · port 8000)                  │
│  ├─ /webhook              inbound handler        │
│  ├─ /ui/                  5-tab admin console    │
│  ├─ /docs                 Swagger API docs       │
│  └─ /admin/*              14 admin endpoints     │
└─────────────────┬────────────────────────────────┘
                  │ XADD  (+ test_id propagation)
                  ▼
        Redis Stream  (uw:webhook:raw)
                  │
         ┌────────┴────────┐
         │  Consumer Group  │
         │  uw-worker-group │
         └────────┬────────┘
                  │ XREADGROUP (×2 workers)
                  ▼
┌──────────────────────────────────────────────────┐
│  Worker Pipeline  (×2 parallel)                  │
│  1. mapping     JSONPath → unified dict          │
│  2. template    Mustache-style {{field}} render  │
│  3. HTTP POST   push to FH2 with retry           │
│  4. persist     save result to Redis             │
└──────────────────────────────────────────────────┘
                  │
                  ▼
         DJI FlightHub2 API
   POST /openapi/v0.1/workflow

   ↓ result (business_code / business_message / is_success)
   ↓ stored in uw:lastpush:{source} + uw:pushlog:{source}
   ↓ queryable via /admin/dashboard/* endpoints
```

---

## File Structure

```
universal-webhook-poc/
├── app/
│   ├── main.py              FastAPI entry point — 14 admin + webhook routes
│   ├── config.py            Pydantic Settings (REDIS_URL, STREAM_KEY, ADMIN_TOKEN…)
│   ├── mapping_engine.py    JSONPath field extraction + type casting
│   ├── template_engine.py   Mustache-style {{field}} renderer
│   ├── queue_bus.py         Redis Streams producer (XADD)
│   ├── redis_repo.py        Redis CRUD (mapping / fhcfg / auth / push results)
│   ├── kafka_bus.py         AIOKafka producer stub (not active in POC)
│   └── static/
│       └── index.html       5-tab admin console (no build step required)
├── worker/
│   └── worker.py            Async XREADGROUP consumer — mapping → template → HTTP → persist
├── scripts/
│   ├── bootstrap_redis.py   Seed default mapping + FH2 config into Redis
│   ├── run_api.sh           Start FastAPI server (daemonised, logs/api.log)
│   ├── run_worker.sh        Start 2 worker consumers (daemonised)
│   ├── sandbox_test.sh      Full E2E test (install → start → auth gate verify)
│   ├── run_kafka.sh         Kafka/Redpanda start helper (optional)
│   └── create_topic.sh      Kafka topic creation helper (optional)
├── config.server.poc.properties   Kafka POC broker config (reference)
├── config_kraft.properties        KRaft mode config (reference)
└── README.md
```

---

## Quick Start

### Prerequisites

```bash
# System packages
sudo apt-get install -y redis-server redis-tools curl jq

# Python packages
pip install fastapi "uvicorn[standard]" redis httpx jsonpath-ng pydantic-settings
```

### One-command E2E test

```bash
# From the repo root (adjust PROJECT_DIR inside the script if needed):
bash universal-webhook-poc/scripts/sandbox_test.sh
```

Expected output:

```
Expect: unauth=401 wrong=401 ok=200
Result: unauth=401  wrong=401  ok=200
DONE. Useful endpoints:
- GUI:  http://127.0.0.1:8000/ui/
- Docs: http://127.0.0.1:8000/docs
```

### Manual start

```bash
# 1. Start Redis
redis-server --daemonize yes

# 2. Seed default mapping + FH2 config
cd universal-webhook-poc
PYTHONPATH=. python3 scripts/bootstrap_redis.py

# 3. Set inbound auth token for the default source
redis-cli set uw:srcauth:flighthub2 \
  '{"enabled":true,"mode":"static_token","header_name":"X-MW-Token","token":"my-secret"}'

# 4. Start API
PYTHONPATH=. bash scripts/run_api.sh

# 5. Start 2 worker consumers
PYTHONPATH=. bash scripts/run_worker.sh

# 6. Open the admin console
open http://127.0.0.1:8000/ui/
```

---

## Admin Console (`/ui/`)

A single-file 5-tab HTML console — no build tools required.

| Tab | What it does |
|-----|-------------|
| **Dashboard** | 8 stat cards (stream length / consumer group / pending / lag / last HTTP status / last business code / last worker); last-push-per-source table; Consumer Group + consumer detail; push history table; **auto-refresh** (off / 2s / 5s / 10s); optional log co-refresh |
| **配置** | FlightHub2 三件套 (endpoint / X-User-Token / x-project-uuid / workflow_uuid) hot-update per source; JSONPath field-mapping editor; token extractor (paste curl/headers/JSON → apply to config) |
| **入站鉴权** | Per-source inbound token configuration; live hint showing whether auth is enabled or disabled for the selected source |
| **集成测试** | **Pipeline Preview** (dry-run mapping + template render, no HTTP sent); **Send & Test** (enqueue real event, auto-poll result every 1.5 s, up to 8 attempts); full result panel: HTTP status / business_code / business_message / worker / msg_id / test_id / rendered body / response preview; token input auto-disabled when source auth is off; recent history table |
| **日志** | Tail `api.log` / `worker-1.log` / `worker-2.log` / aggregated view; configurable line count; toggle auto-refresh (3 s interval) |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | Redis connection URL |
| `STREAM_KEY_RAW` | `uw:webhook:raw` | Redis Stream key |
| `STREAM_GROUP` | `uw-worker-group` | Consumer group name |
| `STREAM_CONSUMER` | `worker-1` | Consumer identity (overridden per worker process) |
| `ADMIN_TOKEN` | *(empty — no auth)* | If set, all `/admin/*` routes require `X-Admin-Token` header |
| `DEFAULT_SOURCE` | `flighthub2` | Fallback source when not supplied in request body |
| `DEFAULT_FLIGHTHUB_ENDPOINT` | `https://es-flight-api-us.djigate.com/openapi/v0.1/workflow` | Default FH2 push target |

---

## API Reference

### Webhook Ingress

```
POST /webhook
Header: X-MW-Token: <per-source inbound token>   ← omit if source auth is disabled
Body:   {"source": "flighthub2", "webhook_event": {...}, "test_id"?: "..."}
```

Response:
```json
{"status": "accepted", "queue": "redis_stream", "stream": "uw:webhook:raw", "test_id": "<uuid>"}
```

- `test_id` is auto-generated if not supplied; use it to poll `/admin/dashboard/last_result`.
- If `source.auth.enabled = false`, the endpoint accepts requests **without any token**.

### Admin Endpoints *(optional `X-Admin-Token` header)*

#### Source & Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/source/list` | List all registered sources |
| POST | `/admin/source/init` | Initialise a source with default config |
| POST | `/admin/source/auth/get` | Read inbound auth config (token masked) |
| POST | `/admin/source/auth/set` | Write inbound auth config |

#### Mapping & Config

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/mapping/get` | Read JSONPath field-mapping config |
| POST | `/admin/mapping/set` | Write field-mapping config |
| POST | `/admin/flighthub/get` | Read FH2 egress config (X-User-Token masked) |
| POST | `/admin/flighthub/set` | Write FH2 egress config |
| POST | `/admin/token/extract` | Extract FH2 auth trio from raw text |

#### Pipeline & Dashboard

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/pipeline/preview` | Dry-run mapping + template render — **no HTTP push** |
| POST | `/admin/dashboard/summary` | Snapshot: stream len, last results, consumer group, pending, lag |
| POST | `/admin/dashboard/last_result` | Query latest push result by `test_id` or `source` |
| POST | `/admin/dashboard/push_log` | Recent push history per source (configurable limit) |
| POST | `/admin/dashboard/logs` | Tail log files (`api` / `worker-1` / `worker-2` / `all`) |

### UI & Docs

| Path | Description |
|------|-------------|
| `/ui/` | 5-tab static admin console |
| `/docs` | Swagger interactive API documentation |

---

## Redis Key Reference

| Key | Purpose |
|-----|---------|
| `uw:webhook:raw` | Redis Stream — raw inbound event queue |
| `uw:srcauth:{source}` | Inbound auth config per source |
| `uw:map:{source}` | JSONPath field-mapping config per source |
| `uw:fhcfg:{source}` | FH2 egress config (endpoint / headers / template / retry) |
| `uw:lastpush:{source}` | Most recent FH2 push result per source |
| `uw:pushlog:{source}` | Push history list — newest first, capped at 50 entries |

---

## Inbound Auth Model

Each source has an independent static token.  
**Setting `enabled: false` completely disables auth** — no token is required in requests.

```json
{
  "enabled": true,
  "mode": "static_token",
  "header_name": "X-MW-Token",
  "token": "your-secret"
}
```

Auth enabled — token required:
```bash
curl -X POST http://127.0.0.1:8000/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-MW-Token: your-secret' \
  -d '{"source":"flighthub2","webhook_event":{...}}'
```

Auth disabled (`enabled: false`) — no token needed:
```bash
curl -X POST http://127.0.0.1:8000/webhook \
  -H 'Content-Type: application/json' \
  -d '{"source":"flighthub2","webhook_event":{...}}'
```

Hot-update without restart:
```bash
redis-cli set uw:srcauth:flighthub2 \
  '{"enabled":false,"mode":"static_token","header_name":"X-MW-Token","token":""}'
```

---

## Mapping Config

```json
{
  "mappings": [
    {"src": "$.latitude",    "dst": "latitude",    "type": "float",  "default": 0,       "required": true},
    {"src": "$.longitude",   "dst": "longitude",   "type": "float",  "default": 0,       "required": true},
    {"src": "$.level",       "dst": "level",       "type": "string", "default": "info",  "required": true},
    {"src": "$.creator_id",  "dst": "creator_id",  "type": "string", "default": "system","required": true},
    {"src": "$.description", "dst": "description", "type": "string", "default": "",      "required": false},
    {"src": "$.timestamp",   "dst": "timestamp",   "type": "string", "default": "",      "required": false}
  ]
}
```

Supported types: `string`, `int`, `float`, `bool`, `json`.

---

## FH2 Push Result Schema

After every push the worker saves the result to Redis:

```json
{
  "msg_id":           "1714123456789-0",
  "test_id":          "uuid-used-for-tracing",
  "source":           "flighthub2",
  "worker":           "worker-1",
  "endpoint":         "https://es-flight-api-us.djigate.com/...",
  "http_status":      200,
  "business_code":    200401,
  "business_message": "invalid token format",
  "is_success":       false,
  "response_preview": "{\"code\":200401,\"message\":\"invalid token format\"}",
  "rendered_body":    {"workflow_uuid": "...", "trigger_type": 0, "name": "Alert-2026-04-26T10:00:00Z", "params": {...}},
  "mapping_error":    null,
  "pushed_at":        1714123460,
  "name":             "Alert-2026-04-26T10:00:00Z"
}
```

**Success determination logic:**

| HTTP Status | business_code | `is_success` |
|-------------|---------------|--------------|
| 2xx | `null` / `0` / `200` | ✅ `true` |
| 2xx | any other value (e.g. `200401`) | ❌ `false` |
| non-2xx or exception | — | ❌ `false` |

---

## FH2 Egress Config

```json
{
  "endpoint": "https://es-flight-api-us.djigate.com/openapi/v0.1/workflow",
  "headers": {
    "Content-Type": "application/json",
    "X-User-Token": "YOUR_SECRET_TOKEN",
    "x-project-uuid": "YOUR_PROJECT_UUID"
  },
  "template_body": {
    "workflow_uuid": "YOUR_WORKFLOW_UUID",
    "trigger_type": 0,
    "name": "Alert-{{timestamp}}",
    "params": {
      "creator":   "{{creator_id}}",
      "latitude":  "{{latitude}}",
      "longitude": "{{longitude}}",
      "level":     "{{level}}",
      "desc":      "{{description}}"
    }
  },
  "retry_policy": {"max_retries": 3, "backoff": "exponential"}
}
```

`{{field}}` placeholders are resolved by `template_engine.render_obj()` against the unified dict produced by the mapping step.

---

## Integration Test Workflow

1. Open `/ui/` → **集成测试** tab.
2. Select a **Source** — the token input is automatically enabled/disabled based on the source's auth config.
3. Click **Preview** to dry-run the mapping and see the rendered FH2 request body (no HTTP sent).
4. Fill in the **入站 Token** (if auth is enabled), edit the **webhook_event** JSON, and click **Send & Test**.
5. The UI auto-polls `/admin/dashboard/last_result?test_id=…` every 1.5 s (up to 8 attempts).
6. The result panel shows: HTTP status / `business_code` / `business_message` / worker / rendered body / raw response.
7. The **最近历史** table below shows the last 10 pushes for the selected source.

---

## Changelog

| Date | Changes |
|------|---------|
| **2026-04-26** | Worker: FH2 response parsing, business success/fail judgment, Redis result persistence (`uw:lastpush` / `uw:pushlog`), `test_id` propagation. Main: fixed `enabled=false` auth bug (was 403, now pass-through); new endpoints: pipeline/preview, dashboard/summary, dashboard/last_result, dashboard/push_log, dashboard/logs; `/webhook` returns `test_id`. UI: full rewrite to 5-tab console (Dashboard with stat cards + auto-refresh, Integration Test with dry-run preview and result panel, auth-linked token input, log viewer). |
| **2026-03-18** | Initial release — Redis Streams queue, mapping engine, Mustache template, inbound static token auth, lightweight HTML UI. |

---

## Differences from Production (`v6.x`)

| Feature | POC | Production (v6.x) |
|---------|-----|-------------------|
| Queue backend | Redis Streams only | Redis Streams (Kafka-compatible) |
| Worker pipeline | mapping → template → HTTP → persist | flatten → normalize → mapping → enrich → autofill → HTTP |
| Mapping DSL | JSONPath list only | JSONPath list + full DSL (`from` / `cases` / `transform`) |
| Result persistence | ✅ `uw:lastpush` + `uw:pushlog` | Dashboard via React SPA |
| Business success check | ✅ HTTP + business_code | ✅ HTTP + business_code |
| Device metadata | ✗ | Redis `uw:device:{id}` registry |
| Adapter normalisation | ✗ | `uw:adapter:{source}` |
| Admin console | Static HTML 5-tab (`/ui/`) | React SPA (`/console`) |
| Autofill | ✗ | 6-priority autofill chain |

---

## Relation to Parent Project

This POC was the initial spike that validated the core concepts (inbound auth gate → Redis queue → async worker → FH2 push → observable result). The production codebase extends this foundation with a full 6-step worker pipeline, DSL mapping engine, device GPS registry, React admin console, and one-click Railway deployment.
