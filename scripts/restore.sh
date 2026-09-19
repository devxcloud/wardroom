#!/usr/bin/env bash

set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
database=${1:-}
backup_file=${2:-}
if [[ ! "$database" =~ ^[a-z][a-z0-9_]{2,62}$ || ! -f "$backup_file" ]]; then
  echo "Provide a new DB name and an existing FILE" >&2
  exit 2
fi
validate_context
# CREATE DATABASE intentionally fails if the target already exists.
# shellcheck disable=SC2016
"${compose[@]}" exec -T -e "RESTORE_DATABASE=$database" postgres sh -eu -c \
  'createdb -U "$POSTGRES_USER" "$RESTORE_DATABASE"'
# shellcheck disable=SC2016
"${compose[@]}" exec -T -e "RESTORE_DATABASE=$database" postgres sh -eu -c \
  'pg_restore -U "$POSTGRES_USER" --exit-on-error --single-transaction --no-owner --dbname="$RESTORE_DATABASE"' <"$backup_file"
echo "Restored into new database: $database (owned by the infrastructure admin)"
