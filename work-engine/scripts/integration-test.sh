#!/bin/bash
set -euo pipefail

LAMBDA_URL="http://localhost:9000/2015-03-31/functions/function/invocations"

# Cleanup on exit
cleanup() {
  echo "Cleaning up..."
  docker compose down --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

echo "Starting containers..."
docker compose up -d --build

echo "Waiting for Lambda to be ready..."
for i in $(seq 1 30); do
  if curl -s -X POST "$LAMBDA_URL" -d '{"httpMethod":"GET","path":"/api/health"}' | grep -q '"ok"'; then
    echo "Lambda is ready!"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Lambda failed to start"
    exit 1
  fi
  sleep 1
done

PASS=0
FAIL=0

# Helper function
test_endpoint() {
  local desc="$1"
  local payload="$2"
  local expected="$3"

  local response
  response=$(curl -s -X POST "$LAMBDA_URL" -d "$payload")

  if echo "$response" | grep -q "$expected"; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc"
    echo "  Expected: $expected"
    echo "  Got: $response"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "Running integration tests..."
echo "================================"

# Health check
test_endpoint "Health check" \
  '{"httpMethod":"GET","path":"/api/health"}' \
  '"ok"'

# Create a task
test_endpoint "Create task" \
  '{"httpMethod":"POST","path":"/api/tasks","body":"{\"description\":\"Integration test task\",\"date\":\"2026-03-01\"}"}' \
  '"description":"Integration test task"'

# List tasks by date
test_endpoint "List tasks by date" \
  '{"httpMethod":"GET","path":"/api/tasks","queryStringParameters":{"date":"2026-03-01"}}' \
  '"tasks"'

# Create a bundle
test_endpoint "Create bundle" \
  '{"httpMethod":"POST","path":"/api/bundles","body":"{\"title\":\"Test Bundle\",\"anchorDate\":\"2026-04-01\"}"}' \
  '"title":"Test Bundle"'

# List bundles
test_endpoint "List bundles" \
  '{"httpMethod":"GET","path":"/api/bundles"}' \
  '"bundles"'

# Create a template
test_endpoint "Create template" \
  '{"httpMethod":"POST","path":"/api/templates","body":"{\"name\":\"Test\",\"type\":\"test\",\"taskDefinitions\":[{\"refId\":\"t1\",\"description\":\"Task 1\",\"offsetDays\":-7}]}"}' \
  '"name":"Test"'

# Create recurring config
test_endpoint "Create recurring config" \
  '{"httpMethod":"POST","path":"/api/recurring","body":"{\"description\":\"Daily standup\",\"schedule\":\"daily\"}"}' \
  '"description":"Daily standup"'

# SPA shell
test_endpoint "SPA shell serves HTML" \
  '{"httpMethod":"GET","path":"/"}' \
  'DataTasks'

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All integration tests passed!"
