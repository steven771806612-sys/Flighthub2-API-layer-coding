"""
bootstrap_redis.py
==================
Run once on container startup to initialise default Redis keys.

CRITICAL RULE: Never overwrite keys that already exist.
Use SET ... NX (set-if-not-exists) so that user-configured values
(real tokens, UUIDs, mappings) survive every redeploy.

Previously this script used plain set(), which clobbered all user
config on every deployment restart — that is the root cause of
"push succeeds but nothing reaches FlightHub2" after redeploy.
"""
import asyncio
import os
import sys

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import json
from redis.asyncio import Redis
from app.config import settings

DEFAULT_SOURCE = "flighthub2"

DEFAULT_MAPPING = {
    "mappings": [
        {"src": "$.timestamp",   "dst": "timestamp",   "type": "string", "default": "",     "required": False},
        {"src": "$.creator_id",  "dst": "creator_id",  "type": "string", "default": "",     "required": False},
        # latitude/longitude: NO default — absence means no real coord in payload.
        # autofill will then try: flat-event fallback → device registry → 0 last-resort.
        {"src": "$.latitude",    "dst": "latitude",    "type": "float",  "default": None,   "required": False},
        {"src": "$.longitude",   "dst": "longitude",   "type": "float",  "default": None,   "required": False},
        {"src": "$.level",       "dst": "level",       "type": "string", "default": "info", "required": False},
        {"src": "$.description", "dst": "description", "type": "string", "default": "",     "required": False},
        {"src": "$.event.name",  "dst": "name",        "type": "string", "default": "",     "required": False},
    ]
}

# Placeholder values — these will ONLY be written when the key does not exist yet.
# Once a user saves real credentials via the console, they are never touched again.
DEFAULT_FHCFG = {
    "endpoint": "https://es-flight-api-us.djigate.com/openapi/v0.1/workflow",
    "headers": {
        "Content-Type":  "application/json",
        "X-User-Token":  "",          # user must fill via Egress config panel
        "x-project-uuid": "",         # user must fill via Egress config panel
    },
    "template_body": {
        "workflow_uuid": "",          # user must fill via Egress config panel
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

DEFAULT_SRCAUTH = {
    "enabled": True,
    "mode": "static_token",
    "header_name": "X-MW-Token",
    "token": "",
}


def _has_stale_coord_defaults(mapping_conf: dict) -> bool:
    """Return True if any lat/lng rule still uses default:0 (old broken config)."""
    for rule in mapping_conf.get("mappings", []):
        if rule.get("dst") in ("latitude", "longitude"):
            default = rule.get("default")
            if default == 0 or default == 0.0:
                return True
    return False


def _patch_coord_defaults(mapping_conf: dict) -> dict:
    """Return a copy with lat/lng default changed from 0 → None."""
    import copy
    patched = copy.deepcopy(mapping_conf)
    for rule in patched.get("mappings", []):
        if rule.get("dst") in ("latitude", "longitude"):
            if rule.get("default") == 0 or rule.get("default") == 0.0:
                rule["default"] = None
    return patched


async def _set_nx(redis: Redis, key: str, value: dict) -> bool:
    """SET key value NX — write only when key is absent.

    Returns True if the key was written (did not exist),
    False if it already existed and was left untouched.
    """
    serialized = json.dumps(value, ensure_ascii=False)
    result = await redis.set(key, serialized, nx=True)
    return result is not None   # Redis SET NX returns None when key exists


async def _patch_all_stale_mappings(redis: Redis) -> list[str]:
    """Scan all uw:map:* keys and patch any that still use default:0 for lat/lng.

    This migration runs on every startup but is cheap — it only rewrites keys
    that actually need patching.  Returns list of patched source names.
    """
    patched: list[str] = []
    cursor = 0
    while True:
        cursor, keys = await redis.scan(cursor=cursor, match="uw:map:*", count=200)
        for key in keys:
            if isinstance(key, bytes):
                key = key.decode("utf-8", errors="ignore")
            try:
                raw = await redis.get(key)
                if not raw:
                    continue
                stored = json.loads(raw)
                if _has_stale_coord_defaults(stored):
                    fixed = _patch_coord_defaults(stored)
                    await redis.set(key, json.dumps(fixed, ensure_ascii=False))
                    source = key.replace("uw:map:", "", 1)
                    patched.append(source)
                    print(f"[bootstrap] patched stale coord defaults for source={source}")
            except Exception as e:
                print(f"[bootstrap] warning: could not patch {key}: {e}")
        if cursor == 0:
            break
    return patched


async def main():
    r = Redis.from_url(settings.REDIS_URL, decode_responses=True)

    # ── Step 1: Initialize default source if keys do not exist ───────────────
    wrote_map     = await _set_nx(r, f"uw:map:{DEFAULT_SOURCE}",     DEFAULT_MAPPING)
    wrote_fhcfg   = await _set_nx(r, f"uw:fhcfg:{DEFAULT_SOURCE}",  DEFAULT_FHCFG)
    wrote_srcauth = await _set_nx(r, f"uw:srcauth:{DEFAULT_SOURCE}", DEFAULT_SRCAUTH)

    # ── Step 2: Patch ALL sources that still use the old default:0 lat/lng ────
    # This fixes sources registered before the coord-injection bug was identified.
    # Safe to run repeatedly — only rewrites keys that actually need patching.
    patched = await _patch_all_stale_mappings(r)

    await r.aclose()

    print(
        f"[bootstrap] source={DEFAULT_SOURCE} "
        f"map={'CREATED' if wrote_map else 'EXISTS(kept)'} "
        f"fhcfg={'CREATED' if wrote_fhcfg else 'EXISTS(kept)'} "
        f"srcauth={'CREATED' if wrote_srcauth else 'EXISTS(kept)'}"
    )
    if patched:
        print(f"[bootstrap] patched stale coord defaults for {len(patched)} source(s): {patched}")
    else:
        print("[bootstrap] all stored mappings already use correct coord defaults")


if __name__ == "__main__":
    asyncio.run(main())
