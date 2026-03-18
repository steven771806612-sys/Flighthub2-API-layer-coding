import os
from pydantic_settings import BaseSettings

def _resolve_redis_url() -> str:
    """Railway 可能注入多种变量名，按优先级探测。"""
    for key in ("REDIS_URL", "REDIS_PRIVATE_URL", "REDIS_PUBLIC_URL", "REDISURL", "REDIS_TLS_URL"):
        val = os.environ.get(key)
        if val:
            return val
    return "redis://127.0.0.1:6379/0"

class Settings(BaseSettings):
    REDIS_URL: str = _resolve_redis_url()

    # Queue backend: Redis Streams (Kafka substitute in this sandbox)
    STREAM_KEY_RAW: str = "uw:webhook:raw"
    STREAM_GROUP: str = "uw-worker-group"
    STREAM_CONSUMER: str = "worker-1"

    ADMIN_TOKEN: str | None = None  # if set, admin endpoints require header X-Admin-Token

    # default source used when webhook request doesn't specify it
    DEFAULT_SOURCE: str = "flighthub2"

    # FlightHub endpoint default (can be overridden by Redis config)
    DEFAULT_FLIGHTHUB_ENDPOINT: str = "https://es-flight-api-us.djigate.com/openapi/v0.1/workflow"

settings = Settings()
