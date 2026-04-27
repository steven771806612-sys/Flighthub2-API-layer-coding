import re
from typing import Any

PAT = re.compile(r"\{\{\s*([a-zA-Z0-9_\.]+)\s*\}\}")


def _get(ctx: dict, key: str):
    cur: Any = ctx
    for part in key.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return ""
    return "" if cur is None else cur


def render_str(s: str, ctx: dict) -> str:
    def repl(m):
        key = m.group(1)
        val = _get(ctx, key)
        return "" if val is None else str(val)

    return PAT.sub(repl, s)


def render_obj(obj: Any, ctx: dict) -> Any:
    if isinstance(obj, str):
        return render_str(obj, ctx)
    if isinstance(obj, list):
        return [render_obj(x, ctx) for x in obj]
    if isinstance(obj, dict):
        return {k: render_obj(v, ctx) for k, v in obj.items()}
    return obj
