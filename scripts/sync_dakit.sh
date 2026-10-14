#!/usr/bin/env bash
# Vendor dakit and its lock; sync.mjs rewrites font URLs for the flat layout.
set -euo pipefail
cd "$(dirname "$0")/.."
DAKIT_DIR="${1:-$HOME/git/dakit}"
node "$DAKIT_DIR/scripts/sync.mjs" --dest frontend/src/dakit
