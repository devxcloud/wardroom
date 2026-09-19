#!/usr/bin/env bash

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker CLI is required" >&2
  exit 1
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${ENV_FILE:-$repo_root/.env}
context_name=${DOCKER_CONTEXT:-}
if [[ -z "$context_name" && -f "$env_file" ]]; then
  context_name=$(awk -F= '$1 == "DOCKER_CONTEXT" { sub(/^[^=]*=/, ""); print; exit }' "$env_file")
fi
context_name=${context_name:-wardroom}
expected_endpoint=${DOCKER_ENDPOINT:-}
if [[ -z "$expected_endpoint" && -f "$env_file" ]]; then
  expected_endpoint=$(awk -F= '$1 == "DOCKER_ENDPOINT" { sub(/^[^=]*=/, ""); print; exit }' "$env_file")
fi
if [[ ! "$expected_endpoint" =~ ^ssh://[^[:space:]]+$ ]]; then
  echo "DOCKER_ENDPOINT is missing or invalid" >&2
  exit 2
fi

if ! docker context inspect "$context_name" >/dev/null 2>&1; then
  docker context create "$context_name" \
    --description "Shared development Docker host over Tailscale" \
    --docker "host=$expected_endpoint"
fi

endpoint=$(docker context inspect "$context_name" --format '{{.Endpoints.docker.Host}}')
if [[ "$endpoint" != "$expected_endpoint" ]]; then
  echo "context '$context_name' points to '$endpoint'; refusing to overwrite it" >&2
  exit 1
fi

docker --context "$context_name" version
echo "Docker context '$context_name' is ready at $expected_endpoint"
