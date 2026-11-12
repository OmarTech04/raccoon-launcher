#!/usr/bin/env bash
# Copy the extension's runtime files into DEST and compile its schema.
# Used by `make install` and by tools/smoketest.sh so both install exactly
# the same file set.
#
# Usage: tools/install.sh DEST
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?usage: install.sh DEST}"
RUNTIME_FILES=(metadata.json extension.js prefs.js stylesheet.css lib schemas)

rm -rf "$DEST"
mkdir -p "$DEST"
for f in "${RUNTIME_FILES[@]}"; do
    cp -r "$SRC/$f" "$DEST/"
done
rm -f "$DEST/schemas/gschemas.compiled"
glib-compile-schemas --strict "$DEST/schemas"
