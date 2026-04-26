import json
from redis.asyncio import Redis

class RedisStreamBus:
    def __init__(self, redis: Redis, stream_key: str):
        self.redis = redis
        self.stream_key = stream_key

    async def produce(self, msg: dict):
        # Keep single field 'data' to avoid Redis Stream field explosion
        payload = json.dumps(msg, ensure_ascii=False)
        await self.redis.xadd(self.stream_key, {"data": payload})
