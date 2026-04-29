from __future__ import annotations

import asyncio
import json
import time
import traceback

import httpx
from redis.asyncio import Redis

from app.config import settings
from app.redis_repo import RedisRepo
from app.mapping_engine import apply_mappings
# ── Pipeline stages ──────────────────────────────────────────────────────────
from app.flatten import flatten_json
from app.normalize import normalize
from app.canonical import build_event
from app.enrichment import enrich
from app.autofill import autofill, build_fh2_body


def _now_ts() -> int:
    return int(time.time())


async def push_flighthub(endpoint: str, headers: dict, body: dict, retry_policy: dict | None):
    max_retries = int((retry_policy or {}).get("max_retries", 3))
    backoff = (retry_policy or {}).get("backoff", "exponential")

    async with httpx.AsyncClient(timeout=20.0) as client:
        for attempt in range(0, max_retries + 1):
            try:
                r = await client.post(endpoint, headers=headers, json=body)
                return r.status_code, r.text
            except Exception as e:
                if attempt >= max_retries:
                    return 0, f"EXCEPTION: {repr(e)}"
                sleep_s = (2 ** attempt) if backoff == "exponential" else 1
                await asyncio.sleep(sleep_s)


async def ensure_group(redis: Redis):
    try:
        await redis.xgroup_create(name=settings.STREAM_KEY_RAW, groupname=settings.STREAM_GROUP, id="0-0", mkstream=True)
    except Exception as e:
        # BUSYGROUP means already exists
        if "BUSYGROUP" not in str(e):
            raise


async def recover_pending(redis: Redis, repo: RedisRepo) -> int:
    """Reclaim messages that were delivered but never ACK'd (stuck in PEL > 30 s).

    Uses XAUTOCLAIM (Redis >= 6.2) to steal stale pending messages back to
    this consumer so they get re-processed.  Falls back gracefully on older
    Redis versions.

    Returns the number of messages reclaimed.
    """
    reclaimed = 0
    min_idle_ms = 30_000  # 30 seconds

    try:
        # XAUTOCLAIM: steal up to 100 messages idle > 30 s, starting from 0-0
        result = await redis.xautoclaim(
            name=settings.STREAM_KEY_RAW,
            groupname=settings.STREAM_GROUP,
            consumername=settings.STREAM_CONSUMER,
            min_idle_time=min_idle_ms,
            start_id="0-0",
            count=100,
        )
        # result = (next_start_id, [(msg_id, fields), ...], [deleted_ids])
        messages = result[1] if isinstance(result, (list, tuple)) and len(result) > 1 else []
        reclaimed = len(messages) if messages else 0
        if reclaimed:
            print(f"[worker] PEL recovery: reclaimed {reclaimed} pending message(s) via XAUTOCLAIM")
    except Exception as e:
        err_str = str(e)
        if "ERR unknown command" in err_str or "CROSSSLOT" in err_str:
            # Redis < 6.2 or cluster limitation — skip silently
            print(f"[worker] PEL recovery: XAUTOCLAIM not available ({err_str[:80]}), skipping")
        else:
            print(f"[worker] PEL recovery warning: {e}")

    return reclaimed


