#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

fake_bin="$temp_dir/bin"
mkdir -p "$fake_bin"

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"

if [[ "${1:-}" == context && "${2:-}" == inspect ]]; then
  case "$FAKE_CONTEXT_STATE" in
    missing)
      if [[ -f "$FAKE_CONTEXT_CREATED" ]]; then
        echo 'ssh://test@100.100.100.100'
        exit 0
      fi
      exit 1
      ;;
    correct)
      echo 'ssh://test@100.100.100.100'
      ;;
    wrong)
      echo 'ssh://another-host'
      ;;
  esac
  exit 0
fi

if [[ "${1:-}" == context && "${2:-}" == create ]]; then
  : >"$FAKE_CONTEXT_CREATED"
  exit 0
fi

if [[ "${1:-}" == --context && "${3:-}" == version ]]; then
  echo 'remote docker is reachable'
  exit 0
fi

echo "unexpected docker invocation: $*" >&2
exit 1
EOF
chmod +x "$fake_bin/docker"

run_case() {
  local state=$1
  local case_dir="$temp_dir/$state"
  mkdir -p "$case_dir"
  FAKE_CONTEXT_STATE=$state \
    FAKE_DOCKER_LOG="$case_dir/docker.log" \
    FAKE_CONTEXT_CREATED="$case_dir/created" \
    DOCKER_ENDPOINT=ssh://test@100.100.100.100 \
    DOCKER_CONTEXT=custom-devbox \
    PATH="$fake_bin:/usr/bin:/bin" \
    bash "$repo_root/scripts/setup-context.sh" >"$case_dir/stdout" 2>"$case_dir/stderr"
}

run_case missing
grep -q '^context create custom-devbox ' "$temp_dir/missing/docker.log"
grep -q 'host=ssh://test@100.100.100.100' "$temp_dir/missing/docker.log"
grep -q '^--context custom-devbox version$' "$temp_dir/missing/docker.log"

run_case correct
if grep -q '^context create ' "$temp_dir/correct/docker.log"; then
  echo "existing correct context must not be recreated" >&2
  exit 1
fi

if run_case wrong; then
  echo "wrong context endpoint should fail" >&2
  exit 1
fi
grep -q 'refusing to overwrite' "$temp_dir/wrong/stderr"

empty_bin="$temp_dir/empty-bin"
mkdir -p "$empty_bin"
if PATH="$empty_bin" /bin/bash "$repo_root/scripts/setup-context.sh" >"$temp_dir/no-docker.out" 2>"$temp_dir/no-docker.err"; then
  echo "missing Docker CLI should fail" >&2
  exit 1
fi
grep -q 'Docker CLI is required' "$temp_dir/no-docker.err"

echo "context setup tests passed"
