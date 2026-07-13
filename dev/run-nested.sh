#!/usr/bin/env bash
# Run a nested GNOME Shell with Agent Island enabled - the standard way to
# develop and test a Shell extension on Wayland without logging out.
#
#   dev/run-nested.sh                       just open the nested shell
#   dev/run-nested.sh -- <cmd> [args...]    also run <cmd> inside the nested
#                                           session (its D-Bus is private),
#                                           then keep the shell open
#
# Notes:
#   - The nested shell reads your real user configuration, so it loads your
#     usual extensions next to this one: good, that is exactly the
#     compatibility situation we want to test.
#   - Enabling the extension writes to your real dconf. Harmless for the
#     running desktop: a Wayland session does not load newly installed
#     extensions until the next login anyway.
#   - AGENT_ISLAND_AUTOEXPAND=1 makes the island expand on its own after
#     1.5 s (there is no scripted way to click inside the nested shell).

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
UUID="agent-island@jmjm1558.github.io"

if [ ! -e "$HOME/.local/share/gnome-shell/extensions/$UUID" ]; then
    echo "extension not installed; run ./install.sh first" >&2
    exit 1
fi

# Size of the nested shell's fake monitor.
export MUTTER_DEBUG_DUMMY_MODE_SPECS="${MUTTER_DEBUG_DUMMY_MODE_SPECS:-1600x900}"

exec dbus-run-session -- bash -s "$UUID" "$@" <<'INNER'
UUID="$1"; shift
[ "${1:-}" = "--" ] && shift

gnome-shell --nested --wayland &
SHELL_PID=$!

# Wait until the Shell answers on this bus, then enable the extension.
for _ in $(seq 1 100); do
    if gnome-extensions enable "$UUID" 2>/dev/null; then
        echo "nested shell up, $UUID enabled"
        break
    fi
    sleep 0.2
done

if [ $# -gt 0 ]; then
    "$@" || echo "inner command exited with $?" >&2
fi

wait "$SHELL_PID"
INNER
