#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

for private_path in .env projects.local.json backups/example.dump test-results/example.png docs/superpowers/example.md; do
  git check-ignore -q "$private_path"
done

for private_file in .env projects.local.json; do
  if git ls-files --error-unmatch "$private_file" >/dev/null 2>&1; then
    echo "$private_file must not be tracked" >&2
    exit 1
  fi
done

grep -qx 'projects.local.json' .dockerignore

echo "privacy configuration contract passed"
