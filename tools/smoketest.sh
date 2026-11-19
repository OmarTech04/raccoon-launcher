#!/usr/bin/env bash
#
# Runtime test for Raccoon Launcher inside a private, headless GNOME Shell.
#
# The real extension is installed unmodified (tools/install.sh) next to a
# test-only driver extension (tests/shell/driver) that exercises it through
# its real entry point: the shell's extension manager enables/disables it,
# keys and clicks come from compositor virtual input devices.
#
# With --firefox, the driver also runs a real Firefox inside the headless
# compositor, using a disposable profile in the sandbox $HOME and local
# stand-in pages (tests/shell/pages). This prototypes window ownership,
# placement, Enter injection, Escape, replacement and search routing under
# Wayland. It does NOT contact ChatGPT and does not use your Firefox profile.
#
# Nothing in your session is touched: separate HOME / XDG dirs, a private
# D-Bus session bus, its own Wayland display. The sandbox is deleted
# afterwards unless the test fails or RACCOON_KEEP_SANDBOX=1.
#
# Usage:  tools/smoketest.sh [--firefox] [--only=GROUP[,GROUP...]]
#         Groups: overlay, lifecycle, folders, copy (default: all of them;
#         --firefox adds the Firefox group), and the opt-in "paste" group,
#         which pastes a copied file in GNOME Files (nautilus) in the sandbox.
# Exit:   0 on PASS, 1 on FAIL.

set -u

UUID="raccoonlauncher@shimafallah.github.io"
DRIVER="raccoon-test-driver@local"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
FIREFOX=0
TIMEOUT=120
ONLY=""
for arg in "$@"; do
    case "$arg" in
        --firefox) FIREFOX=1; TIMEOUT=360 ;;
        --only=*) ONLY="${arg#--only=}" ;;
        *) echo "usage: $0 [--firefox] [--only=GROUP[,GROUP...]]" >&2; exit 2 ;;
    esac
done

SB="$(mktemp -d "${TMPDIR:-/tmp}/rl-smoketest.XXXXXX")"
HOME_DIR="$SB/home"
DATA="$SB/data"
LOG="$SB/shell.log"
OUT="$SB/result.txt"
PID=""

# Kill only processes that belong to this sandbox (identified by HOME).
kill_sandbox_processes() {
    local p
    for p in $(pgrep -u "$(id -u)"); do
        if { tr '\0' '\n' <"/proc/$p/environ"; } 2>/dev/null | grep -qx "HOME=$HOME_DIR"; then
            kill -TERM "$p" 2>/dev/null
        fi
    done
}

cleanup() {
    if [ -n "$PID" ]; then
        kill -TERM -- "-$PID" 2>/dev/null
        sleep 1
    fi
    kill_sandbox_processes
    if [ "${STATUS:-1}" = 0 ] && [ "${RACCOON_KEEP_SANDBOX:-0}" != 1 ]; then
        rm -rf "$SB"
    else
        echo "Sandbox kept for inspection: $SB (shell log: $LOG)"
    fi
}
trap cleanup EXIT

# --- sandbox ------------------------------------------------------------------
mkdir -p "$HOME_DIR/.config" "$DATA/gnome-shell/extensions" "$SB/cache" "$SB/run"
chmod 700 "$SB/run"
"$SRC/tools/install.sh" "$DATA/gnome-shell/extensions/$UUID" || exit 1
cp -r "$SRC/tests/shell/driver" "$DATA/gnome-shell/extensions/$DRIVER"

# File-search fixture inside the sandbox $HOME.
(
    cd "$HOME_DIR" || exit 1
    mkdir -p "Documents/sub dir" .secret many
    : >"Report 2024.pdf"; : >notes.md; : >"تقرير مالي.txt"; : >.hidden-report.txt
    : >".secret/report-inside-hidden.txt"; : >"Documents/sub dir/deep report.odt"
    for i in $(seq -w 1 25); do : >"many/file-$i.txt"; done
    # Folder-search fixture: matching folders, matching files, hidden and
    # symlinked folders.
    mkdir -p Projects "Work/Client Projects" "تقارير/مشاريع" ".hidden-stuff/projects-hidden"
    : >projects-plan.txt; : >"Work/projects-budget.ods"
    ln -s Work projects-link
)

