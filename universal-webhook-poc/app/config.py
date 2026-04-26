from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    REDIS_URL: str = "redis://127.0.0.1:6379/0"

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
