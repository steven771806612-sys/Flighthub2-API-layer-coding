import asyncio
import os
import sys

# Ensure project root is importable when running as a script
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from redis.asyncio import Redis
from app.config import settings
from app.redis_repo import RedisRepo

DEFAULT_SOURCE = "flighthub2"

DEFAULT_MAPPING = {
  "mappings": [
    {"src":"$.timestamp","dst":"timestamp","type":"string","default":"","required":False},
    {"src":"$.creator_id","dst":"creator_id","type":"string","default":"system","required":True},
    {"src":"$.latitude","dst":"latitude","type":"float","default":0,"required":True},
    {"src":"$.longitude","dst":"longitude","type":"float","default":0,"required":True},
    {"src":"$.level","dst":"level","type":"string","default":"info","required":True},
    {"src":"$.description","dst":"description","type":"string","default":"","required":False}
  ]
}

DEFAULT_FHCFG = {
  "endpoint": "https://es-flight-api-us.djigate.com/openapi/v0.1/workflow",
  "headers": {
    "Content-Type": "application/json",
    "X-User-Token": "YOUR_SECRET_TOKEN",
    "x-project-uuid": "YOUR_PROJECT_UUID"
  },
  "template_body": {
    "workflow_uuid": "YOUR_WORKFLOW_UUID",
    "trigger_type": 0,
    "name": "Alert-{{timestamp}}",
    "params": {
      "creator": "{{creator_id}}",
      "latitude": "{{latitude}}",
      "longitude": "{{longitude}}",
      "level": "{{level}}",
      "desc": "{{description}}"
    }
  },
  "retry_policy": {"max_retries": 3, "backoff": "exponential"}
}

async def main():
    r = Redis.from_url(settings.REDIS_URL, decode_responses=False)
    repo = RedisRepo(r)
    await repo.set_mapping(DEFAULT_SOURCE, DEFAULT_MAPPING)
    await repo.set_fhcfg(DEFAULT_SOURCE, DEFAULT_FHCFG)
    await r.aclose()
    print("bootstrapped redis keys for source=flighthub2")

if __name__ == "__main__":
    asyncio.run(main())
