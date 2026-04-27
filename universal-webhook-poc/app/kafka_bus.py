import json
from aiokafka import AIOKafkaProducer

class KafkaBus:
    def __init__(self, bootstrap: str, topic: str):
        self.bootstrap = bootstrap
        self.topic = topic
        self.producer: AIOKafkaProducer | None = None

    async def start(self):
        self.producer = AIOKafkaProducer(
            bootstrap_servers=self.bootstrap,
            value_serializer=lambda v: json.dumps(v, ensure_ascii=False).encode("utf-8"),
        )
        await self.producer.start()

    async def stop(self):
        if self.producer:
            await self.producer.stop()

    async def produce(self, msg: dict, key: str | None = None):
        assert self.producer is not None
        k = key.encode("utf-8") if key else None
        await self.producer.send_and_wait(self.topic, msg, key=k)
