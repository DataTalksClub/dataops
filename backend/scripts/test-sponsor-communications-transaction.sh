#!/usr/bin/env bash
set -euo pipefail

container_name="dataops-sponsor-send-transaction-${PPID}-$$"
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

DYNAMODB_ENDPOINT="$endpoint" \
DATAOPS_SPONSOR_CRM_TABLE=SponsorCrmTransaction \
DATAOPS_USERS_TABLE=UsersTransaction \
AWS_ACCESS_KEY_ID=local \
AWS_SECRET_ACCESS_KEY=local \
AWS_REGION=us-east-1 \
NODE_ENV=test \
SKIP_AUTH=true \
node --import tsx --test --test-concurrency=1 --test-force-exit \
  tests/sponsor-communications-transaction.test.ts
