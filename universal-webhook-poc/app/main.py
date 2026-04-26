from __future__ import annotations

import os
import time
import uuid
from typing import Any

import re
from fastapi import FastAPI, Request, Header
from fastapi import HTTPException
from starlette.staticfiles import StaticFiles
from redis.asyncio import Redis

from app.config import settings
from app.redis_repo import RedisRepo
from app.queue_bus import RedisStreamBus
from app.mapping_engine import apply_mappings
from app.template_engine import render_obj

app = FastAPI(title="Universal Webhook Middleware (POC)")

# Lightweight HTML admin UI — GET /ui/
app.mount("/ui", StaticFiles(directory="app/static", html=True), name="ui")

# ---- token extraction patterns ------------------------------------------------
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


# ---- globals ------------------------------------------------------------------
redis: Redis | None = None
repo: RedisRepo | None = None
bus: RedisStreamBus | None = None


# ---- lifecycle ----------------------------------------------------------------
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


# ---- helpers ------------------------------------------------------------------
def _require_admin(x_admin_token: str | None):
    if settings.ADMIN_TOKEN and x_admin_token != settings.ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="admin token invalid")


def _require_source_auth(source: str, request: Request, srcauth: dict):
    """
    Inbound auth gate.
    - If source not registered → 401
    - If enabled=False         → pass through (auth disabled)
    - If enabled=True          → validate static token
    """
    if not isinstance(srcauth, dict) or not srcauth:
        raise HTTPException(
            status_code=401,
            detail=f"source_not_registered_or_auth_missing: {source}",
        )

    enabled = bool(srcauth.get("enabled", True))
    if not enabled:
        # Auth explicitly disabled — allow all requests through
        return

    mode = (srcauth.get("mode") or "static_token").lower()
    if mode != "static_token":
        raise HTTPException(status_code=400, detail=f"unsupported_auth_mode: {mode}")

    header_name = srcauth.get("header_name") or "X-MW-Token"
    expected = str(srcauth.get("token") or "")
    got = request.headers.get(header_name) or ""

    if not expected or got != expected:
        raise HTTPException(status_code=401, detail="auth_failed")


def _default_mapping() -> dict:
    return {
        "mappings": [
            {"src": "$.timestamp",   "dst": "timestamp",   "type": "string", "default": "",       "required": False},
            {"src": "$.creator_id",  "dst": "creator_id",  "type": "string", "default": "system", "required": True},
            {"src": "$.latitude",    "dst": "latitude",    "type": "float",  "default": 0,        "required": True},
            {"src": "$.longitude",   "dst": "longitude",   "type": "float",  "default": 0,        "required": True},
            {"src": "$.level",       "dst": "level",       "type": "string", "default": "info",   "required": True},
            {"src": "$.description", "dst": "description", "type": "string", "default": "",       "required": False},
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
                "creator":   "{{creator_id}}",
                "latitude":  "{{latitude}}",
                "longitude": "{{longitude}}",
                "level":     "{{level}}",
                "desc":      "{{description}}",
            },
        },
        "retry_policy": {"max_retries": 3, "backoff": "exponential"},
    }


def _mask_token(v: str, keep: int = 3) -> str:
    if not v or len(v) < keep * 2 + 2:
        return "****"
    return v[:keep] + "****" + v[-keep:]


# ==============================================================================
#  WEBHOOK INGRESS
# ==============================================================================

@app.post("/webhook")
async def webhook_ingest(payload: dict[str, Any], request: Request):
    """
    POST only.
    Body: {source, webhook_event, test_id?}
    Requires per-source inbound auth (unless auth is disabled for the source).
    """
    global bus, repo
    assert bus is not None and repo is not None

    source = payload.get("source") or settings.DEFAULT_SOURCE
    webhook_event = payload.get("webhook_event")
    test_id: str = payload.get("test_id") or str(uuid.uuid4())

    if webhook_event is None:
        return {"status": "error", "message": "missing webhook_event"}

    srcauth = await repo.get_source_auth(source)
    _require_source_auth(source, request, srcauth)

    received_at = int(time.time())

    hdr = {}
    for k in ("content-type", "user-agent", "x-forwarded-for"):
        if k in request.headers:
            hdr[k] = request.headers.get(k)

    msg = {
        "source":       source,
        "received_at":  received_at,
        "test_id":      test_id,
        "request":      {"path": str(request.url.path), "method": "POST", "headers": hdr},
        "webhook_event": webhook_event,
    }

    await bus.produce(msg)
    return {
        "status":  "accepted",
        "queue":   "redis_stream",
        "stream":  settings.STREAM_KEY_RAW,
        "test_id": test_id,
    }


# ==============================================================================
#  SOURCE MANAGEMENT
# ==============================================================================

