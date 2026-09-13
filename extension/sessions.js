// SessionStore - the data side of Agent Island.
//
// Agents (Claude Code, Codex, ...) report their state through tiny JSON
// files, one per session, in $XDG_RUNTIME_DIR/agent-island/. The files are
// written by lifecycle hooks (see hooks/ in the repo), so state changes are
// pushed to us: we watch the directory with a Gio.FileMonitor (inotify
// underneath). A 15-second liveness check removes exited processes.
//
// A state file looks like:
//   { "agent": "claude-code", "state": "working",
//     "cwd": "/home/me/project", "ts": 1752350000 }
//
// The directory lives in $XDG_RUNTIME_DIR (a tmpfs) on purpose: it is
// per-user, memory-backed and wiped on logout, so stale sessions do not
// survive a reboot.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

export const STATE_DIR =
    GLib.build_filenamev([GLib.get_user_runtime_dir(), 'agent-island']);

const VALID_STATES = ['working', 'waiting', 'idle'];

// Keep recently used contexts; verified work and requests for input stay visible.
const IDLE_STALE_AFTER_SECONDS = 30 * 60;

Gio._promisify(Gio.File.prototype, 'load_contents_async');

export class SessionStore extends Signals.EventEmitter {
    constructor(extensionPath) {
        super();

        // basename of the state file -> parsed session object
        this._sessions = new Map();
        this._desktopSessions = [];
        this._bridgeCancelled = new Gio.Cancellable();
        this._bridge = null;

        this._dir = Gio.File.new_for_path(STATE_DIR);
        try {
            this._dir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }

        // WATCH_MOVES so the atomic "write tmp file, then rename" done by
        // the hooks shows up as a single MOVED_IN/RENAMED event.
        this._monitor = this._dir.monitor_directory(
            Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitor.connect('changed', (_monitor, file, otherFile) => {
            // For RENAMED events `file` is the old name and `otherFile` the
            // new one; refreshing both covers every event type we care about.
            this._refresh(file);
            if (otherFile)
                this._refresh(otherFile);
        });

        this._reapId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
            for (const [key, session] of this._sessions) {
                if (!this._isLiveTerminal(session)) {
                    this._sessions.delete(key);
                    this.emit('changed');
                }
            }
            const signature = this.sessions.map(s => s.sessionId).join('|');
            if (signature !== this._visibleSignature) {
                this._visibleSignature = signature;
                this.emit('changed');
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._loadExisting();
        if (extensionPath)
            this._startDesktopBridge(extensionPath);
    }

    // Sessions currently worth showing, newest activity first.
    get sessions() {
        const now = GLib.get_real_time() / 1e6;
        const desktopIds = new Set(this._desktopSessions.map(s => s.sessionId));
        const terminals = [...this._sessions.values()].filter(s =>
            !desktopIds.has(s.sessionId) && this._isLiveTerminal(s));
        return [...terminals, ...this._desktopSessions]
            .filter(s => s.state !== 'idle' || now - s.ts < IDLE_STALE_AFTER_SECONDS)
            .sort((a, b) => (b.state !== 'idle') - (a.state !== 'idle') || b.ts - a.ts);
    }

    destroy() {
        GLib.source_remove(this._reapId);
        this._monitor?.cancel();
        this._monitor = null;
        this._sessions.clear();
        this._bridgeCancelled.cancel();
        this._bridge?.force_exit();
        this._bridge = null;
        this._desktopSessions = [];
    }

    _startDesktopBridge(extensionPath) {
        const python = '/usr/bin/python3';
        if (!GLib.file_test(python, GLib.FileTest.IS_EXECUTABLE))
            return;
        const home = GLib.getenv('AGENT_ISLAND_CODEX_HOME') || GLib.getenv('CODEX_HOME') ||
            GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
        try {
            this._bridge = Gio.Subprocess.new([python,
                GLib.build_filenamev([extensionPath, 'codex_bridge.py']), '--home', home],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const input = new Gio.DataInputStream({base_stream: this._bridge.get_stdout_pipe()});
            const read = () => input.read_line_async(GLib.PRIORITY_DEFAULT, this._bridgeCancelled, (stream, result) => {
                try {
                    const [line] = stream.read_line_finish(result);
                    if (!line) {
                        this._desktopSessions = [];
                        if (this._monitor)
                            this.emit('changed');
                        return;
                    }
                    const sessions = JSON.parse(new TextDecoder().decode(line));
                    if (Array.isArray(sessions)) {
                        this._desktopSessions = sessions.filter(s =>
                            s.agent === 'codex-desktop' && typeof s.title === 'string' &&
                            typeof s.cwd === 'string' && /^[0-9a-f-]{36}$/i.test(s.sessionId) &&
                            VALID_STATES.includes(s.state) && Number.isFinite(s.ts));
                        if (this._monitor)
                            this.emit('changed');
                    }
                    if (this._monitor)
                        read();
                } catch (error) {
                    if (!this._bridgeCancelled.is_cancelled())
                        console.warn(`Agent Island: desktop reader stopped: ${error.message}`);
                }
            });
            read();
        } catch (error) {
            console.warn(`Agent Island: desktop reader unavailable: ${error.message}`);
        }
    }

    _isLiveTerminal(session) {
        if (session.agentPid) {
            try {
                const [, bytes] = GLib.file_get_contents(`/proc/${session.agentPid}/stat`);
                const stat = new TextDecoder().decode(bytes);
                const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
                return !session.agentStarted || fields[19] === session.agentStarted;
            } catch {
                return false;
            }
        }
        // Legacy hooks with no process identity cannot claim live activity.
        return false;
    }

    _isStateFile(file) {
        const name = file.get_basename();
        return name.endsWith('.json') && !name.startsWith('.');
    }

    async _loadExisting() {
        try {
            const enumerator = this._dir.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null)
                this._refresh(this._dir.get_child(info.get_name()));
            enumerator.close(null);
        } catch (e) {
            console.warn(`Agent Island: cannot list ${STATE_DIR}: ${e.message}`);
        }
    }

    // (Re)read one state file and update the session map. Called for every
    // monitor event; the file may or may not still exist, both are fine.
    async _refresh(file) {
        if (!this._isStateFile(file))
            return;

        const key = file.get_basename();
        try {
            const [contents] = await file.load_contents_async(null);
            const parsed = JSON.parse(new TextDecoder().decode(contents));
            this._sessions.set(key, this._sanitize(parsed, key));
        } catch {
            // Unreadable or gone (deleted by a SessionEnd hook): drop it.
            // Half-written files cannot happen because hooks rename in place.
            this._sessions.delete(key);
        }

        // The monitor might already be cancelled if disable() raced with an
        // in-flight read; do not emit into a destroyed extension.
        if (this._monitor)
            this.emit('changed');
    }

    _sanitize(raw, filename) {
        return {
            agent: typeof raw.agent === 'string' ? raw.agent : 'unknown',
            sessionId: raw.session_id || filename.replace(/^[^-]+-/, '').replace(/\.json$/, ''),
            agentPid: Number.isSafeInteger(raw.agent_pid) && raw.agent_pid > 1 ? raw.agent_pid : null,
            agentStarted: typeof raw.agent_started === 'string' ? raw.agent_started : '',
            state: VALID_STATES.includes(raw.state) ? raw.state : 'idle',
            cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
            title: typeof raw.title === 'string' ? raw.title : '',
            task: typeof raw.task === 'string' ? raw.task : '',
            termPid: Number.isSafeInteger(raw.term_pid) && raw.term_pid > 1
                ? raw.term_pid : null,
            tmuxSocket: typeof raw.tmux_socket === 'string'
                ? raw.tmux_socket : '',
            tmuxTarget: typeof raw.tmux_target === 'string'
                ? raw.tmux_target : '',
            tmuxClientTty: typeof raw.tmux_client_tty === 'string'
                ? raw.tmux_client_tty : '',
            ts: Number.isFinite(raw.ts) ? raw.ts : GLib.get_real_time() / 1e6,
        };
    }
}
