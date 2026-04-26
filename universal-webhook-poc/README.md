# Universal Webhook POC

> A lightweight, self-contained proof-of-concept for the Universal Webhook Middleware.  
> Uses **Redis Streams** as the message queue (instead of Kafka) so it can be run entirely in a single sandbox without additional infrastructure.

**Released:** 2026-03-18 · **Parent project:** [Flighthub2-API-layer-coding](https://github.com/steven771806612-sys/Flighthub2-API-layer-coding)

---

## Overview

This POC demonstrates the core pipeline of the production middleware:

```
External System
      │
      │  POST /webhook  (X-MW-Token auth)
      ▼
┌─────────────────────────────────────┐
│  FastAPI  (Uvicorn · port 8000)     │
│  ├─ /webhook   inbound handler      │
│  ├─ /ui        lightweight HTML UI  │
│  ├─ /docs      Swagger API docs     │
│  └─ /admin/*   admin endpoints      │
└────────────────┬────────────────────┘
                 │ XADD
                 ▼
       Redis Stream  (uw:webhook:raw)
                 │
        ┌────────┴────────┐
        │  Consumer Group  │
        │  uw-worker-group │
        └────────┬────────┘
                 │ XREADGROUP (×2 workers)
                 ▼
┌────────────────────────────────────────┐
│  Worker Pipeline  (×2 parallel)        │
│  1. mapping     JSONPath → unified dict│
│  2. template    Mustache-style render  │
│  3. HTTP POST   push to FH2 with retry │
└────────────────────────────────────────┘
                 │
                 ▼
        DJI FlightHub2 API
  POST /openapi/v0.1/workflow
```

---

## File Structure

```
universal-webhook-poc/
├── app/
│   ├── main.py              FastAPI entry point + all admin/webhook routes
│   ├── config.py            Pydantic Settings (REDIS_URL, STREAM_KEY, etc.)
│   ├── mapping_engine.py    JSONPath field extraction + type casting
│   ├── template_engine.py   Mustache-style {{field}} rendering
│   ├── queue_bus.py         Redis Streams producer (XADD)
│   ├── redis_repo.py        Redis CRUD for mapping / fhcfg / source auth
│   ├── kafka_bus.py         AIOKafka producer stub (not active in POC)
│   └── static/
│       └── index.html       Lightweight admin UI (no build step)
├── worker/
│   └── worker.py            Async Redis Stream consumer (XREADGROUP)
├── scripts/
│   ├── bootstrap_redis.py   Seed default mapping + FH2 config into Redis
│   ├── run_api.sh            Start the FastAPI server (daemonised)
│   ├── run_worker.sh         Start 2 worker consumers (daemonised)
│   ├── sandbox_test.sh       Full E2E test script (install → start → verify)
│   ├── run_kafka.sh          Kafka/Redpanda start helper (optional)
│   └── create_topic.sh       Kafka topic creation helper (optional)
├── config.server.poc.properties   Kafka POC broker config
├── config_kraft.properties        KRaft mode Kafka config
└── README.md
```

---

## Quick Start (Sandbox / Local)

### Prerequisites

```bash
# System packages
sudo apt-get install -y redis-server redis-tools curl jq

# Python packages
pip install fastapi "uvicorn[standard]" redis httpx jsonpath-ng pydantic-settings
```

### One-command E2E test

The `sandbox_test.sh` script handles everything: starts Redis, seeds config, starts API + workers, and verifies the inbound auth gate.

```bash
# From the repo root, adjust PROJECT_DIR inside the script if needed:
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

# 2. Seed default config (mapping + FlightHub2 config)
cd universal-webhook-poc
PYTHONPATH=. python3 scripts/bootstrap_redis.py

# 3. Set inbound auth token for the default source
redis-cli set uw:srcauth:flighthub2 \
  '{"enabled":true,"mode":"static_token","header_name":"X-MW-Token","token":"my-secret"}'

# 4. Start API
PYTHONPATH=. bash scripts/run_api.sh

# 5. Start workers (2 consumers)
PYTHONPATH=. bash scripts/run_worker.sh
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | Redis connection URL |
| `STREAM_KEY_RAW` | `uw:webhook:raw` | Redis Stream key for raw events |
| `STREAM_GROUP` | `uw-worker-group` | Consumer group name |
| `STREAM_CONSUMER` | `worker-1` | Consumer identity (overridden per worker) |
| `ADMIN_TOKEN` | *(empty)* | If set, all `/admin/*` routes require `X-Admin-Token` header |
| `DEFAULT_SOURCE` | `flighthub2` | Fallback source slug when not provided in request body |
| `DEFAULT_FLIGHTHUB_ENDPOINT` | `https://es-flight-api-us.djigate.com/openapi/v0.1/workflow` | Default FH2 push target |

---

## API Endpoints

### Webhook Ingress

```
POST /webhook
Header: X-MW-Token: <per-source inbound token>
Body:   {"source": "flighthub2", "webhook_event": {...}}
```

Authenticated events are enqueued to `uw:webhook:raw` via `XADD`. Workers pick them up with `XREADGROUP`.

### Admin Endpoints *(optional `X-Admin-Token` header)*

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/source/list` | List registered sources |
| POST | `/admin/source/init` | Initialise a source with default config |
| POST | `/admin/source/auth/get` | Read inbound auth config (token masked) |
| POST | `/admin/source/auth/set` | Write inbound auth config |
| POST | `/admin/mapping/get` | Read JSONPath field-mapping config |
| POST | `/admin/mapping/set` | Write field-mapping config |
| POST | `/admin/flighthub/get` | Read FH2 egress config (token masked) |
| POST | `/admin/flighthub/set` | Write FH2 egress config |
| POST | `/admin/token/extract` | Extract FH2 auth trio from raw text (headers / curl snippet / JSON) |

### UI

| Path | Description |
|------|-------------|
| `/ui/` | Lightweight single-page admin console (no build required) |
| `/docs` | Swagger interactive API documentation |

---

## Redis Key Reference

| Key | Purpose |
|-----|---------|
| `uw:webhook:raw` | Redis Stream — raw inbound event queue |
| `uw:srcauth:{source}` | Inbound auth config per source |
| `uw:map:{source}` | JSONPath field-mapping config per source |
| `uw:fhcfg:{source}` | FH2 egress config (endpoint / headers / template / retry) |

---

## Inbound Auth Model

Each source has an independent static token. Callers must include it in the header defined by `header_name` (default: `X-MW-Token`).

```json
{
  "enabled": true,
  "mode": "static_token",
  "header_name": "X-MW-Token",
  "token": "your-secret"
}
```

Hot-update without restart:
```bash
redis-cli set uw:srcauth:flighthub2 '{"enabled":true,"mode":"static_token","header_name":"X-MW-Token","token":"NEW_TOKEN"}'
```

---

## Mapping Config

Each mapping row extracts one field from the webhook payload via JSONPath and type-casts it:

```json
{
  "mappings": [
    {"src": "$.latitude",    "dst": "latitude",    "type": "float",  "default": 0,      "required": true},
    {"src": "$.longitude",   "dst": "longitude",   "type": "float",  "default": 0,      "required": true},
    {"src": "$.level",       "dst": "level",       "type": "string", "default": "info", "required": true},
    {"src": "$.creator_id",  "dst": "creator_id",  "type": "string", "default": "system","required": true},
    {"src": "$.description", "dst": "description", "type": "string", "default": "",     "required": false},
    {"src": "$.timestamp",   "dst": "timestamp",   "type": "string", "default": "",     "required": false}
  ]
}
```

Supported types: `string`, `int`, `float`, `bool`, `json`.

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

The `{{field}}` placeholders are resolved by `template_engine.render_obj()` against the unified dict produced by the mapping step.

---

## Differences from Production (`v6.x`)

| Feature | POC | Production (v6.x) |
|---------|-----|-------------------|
| Queue backend | Redis Streams only | Redis Streams (Kafka-compatible) |
| Worker pipeline | mapping → template → HTTP | flatten → normalize → mapping → enrich → autofill → HTTP |
| Mapping DSL | JSONPath list only | JSONPath list + full DSL (`from`/`cases`/`transform`) |
| Device metadata | Not supported | Redis `uw:device:{id}` registry |
| Adapter normalisation | Not supported | `uw:adapter:{source}` |
| Admin console | Static HTML (`/ui`) | React SPA (`/console`) |
| Autofill | Not supported | 6-priority autofill chain |

---

## Relation to Parent Project

This POC was the initial spike that validated the core concepts (inbound auth gate → Redis queue → async worker → FH2 push). The production codebase in the parent repository extends this foundation with a full 6-step worker pipeline, a React admin console, DSL mapping engine, device GPS registry, and one-click Railway deployment.
