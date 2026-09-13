#!/usr/bin/env bash
# Agent Island installer.
#
#   ./install.sh            link the extension into GNOME's user directory
#   ./install.sh --claude   also register the Claude Code hooks
#   ./install.sh --codex    also register the Codex hooks
#
# Everything is idempotent: run it as many times as you want.
# Nothing here needs sudo - it only touches files in your home.

set -eu

REPO="$(cd "$(dirname "$0")" && pwd)"
UUID="agent-island@jmjm1558.github.io"
EXT_LINK="$HOME/.local/share/gnome-shell/extensions/$UUID"
HOOK="$REPO/hooks/agent-island-hook.sh"

glib-compile-schemas "$REPO/extension/schemas"

# ---- 1. the extension itself -------------------------------------------
# A symlink instead of a copy, so a `git pull` updates the installed
# extension too (after the next login).
mkdir -p "$(dirname "$EXT_LINK")"
ln -sfnT "$REPO/extension" "$EXT_LINK"
echo "extension linked: $EXT_LINK"

if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "extension enabled: $UUID"
else
    echo "extension will need enabling after login: gnome-extensions enable $UUID"
fi
echo "NOTE: on Wayland a newly installed extension only loads after you log out and back in."

# ---- 2. optional hook registration --------------------------------------
# merge_hooks <snippet file> <target settings file>
# Copies the hook entries from the snippet into the target JSON, replacing
# the __HOOK__ placeholder with the real script path. Events that already
# contain an agent-island hook are left untouched, so re-running is safe.
merge_hooks() {
    local snippet="$1" target="$2"
    mkdir -p "$(dirname "$target")"
    [ -f "$target" ] || echo '{}' >"$target"
    cp "$target" "$target.bak"

    python3 - "$snippet" "$target" "$HOOK" <<'PY'
import json, sys

snippet_path, target_path, hook_path = sys.argv[1:4]

with open(snippet_path) as f:
    snippet = json.load(f)["hooks"]
with open(target_path) as f:
    target = json.load(f)

hooks = target.setdefault("hooks", {})
added, skipped = [], []

for event, groups in snippet.items():
    existing = json.dumps(hooks.get(event, []))
    if "agent-island-hook.sh" in existing:
        skipped.append(event)
        continue
    for group in groups:
        for handler in group["hooks"]:
            handler["command"] = handler["command"].replace("__HOOK__", hook_path)
    hooks.setdefault(event, []).extend(groups)
    added.append(event)

with open(target_path, "w") as f:
    json.dump(target, f, indent=2)
    f.write("\n")

print(f"  added: {', '.join(added) if added else 'nothing'}")
if skipped:
    print(f"  already registered: {', '.join(skipped)}")
PY
    echo "  (backup at $target.bak)"
}

for arg in "$@"; do
    case "$arg" in
        --claude)
            echo "registering Claude Code hooks in ~/.claude/settings.json"
            merge_hooks "$REPO/hooks/claude-code.hooks.json" "$HOME/.claude/settings.json"
            ;;
        --codex)
            echo "registering Codex hooks in ~/.codex/hooks.json"
            merge_hooks "$REPO/hooks/codex.hooks.json" "$HOME/.codex/hooks.json"
            echo "  Codex trusts hooks explicitly: run /hooks inside codex once to approve them."
            ;;
        *)
            echo "unknown option: $arg (valid: --claude --codex)" >&2
            exit 1
            ;;
    esac
done
