"""
app/autofill.py
===============
Autofill layer: fills missing required FH2 body fields using device data
or configured defaults, after the mapping stage.

Pipeline position
-----------------
    mapping → canonical → enrichment → **autofill** → template → HTTP

FH2 required body structure
----------------------------
{
    "workflow_uuid": str,       # from egress config
    "trigger_type":  int,       # default 0
    "name":          str,       # e.g. "motion_detection"
    "params": {
        "creator":   str,
        "latitude":  float,
        "longitude": float,
        "level":     int (1-5),
        "desc":      str,
    }
}

Coordinate injection priority (params.latitude / params.longitude)
------------------------------------------------------------------
For coordinates specifically, the priority chain is:

  1. Mapped value — payload carried a real non-zero lat/lng in a recognised
     field name (e.g. "latitude", "lat", "params.latitude")
  2. Flat-event direct keys — same but read from the pre-flatten dict
     (catches payloads where mapping wasn't configured yet)
  3. event["location"] dict — populated by enrichment() from the device
     registry (uw:device:{device_id}).  This is the primary injection
     mechanism for cameras/sensors that never carry GPS in their payloads.
  4. device_info["location"] — explicit device_info dict passed by caller
  5. autofill_conf override
  6. Hardcoded last-resort 0

IMPORTANT: steps 1 & 2 explicitly SKIP values of exactly 0 / 0.0 for
coords, because 0.0 is indistinguishable from "mapping produced a
default" (old mappings used default:0).  Only a genuinely non-zero lat/lng
from the payload is treated as a real coordinate.

Other autofill rules (non-coord fields) in priority order
----------------------------------------------------------
1. Value already present in mapped dict → keep (non-empty, non-None)
2. Alias fields in mapped dict → use
3. Flat-event fallback — look up well-known keys in the flat dict
4. autofill_conf override
5. Hardcoded default

Device ID resolution
--------------------
The caller is responsible for resolving the device_id before calling autofill().

Public API
----------
    autofill(mapped, device_info, autofill_conf, flat_event=None) -> (filled, missing)
"""
from __future__ import annotations

from typing import Any

# ─── FH2 params schema ────────────────────────────────────────────────────────
# Each entry: (body_path, type, hardcoded_default_or_None)
_FH2_PARAMS: list[tuple[str, type, Any]] = [
    ("params.creator",   str,   "system"),
    ("params.latitude",  float, None),
    ("params.longitude", float, None),
    ("params.level",     int,   3),
    ("params.desc",      str,   ""),
]

# ─── Level string → int mapping ──────────────────────────────────────────────
_LEVEL_MAP: dict[str, int] = {
    "critical": 5,
    "error":    4,
    "warning":  3,
    "warn":     3,
    "info":     2,
    "debug":    1,
    "low":      1,
    "medium":   3,
    "high":     4,
}

_FH2_TOP: list[tuple[str, type, Any]] = [
    ("workflow_uuid", str,   ""),
    ("trigger_type",  int,   0),
    ("name",          str,   "FlightHub2-Event"),
]

# ─── Flat-event fallback keys ──────────────────────────────────────────────────
_FLAT_FALLBACK: dict[str, list[str]] = {
    # Generic fields first, then device/camera identifier fields that third-party
    # systems (e.g. Hikvision) use in place of a generic "creator_id":
    #   Hikvision  → channelName  (e.g. "DXB-Camera-1")
    #   Generic NVR/IoT → deviceName, device_name, camera_name, camera_id
    #   Last-resort → ipAddress (unique per device even without a friendly name)
    "params.creator":   [
        "creator_id", "creator", "operator_id", "operator", "user_id",
        "channelName", "deviceName", "device_name", "camera_name",
        "camera_id", "device_id", "ipAddress",
    ],
    "params.latitude":  ["latitude", "lat", "location.lat", "gps.lat", "position.lat"],
    "params.longitude": ["longitude", "lng", "lon", "location.lng", "gps.lng", "position.lng"],
    "params.level":     ["level", "severity", "priority", "alert_level", "event_level"],
    "params.desc":      ["description", "desc", "message", "msg", "content", "detail",
                         "eventState", "eventType"],
    "name":             ["name", "event_name", "event.name", "event.type",
                         "eventName", "eventType", "alert_name", "title"],
}

