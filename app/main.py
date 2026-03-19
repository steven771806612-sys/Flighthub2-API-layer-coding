from __future__ import annotations

import time
from typing import Any

from fastapi import FastAPI, Request, Header
from fastapi import HTTPException
from fastapi.responses import HTMLResponse
from starlette.staticfiles import StaticFiles
import re
from redis.asyncio import Redis

from app.config import settings
from app.redis_repo import RedisRepo
from app.queue_bus import RedisStreamBus

app = FastAPI(title="Universal Webhook Middleware (POC)")

# ── Legacy minimal GUI (kept for backward compat) ──────────────────────────────
# Access: GET /ui/
app.mount("/ui", StaticFiles(directory="app/static", html=True), name="ui")

# ── New React Admin Console ────────────────────────────────────────────────────
# Built output: app/static/console/  →  served at /console/
# SPA catch-all: any /console/* path → index.html (client-side routing)
import os as _os
from fastapi.responses import FileResponse as _FileResponse

_CONSOLE_DIR = _os.path.join(_os.path.dirname(__file__), "static", "console")

if _os.path.isdir(_CONSOLE_DIR):
    app.mount("/console/assets", StaticFiles(directory=_os.path.join(_CONSOLE_DIR, "assets")), name="console-assets")

    @app.get("/console/{full_path:path}", include_in_schema=False)
    async def serve_console(full_path: str):  # noqa: ARG001
        index = _os.path.join(_CONSOLE_DIR, "index.html")
        return _FileResponse(index)

    @app.get("/console", include_in_schema=False)
    async def serve_console_root():
        index = _os.path.join(_CONSOLE_DIR, "index.html")
        return _FileResponse(index)

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    """Suppress browser 404 noise for favicon requests."""
    from fastapi.responses import Response
    return Response(status_code=204)


_TOKEN_PATTERNS = {
    "X-User-Token": [
        re.compile(r"(?im)^\s*X-User-Token\s*:\s*([^\r\n]+)\s*$"),
        re.compile(r"(?i)\"X-User-Token\"\s*:\s*\"([^\"]+)\""),
        re.compile(r"(?i)\bX-User-Token\b\s*=\s*([^\s;]+)"),
    ],
    "x-project-uuid": [
        re.compile(r"(?im)^\s*x-project-uuid\s*:\s*([^\r\n]+)\s*$"),
        re.compile(r"(?i)\"x-project-uuid\"\s*:\s*\"([^\"]+)\""),
        re.compile(r"(?i)\bx-project-uuid\b\s*=\s*([^\s;]+)"),
    ],
    "workflow_uuid": [
        re.compile(r"(?i)\"workflow_uuid\"\s*:\s*\"([^\"]+)\""),
        re.compile(r"(?i)\bworkflow_uuid\b\s*=\s*([^\s;]+)"),
    ],
}


def _extract_tokens(raw: str) -> dict:
    out: dict[str, str] = {}
    if not raw:
        return out
    for k, pats in _TOKEN_PATTERNS.items():
        for p in pats:
            m = p.search(raw)
            if m:
                out[k] = m.group(1).strip().strip('"')
                break
    return out

redis: Redis | None = None
repo: RedisRepo | None = None
bus: RedisStreamBus | None = None


def _require_admin(x_admin_token: str | None):
    if settings.ADMIN_TOKEN and x_admin_token != settings.ADMIN_TOKEN:
        raise PermissionError("admin token invalid")


@app.on_event("startup")
async def on_startup():
    global redis, repo, bus
    redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    repo = RedisRepo(redis)
    bus = RedisStreamBus(redis, settings.STREAM_KEY_RAW)


@app.on_event("shutdown")
async def on_shutdown():
    global redis
    if redis:
        await redis.aclose()


