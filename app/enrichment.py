"""
app/enrichment.py
=================
Optional enrichment step — injects device metadata from Redis.

Redis key schema
----------------
    uw:device:{device_id}  →  JSON string, e.g.
    {
        "device_id": "DJI-001",
        "location":  {"lat": 22.54, "lng": 114.05, "alt": 120},
        "model":     "Matrice 300 RTK",
        "site":      "SZ-HQ"
    }

Pipeline position
-----------------
    flatten → adapter → mapping → **enrich** → template

    enrich() receives the unified dict (output of apply_mappings).
    It reads `event["device_id"]` (or a configurable key), looks up
    Redis, and injects found fields under `event["_device"]`.

Usage
-----
    from app.enrichment import enrich

    unified = await enrich(unified, repo)
    # unified["_device"] = {"lat": 22.54, "lng": 114.05, ...}

Design decisions
----------------
* Fully optional: if key not found → event unchanged, no error raised.
* Non-destructive: injects under `_device` namespace to avoid clashing
  with existing mapping output.
* Async-ready: takes the same repo object already used in worker.py.
"""
from __future__ import annotations

import logging

from app.redis_repo import RedisRepo

logger = logging.getLogger(__name__)


async def enrich(event: dict, repo: RedisRepo, device_key: str = "device_id") -> dict:
    """Inject device metadata from Redis into *event*.

    Parameters
    ----------
    event : dict
        Unified dict from :func:`app.mapping_engine.apply_mappings`.
        Must contain a ``device_key`` field to trigger lookup.
    repo : RedisRepo
        Repository instance for Redis access.
    device_key : str
        Key in *event* that holds the device identifier.
        Default: ``"device_id"``.

    Returns
    -------
    dict
        The same *event* dict, potentially augmented with ``"_device"``
        and top-level convenience fields (``"location"``).

    Notes
    -----
    * If *device_key* is absent or empty → returns *event* unchanged.
    * If Redis key not found → returns *event* unchanged.
    * Any exception during lookup is caught and logged (never fatal).
    """
    device_id = event.get(device_key)
    if not device_id:
        return event  # nothing to look up

    try:
        device_info = await repo.get_device(str(device_id))
    except Exception as exc:
        logger.warning("[enrichment] Redis lookup failed device_id=%s: %s", device_id, exc)
        return event

    if not device_info:
        logger.debug("[enrichment] no device record found for device_id=%s", device_id)
        return event

    # Inject raw device info under _device namespace
    event["_device"] = device_info

    # Convenience: lift "location" to top level.
    # build_event() always writes location:{lat:None, lng:None, alt:None} as a
    # placeholder so downstream stages can rely on the key existing.  We must
    # OVERWRITE that placeholder when the device registry supplies real coords —
    # not skip it because the key "already exists".
    # Rule: overwrite if the existing location has no real lat/lng (all None/0).
    dev_loc = device_info.get("location")
    if isinstance(dev_loc, dict) and any(
        v is not None and v != 0.0 for v in dev_loc.values()
    ):
        existing_loc = event.get("location") or {}
        existing_has_real = isinstance(existing_loc, dict) and any(
            v is not None and v != 0.0
            for v in (existing_loc.get("lat"), existing_loc.get("lng"))
        )
        if not existing_has_real:
            # No real coords from payload — inject device registry location
            event["location"] = dev_loc
            logger.debug(
                "[enrichment] injected device location for device_id=%s loc=%s",
                device_id, dev_loc,
            )

    # Convenience: inject individual lat/lng/alt at top level if not already set
    # (autofill also reads these top-level keys as coord aliases)
    loc = device_info.get("location") or {}
    if isinstance(loc, dict):
        for field in ("lat", "lng", "alt"):
            if field in loc and loc[field] is not None and loc[field] != 0.0:
                if not event.get(field):
                    event[field] = loc[field]

    logger.debug(
        "[enrichment] enriched event with device_id=%s fields=%s",
        device_id,
        list(device_info.keys()),
    )
    return event
