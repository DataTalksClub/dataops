#!/usr/bin/env bash
set -euo pipefail

container_name="dataops-task-card-transaction-${PPID}-$$"
container_id=""

cleanup() {
  if [ -n "$container_id" ]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

container_id="$(docker run --detach --rm \
  --publish 127.0.0.1::8000 \
  --name "$container_name" \
  amazon/dynamodb-local:latest \
  -jar DynamoDBLocal.jar -inMemory -sharedDb)"

mapping="$(docker port "$container_id" 8000/tcp)"
if [[ ! "$mapping" =~ ^127\.0\.0\.1:[0-9]+$ ]]; then
  docker logs "$container_id" >&2
  echo "DynamoDB Local did not publish one loopback-only port" >&2
  exit 1
fi

endpoint="http://${mapping}"
set +e
DYNAMODB_ENDPOINT="$endpoint" \
DATAOPS_TASKS_TABLE=Issue183TaskCardTransactionTasks \
DATAOPS_CARDS_TABLE=Issue183TaskCardTransactionCards \
DATAOPS_AUDIT_EVENTS_TABLE=Issue183TaskCardTransactionAuditEvents \
AWS_ACCESS_KEY_ID=local \
AWS_SECRET_ACCESS_KEY=local \
AWS_REGION=us-east-1 \
NODE_ENV=production \
node --import tsx --test --test-concurrency=1 tests/task-card-transaction.ddb.ts
test_status=$?
set -e

if [ "$test_status" -ne 0 ]; then
  state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
  echo "DynamoDB Local container state: ${state:-unavailable}" >&2
  docker logs "$container_id" >&2 || true
fi
exit "$test_status"