# ─── Coord alias keys in the unified/mapped dict ──────────────────────────────
_COORD_ALIASES: dict[str, list[str]] = {
    "params.latitude":  ["params.latitude", "latitude", "lat"],
    "params.longitude": ["params.longitude", "longitude", "lng"],
}

# ─── Device location key mapping ─────────────────────────────────────────────
_DEVICE_LOC_KEY: dict[str, str] = {
    "params.latitude":  "lat",
    "params.longitude": "lng",
}


def _is_real_coord(v: Any) -> bool:
    """Return True only when *v* is a non-None, non-zero numeric coordinate.

    0 / 0.0 is treated as "not set" because old DEFAULT_MAPPING rules used
    default:0, making it indistinguishable from a genuine missing value.
    Real coordinates of exactly 0° (Gulf of Guinea) are not relevant here.
    """
    if v is None:
        return False
    if isinstance(v, str) and not v.strip():
        return False
    try:
        return float(v) != 0.0
    except (TypeError, ValueError):
        return False


def _is_valid(v: Any) -> bool:
    """Return True when *v* is a usable non-empty value (for non-coord fields)."""
    if v is None:
        return False
    if isinstance(v, str) and not v.strip():
        return False
    return True


def autofill(
    mapped: dict[str, Any],
    device_info: dict[str, Any],
    autofill_conf: dict[str, Any],
    flat_event: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Fill missing FH2 body fields, report what could not be filled.

    Parameters
    ----------
    mapped : dict
        Output of apply_mappings() passed through canonical + enrichment.
        After enrichment, ``mapped["location"]`` may contain real device
        coordinates from the device registry.
    device_info : dict
        Device metadata from uw:device:{device_id}.  May be empty.
    autofill_conf : dict
        Per-source autofill overrides.
    flat_event : dict | None
        Flattened webhook payload (output of flatten_json).

    Returns
    -------
    (filled, missing) : tuple
    """
    filled: dict[str, Any] = dict(mapped)
    missing: list[str] = []
    _flat = flat_event or {}

    # ── Collect device location from all available sources ────────────────────
    # Priority: explicit device_info arg > event["location"] set by enrich()
    # Both are checked so the caller doesn't need to worry about which path
    # populated the location.
    dev_loc: dict[str, Any] = {}
    # 1. event["location"] — written by enrichment() from uw:device record
    ev_loc = mapped.get("location") or {}
    if isinstance(ev_loc, dict):
        dev_loc.update({k: v for k, v in ev_loc.items() if v is not None and v != 0.0})
    # 2. explicit device_info["location"] — passed by caller
    di_loc = (device_info or {}).get("location") or {}
    if isinstance(di_loc, dict):
        dev_loc.update({k: v for k, v in di_loc.items() if v is not None and v != 0.0})

    # Alias lookup for non-coord fields (checked in the unified/mapped dict)
    # device_id is included for params.creator so that when the worker resolves
    # device_id from e.g. channelName="DXB-Camera-1", that value flows through
    # as the FH2 creator without any extra mapping rule.
    _mapped_aliases: dict[str, list[str]] = {
        "params.creator":   ["params.creator", "creator_id", "creator", "operator",
                             "device_id", "channelName"],
        "params.level":     ["params.level", "level", "event_level", "severity"],
        "params.desc":      ["params.desc", "description", "desc", "message"],
        "workflow_uuid":    ["workflow_uuid"],
        "trigger_type":     ["trigger_type"],
        "name":             ["name", "event_name"],
    }

    all_fields = _FH2_TOP + _FH2_PARAMS

    for body_path, cast, hardcoded_default in all_fields:
        is_coord = body_path in _DEVICE_LOC_KEY

        # ══════════════════════════════════════════════════════════
        # COORDINATE FIELDS — special priority chain
        # ══════════════════════════════════════════════════════════
        if is_coord:
            val = _resolve_coord(body_path, filled, _flat, dev_loc)

            if val is not None:
                try:
                    filled[body_path] = float(val)
                except (TypeError, ValueError):
                    filled[body_path] = val
            else:
                # Last resort: 0.0 — at least the body is schema-valid
                filled[body_path] = 0.0
                missing.append(body_path)
            continue

        # ══════════════════════════════════════════════════════════
        # NON-COORD FIELDS — original priority chain
        # ══════════════════════════════════════════════════════════

        # 1. Already present under exact body_path
        if body_path in filled:
            existing = filled[body_path]
            if _is_valid(existing):
                _safe_cast(filled, body_path, cast)
                continue

        # 2. Mapped aliases
        val = None
        for alias in _mapped_aliases.get(body_path, []):
            if alias in filled and _is_valid(filled[alias]):
                val = filled[alias]
                break

        # 3. Flat-event fallback
        if val is None:
            for flat_key in _FLAT_FALLBACK.get(body_path, []):
                candidate = _flat.get(flat_key)
                if _is_valid(candidate):
                    val = candidate
                    break

        # 4. autofill_conf
        if val is None and body_path in autofill_conf:
            val = autofill_conf[body_path]

        # 5. Hardcoded default
        if val is None and hardcoded_default is not None:
            val = hardcoded_default

        if val is not None:
            if cast is int and isinstance(val, str) and not val.lstrip('-').isdigit():
                val = _LEVEL_MAP.get(val.lower().strip(), 3)
            try:
                filled[body_path] = cast(val)
            except (TypeError, ValueError):
                filled[body_path] = val
        else:
            missing.append(body_path)

    return filled, missing


def _resolve_coord(
    body_path: str,
    filled: dict[str, Any],
    flat: dict[str, Any],
    dev_loc: dict[str, Any],
) -> Any:
    """Resolve a coordinate field using a strict priority chain.

    Priority
    --------
    1. Non-zero value in filled under a coord alias key
    2. Non-zero value in flat_event under a flat fallback key
    3. Device location (from enrich or device_info) — real GPS from registry
    4. None (caller will use 0.0 as last resort)

    Only non-zero values are accepted from steps 1 & 2 to avoid treating
    the old default:0 sentinel as a real coordinate.
    """
    # Step 1: check mapped/filled aliases (only non-zero)
    for alias in _COORD_ALIASES.get(body_path, []):
        if alias in filled and _is_real_coord(filled[alias]):
            return filled[alias]

    # Step 2: flat-event direct keys (only non-zero)
    for flat_key in _FLAT_FALLBACK.get(body_path, []):
        candidate = flat.get(flat_key)
        if _is_real_coord(candidate):
            return candidate

    # Step 3: device location from registry (can be any non-None value,
    # including 0.0 if a device is genuinely at 0°)
    dev_key = _DEVICE_LOC_KEY.get(body_path)
    if dev_key and dev_key in dev_loc:
        return dev_loc[dev_key]

    return None


def build_fh2_body(
    filled: dict[str, Any],
    workflow_uuid: str = "",
) -> dict[str, Any]:
    """Construct the final FH2 API request body from filled fields."""
    wf_uuid = filled.get("workflow_uuid") or workflow_uuid or ""

    def _f(key: str, default: Any = None) -> Any:
        return filled.get(key, default)

    raw_level = _f("params.level", 3)
    if isinstance(raw_level, str) and not raw_level.lstrip('-').isdigit():
        raw_level = _LEVEL_MAP.get(raw_level.lower().strip(), 3)
    try:
        level_int = int(raw_level)
    except (TypeError, ValueError):
        level_int = 3
    level_int = max(1, min(5, level_int))

    return {
        "workflow_uuid": wf_uuid,
        "trigger_type":  int(_f("trigger_type", 0)),
        "name":          str(_f("name", "FlightHub2-Event")),
        "params": {
            "creator":   str(_f("params.creator",   "system")),
            "latitude":  _f("params.latitude",   0),
            "longitude": _f("params.longitude",  0),
            "level":     level_int,
            "desc":      str(_f("params.desc",    "")),
        },
    }


# ─── Private helpers ──────────────────────────────────────────────────────────

def _safe_cast(d: dict, key: str, cast: type) -> None:
    try:
        d[key] = cast(d[key])
    except (TypeError, ValueError):
        pass
