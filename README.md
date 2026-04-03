# FlightHub Webhook Transformer

> A universal webhook middleware for DJI FlightHub2 — receives third-party alarm webhooks, processes them through a standardised pipeline, and forwards the result to the FlightHub2 Workflow API.

**Version:** v6.9 · **Last updated:** 2026-04-03  
**GitHub:** https://github.com/steven771806612-sys/Flighthub2-API-layer-coding

---

## System Architecture

```
External System
      │
      │  POST /webhook  (X-MW-Token auth)
      ▼
┌──────────────────────────────────────────────────┐
│  FastAPI  (Uvicorn · port 8000)                  │
│  ├─ /webhook          inbound handler            │
│  ├─ /console          React admin console (SPA)  │
│  ├─ /ui               lightweight HTML UI        │
│  ├─ /docs             Swagger API docs           │
│  └─ /admin/*          admin API (18 endpoints)   │
└──────────────────┬───────────────────────────────┘
                   │ XADD
                   ▼
         Redis Stream  (uw:webhook:raw)
                   │
          ┌────────┴────────┐
          │  Consumer Group  │
          │  uw-worker-group │
          └────────┬────────┘
                   │ XREADGROUP  (×2 workers)
                   ▼
┌────────────────────────────────────────────────────────┐
│  Worker Pipeline  (×2 parallel)                        │
│                                                         │
│  1. flatten     nested JSON → dot-notation dict        │
│  2. normalize   apply adapter config to unify fields   │
│  3. mapping     JSONPath / DSL  → unified dict         │
│  4. enrich      inject device metadata (Redis lookup)  │
│  5. autofill    complete required FH2 fields           │
│  6. HTTP POST   push to FlightHub2 API with retry      │
└────────────────────────────────────────────────────────┘
                   │
                   ▼
          DJI FlightHub2 API
    POST /openapi/v0.1/workflow
```

---

## Features

### Backend Core

| Module | Description |
|--------|-------------|
| `app/main.py` | FastAPI entry point — 18 Admin API endpoints |
| `app/flatten.py` | Nested JSON → dot-notation (supports list indices) |
| `app/normalize.py` | Applies adapter config; returns a unified field list |
| `app/adapter_engine.py` | Multi-path field candidate resolution with fallback |
| `app/mapping_engine.py` | JSONPath (legacy list) + DSL (`from` / `default` / `cases` / `transform`) |
| `app/enrichment.py` | Injects device metadata from `uw:device:{id}` |
| `app/autofill.py` | Completes required FH2 fields; outputs a standard body |
| `app/redis_repo.py` | Redis CRUD for mapping / fhcfg / auth / adapter / device |
| `worker/worker.py` | Async consumer — full 6-step pipeline |

### Worker Pipeline (v6)

```
raw → flatten_json → normalize → apply_mappings
    → enrich → autofill → build_fh2_body → HTTP POST
```

> `template_engine` and `canonical` layers have been removed.  
> `autofill.build_fh2_body()` now directly produces the standard FH2 request body.

### Redis Key Reference

| Key | Purpose |
|-----|---------|
| `uw:webhook:raw` | Redis Stream (message queue) |
| `uw:srcauth:{source}` | Ingress token authentication config |
| `uw:map:{source}` | Field-mapping config (legacy list or DSL dict) |
| `uw:fhcfg:{source}` | FlightHub2 egress config (endpoint / headers / retry) |
| `uw:adapter:{source}` | Field-normalisation adapter config |
| `uw:device:{device_id}` | Device metadata (GPS / site / model) |
| `uw:deviceidfield:{source}` | Which payload field carries the device identifier |

---

## Admin Console

**React SPA** — served at `/console`

| Page | Route | Purpose |
|------|-------|---------|
| Dashboard | `/console` | System overview; per-source pipeline health cards with live API preview |
| Sources | `/console/sources` | Create / manage webhook sources; configure ingress auth |
| Visual Mapper | `/console/mapping` | **Core** — 3-column drag-and-drop field mapping with live FH2 preview |
| Egress | `/console/egress` | FlightHub2 downstream API configuration |
| Devices | `/console/device` | Device metadata CRUD (GPS coordinates registry) |
| New Integration | `/console/wizard` | Guided 5-step wizard for setting up a new integration |

### Visual Mapper Workflow

1. Select a source in the sidebar → the source persists across page navigations.
2. (Optional) Expand **Sample Payload** and paste a real webhook body.
3. Click **Load Fields & Preview** → calls `/admin/debug/run` with the current (unsaved) mapping override → the left column populates with normalised field names.
4. Drag fields or use the centre-column dropdowns to map input fields to FH2 target fields. Click **Auto-Suggest** for intelligent auto-mapping.
5. The right column shows the live FH2 output body and a **Required Fields Status** panel highlighting any missing fields.
6. Click **Save Mapping** → writes to Redis and clears the dirty flag.

### Source Context & Draft Isolation (v6.9)

