"""
app/canonical.py
================
Build a lightweight canonical event envelope from mapping output.

Pipeline position
-----------------
    flatten → adapter → mapping → **canonical** → enrichment → template

Purpose
-------
Normalise every message into a predictable shape so that enrichment and
template stages can rely on a stable contract, regardless of the source
system or mapping config used.

Design choices
--------------
* Minimal struct — only guaranteed fields are present.
* ``raw`` is carried through for debugging / fallback access.
* ``location`` starts with None values; enrichment fills real coords.
* UUID is generated deterministically-ish (uuid4 at intake time).
* No heavy validation — this layer is deliberately thin.
* 0 / 0.0 are NOT treated as real coordinates — they are indistinguishable
  from "no coord supplied", so the location dict carries None in that case.
  The autofill stage then has the chance to inject device-registry coords.

Public API
----------
    build_event(mapped, raw, source) -> dict
"""
from __future__ import annotations

import uuid
from typing import Any


def build_event(
    mapped: dict[str, Any],
    raw: dict[str, Any],
    source: str,
) -> dict[str, Any]:
    """Build canonical event envelope.

    Parameters
    ----------
    mapped : dict
        Output of :func:`app.mapping_engine.apply_mappings`.
        Expected optional keys: ``event_type``, ``timestamp``, ``device_id``,
        ``lat``, ``lng``, ``alt``, ``latitude``, ``longitude``.
    raw : dict
        Original (unmodified) ``webhook_event`` from the ingress payload.
        Kept for traceability; template may reference ``raw.*`` fields.
    source : str
        Source identifier (e.g. ``"flighthub2"``).

    Returns
    -------
    dict
        Canonical event dict with structure::

            {
                "id":         str,        # uuid4
                "source":     str,
                "event_type": str | None,
                "timestamp":  Any,        # passed through from mapped
                "device": {
                    "id": str | None
                },
                "location": {             # None values until enrichment fills them
                    "lat": float | None,
                    "lng": float | None,
                    "alt": float | None,
                },
                "raw": dict,              # original webhook_event
                **mapped                  # all mapped fields merged in
            }

    Notes
    -----
    * ``mapped`` fields are merged in at the top level so templates like
      ``{{creator_id}}`` continue to work without any changes.
    * ``id``, ``source``, ``event_type``, ``device``, ``location``, ``raw``
      are set *after* the spread so they cannot be accidentally overwritten
      by mapping output.
    * Coordinates of exactly 0 / 0.0 are treated as "not set" — they are
      indistinguishable from a missing coord and would block the device-
      location injection in autofill.  Real zero-coords are astronomically
      rare (Gulf of Guinea, ~0°N 0°E) and irrelevant for this use case.
    """
    # Pre-extract location fields from mapped.
    # IMPORTANT: treat 0 / 0.0 as "absent" — not a real coordinate.
    # A payload that has no lat/lng produces latitude=None after mapping
    # (we removed the default:0 from DEFAULT_MAPPING).  If somehow 0 still
    # arrives here (old stored mapping or explicit payload value), keep None
    # so the autofill device-location step can inject registry coordinates.
    lat = _to_real_float(mapped.get("lat") or mapped.get("latitude"))
    lng = _to_real_float(mapped.get("lng") or mapped.get("longitude"))
    alt = _to_real_float(mapped.get("alt") or mapped.get("altitude"))

    event: dict[str, Any] = {
        # spread all mapped fields first — keeps template compatibility
        **mapped,

        # guaranteed envelope fields (override any mapping key collision)
        "id":         str(uuid.uuid4()),
        "source":     source,
        "event_type": mapped.get("event_type"),
        "timestamp":  mapped.get("timestamp"),

        "device": {
            "id": mapped.get("device_id") or mapped.get("device.id"),
        },

        # Location starts None; enrichment will overwrite with device coords
        # if a device record is found.  autofill reads this dict too.
        "location": {
            "lat": lat,
            "lng": lng,
            "alt": alt,
        },

        "raw": raw,
    }
    return event


# ── Private helpers ──────────────────────────────────────────────────────────

def _to_real_float(v: Any) -> float | None:
    """Coerce *v* to float; return None on failure OR if value is zero.

    Zero (0 / 0.0) is treated as 'not set' for coordinates — it cannot be
    distinguished from a missing value when mapping uses default:0.
    """
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # Treat exact zero as absent — real lat/lng of 0°N 0°E is Gulf of Guinea
    # and is not a realistic device location for this system.
    if f == 0.0:
        return None
    return f
