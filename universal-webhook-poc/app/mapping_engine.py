from __future__ import annotations

from typing import Any
from jsonpath_ng import parse as jp

TYPE_CASTERS = {
    "string": lambda v: "" if v is None else str(v),
    "int": lambda v: int(v),
    "float": lambda v: float(v),
    "bool": lambda v: bool(v),
    "json": lambda v: v,
}


def extract_jsonpath(obj: Any, path: str):
    expr = jp(path)
    matches = [m.value for m in expr.find(obj)]
    if not matches:
        return None
    return matches[0]


def apply_mappings(webhook_event: dict, source: str, mapping_conf: dict, received_at: int) -> dict:
    unified: dict[str, Any] = {
        "source": source,
        "timestamp": received_at,
        "raw": webhook_event,
    }

    for row in mapping_conf.get("mappings", []):
        src = row.get("src")
        dst = row.get("dst")
        tp = row.get("type", "string")
        default = row.get("default", None)
        required = bool(row.get("required", False))

        if not src or not dst:
            continue

        val = extract_jsonpath(webhook_event, src)
        if val is None:
            val = default

        if val is None and required:
            raise ValueError(f"required field missing: {dst} (from {src})")

        if val is not None:
            caster = TYPE_CASTERS.get(tp, TYPE_CASTERS["string"])
            try:
                val = caster(val)
            except Exception as e:
                raise ValueError(f"type cast failed: {dst} as {tp}, value={val}") from e

        unified[dst] = val

    return unified
