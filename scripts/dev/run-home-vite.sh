#!/usr/bin/env bash
set -euo pipefail

umask 077

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
replica_root="${DATAOPS_REPLICA_ROOT:-$repo_root/.local/prod-shaped-replica}"
database_path="$replica_root/dynalite"
dynamo_port="${DATAOPS_REPLICA_PORT:-8001}"
dynamo_endpoint="http://127.0.0.1:$dynamo_port"

# Keep actor identity outside Git without importing unrelated `.env` secrets.
for env_file in "$repo_root/.env" "$repo_root/.env.local"; do
  if test -f "$env_file"; then
    while IFS='=' read -r env_key env_value; do
      if test "$env_key" = DATAOPS_DEV_ACTOR_EMAIL; then
        export DATAOPS_DEV_ACTOR_EMAIL="$env_value"
      fi
    done <"$env_file"
  fi
done

test -d "$database_path"
test -f "$replica_root/manifest.json"

for required_port in 3000 3001 "$dynamo_port"; do
  if (echo >"/dev/tcp/127.0.0.1/$required_port") 2>/dev/null; then
    echo "Port $required_port is already in use" >&2
    exit 1
  fi
done

node "$repo_root/scripts/dev/run-loopback-dynalite.cjs" \
  "$dynamo_port" \
  "$database_path" \
  >"$replica_root/home-prototype-dynalite.log" 2>&1 &
replica_pid=$!

cleanup() {
  status=$?
  trap - EXIT INT TERM HUP
  if kill -0 "$replica_pid" 2>/dev/null; then
    kill "$replica_pid" 2>/dev/null || true
    wait "$replica_pid" 2>/dev/null || true
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

for _attempt in $(seq 1 60); do
  if (echo >"/dev/tcp/127.0.0.1/$dynamo_port") 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if ! (echo >"/dev/tcp/127.0.0.1/$dynamo_port") 2>/dev/null; then
  echo "Local representative Dynalite did not become ready" >&2
  exit 1
fi

unset AWS_PROFILE AWS_SESSION_TOKEN DATAOPS_DEV_FRONTEND_PORT DATAOPS_DEV_BACKEND_PORT
export IS_LOCAL=true
export DYNAMODB_ENDPOINT="$dynamo_endpoint"
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local
export AWS_REGION=us-east-1
export DATAOPS_DEV_SEED_MODE=none
export DATAOPS_TASKS_TABLE=dataops-v1-tasks
export DATAOPS_CARDS_TABLE=dataops-v1-cards
export DATAOPS_TEMPLATES_TABLE=dataops-v1-templates
export DATAOPS_USERS_TABLE=dataops-v1-users
export DATAOPS_FILES_TABLE=dataops-v1-files
export DATAOPS_ARTIFACTS_TABLE=dataops-v1-artifacts
export DATAOPS_ASSISTANT_JOBS_TABLE=dataops-v1-assistant-jobs
export DATAOPS_AUDIT_EVENTS_TABLE=dataops-v1-audit-events
export DATAOPS_INTAKE_TABLE=dataops-v1-intake
export DATAOPS_NOTIFICATIONS_TABLE=dataops-v1-notifications
export DATAOPS_SESSIONS_TABLE=dataops-v1-sessions
export DATAOPS_BOOKKEEPING_TABLE=dataops-v1-bookkeeping
export DATAOPS_SPONSOR_CRM_TABLE=dataops-v1-sponsor-crm
export DATAOPS_NEWSLETTER_SLOTS_TABLE=dataops-v1-newsletter-slots
export DATAOPS_CALENDAR_TABLE=dataops-v1-calendar
export DATAOPS_CONVERSATIONAL_STATE_TABLE=dataops-v1-conversational-state
export DATAOPS_DOCS_DOMAIN=1
export DTC_OFFLINE=1
export DTC_CACHE_ROOT="$repo_root/.local/dev-portal"
export FRONTEND_ROOT="$repo_root/frontend"
export UPLOAD_DIR="$repo_root/.local/dev-portal/uploads"
export DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR="$repo_root/.local/dev-portal/exports"
export CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED=false
export CONVERSATIONAL_EXECUTION_ENABLED=false
export CONVERSATIONAL_ENABLED_PLUGINS=none
export CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED=false
export CONVERSATIONAL_TELEGRAM_VOICE_ENABLED=false
export CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED=false

cd "$repo_root"
npm run dev
