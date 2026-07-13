// SessionStore - the data side of Agent Island.
//
// Agents (Claude Code, Codex, ...) report their state through tiny JSON
// files, one per session, in $XDG_RUNTIME_DIR/agent-island/. The files are
// written by lifecycle hooks (see hooks/ in the repo), so state changes are
// pushed to us: we watch the directory with a Gio.FileMonitor (inotify
// underneath) and never poll.
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

// A session whose file has not been touched in this long is treated as dead
// (e.g. the agent was killed and its SessionEnd hook never ran).
const STALE_AFTER_SECONDS = 6 * 60 * 60;

Gio._promisify(Gio.File.prototype, 'load_contents_async');

export class SessionStore extends Signals.EventEmitter {
    constructor() {
        super();

        // basename of the state file -> parsed session object
        this._sessions = new Map();

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

        this._loadExisting();
    }

    // Sessions currently worth showing, newest activity first.
    get sessions() {
        const now = GLib.get_real_time() / 1e6;
        return [...this._sessions.values()]
            .filter(s => now - s.ts < STALE_AFTER_SECONDS)
            .sort((a, b) => b.ts - a.ts);
    }

    destroy() {
        this._monitor?.cancel();
        this._monitor = null;
        this._sessions.clear();
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
            this._sessions.set(key, this._sanitize(parsed));
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

    _sanitize(raw) {
        return {
            agent: typeof raw.agent === 'string' ? raw.agent : 'unknown',
            state: VALID_STATES.includes(raw.state) ? raw.state : 'idle',
            cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
            title: typeof raw.title === 'string' ? raw.title : '',
            ts: Number.isFinite(raw.ts) ? raw.ts : GLib.get_real_time() / 1e6,
        };
    }
}
