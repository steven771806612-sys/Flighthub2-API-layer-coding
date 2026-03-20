"""
app/autofill.py
===============
Autofill layer: fills missing required FH2 body fields using device data
or configured defaults, after the mapping stage.

Pipeline position
-----------------
    mapping → **autofill** → template → HTTP

FH2 required body structure
----------------------------
{
    "workflow_uuid": str,       # from egress config
    "trigger_type":  int,       # default 0
    "name":          str,       # e.g. "Alert-{timestamp}"
    "params": {
        "creator":   str,
        "latitude":  float,
        "longitude": float,
        "level":     int (1-5),
        "desc":      str,
    }
}

Autofill rules (in priority order)
------------------------------------
1. Value already present in mapped dict → keep
2. Alias fields in mapped dict (e.g. "latitude" for "params.latitude") → use
3. Device location from device_info (lat/lng from uw:device record) → inject
4. Configured default in autofill_conf → apply
5. Hardcoded default → apply
6. Field remains missing → add to missing[] list

Device ID resolution
--------------------
The caller is responsible for resolving the device_id before calling autofill().
If the source uses a non-standard field (e.g. deviceSN), the caller should
look up device_id_field from Redis and extract the value from the flat/mapped dict
before fetching device_info.

Public API
----------
    autofill(mapped, device_info, autofill_conf) -> (filled, missing)
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

_FH2_TOP: list[tuple[str, type, Any]] = [
    ("workflow_uuid", str,   ""),
    ("trigger_type",  int,   0),
    ("name",          str,   "FlightHub2-Event"),
]


def autofill(
    mapped: dict[str, Any],
    device_info: dict[str, Any],
    autofill_conf: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    """Fill missing FH2 body fields, report what could not be filled.

    Parameters
    ----------
    mapped : dict
        Output of apply_mappings().  Keys are unified field names.
    device_info : dict
        Device metadata from uw:device:{device_id}.  May be empty.
        If the device has location data (lat/lng), they will be used to fill
        params.latitude / params.longitude when not already mapped.
    autofill_conf : dict
        Per-source autofill overrides, e.g.::

            {
                "params.level":     3,
                "params.creator":   "auto",
            }

    Returns
    -------
    (filled, missing) : tuple
        filled  — merged dict with all resolvable fields set
        missing — list of body paths that remain unfilled
    """
    filled: dict[str, Any] = dict(mapped)
    missing: list[str] = []

    loc = device_info.get("location") or {}

    # Device field mapping: body_path → device location key
    _device_map: dict[str, str] = {
        "params.latitude":  "lat",
        "params.longitude": "lng",
    }

    # Mapped field aliases: body_path → possible mapped keys
    _mapped_aliases: dict[str, list[str]] = {
        "params.creator":   ["creator_id", "creator", "operator"],
        "params.latitude":  ["latitude", "lat"],
        "params.longitude": ["longitude", "lng"],
        "params.level":     ["level", "event_level", "severity"],
        "params.desc":      ["description", "desc", "message"],
        "workflow_uuid":    ["workflow_uuid"],
        "trigger_type":     ["trigger_type"],
        "name":             ["name", "event_name"],
    }

    all_fields = _FH2_TOP + _FH2_PARAMS

    for body_path, cast, hardcoded_default in all_fields:
        # 1. Already in filled under exact body_path key
        if body_path in filled and filled[body_path] is not None:
            _safe_cast(filled, body_path, cast)
            continue

        # 2. Try mapped aliases
        val = None
        for alias in _mapped_aliases.get(body_path, []):
            if alias in filled and filled[alias] is not None:
                val = filled[alias]
                break

        # 3. Try device location (GPS injected from device registry)
        if val is None and body_path in _device_map:
            device_key = _device_map[body_path]
            if loc.get(device_key) is not None:
                val = loc[device_key]

        # 4. Try autofill_conf
        if val is None and body_path in autofill_conf:
            val = autofill_conf[body_path]

        # 5. Hardcoded default
        if val is None and hardcoded_default is not None:
            val = hardcoded_default

        if val is not None:
            try:
                filled[body_path] = cast(val)
            except (TypeError, ValueError):
                filled[body_path] = val
        else:
            missing.append(body_path)

    return filled, missing


def build_fh2_body(
    filled: dict[str, Any],
    workflow_uuid: str = "",
) -> dict[str, Any]:
    """Construct the final FH2 API request body from filled fields.

    Parameters
    ----------
    filled : dict
        Output of autofill().
    workflow_uuid : str
        Explicit override; if filled already has it, this is ignored.

    Returns
    -------
    dict
        Ready-to-send FH2 body.
    """
    wf_uuid = filled.get("workflow_uuid") or workflow_uuid or ""

    def _f(key: str, default: Any = None) -> Any:
        return filled.get(key, default)

    return {
        "workflow_uuid": wf_uuid,
        "trigger_type":  int(_f("trigger_type", 0)),
        "name":          str(_f("name", "FlightHub2-Event")),
        "params": {
            "creator":   str(_f("params.creator",   "system")),
            "latitude":  _f("params.latitude",   0),
            "longitude": _f("params.longitude",  0),
            "level":     int(_f("params.level",   3)),
            "desc":      str(_f("params.desc",    "")),
        },
    }


# ─── Private helpers ──────────────────────────────────────────────────────────

def _safe_cast(d: dict, key: str, cast: type) -> None:
    try:
        d[key] = cast(d[key])
    except (TypeError, ValueError):
        pass
