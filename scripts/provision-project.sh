#!/usr/bin/env bash

set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
project=${1:-}
if [[ ! "$project" =~ ^[a-z][a-z0-9_]{2,47}$ ]]; then
  echo "project must match ^[a-z][a-z0-9_]{2,47}$" >&2
  exit 2
fi
password=${PROJECT_DB_PASSWORD:-}
if [[ -z "$password" ]]; then
  echo "PROJECT_DB_PASSWORD is required" >&2
  exit 2
fi
validate_context
"${compose[@]}" exec -T \
  -e PROJECT_DB_PASSWORD -e PROJECT_DB_NAME -e PROJECT_TEST_DB_NAME \
  -e PROJECT_S3_BUCKET -e PROJECT_TEST_S3_BUCKET \
  dashboard node dashboard/cli.mjs provision "$project"
