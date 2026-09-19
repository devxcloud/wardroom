#!/usr/bin/env bash

set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
node "$(dirname "${BASH_SOURCE[0]}")/ensure-private-config.mjs"
validate_context
"${compose[@]}" "$@"
