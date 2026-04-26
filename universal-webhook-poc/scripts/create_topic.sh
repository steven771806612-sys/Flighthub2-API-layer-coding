#!/usr/bin/env bash
set -euo pipefail
cd /mnt/user-data/outputs/universal-webhook-poc
KDIR=/mnt/user-data/outputs/universal-webhook-poc/kafka_2.13-4.2.0
export KAFKA_HEAP_OPTS='-Xms256m -Xmx512m'

# Wait broker ready
for i in $(seq 1 60); do
  if $KDIR/bin/kafka-broker-api-versions.sh --bootstrap-server 127.0.0.1:9092 >/dev/null 2>&1; then
    echo "kafka_ready"
    break
  fi
  sleep 1
  if [ $i -eq 60 ]; then
    echo "kafka_not_ready" >&2
    exit 1
  fi
done

$KDIR/bin/kafka-topics.sh --bootstrap-server 127.0.0.1:9092 --create --if-not-exists --topic uw.webhook.raw --partitions 1 --replication-factor 1
$KDIR/bin/kafka-topics.sh --bootstrap-server 127.0.0.1:9092 --list