async def process_message(
    msg_id: str,
    fields: dict,
    redis: Redis,
    repo: RedisRepo,
) -> None:
    """Process a single stream message end-to-end.

    Always ACKs the message (even on error) so it never gets stuck in PEL
    permanently.  Errors are written to the Processing Log so they surface
    in the console UI.
    """
    data = fields.get("data")
    try:
        msg = json.loads(data) if data else {}
    except Exception:
        msg = {}

    source = msg.get("source") or settings.DEFAULT_SOURCE
    received_at = int(msg.get("received_at") or _now_ts())
    webhook_event = msg.get("webhook_event") or {}

    # ── Outer guard: catch any unhandled exception so the worker never dies ──
    try:
        mapping_conf = await repo.get_mapping(source)
        fhcfg = await repo.get_fhcfg(source)

        endpoint = (fhcfg.get("endpoint") if isinstance(fhcfg, dict) else None) or settings.DEFAULT_FLIGHTHUB_ENDPOINT
        headers = (fhcfg.get("headers") if isinstance(fhcfg, dict) else None) or {}
        retry_policy = (fhcfg.get("retry_policy") if isinstance(fhcfg, dict) else None) or {"max_retries": 3, "backoff": "exponential"}

        headers = dict(headers)
        headers.setdefault("Content-Type", "application/json")

        # ── Pipeline: raw → flatten → normalize → mapping → canonical → enrichment → autofill → HTTP ──
        # NOTE: must mirror the debug_run pipeline in app/main.py exactly so
        # third-party pushes produce identical results to manual test triggers.

        # Step 1: Flatten nested event into dot-notation dict
        flat = flatten_json(webhook_event)

        # Step 2: Normalize — apply adapter config to produce unified fields
        adapter_conf = await repo.get_adapter(source)
        normalized_flat = normalize(flat, adapter_conf)

        # Step 3: Mapping — JSONPath / DSL mappings applied to normalized flat
        try:
            unified = apply_mappings(
                webhook_event, source, mapping_conf, received_at,
                flat_event=normalized_flat,
            )
        except Exception as e:
            print(f"[worker] mapping error source={source} msg_id={msg_id}: {e}")
            # Write a failed log entry so it's visible in the console
            await _write_error_log(repo, source, msg_id, f"mapping error: {e}")
            await redis.xack(settings.STREAM_KEY_RAW, settings.STREAM_GROUP, msg_id)
            return

        # Step 4: Canonical envelope — normalises shape, extracts location,
        # merges all mapped fields.
        unified = build_event(unified, webhook_event, source)

        # Step 5: Resolve device_id FIRST so enrichment can look up the device.
        # Order matters: device_id must be injected into unified BEFORE enrich()
        # is called, otherwise enrich() finds no device_id and skips the lookup,
        # leaving location={lat:None, lng:None} and blocking coord injection.
        device_id = unified.get("device_id") or ""
        if isinstance(unified.get("device"), dict):
            device_id = device_id or unified["device"].get("id", "")

        if not device_id:
            # Per-source field config: e.g. for hikvision "creator_id" is the
            # device key (set via Console → Device → Device ID Field).
            device_id_field = await repo.get_device_id_field(source)
            if device_id_field:
                device_id = str(
                    unified.get(device_id_field) or flat.get(device_id_field) or ""
                )

        # Inject device_id into the event so enrich() can find it
        if device_id:
            unified["device_id"] = device_id
            unified["device"] = {"id": device_id}

        # Step 6: Enrichment — inject device metadata (location, model, site…)
        # from uw:device:{device_id}.  Now that device_id is set, enrich() will
        # find the record and write location into unified["location"].
        unified = await enrich(unified, repo)

        # Step 7: Fetch device_info for autofill's coord injection fallback
        # (autofill reads both unified["location"] AND device_info["location"])
        device_info = (await repo.get_device(str(device_id))) if device_id else {}

        # Step 8: Autofill — fill missing FH2 body fields using flat-event
        # fallback (keyword matching), device location, and configured defaults.
        autofill_conf = {}
        workflow_uuid = ""
        if isinstance(fhcfg, dict):
            autofill_conf = fhcfg.get("autofill", {})
            tb = fhcfg.get("template_body", {})
            if isinstance(tb, dict):
                workflow_uuid = str(tb.get("workflow_uuid", ""))

        filled, missing_fields = autofill(unified, device_info, autofill_conf, flat_event=flat)
        body = build_fh2_body(filled, workflow_uuid=workflow_uuid)

        if missing_fields:
            print(f"[worker] missing fields source={source} fields={missing_fields}")

        # Step 9: Push to FlightHub2
        status, text = await push_flighthub(endpoint, headers, body, retry_policy)
        print(f"[worker] pushed msg_id={msg_id} source={source} http_status={status} name={body.get('name') if isinstance(body, dict) else 'n/a'}")
        if status and status >= 400:
            print(f"[worker] FH2 error response: {text[:300]}")

        # ── Persist processing log entry to Redis ──────────────────────────────
        try:
            log_entry = {
                "ts": _now_ts(),
                "source": source,
                "msg_id": msg_id,
                "http_status": status,
                "fh2_response": text[:500] if text else "",
                "body_name": body.get("name", "") if isinstance(body, dict) else "",
                "workflow_uuid": body.get("workflow_uuid", "") if isinstance(body, dict) else "",
                "missing_fields": missing_fields,
                "ok": bool(status and 200 <= status < 300),
            }
            await repo.append_log(source, log_entry)
        except Exception as log_exc:
            print(f"[worker] log_write_error: {log_exc}")

    except Exception as exc:
        # Unhandled exception in pipeline — log it, do NOT re-raise
        tb_str = traceback.format_exc()
        print(f"[worker] UNHANDLED ERROR msg_id={msg_id} source={source}: {exc}\n{tb_str}")
        await _write_error_log(repo, source, msg_id, f"pipeline crash: {exc}")

    finally:
        # Always ACK so the message is removed from PEL and never re-delivered
        try:
            await redis.xack(settings.STREAM_KEY_RAW, settings.STREAM_GROUP, msg_id)
        except Exception as ack_exc:
            print(f"[worker] XACK failed msg_id={msg_id}: {ack_exc}")


async def _write_error_log(repo: RedisRepo, source: str, msg_id: str, error_msg: str) -> None:
    """Write a failed-processing log entry so errors are visible in the console UI."""
    try:
        log_entry = {
            "ts": _now_ts(),
            "source": source,
            "msg_id": msg_id,
            "http_status": 0,
            "fh2_response": error_msg[:500],
            "body_name": "",
            "workflow_uuid": "",
            "missing_fields": [],
            "ok": False,
        }
        await repo.append_log(source, log_entry)
    except Exception:
        pass  # never let logging crash the worker


async def run():
    import re as _re
    # Log masked Redis URL so it's visible in Railway deployment logs
    masked_url = _re.sub(r"(rediss?://)([^@]+@)", r"\1***@", settings.REDIS_URL)
    print(f"[worker] startup: REDIS_URL={masked_url}")
    print(f"[worker] startup: STREAM_KEY={settings.STREAM_KEY_RAW} GROUP={settings.STREAM_GROUP} CONSUMER={settings.STREAM_CONSUMER}")

    redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    repo = RedisRepo(redis)

    await ensure_group(redis)

    # ── Recover any messages stuck in PEL from a previous crashed worker ─────
    await recover_pending(redis, repo)

    print(f"[worker] ready — consuming stream={settings.STREAM_KEY_RAW} group={settings.STREAM_GROUP} consumer={settings.STREAM_CONSUMER}")

    while True:
        try:
            # Read one message at a time, block up to 5s
            resp = await redis.xreadgroup(
                groupname=settings.STREAM_GROUP,
                consumername=settings.STREAM_CONSUMER,
                streams={settings.STREAM_KEY_RAW: ">"},
                count=1,
                block=5000,
            )
        except Exception as read_exc:
            print(f"[worker] xreadgroup error: {read_exc} — retrying in 2s")
            await asyncio.sleep(2)
            continue

        if not resp:
            continue

        for stream_name, messages in resp:
            for msg_id, fields in messages:
                await process_message(msg_id, fields, redis, repo)


if __name__ == "__main__":
    asyncio.run(run())
