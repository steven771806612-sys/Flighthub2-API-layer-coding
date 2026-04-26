import json
import time
from redis.asyncio import Redis

PUSH_LOG_MAX = 50  # keep last N push results per source


class RedisRepo:
    def __init__(self, redis: Redis):
        self.redis = redis

    # ------------------------------------------------------------------ sources
    async def list_sources(self) -> list[str]:
        """List sources that have mapping and/or flighthub config."""
        sources: set[str] = set()
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

    # ------------------------------------------------------------------ key helpers
    @staticmethod
    def _k_map(source: str) -> str:
        return f"uw:map:{source}"

    @staticmethod
    def _k_fhcfg(source: str) -> str:
        return f"uw:fhcfg:{source}"

    @staticmethod
    def _k_srcauth(source: str) -> str:
        return f"uw:srcauth:{source}"

    @staticmethod
    def _k_lastpush(source: str) -> str:
        return f"uw:lastpush:{source}"

    @staticmethod
    def _k_pushlog(source: str) -> str:
        return f"uw:pushlog:{source}"

    # ------------------------------------------------------------------ mapping
    async def get_mapping(self, source: str) -> dict:
        raw = await self.redis.get(self._k_map(source))
        if not raw:
            return {"mappings": []}
        return json.loads(raw)

    async def set_mapping(self, source: str, mapping: dict) -> None:
        await self.redis.set(self._k_map(source), json.dumps(mapping, ensure_ascii=False))

    # ------------------------------------------------------------------ fhcfg
    async def get_fhcfg(self, source: str) -> dict:
        raw = await self.redis.get(self._k_fhcfg(source))
        if not raw:
            return {}
        return json.loads(raw)

    async def set_fhcfg(self, source: str, cfg: dict) -> None:
        await self.redis.set(self._k_fhcfg(source), json.dumps(cfg, ensure_ascii=False))

    # ------------------------------------------------------------------ source auth
    async def get_source_auth(self, source: str) -> dict:
        raw = await self.redis.get(self._k_srcauth(source))
        if not raw:
            return {}
        return json.loads(raw)

    async def set_source_auth(self, source: str, cfg: dict) -> None:
        await self.redis.set(self._k_srcauth(source), json.dumps(cfg, ensure_ascii=False))

    # ------------------------------------------------------------------ push results
    async def set_last_push(self, source: str, result: dict) -> None:
        """Persist the most recent FH2 push result for a source."""
        await self.redis.set(self._k_lastpush(source), json.dumps(result, ensure_ascii=False))

    async def get_last_push(self, source: str) -> dict | None:
        raw = await self.redis.get(self._k_lastpush(source))
        if not raw:
            return None
        return json.loads(raw)

    async def append_push_log(self, source: str, result: dict) -> None:
        """Append a push result to the per-source history list (capped at PUSH_LOG_MAX)."""
        key = self._k_pushlog(source)
        entry = json.dumps(result, ensure_ascii=False)
        pipe = self.redis.pipeline()
        pipe.lpush(key, entry)
        pipe.ltrim(key, 0, PUSH_LOG_MAX - 1)
        await pipe.execute()

    async def get_push_log(self, source: str, limit: int = 20) -> list[dict]:
        """Return recent push results (newest first)."""
        key = self._k_pushlog(source)
        raw_list = await self.redis.lrange(key, 0, limit - 1)
        results = []
        for raw in raw_list:
            try:
                results.append(json.loads(raw))
            except Exception:
                pass
        return results

    async def get_last_push_by_test_id(self, test_id: str, sources: list[str]) -> dict | None:
        """Search push logs across sources for a specific test_id."""
        for source in sources:
            logs = await self.get_push_log(source, limit=PUSH_LOG_MAX)
            for entry in logs:
                if entry.get("test_id") == test_id:
                    return entry
        return None
