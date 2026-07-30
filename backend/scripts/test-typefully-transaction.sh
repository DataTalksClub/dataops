#!/usr/bin/env bash
set -euo pipefail

container_name="dataops-typefully-transaction-${PPID}-$$"
container_id=""

cleanup() {
  if [ -n "$container_id" ]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

container_id="$(docker run -d --rm \
  -p 127.0.0.1::8000 \
  --name "$container_name" \
  amazon/dynamodb-local:latest \
  -jar DynamoDBLocal.jar -inMemory -sharedDb)"

mapping="$(docker port "$container_id" 8000/tcp)"
endpoint="http://${mapping}"
ready="false"
for _attempt in $(seq 1 50); do
  status="$(curl -s -o /dev/null -w '%{http_code}' "$endpoint" || true)"
  if [ "$status" != "000" ]; then
    ready="true"
    break
  fi
  sleep 0.2
done
if [ "$ready" != "true" ]; then
  docker logs "$container_id" >&2
  echo "DynamoDB Local did not become ready" >&2
  exit 1
fi

DYNAMODB_ENDPOINT="$endpoint" \
AWS_ACCESS_KEY_ID=local \
AWS_SECRET_ACCESS_KEY=local \
AWS_REGION=us-east-1 \
NODE_ENV=production \
SKIP_AUTH=true \
node --import tsx --test --test-concurrency=1 \
  tests/typefully-transaction.test.ts
