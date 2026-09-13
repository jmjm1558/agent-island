import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Audio processing stays outside the Shell; only twelve levels cross this pipe.
export class Spectrum {
    constructor(extensionPath, onLevels) {
        this.path = GLib.build_filenamev([extensionPath, 'audio_spectrum.py']);
        this.onLevels = onLevels;
        this.levels = Array(12).fill(0);
        this.active = false;
        this.process = null;
        this.cancel = null;
        this.retryId = 0;
    }

    setActive(active) {
        if (active === this.active)
            return;
        this.active = active;
        if (!active) {
            if (this.retryId)
                GLib.source_remove(this.retryId);
            this.retryId = 0;
            this.cancel?.cancel();
            this.process?.force_exit();
            this.process = null;
            this.levels.fill(0);
            return;
        }
        try {
            this.cancel = new Gio.Cancellable();
            const cancel = this.cancel;
            this.process = Gio.Subprocess.new(['/usr/bin/python3', this.path],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const input = new Gio.DataInputStream({base_stream: this.process.get_stdout_pipe()});
            const read = () => input.read_line_async(GLib.PRIORITY_DEFAULT, cancel, (stream, result) => {
                try {
                    const [bytes] = stream.read_line_finish(result);
                    if (cancel.is_cancelled())
                        return;
                    if (!bytes) {
                        this.levels.fill(0);
                        this.onLevels(this.levels);
                        this._retry();
                        return;
                    }
                    const values = JSON.parse(new TextDecoder().decode(bytes));
                    if (Array.isArray(values) && values.length === 12 && values.every(Number.isFinite)) {
                        this.levels = values.map((value, i) => {
                            const target = Math.max(0, Math.min(1, value));
                            return this.levels[i] + (target - this.levels[i]) * (target > this.levels[i] ? 0.75 : 0.18);
                        });
                        this.onLevels(this.levels);
                    }
                    read();
                } catch {
                    // Unavailable playback monitor leaves a quiet, honest spectrum.
                }
            });
            read();
        } catch {
            this.process = null;
            this._retry();
        }
    }

    _retry() {
        if (!this.active || this.retryId)
            return;
        this.retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this.retryId = 0;
            this.active = false;
            this.setActive(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this.setActive(false);
    }
}