def _require_source_auth(source: str, request: Request, srcauth: dict):
    """Inbound auth: only authenticated requests can enter queue.

    Current POC supports: mode=static_token.
    """
    if not isinstance(srcauth, dict) or not srcauth:
        raise HTTPException(status_code=401, detail=f"source_not_registered_or_auth_missing: {source}")

    enabled = bool(srcauth.get("enabled", True))
    if not enabled:
        raise HTTPException(status_code=403, detail=f"source_disabled: {source}")

    mode = (srcauth.get("mode") or "static_token").lower()
    if mode != "static_token":
        raise HTTPException(status_code=400, detail=f"unsupported_auth_mode: {mode}")

    header_name = srcauth.get("header_name") or "X-MW-Token"
    expected = str(srcauth.get("token") or "")
    got = request.headers.get(header_name) or ""

    if not expected or got != expected:
        raise HTTPException(status_code=401, detail="auth_failed")


@app.post("/webhook")
async def webhook_ingest(payload: dict[str, Any], request: Request):
    """POST only. Body: {source, webhook_event}. Requires per-source inbound auth."""
    global bus, repo
    assert bus is not None
    assert repo is not None

    source = payload.get("source") or settings.DEFAULT_SOURCE
    webhook_event = payload.get("webhook_event")
    if webhook_event is None:
        return {"status": "error", "message": "missing webhook_event"}

    # inbound auth gate (pass -> enqueue)
    srcauth = await repo.get_source_auth(source)
    _require_source_auth(source, request, srcauth)

    received_at = int(time.time())

    # store some request meta for debugging/audit
    hdr = {}
    for k in ("content-type", "user-agent", "x-forwarded-for"):
        if k in request.headers:
            hdr[k] = request.headers.get(k)

    msg = {
        "source": source,
        "received_at": received_at,
        "request": {"path": str(request.url.path), "method": "POST", "headers": hdr},
        "webhook_event": webhook_event,
    }

    await bus.produce(msg)
    return {"status": "accepted", "queue": "redis_stream", "stream": settings.STREAM_KEY_RAW}


def _default_mapping() -> dict:
    return {
        "mappings": [
            {"src": "$.timestamp", "dst": "timestamp", "type": "string", "default": "", "required": False},
            {"src": "$.creator_id", "dst": "creator_id", "type": "string", "default": "system", "required": True},
            {"src": "$.latitude", "dst": "latitude", "type": "float", "default": 0, "required": True},
            {"src": "$.longitude", "dst": "longitude", "type": "float", "default": 0, "required": True},
            {"src": "$.level", "dst": "level", "type": "string", "default": "info", "required": True},
            {"src": "$.description", "dst": "description", "type": "string", "default": "", "required": False},
        ]
    }


def _default_fhcfg() -> dict:
    return {
        "endpoint": settings.DEFAULT_FLIGHTHUB_ENDPOINT,
        "headers": {
            "Content-Type": "application/json",
            "X-User-Token": "",
            "x-project-uuid": "",
        },
        "template_body": {
            "workflow_uuid": "",
            "trigger_type": 0,
            "name": "Alert-{{timestamp}}",
            "params": {
                "creator": "{{creator_id}}",
                "latitude": "{{latitude}}",
                "longitude": "{{longitude}}",
                "level": "{{level}}",
                "desc": "{{description}}",
            },
        },
        "retry_policy": {"max_retries": 3, "backoff": "exponential"},
    }


