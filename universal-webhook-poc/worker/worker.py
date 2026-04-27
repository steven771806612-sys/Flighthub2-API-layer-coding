from __future__ import annotations

import asyncio
import json
import time
import uuid

import httpx
from redis.asyncio import Redis

from app.config import settings
from app.redis_repo import RedisRepo
from app.mapping_engine import apply_mappings
from app.template_engine import render_obj


def _now_ts() -> int:
    return int(time.time())


def _parse_business_result(http_status: int, text: str) -> tuple[int | None, str | None, bool]:
    """
    Parse FH2 response body to extract business_code and business_message.

    Returns: (business_code, business_message, is_success)
    Success criteria:
      - HTTP 2xx AND business_code in (0, 200, None)  → success
      - HTTP 2xx + non-zero/unexpected business_code  → business failure
      - HTTP non-2xx or exception (status=0)          → failure
    """
    business_code: int | None = None
    business_message: str | None = None

    if http_status and 200 <= http_status < 300:
        try:
            body = json.loads(text)
            # FH2 wraps results in various shapes; try common keys
            for key in ("code", "business_code", "retCode", "ret_code"):
                if key in body:
                    business_code = int(body[key])
                    break
            for key in ("message", "business_message", "msg", "retMsg", "ret_msg"):
                if key in body:
                    business_message = str(body[key])
                    break
        except Exception:
            pass

    # Determine success
    if http_status and 200 <= http_status < 300:
        if business_code is None or business_code in (0, 200):
            is_success = True
        else:
            # business failure despite HTTP 200
            is_success = False
    else:
        is_success = False

    return business_code, business_message, is_success


async def push_flighthub(
    endpoint: str, headers: dict, body: dict, retry_policy: dict | None
) -> tuple[int, str]:
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
    return 0, "UNKNOWN_ERROR"


async def ensure_group(redis: Redis):
    try:
        await redis.xgroup_create(
            name=settings.STREAM_KEY_RAW,
            groupname=settings.STREAM_GROUP,
            id="0-0",
            mkstream=True,
        )
    except Exception as e:
        if "BUSYGROUP" not in str(e):
            raise


async def run():
    redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    repo = RedisRepo(redis)

    await ensure_group(redis)

    consumer = settings.STREAM_CONSUMER
    print(
        f"[worker] consuming redis stream={settings.STREAM_KEY_RAW} "
        f"group={settings.STREAM_GROUP} consumer={consumer}"
    )

    while True:
        resp = await redis.xreadgroup(
            groupname=settings.STREAM_GROUP,
            consumername=consumer,
            streams={settings.STREAM_KEY_RAW: ">"},
            count=1,
            block=5000,
        )

        if not resp:
            continue

        for _stream_name, messages in resp:
            for msg_id, fields in messages:
                data = fields.get("data")
                try:
                    msg = json.loads(data) if data else {}
                except Exception:
                    msg = {}

                source = msg.get("source") or settings.DEFAULT_SOURCE
                received_at = int(msg.get("received_at") or _now_ts())
                webhook_event = msg.get("webhook_event") or {}
                # test_id injected by the API for integration-test tracing
                test_id: str = msg.get("test_id") or ""

                mapping_conf = await repo.get_mapping(source)
                fhcfg = await repo.get_fhcfg(source)

                endpoint = (
                    fhcfg.get("endpoint") if isinstance(fhcfg, dict) else None
                ) or settings.DEFAULT_FLIGHTHUB_ENDPOINT
                headers = (fhcfg.get("headers") if isinstance(fhcfg, dict) else None) or {}
                template_body = (
                    fhcfg.get("template_body") if isinstance(fhcfg, dict) else None
                ) or {}
                retry_policy = (
                    fhcfg.get("retry_policy") if isinstance(fhcfg, dict) else None
                ) or {"max_retries": 3, "backoff": "exponential"}

                headers = dict(headers)
                headers.setdefault("Content-Type", "application/json")

                # ----- mapping -----
                mapping_error: str | None = None
                unified: dict = {}
                try:
                    unified = apply_mappings(webhook_event, source, mapping_conf, received_at)
                except Exception as e:
                    mapping_error = str(e)
                    print(f"[worker] mapping error source={source}: {e}")

                rendered_body: dict = {}
                if not mapping_error:
                    ctx = dict(unified)
                    if isinstance(template_body, dict) and "workflow_uuid" in template_body:
                        ctx["workflow_uuid"] = template_body.get("workflow_uuid")
                    rendered_body = render_obj(template_body, ctx)

                # ----- push to FlightHub2 -----
                push_ts = _now_ts()
                if mapping_error:
                    http_status, response_text = 0, f"MAPPING_ERROR: {mapping_error}"
                else:
                    http_status, response_text = await push_flighthub(
                        endpoint, headers, rendered_body, retry_policy
                    )

                # ----- parse business result -----
                business_code, business_message, is_success = _parse_business_result(
                    http_status, response_text
                )

                # summary log
                name_val = (
                    rendered_body.get("name") if isinstance(rendered_body, dict) else "n/a"
                )
                print(
                    f"[worker] pushed msg_id={msg_id} source={source} "
                    f"http_status={http_status} business_code={business_code} "
                    f"success={is_success} name={name_val}"
                )
                if not is_success:
                    print(f"[worker] response preview: {response_text[:400]}")

                # ----- persist result -----
                push_result = {
                    "msg_id": msg_id,
                    "test_id": test_id,
                    "source": source,
                    "worker": consumer,
                    "endpoint": endpoint,
                    "http_status": http_status,
                    "business_code": business_code,
                    "business_message": business_message,
                    "is_success": is_success,
                    "response_preview": response_text[:500],
                    "rendered_body": rendered_body if not mapping_error else None,
                    "mapping_error": mapping_error,
                    "pushed_at": push_ts,
                    "name": name_val,
                }
                await repo.set_last_push(source, push_result)
                await repo.append_push_log(source, push_result)

                await redis.xack(settings.STREAM_KEY_RAW, settings.STREAM_GROUP, msg_id)


if __name__ == "__main__":
    asyncio.run(run())