if [ "$FIREFOX" = 1 ]; then
    # Disposable Firefox profile; legacy profile mode makes Firefox use it.
    PROFILES="$HOME_DIR/.mozilla/firefox"
    mkdir -p "$PROFILES/test.profile"
    cat >"$PROFILES/profiles.ini" <<'EOF'
[General]
StartWithLastProfile=1

[Profile0]
Name=test
IsRelative=1
Path=test.profile
Default=1
EOF
    cat >"$PROFILES/test.profile/user.js" <<'EOF'
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("startup.homepage_first_run_url", "");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("datareporting.policy.firstRunURL", "");
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.startup.page", 0);
user_pref("browser.startup.homepage", "about:blank");
user_pref("browser.newtabpage.enabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.warnOnQuit", false);
user_pref("app.update.auto", false);
user_pref("network.captive-portal-service.enabled", false);
EOF
    cat >"$HOME_DIR/.config/mimeapps.list" <<'EOF'
[Default Applications]
x-scheme-handler/http=org.mozilla.firefox.desktop
x-scheme-handler/https=org.mozilla.firefox.desktop
text/html=org.mozilla.firefox.desktop
EOF
fi

# --- run --------------------------------------------------------------------------
echo "Starting headless GNOME Shell (sandbox $SB)..."
setsid env \
    HOME="$HOME_DIR" XDG_DATA_HOME="$DATA" XDG_CONFIG_HOME="$HOME_DIR/.config" \
    XDG_CACHE_HOME="$SB/cache" XDG_RUNTIME_DIR="$SB/run" \
    RACCOON_TEST_OUT="$OUT" RACCOON_TEST_FIREFOX="$FIREFOX" RACCOON_TEST_ONLY="$ONLY" \
    RACCOON_TEST_PAGES="$SRC/tests/shell/pages" \
    MOZ_ENABLE_WAYLAND=1 MOZ_LEGACY_PROFILES=1 MOZ_CRASHREPORTER_DISABLE=1 \
    SHELL_DEBUG="${SHELL_DEBUG:-}" G_MESSAGES_DEBUG="${G_MESSAGES_DEBUG:-}" \
    dbus-run-session -- bash -c '
        # A fresh HOME would show the first-login welcome tour, a system-modal
        # dialog that takes keyboard input away from windows and the launcher.
        gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
        gsettings set org.gnome.shell disable-user-extensions false
        gsettings set org.gnome.shell enabled-extensions "[\"'"$UUID"'\", \"'"$DRIVER"'\"]"
        exec gnome-shell --headless --virtual-monitor 1280x800
    ' >"$LOG" 2>&1 &
PID=$!

# Bounded wait for the driver to finish (or the shell to die).
STATUS=1
deadline=$((SECONDS + TIMEOUT))
while [ $SECONDS -lt $deadline ]; do
    if grep -q "RACCOON_TEST DONE" "$OUT" 2>/dev/null; then
        break
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
        echo "GNOME Shell exited early."
        break
    fi
    sleep 1
done

echo "----- test output -----"
if [ -s "$OUT" ]; then
    cat "$OUT"
else
    echo "(no driver output)"
fi
echo "-----------------------"

if grep -q "RACCOON_TEST DONE PASS" "$OUT" 2>/dev/null; then
    STATUS=0
else
    grep -q "RACCOON_TEST DONE" "$OUT" 2>/dev/null || echo "Timed out after ${TIMEOUT}s."
fi

# Surface extension errors / JS exceptions from the shell log either way.
# Only up to the driver's DONE marker: later lines come from shutting the
# sandbox down (e.g. the shell's calendar losing its D-Bus service).
ERRS="$(sed '/RACCOON_TEST DONE/q' "$LOG" \
    | grep -nE "JS ERROR|CRITICAL|raccoon|Raccoon|Extension .* had error|TypeError|ReferenceError" \
    | grep -v "RACCOON_TEST \(ok\|DONE\)" | grep -v "expected test failure" | head -40)"
if echo "$ERRS" | grep -qE "JS ERROR|CRITICAL"; then
    echo "Errors were logged during the test run."
    STATUS=1
fi
if [ -n "$ERRS" ]; then
    echo "----- shell log: errors / extension messages -----"
    echo "$ERRS"
    echo "--------------------------------------------------"
fi

if [ "$STATUS" = 0 ]; then
    echo "PASS"
else
    echo "FAIL"
fi
exit "$STATUS"