@app.post("/admin/source/list")
async def source_list(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    sources = await repo.list_sources()
    return {"status": "ok", "sources": sources}


@app.post("/admin/source/init")
async def source_init(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    """Create Redis keys for a new source (mapping + flighthub config + inbound auth) if absent."""
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    if not source:
        return {"status": "error", "message": "missing source"}

    # If already exists, keep as-is unless force=true
    force = bool(payload.get("force", False))

    existing_map = await repo.get_mapping(source)
    existing_cfg = await repo.get_fhcfg(source)

    if (existing_map.get("mappings") or existing_cfg) and not force:
        return {"status": "ok", "message": "already exists", "source": source}

    await repo.set_mapping(source, _default_mapping())
    await repo.set_fhcfg(source, _default_fhcfg())

    # default inbound auth: disabled until token set
    await repo.set_source_auth(source, {
        "enabled": True,
        "mode": "static_token",
        "header_name": "X-MW-Token",
        "token": "",
    })

    return {"status": "ok", "message": "initialized", "source": source}


@app.post("/admin/source/delete")
async def source_delete(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    """Delete all Redis keys associated with a source (map, fhcfg, srcauth, adapter)."""
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source", "").strip()
    if not source:
        return {"status": "error", "message": "missing source"}

    keys_to_delete = [
        f"uw:map:{source}",
        f"uw:fhcfg:{source}",
        f"uw:srcauth:{source}",
        f"uw:adapter:{source}",
    ]
    deleted = 0
    for key in keys_to_delete:
        n = await repo.redis.delete(key)
        deleted += n

    return {"status": "ok", "source": source, "keys_deleted": deleted}


@app.post("/admin/token/extract")
async def token_extract(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    """Helper endpoint for GUI: paste raw headers / curl / JSON, extract token fields.

    Note: this is for FlightHub2 auth trio extraction, not middleware inbound auth.
    """
    _require_admin(x_admin_token)
    raw = str(payload.get("raw") or "")
    extracted = _extract_tokens(raw)
    return {"status": "ok", "extracted": extracted}


@app.post("/admin/source/auth/get")
async def source_auth_get(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    if not source:
        return {"status": "error", "message": "missing source"}

    cfg = await repo.get_source_auth(source)

    # mask token on read
    def mask(v: str):
        if not v or len(v) < 8:
            return "****"
        return v[:3] + "****" + v[-3:]

    if isinstance(cfg, dict) and "token" in cfg:
        cfg = dict(cfg)
        cfg["token"] = mask(str(cfg.get("token") or ""))

    return {"status": "ok", "source": source, "auth": cfg}


@app.post("/admin/source/auth/set")
async def source_auth_set(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    cfg = payload.get("auth")
    if not source or cfg is None:
        return {"status": "error", "message": "missing source or auth"}

    # 如果前端未传 token（留空保留原值），从 Redis 读取原 token 合并
    if isinstance(cfg, dict) and not cfg.get("token"):
        existing = await repo.get_source_auth(source)
        if isinstance(existing, dict) and existing.get("token"):
            cfg = dict(cfg)
            cfg["token"] = existing["token"]

    await repo.set_source_auth(source, cfg)
    return {"status": "ok"}


@app.post("/admin/mapping/get")
async def mapping_get(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    if not source:
        return {"status": "error", "message": "missing source"}

    mapping = await repo.get_mapping(source)
    return {"status": "ok", "source": source, "mapping": mapping}


@app.post("/admin/mapping/set")
async def mapping_set(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    mapping = payload.get("mapping")
    if not source or mapping is None:
        return {"status": "error", "message": "missing source or mapping"}

    await repo.set_mapping(source, mapping)
    return {"status": "ok"}


@app.post("/admin/flighthub/get")
async def flighthub_get(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    if not source:
        return {"status": "error", "message": "missing source"}

    cfg = await repo.get_fhcfg(source)

    # mask secrets on read
    def mask(v: str):
        if not v or len(v) < 8:
            return "****"
        return v[:4] + "****" + v[-4:]

    if isinstance(cfg, dict):
        headers = cfg.get("headers")
        if isinstance(headers, dict):
            if "X-User-Token" in headers:
                headers = dict(headers)
                headers["X-User-Token"] = mask(str(headers["X-User-Token"]))
                cfg = dict(cfg)
                cfg["headers"] = headers

    return {"status": "ok", "source": source, "config": cfg}


@app.post("/admin/flighthub/set")
async def flighthub_set(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    cfg = payload.get("config")
    if not source or cfg is None:
        return {"status": "error", "message": "missing source or config"}

    await repo.set_fhcfg(source, cfg)
    return {"status": "ok"}


# ════════════════════════════════════════════════════════════════════════════
# ADAPTER  (uw:adapter:{source})
# ════════════════════════════════════════════════════════════════════════════

@app.post("/admin/adapter/get")
async def adapter_get(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    if not source:
        return {"status": "error", "message": "missing source"}

    cfg = await repo.get_adapter(source)
    return {"status": "ok", "source": source, "adapter": cfg}


@app.post("/admin/adapter/set")
async def adapter_set(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    cfg = payload.get("adapter")
    if not source or cfg is None:
        return {"status": "error", "message": "missing source or adapter"}

    await repo.set_adapter(source, cfg)
    return {"status": "ok"}


# ════════════════════════════════════════════════════════════════════════════
# DEVICE  (uw:device:{device_id})
# ════════════════════════════════════════════════════════════════════════════

@app.post("/admin/device/get")
async def device_get(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    device_id = payload.get("device_id")
    if not device_id:
        return {"status": "error", "message": "missing device_id"}

    info = await repo.get_device(device_id)
    return {"status": "ok", "device_id": device_id, "device": info}


@app.post("/admin/device/set")
async def device_set(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    device_id = payload.get("device_id")
    info = payload.get("device")
    if not device_id or info is None:
        return {"status": "error", "message": "missing device_id or device"}

    await repo.set_device(device_id, info)
    return {"status": "ok"}


@app.post("/admin/device/delete")
async def device_delete(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    device_id = payload.get("device_id")
    if not device_id:
        return {"status": "error", "message": "missing device_id"}

    await repo.redis.delete(repo._k_device(device_id))
    return {"status": "ok"}


@app.post("/admin/device/list")
async def device_list(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    device_ids: list[str] = []
    cursor = 0
    while True:
        cursor, keys = await repo.redis.scan(cursor=cursor, match="uw:device:*", count=200)
        for k in keys:
            if isinstance(k, bytes):
                k = k.decode("utf-8", errors="ignore")
            device_ids.append(k[len("uw:device:"):])
        if cursor == 0:
            break

    return {"status": "ok", "devices": sorted(device_ids)}


# ════════════════════════════════════════════════════════════════════════════
# DEBUG  — run full pipeline on a sample payload, return each stage output
# ════════════════════════════════════════════════════════════════════════════

@app.post("/admin/debug/run")
async def debug_run(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    """Dry-run the full processing pipeline without writing to Redis Stream.

    Input:  { source, sample_payload }
    Output: { raw, flat, normalized, mapped, event, final_body, missing, normalized_fields }
    """
    global repo
    assert repo is not None
    _require_admin(x_admin_token)

    import time as _time
    from app.flatten import flatten_json
    from app.normalize import normalize, get_normalized_fields
    from app.mapping_engine import apply_mappings
    from app.canonical import build_event
    from app.enrichment import enrich
    from app.autofill import autofill, build_fh2_body

    source = payload.get("source") or settings.DEFAULT_SOURCE
    raw: dict = payload.get("sample_payload") or {}

    stages: dict[str, Any] = {"source": source, "raw": raw}

    try:
        # Stage 1 — flatten
        flat = flatten_json(raw)
        stages["flat"] = flat

        # Stage 2 — normalize (adapter)
        adapter_conf = await repo.get_adapter(source)
        normalized = normalize(flat, adapter_conf)
        stages["normalized"] = normalized
        stages["normalized_fields"] = get_normalized_fields(flat, adapter_conf)

        # Stage 3 — mapping
        mapping_conf = await repo.get_mapping(source)
        received_at = int(_time.time())
        mapped = apply_mappings(raw, source, mapping_conf, received_at, flat_event=normalized)
        stages["mapped"] = mapped

        # Stage 4 — canonical
        event = build_event(mapped, raw, source)

        # Stage 5 — enrichment (read-only)
        event = await enrich(event, repo)
        stages["event"] = event

        # Stage 6 — autofill → final FH2 body
        fhcfg = await repo.get_fhcfg(source)
        device_id = event.get("device_id") or event.get("device", {}).get("id") or ""
        device_info = (await repo.get_device(str(device_id))) if device_id else {}
        autofill_conf = fhcfg.get("autofill", {}) if isinstance(fhcfg, dict) else {}
        workflow_uuid = ""
        if isinstance(fhcfg, dict):
            tb = fhcfg.get("template_body", {})
            if isinstance(tb, dict):
                workflow_uuid = str(tb.get("workflow_uuid", ""))

        filled, missing = autofill(event, device_info, autofill_conf)
        final_body = build_fh2_body(filled, workflow_uuid=workflow_uuid)
        stages["final_body"] = final_body
        stages["missing"] = missing

        return {"status": "ok", **stages}

    except Exception as exc:
        return {"status": "error", "message": str(exc), **stages}