- **Persistent source selection** — the active source is stored in `localStorage` (`fh2-source-ctx`) and survives page refresh and navigation.
- **Per-source mapping drafts** — each source has its own isolated draft in `localStorage` (`fh2-mapping-drafts`). Switching sources never overwrites another source's draft.
- **Unsaved-change protection** — an amber banner and `window.beforeunload` guard appear whenever there are unsaved edits on the Mapping, Egress, Device, or Source Auth pages. Switching sources while a draft is dirty triggers a confirmation dialog.
- **Global source switcher** — the sidebar's **Active Source** dropdown lets you switch sources from any page without navigating to the Sources page.

---

## API Reference

### Webhook Ingress

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook` | Receive a webhook event (authenticated via `X-MW-Token`) |

**Minimal request body:**
```json
{
  "source": "hikvision",
  "webhook_event": { /* raw device payload */ }
}
```

### Admin Endpoints  *(require `X-Admin-Token` header)*

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/source/list` | List all registered sources |
| POST | `/admin/source/init` | Initialise a source with default config |
| POST | `/admin/source/delete` | Delete a source and its config |
| POST | `/admin/source/auth/get` | Get ingress authentication config |
| POST | `/admin/source/auth/set` | Set ingress authentication config |
| POST | `/admin/mapping/get` | Get field-mapping config |
| POST | `/admin/mapping/set` | Save field-mapping config |
| POST | `/admin/flighthub/get` | Get FH2 egress config |
| POST | `/admin/flighthub/set` | Save FH2 egress config |
| POST | `/admin/token/extract` | Extract credentials from a curl snippet or header text |
| POST | `/admin/adapter/get` | Get field-normalisation adapter |
| POST | `/admin/adapter/set` | Save field-normalisation adapter |
| POST | `/admin/device/list` | List all registered devices |
| POST | `/admin/device/get` | Get device metadata |
| POST | `/admin/device/set` | Save device metadata (GPS, model, etc.) |
| POST | `/admin/device/delete` | Delete a device record |
| POST | `/admin/debug/run` | Dry-run the full pipeline without persisting — accepts an optional `mapping_override` to preview unsaved mappings |

---

## FH2 Request Body Schema

```json
{
  "workflow_uuid": "uuid-from-config",
  "trigger_type": 0,
  "name": "Alert-{event_name}",
  "params": {
    "creator": "pilot01",
    "latitude": 22.543096,
    "longitude": 114.057865,
    "level": 3,
    "desc": "obstacle detected"
  }
}
```

### Autofill Priority (per `params` field)

| Priority | Source |
|----------|--------|
| 1 | Value already present in the mapped dict (including dot-path keys like `params.latitude`) |
| 2 | Alias fields (e.g. `latitude`, `lat`) found in the mapped dict |
| 3 | Device GPS from `uw:device:{device_id}` (injected by enrichment) |
| 4 | Per-source autofill overrides in `uw:fhcfg:{source}` |
| 5 | Hard-coded defaults (`creator="system"`, `level=3`, `desc=""`, `trigger_type=0`) |
| 6 | Reported as missing in `missing[]` |

### Level String → Integer Mapping

| String value | Integer |
|--------------|---------|
| `"info"` / `"low"` | `1` |
| `"notice"` | `2` |
| `"warning"` / `"medium"` | `3` |
| `"error"` / `"high"` | `4` |
| `"critical"` / `"emergency"` | `5` |

---

## Project Structure

```
webapp/
├── app/
│   ├── main.py              FastAPI entry point + all API routes
│   ├── config.py            Settings (pydantic BaseSettings)
│   ├── redis_repo.py        Redis CRUD wrapper
│   ├── flatten.py           Nested JSON → dot-notation
│   ├── normalize.py         Adapter normalisation wrapper
│   ├── adapter_engine.py    Multi-path field candidate mapping
│   ├── mapping_engine.py    JSONPath + DSL mapping engine
│   ├── enrichment.py        Device metadata injection
│   ├── autofill.py          FH2 field autofill + body builder
│   └── static/console/      React SPA build output
├── worker/
│   └── worker.py            Redis Stream consumer (6-step pipeline)
├── frontend/                React + Vite + TypeScript source
│   └── src/
│       ├── modules/
│       │   ├── dashboard/   Dashboard + ApiPreviewPanel
│       │   ├── mapping/     MappingBoard (3-column visual mapper)
│       │   ├── device/      DevicePage (GPS registry)
│       │   ├── egress/      EgressConfigPanel
│       │   ├── source/      SourcesPage + SourceForm
│       │   └── wizard/      IntegrationWizard (5 steps)
│       ├── hooks/
│       │   └── useDirtyGuard.ts   Unsaved-change guard hook
│       ├── store/           Zustand stores (source, mapping, wizard, UI)
│       ├── services/        API service layer (18 endpoints)
│       └── types/           TypeScript type definitions
├── deploy/
│   ├── supervisord.conf     Process supervisor config
│   └── entrypoint.sh        Docker start script
├── Dockerfile
├── docker-compose.yml
└── railway.toml
```

---

