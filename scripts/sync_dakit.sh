#!/usr/bin/env bash
# Vendor the dakit design system bundle into the frontend source tree.
#
# The frontend loads dakit's built output directly (tokens, base layer,
# .dk-* components, self-hosted fonts) instead of keeping its own copies:
# edit dakit, never the vendored files. Run after changing dakit
# (cd ../dakit && node build.mjs), then commit both repos. The dakit commit
# the bundle came from is recorded in frontend/src/dakit/PROVENANCE.
#
# Usage: scripts/sync_dakit.sh [path-to-dakit]   (default: ../dakit)
set -euo pipefail

cd "$(dirname "$0")/.."
DAKIT_DIR="${1:-../dakit}"
DAKIT_DIR="${DAKIT_DIR%/}"

if [[ ! -f "$DAKIT_DIR/dist/dakit.css" ]]; then
  echo "error: $DAKIT_DIR/dist/dakit.css not found — build dakit first:" >&2
  echo "  cd $DAKIT_DIR && node build.mjs" >&2
  exit 1
fi

# The bundle's @font-face rules use ../fonts/ relative to dakit's dist/; the
# portal serves the same faces from src/assets/fonts/, so the prefix is
# rewritten to match. Nothing else in the bundle is touched.
sed 's|\.\./fonts/|../assets/fonts/|g' "$DAKIT_DIR/dist/dakit.css" \
  > frontend/src/dakit/dakit.css

# The dialog-dismissal helper ships as plain JS; vendored as-is.
cp "$DAKIT_DIR/dist/dialogs.js" frontend/src/dakit/dakit-dialogs.js

# Tokens stay separately linked from the page head; keep the copy current.
cp "$DAKIT_DIR/dist/tokens.css" frontend/src/dakit/tokens.css

{
  echo "Vendored from dakit ($(git -C "$DAKIT_DIR" rev-parse --short HEAD) $(git -C "$DAKIT_DIR" log -1 --format=%cs))."
  echo "Do not edit; regenerate with scripts/sync_dakit.sh after rebuilding dakit."
} > frontend/src/dakit/PROVENANCE

echo "Synced dakit into frontend/src/dakit/ (dakit $(git -C "$DAKIT_DIR" rev-parse --short HEAD))"
