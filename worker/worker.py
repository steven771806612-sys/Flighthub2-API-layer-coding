from __future__ import annotations

import asyncio
import json
import time

import httpx
from redis.asyncio import Redis

from app.config import settings
from app.redis_repo import RedisRepo
from app.mapping_engine import apply_mappings
# ── Pipeline stages ──────────────────────────────────────────────────────────
from app.flatten import flatten_json
from app.normalize import normalize
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


async def run():
    redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    repo = RedisRepo(redis)

    await ensure_group(redis)

    print(f"[worker] consuming redis stream={settings.STREAM_KEY_RAW} group={settings.STREAM_GROUP} consumer={settings.STREAM_CONSUMER}")

    while True:
        # Read one message at a time, block up to 5s
        resp = await redis.xreadgroup(
            groupname=settings.STREAM_GROUP,
            consumername=settings.STREAM_CONSUMER,
            streams={settings.STREAM_KEY_RAW: ">"},
            count=1,
            block=5000,
        )

        if not resp:
            continue

        for stream_name, messages in resp:
            for msg_id, fields in messages:
                data = fields.get("data")
                try:
                    msg = json.loads(data) if data else {}
                except Exception:
                    msg = {}

                source = msg.get("source") or settings.DEFAULT_SOURCE
                received_at = int(msg.get("received_at") or _now_ts())
                webhook_event = msg.get("webhook_event") or {}

                mapping_conf = await repo.get_mapping(source)
                fhcfg = await repo.get_fhcfg(source)

                endpoint = (fhcfg.get("endpoint") if isinstance(fhcfg, dict) else None) or settings.DEFAULT_FLIGHTHUB_ENDPOINT
                headers = (fhcfg.get("headers") if isinstance(fhcfg, dict) else None) or {}
                retry_policy = (fhcfg.get("retry_policy") if isinstance(fhcfg, dict) else None) or {"max_retries": 3, "backoff": "exponential"}

                headers = dict(headers)
                headers.setdefault("Content-Type", "application/json")

                # ── Pipeline: raw → flatten → normalize → mapping → autofill → HTTP ──
                #
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
                    print(f"[worker] mapping error source={source}: {e}")
                    await redis.xack(settings.STREAM_KEY_RAW, settings.STREAM_GROUP, msg_id)
                    continue

                # Step 4: Enrichment — inject device metadata if available
                unified = await enrich(unified, repo)

                # Step 5: Autofill → build final FH2 request body
                #
                # Resolve device_id:
                #  a) Standard key: unified["device_id"] or unified["device"]["id"]
                #  b) Per-source configured field (device_id_field) for vendors that
                #     use a non-standard identifier field (e.g. deviceSN, camera.id)
                device_id = unified.get("device_id") or ""
                if isinstance(unified.get("device"), dict):
                    device_id = device_id or unified["device"].get("id", "")

                if not device_id:
                    device_id_field = await repo.get_device_id_field(source)
                    if device_id_field:
                        # Try unified dict first, then the flat dict
                        device_id = str(
                            unified.get(device_id_field) or flat.get(device_id_field) or ""
                        )

                device_info = (await repo.get_device(str(device_id))) if device_id else {}

                autofill_conf = {}
                workflow_uuid = ""
                if isinstance(fhcfg, dict):
                    autofill_conf = fhcfg.get("autofill", {})
                    tb = fhcfg.get("template_body", {})
                    if isinstance(tb, dict):
                        workflow_uuid = str(tb.get("workflow_uuid", ""))

                filled, missing_fields = autofill(unified, device_info, autofill_conf)
                body = build_fh2_body(filled, workflow_uuid=workflow_uuid)

                if missing_fields:
                    print(f"[worker] missing fields source={source} fields={missing_fields}")

                status, text = await push_flighthub(endpoint, headers, body, retry_policy)
                print(f"[worker] pushed msg_id={msg_id} source={source} http_status={status} name={body.get('name') if isinstance(body, dict) else 'n/a'}")
                if status and status >= 400:
                    print(f"[worker] response: {text[:300]}")

                await redis.xack(settings.STREAM_KEY_RAW, settings.STREAM_GROUP, msg_id)


if __name__ == "__main__":
    asyncio.run(run())
