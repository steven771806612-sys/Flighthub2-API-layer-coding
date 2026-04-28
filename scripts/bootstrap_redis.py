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
        {"src": "$.timestamp",   "dst": "timestamp",   "type": "string", "default": "",       "required": False},
        {"src": "$.creator_id",  "dst": "creator_id",  "type": "string", "default": "system", "required": True},
        {"src": "$.latitude",    "dst": "latitude",    "type": "float",  "default": 0,        "required": False},
        {"src": "$.longitude",   "dst": "longitude",   "type": "float",  "default": 0,        "required": False},
        {"src": "$.level",       "dst": "level",       "type": "string", "default": "info",   "required": True},
        {"src": "$.description", "dst": "description", "type": "string", "default": "",       "required": False},
        {"src": "$.event.name",  "dst": "name",        "type": "string", "default": "",       "required": False},
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


async def _set_nx(redis: Redis, key: str, value: dict) -> bool:
    """SET key value NX — write only when key is absent.

    Returns True if the key was written (did not exist),
    False if it already existed and was left untouched.
    """
    serialized = json.dumps(value, ensure_ascii=False)
    result = await redis.set(key, serialized, nx=True)
    return result is not None   # Redis SET NX returns None when key exists


async def main():
    r = Redis.from_url(settings.REDIS_URL, decode_responses=True)

    wrote_map     = await _set_nx(r, f"uw:map:{DEFAULT_SOURCE}",     DEFAULT_MAPPING)
    wrote_fhcfg   = await _set_nx(r, f"uw:fhcfg:{DEFAULT_SOURCE}",  DEFAULT_FHCFG)
    wrote_srcauth = await _set_nx(r, f"uw:srcauth:{DEFAULT_SOURCE}", DEFAULT_SRCAUTH)

    await r.aclose()

    print(
        f"[bootstrap] source={DEFAULT_SOURCE} "
        f"map={'CREATED' if wrote_map else 'EXISTS(kept)'} "
        f"fhcfg={'CREATED' if wrote_fhcfg else 'EXISTS(kept)'} "
        f"srcauth={'CREATED' if wrote_srcauth else 'EXISTS(kept)'}"
    )


if __name__ == "__main__":
    asyncio.run(main())
