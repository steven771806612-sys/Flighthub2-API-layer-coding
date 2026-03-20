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

    async def get_mapping(self, source: str) -> dict:
        raw = await self.redis.get(self._k_map(source))
        if not raw:
            return {"mappings": []}
        return json.loads(raw)

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
            return {}
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