## Deployment

### Railway (recommended)

```bash
# 1. Create a Railway project and add the Redis plugin.
# 2. Railway automatically injects REDIS_URL.
# 3. After deploy, initialise your first source:
curl -X POST https://your-app.railway.app/admin/source/init \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: your-token" \
  -d '{"source": "hikvision", "force": true}'
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | Redis connection URL (auto-injected by Railway) |
| `PORT` | `8000` | Service port |
| `ADMIN_TOKEN` | *(empty — no auth)* | Admin API protection token |
| `DEFAULT_SOURCE` | `flighthub2` | Default source slug |
| `STREAM_KEY_RAW` | `uw:webhook:raw` | Redis Stream key |
| `STREAM_GROUP` | `uw-worker-group` | Consumer group name |

### Local Development (sandbox / Docker Compose)

```bash
# Docker Compose
docker compose up -d --build

# PM2 (sandbox)
pm2 restart all

# Access points
# http://localhost:8000/console   →  Admin console (React SPA)
# http://localhost:8000/docs      →  Swagger API docs
# http://localhost:8000/ui        →  Lightweight legacy UI
```

---

## Quick-Start Guide

### 1 — Create a source

```bash
curl -X POST http://localhost:8000/admin/source/init \
  -H "Content-Type: application/json" \
  -d '{"source": "hikvision"}'
```

### 2 — Set ingress authentication

Open the **Sources** page in `/console`, select your source, and set an ingress token. The webhook endpoint is:

```
POST /webhook
Header: X-MW-Token: <your-token>
Body:   {"source": "hikvision", "webhook_event": {...}}
```

### 3 — Map fields visually

Navigate to **Visual Mapper**, select your source, paste a sample payload, and click **Load Fields & Preview**. Drag input fields to the corresponding FH2 output fields (or use **Auto-Suggest**), then click **Save Mapping**.

### 4 — Configure egress

Open the **Egress** page, enter your FlightHub2 `X-User-Token`, `x-project-uuid`, and `workflow_uuid`. Click **Save Egress Config**.

### 5 — (Optional) Register devices for GPS auto-injection

On the **Devices** page, add device records with GPS coordinates. In **Visual Mapper → DevicePicker**, set the payload field that carries the device identifier. The worker will then automatically inject `params.latitude` / `params.longitude` from the registry.

### 6 — Test end-to-end

Use the **New Integration** wizard (step 5 — Integration Test) or send a real webhook:

```bash
curl -X POST http://localhost:8000/webhook \
  -H "Content-Type: application/json" \
  -H "X-MW-Token: <your-ingress-token>" \
  -d '{
    "source": "hikvision",
    "webhook_event": {
      "ipAddress": "192.168.1.64",
      "eventType": "VMD",
      "eventDescription": "Motion Detection",
      "dateTime": "2026-04-03T10:00:00+08:00"
    }
  }'
```

---

## Changelog

| Version | Key changes |
|---------|-------------|
| **v6.9** | Source context persistence (localStorage); per-source mapping draft isolation; `useDirtyGuard` hook for all form pages; MappingPage & Sidebar dirty-switch confirmation; no-source guard on Mapping/Egress pages |
| **v6.8** | Real-time mapping preview: unsaved visual mappings passed to `debug/run` as `mapping_override` |
| **v6.7** | Autofill fixes: empty-string passthrough, dot-path aliases (`params.latitude`), level string → integer conversion |
| **v6.6** | Dashboard live API preview panel (`ApiPreviewPanel`); IntegrationTest two-column layout |
| **v6.5** | Device model simplified; DevicePicker unified with shared device list |
| **v6.4** | Frontend bug fixes and UX improvements |
| **v6.3** | Preview refresh fix; GPS fallback refactored to `device_id_field` per source |
| **v6.2** | Live parameter validation; GPS field mapping; MissingPanel multi-path coverage |
| **v6.1** | Wizard uses MappingBoard; source deletion; DevicePicker integrated into mapper |

---

## Completed ✅

- FastAPI + Redis Stream full message queue pipeline
- 6-step worker pipeline (flatten → normalize → mapping → enrich → autofill → HTTP POST)
- DSL mapping engine (`from` / `default` / `cases` / `transform`)
- Device metadata registry with automatic GPS injection
- 3-column visual field mapper with real-time FH2 body preview and missing-field analysis
- Debug dry-run API (`/admin/debug/run`) with `mapping_override` for unsaved mappings
- Auto-suggest field mapping
- Persistent source context (survives refresh); per-source draft isolation
- Unsaved-change guards on all configuration pages
- Global source switcher in sidebar
- Railway + Docker Compose deployment support

## Roadmap / Backlog

- [ ] Mapping DSL visual rule builder (RuleBuilder UI)
- [ ] Adapter configuration page in the console (backend already supports it)
- [ ] Multi-tenant / bulk source management
- [ ] Webhook history browser (Redis Stream replay)
- [ ] FlightHub2 API response parsing and error alerting
- [ ] Role-based access control for the admin console
