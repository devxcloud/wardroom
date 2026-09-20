#!/usr/bin/env bash

set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
database=${1:-}
if [[ ! "$database" =~ ^[a-z][a-z0-9_]{2,62}$ ]]; then
  echo "Provide a valid DB name" >&2
  exit 2
fi
validate_context
umask 077
mkdir -p "$repo_root/backups"
backup_file="$repo_root/backups/${database}-$(date -u +%Y%m%dT%H%M%SZ).dump"
set -o noclobber
# shellcheck disable=SC2016
if ! "${compose[@]}" exec -T -e "BACKUP_DATABASE=$database" postgres sh -eu -c \
  'pg_dump -U "$POSTGRES_USER" --format=custom "$BACKUP_DATABASE"' >"$backup_file"; then
  rm -f "$backup_file"
  echo "Backup failed. Incomplete dump removed." >&2
  exit 1
fi
echo "Backup saved: $backup_file"