@app.post("/admin/source/list")
async def source_list(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    assert repo is not None
    _require_admin(x_admin_token)
    sources = await repo.list_sources()
    return {"status": "ok", "sources": sources}


@app.post("/admin/source/init")
async def source_init(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    """Initialise Redis keys for a new source (mapping + flighthub config + inbound auth)."""
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    if not source:
        return {"status": "error", "message": "missing source"}

    force = bool(payload.get("force", False))
    existing_map = await repo.get_mapping(source)
    existing_cfg = await repo.get_fhcfg(source)

    if (existing_map.get("mappings") or existing_cfg) and not force:
        return {"status": "ok", "message": "already exists", "source": source}

    await repo.set_mapping(source, _default_mapping())
    await repo.set_fhcfg(source, _default_fhcfg())
    await repo.set_source_auth(source, {
        "enabled":     True,
        "mode":        "static_token",
        "header_name": "X-MW-Token",
        "token":       "",
    })
    return {"status": "ok", "message": "initialized", "source": source}


# ==============================================================================
#  TOKEN EXTRACTION
# ==============================================================================

@app.post("/admin/token/extract")
async def token_extract(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    """Extract FH2 auth trio from raw header / curl / JSON text."""
    _require_admin(x_admin_token)
    raw = str(payload.get("raw") or "")
    extracted = _extract_tokens(raw)
    return {"status": "ok", "extracted": extracted}


# ==============================================================================
#  SOURCE AUTH
# ==============================================================================

@app.post("/admin/source/auth/get")
async def source_auth_get(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    if not source:
        return {"status": "error", "message": "missing source"}

    cfg = await repo.get_source_auth(source)
    if isinstance(cfg, dict) and "token" in cfg:
        cfg = dict(cfg)
        cfg["token"] = _mask_token(str(cfg.get("token") or ""))
    return {"status": "ok", "source": source, "auth": cfg}


@app.post("/admin/source/auth/set")
async def source_auth_set(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    cfg = payload.get("auth")
    if not source or cfg is None:
        return {"status": "error", "message": "missing source or auth"}

    await repo.set_source_auth(source, cfg)
    return {"status": "ok"}


# ==============================================================================
#  FIELD MAPPING
# ==============================================================================

@app.post("/admin/mapping/get")
async def mapping_get(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    if not source:
        return {"status": "error", "message": "missing source"}

    mapping = await repo.get_mapping(source)
    return {"status": "ok", "source": source, "mapping": mapping}


@app.post("/admin/mapping/set")
async def mapping_set(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    mapping = payload.get("mapping")
    if not source or mapping is None:
        return {"status": "error", "message": "missing source or mapping"}

    await repo.set_mapping(source, mapping)
    return {"status": "ok"}


# ==============================================================================
#  FLIGHTHUB CONFIG
# ==============================================================================

@app.post("/admin/flighthub/get")
async def flighthub_get(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    if not source:
        return {"status": "error", "message": "missing source"}

    cfg = await repo.get_fhcfg(source)
    if isinstance(cfg, dict):
        headers = cfg.get("headers")
        if isinstance(headers, dict) and "X-User-Token" in headers:
            headers = dict(headers)
            headers["X-User-Token"] = _mask_token(str(headers["X-User-Token"]), keep=4)
            cfg = dict(cfg)
            cfg["headers"] = headers

    return {"status": "ok", "source": source, "config": cfg}


@app.post("/admin/flighthub/set")
async def flighthub_set(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    cfg = payload.get("config")
    if not source or cfg is None:
        return {"status": "error", "message": "missing source or config"}

    await repo.set_fhcfg(source, cfg)
    return {"status": "ok"}


# ==============================================================================
#  PIPELINE PREVIEW  (dry-run: mapping + template render, no HTTP push)
# ==============================================================================

@app.post("/admin/pipeline/preview")
async def pipeline_preview(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    """
    Dry-run the mapping + template render pipeline for a given source and event.
    Does NOT send anything to FlightHub2.

    Body: {source, webhook_event}
    """
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source") or settings.DEFAULT_SOURCE
    webhook_event = payload.get("webhook_event") or {}
    received_at = int(time.time())

    mapping_conf = await repo.get_mapping(source)
    fhcfg = await repo.get_fhcfg(source)
    template_body = (fhcfg.get("template_body") if isinstance(fhcfg, dict) else None) or {}

    try:
        unified = apply_mappings(webhook_event, source, mapping_conf, received_at)
    except Exception as e:
        return {"status": "error", "stage": "mapping", "message": str(e)}

    ctx = dict(unified)
    if isinstance(template_body, dict) and "workflow_uuid" in template_body:
        ctx["workflow_uuid"] = template_body.get("workflow_uuid")

    rendered = render_obj(template_body, ctx)

    return {
        "status":        "ok",
        "source":        source,
        "unified":       unified,
        "rendered_body": rendered,
    }


# ==============================================================================
#  LAST RESULT & PUSH LOG
# ==============================================================================

@app.post("/admin/dashboard/last_result")
async def dashboard_last_result(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    """
    Return the most recent FH2 push result for a source, or search by test_id.

    Body: {source?, test_id?}
    """
    assert repo is not None
    _require_admin(x_admin_token)

    test_id: str = payload.get("test_id") or ""
    source: str = payload.get("source") or ""

    if test_id:
        sources = await repo.list_sources()
        result = await repo.get_last_push_by_test_id(test_id, sources)
        if result is None:
            return {"status": "not_found", "test_id": test_id}
        return {"status": "ok", "result": result}

    if source:
        result = await repo.get_last_push(source)
        if result is None:
            return {"status": "not_found", "source": source}
        return {"status": "ok", "result": result}

    return {"status": "error", "message": "provide source or test_id"}


@app.post("/admin/dashboard/push_log")
async def dashboard_push_log(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    """Return recent push history for a source."""
    assert repo is not None
    _require_admin(x_admin_token)

    source = payload.get("source")
    if not source:
        return {"status": "error", "message": "missing source"}

    limit = int(payload.get("limit") or 20)
    log = await repo.get_push_log(source, limit=limit)
    return {"status": "ok", "source": source, "log": log}


# ==============================================================================
#  DASHBOARD SUMMARY
# ==============================================================================

@app.post("/admin/dashboard/summary")
async def dashboard_summary(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    """
    Return a snapshot of system health for the Dashboard panel.

    Includes: stream length, last result per source, consumer group info,
    pending count, lag, and a refresh timestamp.
    """
    assert repo is not None
    assert redis is not None
    _require_admin(x_admin_token)

    sources = await repo.list_sources()

    # Stream length
    try:
        stream_len = await redis.xlen(settings.STREAM_KEY_RAW)
    except Exception:
        stream_len = -1

    # Last push result per source
    last_results: dict[str, Any] = {}
    for s in sources:
        r = await repo.get_last_push(s)
        if r:
            last_results[s] = r

    # Consumer group info
    group_info: list[dict] = []
    try:
        groups = await redis.xinfo_groups(settings.STREAM_KEY_RAW)
        for g in groups:
            # normalise bytes vs str
            def _v(d, *keys):
                for k in keys:
                    if k in d:
                        return d[k]
                    if k.encode() in d:
                        return d[k.encode()].decode() if isinstance(d[k.encode()], bytes) else d[k.encode()]
                return None

            consumers_raw = []
            try:
                consumers_raw = await redis.xinfo_consumers(
                    settings.STREAM_KEY_RAW, _v(g, "name") or settings.STREAM_GROUP
                )
            except Exception:
                pass

            consumers_info = []
            for c in consumers_raw:
                consumers_info.append({
                    "name":    _v(c, "name"),
                    "pending": _v(c, "pending"),
                    "idle_ms": _v(c, "idle"),
                })

            # lag calculation: delivered_id vs last entry id
            last_delivered = _v(g, "last-delivered-id", "last_delivered_id")
            try:
                pending_count = int(_v(g, "pending") or 0)
            except Exception:
                pending_count = 0

            group_info.append({
                "name":              _v(g, "name"),
                "consumers":         consumers_info,
                "consumer_count":    len(consumers_info),
                "pending":           pending_count,
                "last_delivered_id": last_delivered,
            })
    except Exception as e:
        group_info = [{"error": str(e)}]

    # Compute approximate lag (stream_len - entries acked up to last-delivered)
    lag = None
    if group_info and stream_len >= 0:
        try:
            pending_total = sum(g.get("pending", 0) for g in group_info if isinstance(g.get("pending"), int))
            lag = pending_total
        except Exception:
            pass

    return {
        "status":       "ok",
        "refreshed_at": int(time.time()),
        "stream":       settings.STREAM_KEY_RAW,
        "stream_len":   stream_len,
        "sources":      sources,
        "last_results": last_results,
        "groups":       group_info,
        "lag":          lag,
    }


# ==============================================================================
#  LOGS
# ==============================================================================

def _tail_log(path: str, lines: int = 200) -> list[str]:
    """Read the last N lines from a log file."""
    try:
        with open(path, "r", errors="replace") as f:
            all_lines = f.readlines()
        return [l.rstrip() for l in all_lines[-lines:]]
    except FileNotFoundError:
        return [f"[log not found: {path}]"]
    except Exception as e:
        return [f"[error reading log: {e}]"]


@app.post("/admin/dashboard/logs")
async def dashboard_logs(payload: dict[str, Any], x_admin_token: str | None = Header(default=None)):
    """
    Return log file contents.

    Body: {log: "api"|"worker-1"|"worker-2"|"all", lines?: int}
    """
    _require_admin(x_admin_token)

    log_name = str(payload.get("log") or "all")
    lines = int(payload.get("lines") or 200)

    log_dir = os.path.join(os.path.dirname(__file__), "..", "logs")
    log_dir = os.path.abspath(log_dir)

    log_files = {
        "api":      os.path.join(log_dir, "api.log"),
        "worker-1": os.path.join(log_dir, "worker-1.log"),
        "worker-2": os.path.join(log_dir, "worker-2.log"),
    }

    if log_name == "all":
        combined: list[str] = []
        for name, path in log_files.items():
            combined.append(f"=== {name}.log ===")
            combined.extend(_tail_log(path, lines))
        return {"status": "ok", "log": "all", "lines": combined}

    if log_name not in log_files:
        return {"status": "error", "message": f"unknown log '{log_name}'. choose api/worker-1/worker-2/all"}

    return {
        "status": "ok",
        "log":    log_name,
        "lines":  _tail_log(log_files[log_name], lines),
    }
