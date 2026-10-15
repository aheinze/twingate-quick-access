// Tests real Gio.Subprocess and GLib lifecycle; never invokes the Twingate client.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
import {CommandRunner} from '../runner.js';

function assert(condition, message) { if (!condition) throw new Error(message); }
const loop = GLib.MainLoop.new(null, false);
let failures = 0;
async function main() {
    const runner = new CommandRunner();
    const ok = await runner.run(['/usr/bin/printf', '%s', 'literal; $HOME']);
    assert(ok.ok && ok.stdout === 'literal; $HOME', 'argv must remain literal');
    print('PASS: real subprocess stdout and argv');
    const failed = await runner.run(['/bin/sh', '-c', 'printf denied >&2; exit 4']);
    assert(!failed.ok && failed.stderr === 'denied', 'exit code and stderr must be preserved');
    print('PASS: real subprocess failure');
    let timeout = false;
    try { await runner.run(['/usr/bin/sleep', '10'], 40); }
    catch (error) { timeout = error.kind === 'timeout'; }
    assert(timeout, 'timeout should stop and reap the child');
    assert(runner._jobs.size === 0, 'timed-out job remains registered');
    print('PASS: timeout and job cleanup');
    let missing = false;
    try { await runner.run(['/not/a/real/program']); }
    catch (error) { missing = error.kind === 'missing'; }
    assert(missing, 'missing executable must have its own error category');
    print('PASS: missing executable');
    const pending = runner.run(['/usr/bin/sleep', '10']);
    const pid = [...runner._jobs][0].proc.get_identifier();
    runner.dispose();
    let cancelled = false;
    try { await pending; } catch (error) { cancelled = error.kind === 'cancelled'; }
    assert(cancelled && runner._jobs.size === 0, 'dispose should cancel and remove all jobs');
    assert(!Gio.File.new_for_path(`/proc/${pid}`).query_exists(null), 'disposed child remains running');
    print('PASS: cancellation terminates and reaps the child');
    try { await runner.run(['/usr/bin/true']); throw new Error('disposed runner accepted a job'); }
    catch (error) { assert(error.kind === 'cancelled', 'disposed runner must reject'); }
    print('PASS: disposed runner rejects new work');
}
main().catch(error => { printerr(error.stack); failures++; }).finally(() => loop.quit());
loop.run();
System.exit(failures ? 1 : 0);
