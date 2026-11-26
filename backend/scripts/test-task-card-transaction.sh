#!/usr/bin/env bash
set -euo pipefail

container_name="dataops-task-card-transaction-${PPID}-$$"
container_id="$container_name"

cleanup() {
  if [ -n "$container_id" ]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Docker picks the ephemeral host port. On the shared self-hosted CI host another job can take it
# between selection and bind ("address already in use"); only that startup collision is retried.
docker_err="$(mktemp)"
started=""
for start_attempt in 1 2 3 4 5 6; do
  if started="$(docker run --detach --rm \
  --cpus=1 \
  --publish 127.0.0.1::8000 \
  --name "$container_name" \
  amazon/dynamodb-local:latest \
  -jar DynamoDBLocal.jar -inMemory -sharedDb 2>"$docker_err")"; then
    break
  fi
  if grep -q "address already in use" "$docker_err" && [ "$start_attempt" -lt 6 ]; then
    echo "docker port collision starting $container_name (attempt $start_attempt); retrying" >&2
    docker rm -f "$container_name" >/dev/null 2>&1 || true
    sleep "$start_attempt"
    continue
  fi
  cat "$docker_err" >&2
  rm -f "$docker_err"
  exit 1
done
rm -f "$docker_err"
container_id="$started"

mapping="$(docker port "$container_id" 8000/tcp)"
if [[ ! "$mapping" =~ ^127\.0\.0\.1:[0-9]+$ ]]; then
  docker logs "$container_id" >&2
  echo "DynamoDB Local did not publish one loopback-only port" >&2
  exit 1
fi

endpoint="http://${mapping}"
ready="false"
for _attempt in $(seq 1 50); do
  status="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 1 --max-time 2 "$endpoint" || true)"
  if [ "$status" != "000" ]; then ready="true"; break; fi
  sleep 0.2
done
if [ "$ready" != "true" ]; then
  docker logs "$container_id" >&2
  echo "DynamoDB Local did not become ready" >&2
  exit 1
fi

set +e
DYNAMODB_ENDPOINT="$endpoint" \
DATAOPS_TASKS_TABLE=Issue183TaskCardTransactionTasks \
DATAOPS_CARDS_TABLE=Issue183TaskCardTransactionCards \
DATAOPS_AUDIT_EVENTS_TABLE=Issue183TaskCardTransactionAuditEvents \
DATAOPS_CALENDAR_TABLE=EventLifecycleTransactionCalendar \
AWS_ACCESS_KEY_ID=local \
AWS_SECRET_ACCESS_KEY=local \
AWS_REGION=us-east-1 \
NODE_ENV=production \
node --import tsx --test --test-concurrency=1 --test-force-exit tests/task-card-transaction.ddb.ts tests/task-dependency-transaction.ddb.ts tests/card-deletion-transaction.ddb.ts tests/marketing-transaction.ddb.ts
test_status=$?
if [ "$test_status" -eq 0 ]; then
  DYNAMODB_ENDPOINT="$endpoint" \
  DATAOPS_CARDS_TABLE=EventLifecycleTransactionCards \
  DATAOPS_CALENDAR_TABLE=EventLifecycleTransactionCalendar \
  DATAOPS_PODCAST_EPISODES_TABLE=EventLifecycleTransactionPodcastEpisodes \
  AWS_ACCESS_KEY_ID=local \
  AWS_SECRET_ACCESS_KEY=local \
  AWS_REGION=us-east-1 \
  NODE_ENV=production \
  node --import tsx --test --test-concurrency=1 --test-force-exit tests/event-store.ddb.ts
  test_status=$?
fi
set -e

if [ "$test_status" -ne 0 ]; then
  state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
  echo "DynamoDB Local container state: ${state:-unavailable}" >&2
  docker logs "$container_id" >&2 || true
fi
exit "$test_status"
