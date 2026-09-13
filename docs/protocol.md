# State file protocol

Agent Island reads process-verified sessions in `$XDG_RUNTIME_DIR/agent-island/`.
Anything that can write a JSON file can appear in the island: an agent CLI,
a CI watcher, a long-running script. This document is the whole contract.

## Location and naming

```
$XDG_RUNTIME_DIR/agent-island/<agent>-<session-id>.json
```

- One file per live session. The file describes a session with a live process: create it to appear,
  rewrite it to change state, delete it to disappear.
- `$XDG_RUNTIME_DIR` (usually `/run/user/<uid>`) is a tmpfs: per-user
  permissions, RAM-backed, wiped on logout. Do not use `/tmp`.
- Files starting with a dot are ignored; write to a dot-file first, then
  `mv` it into place so the extension never reads a half-written JSON.

## Format

```json
{
  "agent": "claude-code",
  "state": "working",
  "session_id": "session-uuid",
  "agent_pid": 1234,
  "agent_started": "987654",
  "cwd": "/home/me/some-project",
  "title": "",
  "task": "Refactor the session adapter",
  "term_pid": 4242,
  "tmux_socket": "/tmp/tmux-1000/default",
  "tmux_target": "aoe_Project:0.0",
  "tmux_client_tty": "/dev/pts/7",
  "ts": 1752350000
}
```

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `agent` | string | yes | Agent identifier, kebab-case (`claude-code`, `codex`). Shown in the card; unknown agents get a generic avatar. |
| `state` | string | yes | `working`, `waiting` (needs the human) or `idle`. Anything else is treated as `idle`. |
| `session_id` | string | yes | Stable task ID, also used to merge duplicate Codex Desktop tasks. |
| `agent_pid` | number | yes | Live agent process PID. Files without process identity are hidden. |
| `agent_started` | string | recommended | Field 22 of `/proc/<pid>/stat`, to detect PID reuse. The reference hook always supplies it. |
| `cwd` | string | no | Session working directory. Its basename becomes the row title. |
| `title` | string | no | Session title, used when `task` is empty. |
| `task` | string | no | Short description of the current work. Preferred as the row title. |
| `term_pid` | number | no | PID that owns the terminal window, when the adapter can discover one. |
| `tmux_socket` | string | no | Absolute path to the tmux server socket. |
| `tmux_target` | string | no | Exact tmux target as `<session>:<window>.<pane>`. |
| `tmux_client_tty` | string | no | TTY of an attached tmux client. Empty when the session is detached. |
| `ts` | number | no | Unix epoch seconds of the last state change. Idle sessions disappear after 30 minutes; process-verified working/waiting sessions remain. SessionStart renews visibility when context is loaded. Defaults to "now" when missing. |

The jump fields are optional and backward compatible. On click, the extension
selects the exact tmux pane and switches its attached client when possible. A
detached tmux session opens in a new terminal. Direct sessions use
`term_pid`; older producers fall back to matching the `cwd` basename in the
window title.

## Reference implementation

[hooks/agent-island-hook.sh](../hooks/agent-island-hook.sh) is the complete
adapter used for both Claude Code and Codex (they share the same lifecycle
hook schema). It derives jump metadata from the local process tree and tmux
environment, then applies this state mapping:

| Hook event | State |
|------------|-------|
| `SessionStart` | `idle` |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | `working` |
| `PermissionRequest` | `waiting` |
| `Notification` (`permission_prompt`, `idle_prompt`, `agent_needs_input`, `elicitation_dialog`) | `waiting` |
| `Stop`, `StopFailure` | `idle` |
| `SessionEnd` | file deleted |

Design rules for adapters: always exit 0 (a status pill must never block an
agent), stay fast (a few ms), write atomically (`mktemp` + `mv`).
