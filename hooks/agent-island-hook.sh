#!/usr/bin/env bash
# Agent Island - shared lifecycle-hook adapter for Claude Code and Codex.
#
# Both CLIs run this script on session events and pipe a JSON payload on
# stdin (they use the same schema: hook_event_name, session_id, cwd, ...).
# We translate the event into a tiny state file that the GNOME extension
# watches:   $XDG_RUNTIME_DIR/agent-island/<agent>-<session id>.json
#
# Usage (registered by install.sh):  agent-island-hook.sh <agent-name>
#   where <agent-name> is "claude-code" or "codex".
#
# Design rules:
#   - Never break the agent: exit 0 no matter what happened here. A nonzero
#     exit from some hooks (PreToolUse, PermissionRequest) can block the
#     agent's action, and a status pill is never worth that.
#   - Never block: everything below is a few milliseconds of jq.
#   - Writes are atomic: write to a dot-file, then rename. The extension
#     therefore never sees a half-written JSON.

agent="${1:-unknown}"
dir="${XDG_RUNTIME_DIR:-/tmp}/agent-island"

main() {
    command -v jq >/dev/null 2>&1 || return 0

    input=$(cat) || return 0
    event=$(jq -r '.hook_event_name // empty' <<<"$input" 2>/dev/null)
    session_id=$(jq -r '.session_id // empty' <<<"$input" 2>/dev/null)
    [ -n "$event" ] && [ -n "$session_id" ] || return 0

    file="$dir/${agent}-${session_id}.json"

    # Event -> island state. Anything not listed is ignored on purpose.
    case "$event" in
        SessionEnd)
            rm -f "$file"
            return 0
            ;;
        UserPromptSubmit|PreToolUse|PostToolUse)
            state="working"
            ;;
        PermissionRequest)
            state="waiting"
            ;;
        Notification)
            # Claude Code only. Just the "the human is needed" kinds.
            case "$(jq -r '.notification_type // empty' <<<"$input" 2>/dev/null)" in
                permission_prompt|idle_prompt|agent_needs_input|elicitation_dialog)
                    state="waiting" ;;
                *)
                    return 0 ;;
            esac
            ;;
        SessionStart|Stop|StopFailure)
            state="idle"
            ;;
        *)
            return 0
            ;;
    esac

    mkdir -p "$dir" || return 0
    cwd=$(jq -r '.cwd // empty' <<<"$input")

    tmp=$(mktemp "$dir/.${agent}-${session_id}.XXXXXX") || return 0
    jq -n \
        --arg agent "$agent" \
        --arg state "$state" \
        --arg cwd "$cwd" \
        --argjson ts "$(date +%s)" \
        '{agent: $agent, state: $state, cwd: $cwd, ts: $ts}' >"$tmp" &&
        mv -f "$tmp" "$file"
    rm -f "$tmp" 2>/dev/null
    return 0
}

main "$@" || true
exit 0
