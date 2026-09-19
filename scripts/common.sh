#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${ENV_FILE:-$repo_root/.env}

env_value() {
  awk -v key="$1" -F= '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$env_file"
}

context_name=${DOCKER_CONTEXT:-$(env_value DOCKER_CONTEXT)}
context_name=${context_name:-wardroom}
# Used by scripts sourcing this file.
# shellcheck disable=SC2034
compose=(docker --context "$context_name" compose --env-file "$env_file" -f "$repo_root/compose.yaml")

validate_context() {
  local expected_endpoint endpoint
  expected_endpoint=${DOCKER_ENDPOINT:-$(env_value DOCKER_ENDPOINT)}
  if [[ ! "$expected_endpoint" =~ ^ssh://[^[:space:]]+$ ]]; then
    echo "DOCKER_ENDPOINT is missing or invalid" >&2
    return 2
  fi
  endpoint=$(docker context inspect "$context_name" --format '{{.Endpoints.docker.Host}}')
  if [[ "$endpoint" != "$expected_endpoint" ]]; then
    echo "context '$context_name' uses '$endpoint'; expected $expected_endpoint" >&2
    return 1
  fi
}
