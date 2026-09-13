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
runtime_dir="${XDG_RUNTIME_DIR:-}"
dir="${runtime_dir:+$runtime_dir/agent-island}"

terminal_pid_from() {
    local pid="${1:-}" comm

    while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
        comm=$(cat "/proc/$pid/comm" 2>/dev/null) || return 0
        case "$comm" in
            gnome-terminal-*|kgx|ptyxis|kitty|alacritty|wezterm-gui|foot|konsole|xterm)
                printf '%s\n' "$pid"
                return 0
                ;;
        esac
        pid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null) || return 0
    done
}

capture_jump_target() {
    term_pid=""
    tmux_socket=""
    tmux_target=""
    tmux_client_tty=""

    if [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ]; then
        tmux_socket="${TMUX%,*,*}"
        tmux_target=$(tmux -S "$tmux_socket" display-message \
            -p -t "$TMUX_PANE" \
            '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null) ||
            tmux_target=""

        local tmux_session client_tty client_pid client_session
        tmux_session="${tmux_target%%:*}"
        while IFS='|' read -r client_tty client_pid client_session; do
            [ "$client_session" = "$tmux_session" ] || continue
            tmux_client_tty="$client_tty"
            term_pid=$(terminal_pid_from "$client_pid")
            break
        done < <(tmux -S "$tmux_socket" list-clients \
            -F '#{client_tty}|#{client_pid}|#{session_name}' 2>/dev/null)
        return 0
    fi

    term_pid=$(terminal_pid_from "$PPID")
}

main() {
    [ -n "$runtime_dir" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0

    input=$(cat) || return 0
    event=$(jq -r '.hook_event_name // empty' <<<"$input" 2>/dev/null)
    session_id=$(jq -r '.session_id // empty' <<<"$input" 2>/dev/null)
    [ -n "$event" ] && [ -n "$session_id" ] || return 0

    file="$dir/${agent}-${session_id}.json"

    # Title and task survive across events: read what we stored before.
    title=$(jq -r '.title // empty' "$file" 2>/dev/null)
    task=$(jq -r '.task // empty' "$file" 2>/dev/null)

    # Event -> island state. Anything not listed is ignored on purpose.
    case "$event" in
        SessionEnd)
            rm -f "$file"
            return 0
            ;;
        UserPromptSubmit)
            state="working"
            # The prompt is the best one-line answer to "what is this
            # session doing?" - keep the first 100 chars.
            new_task=$(jq -r '.prompt // empty' <<<"$input" 2>/dev/null |
                tr '\n' ' ' | cut -c1-100)
            [ -n "$new_task" ] && task="$new_task"
            ;;
        PreToolUse|PostToolUse)
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
        SessionStart)
            state="idle"
            new_title=$(jq -r '.session_title // empty' <<<"$input" 2>/dev/null)
            [ -n "$new_title" ] && title="$new_title"
            ;;
        Stop|StopFailure)
            state="idle"
            ;;
        *)
            return 0
            ;;
    esac

    mkdir -p "$dir" || return 0
    cwd=$(jq -r '.cwd // empty' <<<"$input")
    capture_jump_target
    agent_pid=""
    agent_started=""
    local ancestor="$PPID" process_name
    while [ "$ancestor" -gt 1 ] 2>/dev/null; do
        process_name=$(cat "/proc/$ancestor/comm" 2>/dev/null) || break
        case "$process_name" in
            codex|claude|claude-code)
                agent_pid="$ancestor"
                agent_started=$(awk '{print $22}' "/proc/$ancestor/stat" 2>/dev/null)
                break ;;
        esac
        ancestor=$(awk '{print $4}' "/proc/$ancestor/stat" 2>/dev/null) || break
    done

    tmp=$(mktemp "$dir/.${agent}-${session_id}.XXXXXX") || return 0
    jq -n \
        --arg session_id "$session_id" \
        --argjson agent_pid "${agent_pid:-null}" \
        --arg agent_started "$agent_started" \
        --arg agent "$agent" \
        --arg state "$state" \
        --arg cwd "$cwd" \
        --arg title "$title" \
        --arg task "$task" \
        --argjson term_pid "${term_pid:-null}" \
        --arg tmux_socket "$tmux_socket" \
        --arg tmux_target "$tmux_target" \
        --arg tmux_client_tty "$tmux_client_tty" \
        --argjson ts "$(date +%s)" \
        '{session_id: $session_id, agent_pid: $agent_pid, agent_started: $agent_started, agent: $agent, state: $state, cwd: $cwd, title: $title,
          task: $task, term_pid: $term_pid, tmux_socket: $tmux_socket,
          tmux_target: $tmux_target, tmux_client_tty: $tmux_client_tty,
          ts: $ts}' >"$tmp" &&
        mv -f "$tmp" "$file"
    rm -f "$tmp" 2>/dev/null
    return 0
}

main "$@" || true
exit 0
