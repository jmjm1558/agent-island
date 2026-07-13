# State file protocol

Agent Island renders whatever it finds in `$XDG_RUNTIME_DIR/agent-island/`.
Anything that can write a JSON file can appear in the island: an agent CLI,
a CI watcher, a long-running script. This document is the whole contract.

## Location and naming

```
$XDG_RUNTIME_DIR/agent-island/<agent>-<session-id>.json
```

- One file per live session. The file IS the session: create it to appear,
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
  "cwd": "/home/me/some-project",
  "title": "",
  "ts": 1752350000
}
```

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `agent` | string | yes | Agent identifier, kebab-case (`claude-code`, `codex`). Shown in the card; unknown agents get a generic avatar. |
| `state` | string | yes | `working`, `waiting` (needs the human) or `idle`. Anything else is treated as `idle`. |
| `cwd` | string | no | Session working directory. Its basename becomes the row title. |
| `title` | string | no | Overrides the row title if set. |
| `ts` | number | no | Unix epoch seconds of the last state change. Sessions older than 6 hours are hidden (crash protection). Defaults to "now" when missing. |

## Reference implementation

[hooks/agent-island-hook.sh](../hooks/agent-island-hook.sh) is the complete
adapter used for both Claude Code and Codex (they share the same lifecycle
hook schema). The mapping it applies:

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
