#!/usr/bin/env bash
set -euo pipefail
cd /mnt/user-data/outputs/universal-webhook-poc
KDIR=/mnt/user-data/outputs/universal-webhook-poc/kafka_2.13-4.2.0
export KAFKA_HEAP_OPTS='-Xms256m -Xmx512m'

mkdir -p data/kraft-combined-logs logs

# Create a dedicated config for this sandbox
cat > config.server.poc.properties <<EOF
process.roles=broker,controller
node.id=1
controller.quorum.bootstrap.servers=127.0.0.1:9093
listeners=PLAINTEXT://127.0.0.1:9092,CONTROLLER://127.0.0.1:9093
advertised.listeners=PLAINTEXT://127.0.0.1:9092,CONTROLLER://127.0.0.1:9093
listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
controller.listener.names=CONTROLLER
inter.broker.listener.name=PLAINTEXT
log.dirs=/mnt/user-data/outputs/universal-webhook-poc/data/kraft-combined-logs
num.partitions=1
auto.create.topics.enable=true
EOF

# Format storage if not already formatted
CLUSTER_ID_FILE=logs/kafka.cluster_id
if [ ! -f "$CLUSTER_ID_FILE" ]; then
  CLUSTER_ID=$($KDIR/bin/kafka-storage.sh random-uuid)
  echo "$CLUSTER_ID" > "$CLUSTER_ID_FILE"
fi
CLUSTER_ID=$(cat "$CLUSTER_ID_FILE")

# Format (ignore if already)
$KDIR/bin/kafka-storage.sh format --standalone -t "$CLUSTER_ID" -c config.server.poc.properties --ignore-formatted

# Start kafka
nohup $KDIR/bin/kafka-server-start.sh config.server.poc.properties > logs/kafka.log 2>&1 &
echo $! > logs/kafka.pid

echo "Kafka starting pid=$(cat logs/kafka.pid) cluster_id=$CLUSTER_ID"
