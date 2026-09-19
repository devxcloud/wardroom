#!/usr/bin/env bash

set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
validate_context
"${compose[@]}" exec -T dashboard node dashboard/cli.mjs smoke
