#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

transaction_suites=(
  'test:execution-transaction'
  'test:telegram-transaction'
  'test:sponsor-finance-transaction'
  'test:sponsor-communications-transaction'
  'test:task-card-transaction'
  'test:todo-transaction'
  'test:typefully-transaction'
)

active_suite=''
suite_pid=''
interrupt_suite() {
  signal_name="$1"
  exit_status="$2"
  if [ -n "$suite_pid" ] && kill -0 "$suite_pid" 2>/dev/null; then
    # npm swallows interactive interrupts; TERM reaches timeout's process group.
    kill -TERM "$suite_pid" 2>/dev/null || true
    wait "$suite_pid" 2>/dev/null || true
  fi
  printf 'INTERRUPTED before completing %s (exit %s)\n' "$active_suite" "$exit_status" >&2
  exit "$exit_status"
}
trap 'interrupt_suite INT 130' INT
trap 'interrupt_suite TERM 143' TERM

for suite in "${transaction_suites[@]}"; do
  active_suite="$suite"
  started_at="$(date +%s)"
  printf '==> START suite=%s timeout=10m\n' "$suite"
  set +e
  timeout --kill-after=30s 10m npm --prefix backend run "$suite" &
  suite_pid="$!"
  wait "$suite_pid"
  suite_status=$?
  suite_pid=''
  set -e
  duration_seconds=$(( $(date +%s) - started_at ))

  if [ "$suite_status" -ne 0 ]; then
    printf 'FAILED suite=%s exit=%s duration_seconds=%s owning_command=npm --prefix backend run %s\n' \
      "$suite" "$suite_status" "$duration_seconds" "$suite" >&2
    exit "$suite_status"
  fi

  printf '<== PASS suite=%s exit=0 duration_seconds=%s\n' "$suite" "$duration_seconds"
done
