// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class CommandError extends Error {
    constructor(message, kind = 'command') { super(message); this.kind = kind; }
}

export class CommandRunner {
    constructor() { this._jobs = new Set(); this._disposed = false; }

    run(argv, timeoutMs = 10000) {
        if (this._disposed)
            return Promise.reject(new CommandError('Operation cancelled', 'cancelled'));
        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = new Gio.Subprocess({argv,
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE});
                proc.init(null);
            } catch (error) {
                const missing = error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ||
                    error.matches?.(GLib.SpawnError, GLib.SpawnError.NOENT);
                reject(new CommandError(error.message, missing ? 'missing' : 'command'));
                return;
            }
            const job = {proc, cancellable: new Gio.Cancellable(), timeout: 0, expired: false};
            this._jobs.add(job);
            job.timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                job.timeout = 0;
                job.expired = true;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            proc.communicate_utf8_async(null, job.cancellable, (source, result) => {
                if (job.timeout) GLib.Source.remove(job.timeout);
                this._jobs.delete(job);
                const rejectCancelled = () => source.wait_async(null, (child, waitResult) => {
                    try { child.wait_finish(waitResult); } catch { /* Process is already terminating. */ }
                    reject(new CommandError('Operation cancelled', 'cancelled'));
                });
                try {
                    const [, stdout, stderr] = source.communicate_utf8_finish(result);
                    if (this._disposed) { rejectCancelled(); return; }
                    if (job.expired) throw new CommandError('The client did not respond in time. Try again.', 'timeout');
                    resolve({ok: source.get_successful(), stdout: stdout ?? '', stderr: stderr ?? ''});
                } catch (error) {
                    if (this._disposed) rejectCancelled();
                    else reject(error);
                }
            });
        });
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        for (const job of this._jobs) {
            job.proc.force_exit();
            job.cancellable.cancel();
        }
    }
}

export const scheduler = {
    later(ms, callback) {
        return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { callback(); return GLib.SOURCE_REMOVE; });
    },
    cancel(id) { GLib.Source.remove(id); },
};
