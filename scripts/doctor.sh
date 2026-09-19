#!/usr/bin/env bash

set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
validate_context
"${compose[@]}" ps
host=$(env_value SHARED_INFRA_HOST)
if [[ ! "$host" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "SHARED_INFRA_HOST is invalid" >&2
  exit 2
fi
failed=0
for port in 80 4317 4318 5434 6379 9100 9101 1125 8125 8787; do
  if nc -z -w 3 "$host" "$port"; then
    printf '%s:%s reachable\n' "$host" "$port"
  else
    printf '%s:%s unreachable\n' "$host" "$port" >&2
    failed=1
  fi
done
"${compose[@]}" exec -T postgres df -h /var/lib/postgresql
"${compose[@]}" exec -T dashboard node dashboard/cli.mjs smoke || failed=1
exit "$failed"
