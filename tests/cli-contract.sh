#!/usr/bin/env bash

set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$temp_dir/bin"
cat >"$temp_dir/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == context ]]; then
  echo "${FAKE_ENDPOINT:-ssh://test@100.100.100.100}"
else
  printf '%s\n' "$*" >>"$FAKE_LOG"
  exit "${FAKE_EXIT:-0}"
fi
EOF
chmod +x "$temp_dir/bin/docker"
export PATH="$temp_dir/bin:$PATH"
export DOCKER_ENDPOINT=ssh://test@100.100.100.100
export DOCKER_CONTEXT=custom-devbox
export FAKE_LOG="$temp_dir/calls"
export PROJECT_DB_PASSWORD=test-project-password
bash "$repo_root/scripts/provision-project.sh" sample
grep -q '^--context custom-devbox compose ' "$FAKE_LOG"
grep -q 'dashboard node dashboard/cli.mjs provision sample' "$FAKE_LOG"
if grep -q "$PROJECT_DB_PASSWORD" "$FAKE_LOG"; then
  echo "Password leaked into CLI arguments" >&2
  exit 1
fi
for project in a 'bad-name' 'bad name' 'Bad'; do
  if bash "$repo_root/scripts/provision-project.sh" "$project" 2>/dev/null; then
    echo "Invalid project accepted" >&2
    exit 1
  fi
done
export FAKE_ENDPOINT=ssh://wrong-host
for script in compose smoke provision-project; do
  if bash "$repo_root/scripts/$script.sh" sample 2>/dev/null; then
    echo "$script accepted the wrong endpoint" >&2
    exit 1
  fi
done
unset FAKE_ENDPOINT
export FAKE_EXIT=1
if bash "$repo_root/scripts/smoke.sh"; then
  echo "Smoke failure was hidden" >&2
  exit 1
fi
echo "CLI context, validation, and error propagation passed"
