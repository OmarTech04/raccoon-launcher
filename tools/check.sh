#!/usr/bin/env bash
# Static and unit checks that run outside GNOME Shell.
#
# Usage: tools/check.sh [schema|syntax|unit|pack|all]   (default: all)
#
# Needs: gjs, glib-compile-schemas, gnome-extensions, unzip, and Mutter's
# typelibs (package "mutter", installed with GNOME Shell) for the unit tests.
set -uo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
UUID="raccoonlauncher@shimafallah.github.io"
cd "$SRC"

# Mutter / GNOME Shell typelibs live outside the default GI path.
MUTTER_DIR="$(ls -d /usr/lib64/mutter-* /usr/lib/mutter-* /usr/lib/*/mutter-* 2>/dev/null | sort -V | tail -1)"
SHELL_DIR="$(ls -d /usr/lib64/gnome-shell /usr/lib/gnome-shell /usr/lib/*/gnome-shell 2>/dev/null | head -1)"
export GI_TYPELIB_PATH="${MUTTER_DIR}:${SHELL_DIR}${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}"
export LD_LIBRARY_PATH="${MUTTER_DIR}:${SHELL_DIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

check_schema() {
    echo "== schema"
    glib-compile-schemas --strict --dry-run schemas/ && echo "ok        schemas/"
}

check_syntax() {
    echo "== syntax (ES modules)"
    # shellcheck disable=SC2046
    gjs -m tools/syntaxcheck.js extension.js prefs.js \
        $(find lib -name '*.js' | sort) tests/shell/driver/extension.js
}

check_unit() {
    echo "== unit tests"
    gjs -m tests/unit/run.js
}

check_pack() {
    echo "== pack"
    local out
    out="$(mktemp -d)"
    glib-compile-schemas --strict schemas/ &&
        gnome-extensions pack --force --extra-source=lib --out-dir="$out" . >/dev/null || {
        rm -rf "$out"
        return 1
    }
    local zip="$out/$UUID.shell-extension.zip" missing=0 f
    for f in metadata.json extension.js prefs.js stylesheet.css \
        schemas/org.gnome.shell.extensions.raccoonlauncher.gschema.xml \
        $(find lib -name '*.js' | sort); do
        if ! unzip -l "$zip" "$f" >/dev/null 2>&1; then
            echo "FAIL      missing from zip: $f"
            missing=1
        fi
    done
    if unzip -l "$zip" | grep -q 'tests/\|tools/'; then
        echo "FAIL      test/tool files leaked into the zip"
        missing=1
    fi
    [ "$missing" = 0 ] && echo "ok        $UUID.shell-extension.zip contains all runtime files"
    rm -rf "$out"
    return "$missing"
}

status=0
case "${1:-all}" in
    schema) check_schema || status=1 ;;
    syntax) check_syntax || status=1 ;;
    unit) check_unit || status=1 ;;
    pack) check_pack || status=1 ;;
    all)
        check_schema || status=1
        check_syntax || status=1
        check_unit || status=1
        check_pack || status=1
        ;;
    *) echo "usage: $0 [schema|syntax|unit|pack|all]" >&2; exit 2 ;;
esac
[ "$status" = 0 ] && echo "ALL CHECKS PASSED" || echo "CHECKS FAILED"
exit "$status"
