import json
from redis.asyncio import Redis

class RedisRepo:
    def __init__(self, redis: Redis):
        self.redis = redis

    async def list_sources(self) -> list[str]:
        """List sources that have mapping and/or flighthub config."""
        sources: set[str] = set()

        # Prefer SCAN over KEYS (still fine for POC size)
        cursor = 0
        for prefix in ("uw:map:", "uw:fhcfg:"):
            cursor = 0
            while True:
                cursor, keys = await self.redis.scan(cursor=cursor, match=f"{prefix}*", count=200)
                for k in keys:
                    if isinstance(k, bytes):
                        k = k.decode("utf-8", errors="ignore")
                    if isinstance(k, str) and k.startswith(prefix):
                        sources.add(k[len(prefix):])
                if cursor == 0:
                    break

        return sorted(sources)

    @staticmethod
    def _k_map(source: str) -> str:
        return f"uw:map:{source}"

    @staticmethod
    def _k_fhcfg(source: str) -> str:
        return f"uw:fhcfg:{source}"

    @staticmethod
    def _k_srcauth(source: str) -> str:
        return f"uw:srcauth:{source}"

    # ── NEW keys (STEP 6) ─────────────────────────────────────────────────────

    @staticmethod
    def _k_adapter(source: str) -> str:
        """uw:adapter:{source}  →  adapter field-normalization config."""
        return f"uw:adapter:{source}"

    @staticmethod
    def _k_device(device_id: str) -> str:
        """uw:device:{device_id}  →  device metadata for enrichment."""
        return f"uw:device:{device_id}"

    @staticmethod
    def _k_device_id_field(source: str) -> str:
        """uw:deviceidfield:{source}  →  which payload field holds the device ID."""
        return f"uw:deviceidfield:{source}"

    # ── Existing methods (unchanged) ──────────────────────────────────────────

    # ── Default mapping — written NX when a new source is first seen ──────────
    _DEFAULT_MAPPING: dict = {
        "mappings": [
            {"src": "$.timestamp",   "dst": "timestamp",   "type": "string", "default": "",     "required": False},
            {"src": "$.creator_id",  "dst": "creator_id",  "type": "string", "default": "",     "required": False},
            # latitude/longitude: NO default — absence means no real coord in payload.
            # autofill will then try: flat-event fallback → device registry → 0 last-resort.
            # Using default:0 here would inject 0.0 and block the device-location step.
            {"src": "$.latitude",    "dst": "latitude",    "type": "float",  "default": None,   "required": False},
            {"src": "$.longitude",   "dst": "longitude",   "type": "float",  "default": None,   "required": False},
            {"src": "$.level",       "dst": "level",       "type": "string", "default": "info", "required": False},
            {"src": "$.description", "dst": "description", "type": "string", "default": "",     "required": False},
            {"src": "$.event.name",  "dst": "name",        "type": "string", "default": "",     "required": False},
        ]
    }

    _DEFAULT_SRCAUTH: dict = {
        "enabled": True,
        "mode": "static_token",
        "header_name": "X-MW-Token",
        "token": "",
    }

    @staticmethod
    def _has_stale_coord_defaults(mapping_conf: dict) -> bool:
        """Return True if any lat/lng rule still uses default:0 (old broken config).

        Old DEFAULT_MAPPING had ``"default": 0`` for latitude/longitude which
        injects 0.0 even when the payload has no coords, blocking the device-
        registry GPS injection step.  Any stored mapping with this pattern must
        be upgraded to ``"default": None``.
        """
        for rule in mapping_conf.get("mappings", []):
            if rule.get("dst") in ("latitude", "longitude"):
                default = rule.get("default")
                if default == 0 or default == 0.0:
                    return True
        return False

    @staticmethod
    def _patch_coord_defaults(mapping_conf: dict) -> dict:
        """Return a copy of mapping_conf with lat/lng default changed from 0 → None."""
        import copy
        patched = copy.deepcopy(mapping_conf)
        for rule in patched.get("mappings", []):
            if rule.get("dst") in ("latitude", "longitude"):
                if rule.get("default") == 0 or rule.get("default") == 0.0:
                    rule["default"] = None
        return patched

    async def get_mapping(self, source: str) -> dict:
        raw = await self.redis.get(self._k_map(source))
        if not raw:
            # Key absent — write DEFAULT_MAPPING and return it
            await self.redis.set(self._k_map(source), json.dumps(self._DEFAULT_MAPPING, ensure_ascii=False), nx=True)
            return self._DEFAULT_MAPPING

        stored = json.loads(raw)
        # Guard 1: empty dict {} or no rules at all → return DEFAULT_MAPPING
        # (handles sources registered before auto-init logic existed)
        if not stored or (not stored.get("mappings") and not stored.get("dsl")):
            await self.redis.set(self._k_map(source), json.dumps(self._DEFAULT_MAPPING, ensure_ascii=False))
            return self._DEFAULT_MAPPING

        # Guard 2: stale default:0 for lat/lng → patch in-place and return fixed copy.
        # Old DEFAULT_MAPPING used default:0 which injects 0.0 into the unified
        # event even when the payload has no coordinates.  This blocks the device-
        # registry GPS injection because autofill treats 0.0 as a valid value.
        if self._has_stale_coord_defaults(stored):
            patched = self._patch_coord_defaults(stored)
            await self.redis.set(self._k_map(source), json.dumps(patched, ensure_ascii=False))
            return patched

        return stored

    async def set_mapping(self, source: str, mapping: dict) -> None:
        await self.redis.set(self._k_map(source), json.dumps(mapping, ensure_ascii=False))

    async def get_fhcfg(self, source: str) -> dict:
        raw = await self.redis.get(self._k_fhcfg(source))
        if not raw:
            return {}
        return json.loads(raw)

    async def set_fhcfg(self, source: str, cfg: dict) -> None:
        await self.redis.set(self._k_fhcfg(source), json.dumps(cfg, ensure_ascii=False))

    async def get_source_auth(self, source: str) -> dict:
        raw = await self.redis.get(self._k_srcauth(source))
        if not raw:
            # Auto-initialize auth config for unknown sources (token empty = open).
            await self.redis.set(self._k_srcauth(source), json.dumps(self._DEFAULT_SRCAUTH, ensure_ascii=False), nx=True)
            return dict(self._DEFAULT_SRCAUTH)
        return json.loads(raw)

    async def set_source_auth(self, source: str, cfg: dict) -> None:
        await self.redis.set(self._k_srcauth(source), json.dumps(cfg, ensure_ascii=False))

    # ── NEW methods (STEP 6) ──────────────────────────────────────────────────

    async def get_adapter(self, source: str) -> dict:
        """Return adapter config for *source*.  Empty dict if not configured."""
        raw = await self.redis.get(self._k_adapter(source))
        if not raw:
            return {}
        return json.loads(raw)

    async def set_adapter(self, source: str, cfg: dict) -> None:
        """Persist adapter config for *source*."""
        await self.redis.set(self._k_adapter(source), json.dumps(cfg, ensure_ascii=False))

    async def get_device(self, device_id: str) -> dict:
        """Return device metadata.  Empty dict if not found."""
        raw = await self.redis.get(self._k_device(device_id))
        if not raw:
            return {}
        return json.loads(raw)

    async def set_device(self, device_id: str, info: dict) -> None:
        """Persist device metadata."""
        await self.redis.set(self._k_device(device_id), json.dumps(info, ensure_ascii=False))

    async def get_device_id_field(self, source: str) -> str:
        """Return the payload field name used as device lookup key for *source*.
        Empty string means use the default 'device_id' key.
        """
        raw = await self.redis.get(self._k_device_id_field(source))
        if not raw:
            return ""
        val = json.loads(raw)
        return str(val) if val else ""

    async def set_device_id_field(self, source: str, field: str) -> None:
        """Persist device ID field config for *source*."""
        await self.redis.set(self._k_device_id_field(source), json.dumps(field, ensure_ascii=False))

    # ── Processing Logs ───────────────────────────────────────────────────────
    # Stored as a Redis List (LPUSH + LTRIM) under uw:logs:{source}
    # Each entry is a JSON-encoded dict with keys:
    #   ts, source, msg_id, http_status, fh2_response, body_summary, missing, error
    # Global log list: uw:logs:_all_ keeps the last MAX_GLOBAL_LOGS across all sources

    _MAX_LOGS_PER_SOURCE = 200
    _MAX_GLOBAL_LOGS = 500
    _LOG_KEY_GLOBAL = "uw:logs:_all_"

    @staticmethod
    def _k_logs(source: str) -> str:
        return f"uw:logs:{source}"

    async def append_log(self, source: str, entry: dict) -> None:
        """Prepend a log entry (newest-first) to the per-source and global log lists."""
        import json as _json
        serialized = _json.dumps(entry, ensure_ascii=False)
        pipe = self.redis.pipeline()
        pipe.lpush(self._k_logs(source), serialized)
        pipe.ltrim(self._k_logs(source), 0, self._MAX_LOGS_PER_SOURCE - 1)
        pipe.lpush(self._LOG_KEY_GLOBAL, serialized)
        pipe.ltrim(self._LOG_KEY_GLOBAL, 0, self._MAX_GLOBAL_LOGS - 1)
        await pipe.execute()

    async def get_logs(self, source: str | None, limit: int = 100) -> list[dict]:
        """Return the most recent *limit* log entries for *source* (or all sources)."""
        import json as _json
        key = self._LOG_KEY_GLOBAL if not source else self._k_logs(source)
        raws = await self.redis.lrange(key, 0, limit - 1)
        out = []
        for r in raws:
            try:
                out.append(_json.loads(r))
            except Exception:
                pass
        return out

    async def clear_logs(self, source: str | None) -> int:
        """Delete log list for *source* (or the global list if source is None)."""
        key = self._LOG_KEY_GLOBAL if not source else self._k_logs(source)
        return await self.redis.delete(key)

    # ── Ingest Access Logs ────────────────────────────────────────────────────
    # Records every HTTP request that hits POST /webhook — both accepted and
    # rejected — so users can see what the third-party system sent and why
    # it was rejected (auth failure, missing source, bad payload, etc.).
    #
    # Redis key: uw:ingest:_all_   (global, newest-first, capped at 500)
    # Each entry dict keys:
    #   ts, source, ip, method, path, status_code, result,
    #   reject_reason, request_headers, body_size

    _MAX_INGEST_LOGS = 500
    _INGEST_KEY_GLOBAL = "uw:ingest:_all_"

    async def append_ingest_log(self, entry: dict) -> None:
        """Prepend an ingest log entry (newest-first) to the global ingest list."""
        import json as _json
        serialized = _json.dumps(entry, ensure_ascii=False)
        pipe = self.redis.pipeline()
        pipe.lpush(self._INGEST_KEY_GLOBAL, serialized)
        pipe.ltrim(self._INGEST_KEY_GLOBAL, 0, self._MAX_INGEST_LOGS - 1)
        await pipe.execute()

    async def get_ingest_logs(self, source: str | None, limit: int = 100) -> list[dict]:
        """Return the most recent *limit* ingest log entries, optionally filtered by source."""
        import json as _json
        raws = await self.redis.lrange(self._INGEST_KEY_GLOBAL, 0, self._MAX_INGEST_LOGS - 1)
        out = []
        for r in raws:
            try:
                entry = _json.loads(r)
                if source and entry.get("source") != source:
                    continue
                out.append(entry)
                if len(out) >= limit:
                    break
            except Exception:
                pass
        return out

    async def clear_ingest_logs(self) -> int:
        """Delete all ingest logs."""
        return await self.redis.delete(self._INGEST_KEY_GLOBAL)

