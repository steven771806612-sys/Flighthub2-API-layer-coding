import os
from pydantic_settings import BaseSettings
from pydantic import field_validator


def _resolve_redis_url() -> str:
    """Railway injects Redis URL under various variable names; try each in order.
    Skip empty strings (supervisord sets missing %(ENV_*)s vars to '').
    """
    for key in ("REDIS_URL", "REDIS_PRIVATE_URL", "REDIS_PUBLIC_URL", "REDISURL", "REDIS_TLS_URL"):
        val = (os.environ.get(key) or "").strip()
        if val:
            return val
    return "redis://127.0.0.1:6379/0"


class Settings(BaseSettings):
    # NOTE: pydantic-settings will set REDIS_URL from the env var of the same name.
    # supervisord may pass REDIS_URL="" (empty string) when the var is unset in Railway.
    # The validator below replaces empty/whitespace values with the resolved URL so the
    # worker always connects to the real Redis even when supervisord sets REDIS_URL="".
    REDIS_URL: str = "redis://127.0.0.1:6379/0"

    @field_validator("REDIS_URL", mode="before")
    @classmethod
    def resolve_redis_url(cls, v: str) -> str:
        """Replace blank REDIS_URL with the first non-empty Redis env var found."""
        if not (v or "").strip():
            return _resolve_redis_url()
        return v

    # Queue backend: Redis Streams
    STREAM_KEY_RAW: str = "uw:webhook:raw"
    STREAM_GROUP: str = "uw-worker-group"
    STREAM_CONSUMER: str = "worker-1"

    ADMIN_TOKEN: str | None = None  # if set, admin endpoints require X-Admin-Token header

    # default source used when webhook request doesn't specify it
    DEFAULT_SOURCE: str = "flighthub2"

    # FlightHub endpoint default (can be overridden by Redis config)
    DEFAULT_FLIGHTHUB_ENDPOINT: str = "https://es-flight-api-us.djigate.com/openapi/v0.1/workflow"


settings = Settings()
