import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TwingateClient} from '../client.js';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// Responds like the installed client: argv → {ok, stdout, stderr}.
function fakeRunner(responses = {}, calls = []) {
    return {calls, run: async (argv, timeout) => {
        calls.push(argv);
        const key = argv.join(' ');
        const response = typeof responses[key] === 'function' ? await responses[key](timeout) : responses[key];
        return {ok: true, stdout: '', stderr: '', ...response};
    }};
}

async function discovered(responses = {}) {
    const runner = fakeRunner({
        '/usr/bin/twingate -d --help': {stdout: fixture('cli-help.txt')},
        '/usr/bin/twingate-notifier --help': {stdout: fixture('notifier-help.txt')},
        ...responses,
    });
    const client = new TwingateClient(runner);
    await client.discover();
    runner.calls.length = 0;
    return {client, calls: runner.calls};
}

test('discovery reads both binaries and prefers the sudo-free notifier transport', async () => {
    const {client} = await discovered();
    assert.deepEqual(client.capabilities, {pause: true, resume: 'notifier', accounts: true, auth: true,
        exitNodes: true, signIn: true});
});

test('a missing notifier falls back to the CLI connect command', async () => {
    const runner = fakeRunner({'/usr/bin/twingate -d --help': {stdout: fixture('cli-help.txt')}});
    runner.run = (run => async argv => {
        if (argv[0] === '/usr/bin/twingate-notifier') { const e = new Error('missing'); e.kind = 'missing'; throw e; }
        return run(argv);
    })(runner.run);
    const client = new TwingateClient(runner);
    await client.discover();
    assert.equal(client.capabilities.resume, 'cli');
    runner.calls.length = 0;
    await client.action('resume');
    assert.deepEqual(runner.calls, [['/usr/bin/twingate', '-d', 'connect']]);
});

test('actions use argv as the desktop user, preserve arguments, and never invoke a shell, sudo, or pkexec', async () => {
    const {client, calls} = await discovered();
    await client.action('pause');
    await client.action('resume');
    await client.action('signIn');
    await client.action('authenticate', 'Wiki; echo private');
    await client.action('switchAccount', 'a@b.test:company');
    await client.action('exitSwitch', 'Tokyo');
    assert.deepEqual(calls, [
        ['/usr/bin/twingate', '-d', 'disconnect'],
        ['/usr/bin/twingate-notifier', 'sdwan-start'],
        ['/usr/bin/twingate', '-d', 'desktop-restart'],
        ['/usr/bin/twingate', '-d', 'auth', 'Wiki; echo private'],
        ['/usr/bin/twingate', '-d', 'account', 'switch', 'a@b.test:company'],
        ['/usr/bin/twingate', '-d', 'exit-node', 'switch', 'Tokyo'],
    ]);
    assert.equal(calls.flat().some(arg => /sudo|pkexec|^sh$|bash/.test(arg)), false);
    await assert.rejects(client.action('authenticate', '--help'), /safely/);
    await assert.rejects(client.action('exitSwitch', '-x'), /safely/);
    await assert.rejects(client.action('unrecognized'), /Unknown/);
});

test('notification authentication resolves the current resource and uses the working CLI path', async () => {
    const name = 'Office - NAS (private); echo ignored';
    const {client, calls} = await discovered({
        '/usr/bin/twingate -d resources': {stdout: `NAME\tADDRESS\tALIAS\n${name}\t192.0.2.10\tnas.example.test`},
    });
    await client.action('authenticateNotification', `${name} - nas.example.test(192.0.2.10)`);
    assert.deepEqual(calls, [
        ['/usr/bin/twingate', '-d', 'resources'],
        ['/usr/bin/twingate', '-d', 'auth', name],
    ]);
    calls.length = 0;
    await client.action('authenticateNotification', `${name} - 192.0.2.10`);
    assert.deepEqual(calls.at(-1), ['/usr/bin/twingate', '-d', 'auth', name]);
});

test('stale, changed-account, and ambiguous authentication notifications never start authentication', async () => {
    for (const [body, rows] of [
        ['Old NAS - nas.example.test(192.0.2.10)', 'New NAS\t192.0.2.10\tnas.example.test'],
        ['NAS - nas.example.test(192.0.2.10)', 'NAS\t192.0.2.11\tnas.example.test'],
        ['NAS - nas.example.test(192.0.2.10)', 'NAS\t192.0.2.10\tnas.example.test\nNAS\t192.0.2.11\tnas2.example.test'],
        ['NAS - nas.example.test(192.0.2.10); echo ignored', 'NAS\t192.0.2.10\tnas.example.test'],
    ]) {
        const {client, calls} = await discovered({'/usr/bin/twingate -d resources': {stdout: `NAME\tADDRESS\tALIAS\n${rows}`}});
        await assert.rejects(client.action('authenticateNotification', body), /unique available resource/);
        assert.deepEqual(calls, [['/usr/bin/twingate', '-d', 'resources']]);
    }
});

test('start only requests systemd authorization when the service is stopped', async () => {
    const {client, calls} = await discovered({'/usr/bin/systemctl is-active --quiet twingate.service': {ok: false},
        '/usr/bin/twingate -d status': {stdout: 'online\n'}});
    await client.action('start');
    assert.deepEqual(calls, [
        ['/usr/bin/systemctl', 'is-active', '--quiet', 'twingate.service'],
        ['/usr/bin/systemctl', 'start', 'twingate.service'],
        ['/usr/bin/twingate', '-d', 'start'],
        ['/usr/bin/twingate', '-d', 'status'],
    ]);
    const running = await discovered({'/usr/bin/twingate -d status': {stdout: 'online\n'}});
    await running.client.action('start');
    assert.deepEqual(running.calls, [
        ['/usr/bin/systemctl', 'is-active', '--quiet', 'twingate.service'],
        ['/usr/bin/twingate', '-d', 'start'],
        ['/usr/bin/twingate', '-d', 'status'],
    ]);
});

test('start reconnects a running daemon, because `twingate start` then only waits', async () => {
    // Observed with 2026.239.6882: paused daemon, `twingate start` exits 0 and stays "disconnected".
    const {client, calls} = await discovered({'/usr/bin/twingate -d status': {stdout: 'disconnected\n'}});
    await client.action('start');
    assert.deepEqual(calls.slice(-2), [
        ['/usr/bin/twingate', '-d', 'status'],
        ['/usr/bin/twingate-notifier', 'sdwan-start'],
    ]);
    const failed = await discovered({'/usr/bin/twingate -d status': {stdout: 'disconnected\n'},
        '/usr/bin/twingate-notifier sdwan-start': {ok: false, stderr: 'Connection refused'}});
    await assert.rejects(failed.client.action('start'), /Connection refused/);
});

test('service authorization failure does not fall back to the CLI sudo wrapper', async () => {
    const {client, calls} = await discovered({
        '/usr/bin/systemctl is-active --quiet twingate.service': {ok: false},
        '/usr/bin/systemctl start twingate.service': {ok: false, stderr: 'Access denied'},
    });
    await assert.rejects(client.action('start'), /Approve the system authentication prompt/);
    assert.deepEqual(calls.at(-1), ['/usr/bin/systemctl', 'start', 'twingate.service']);
});

test('startup waits for service authorization before starting the session client', async () => {
    let approve;
    const {client, calls} = await discovered({
        '/usr/bin/systemctl is-active --quiet twingate.service': {ok: false},
        '/usr/bin/systemctl start twingate.service': async timeout => {
            assert.equal(timeout, 120000);
            await new Promise(resolve => { approve = resolve; });
            return {};
        },
    });
    const action = client.action('start');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2);
    approve();
    await action;
    assert.deepEqual(calls[2], ['/usr/bin/twingate', '-d', 'start']);
});

test('stop uses systemd authorization, then stops the desktop notifier', async () => {
    const {client, calls} = await discovered();
    await client.action('stop');
    assert.deepEqual(calls, [
        ['/usr/bin/systemctl', 'stop', 'twingate.service'],
        ['/usr/bin/twingate', '-d', 'desktop-stop'],
    ]);
});

test('resume failure surfaces the transport error', async () => {
    const {client} = await discovered({'/usr/bin/twingate-notifier sdwan-start': {ok: false, stderr: 'Connection refused'}});
    await assert.rejects(client.action('resume'), /Connection refused/);
});

test('empty lists exit nonzero with a sentence and are not reported as failures', async () => {
    const {client} = await discovered({
        '/usr/bin/twingate -d exit-node list': {ok: false, stdout: fixture('exit-nodes-empty.txt')},
        '/usr/bin/twingate -d resources': {ok: false, stdout: fixture('resources-empty.txt')},
    });
    assert.deepEqual(await client.exitNodes(), []);
    assert.deepEqual(await client.resources(), []);
});

test('real client tables parse into resources and accounts', async () => {
    const {client} = await discovered({
        '/usr/bin/twingate -d resources': {stdout: fixture('resources.txt')},
        '/usr/bin/twingate -d account list': {stdout: fixture('accounts.txt')},
    });
    const [resource] = await client.resources();
    assert.deepEqual({name: resource.name, address: resource.address, alias: resource.alias, authorization: resource.authorization},
        {name: 'Example NAS', address: '192.0.2.10', alias: 'nas.example.test', authorization: 'Pending'});
    const [account] = await client.accounts();
    assert.deepEqual({email: account.email, network: account.network, id: account.id},
        {email: 'user@example.test', network: 'example', id: 'user@example.test:example'});
});

test('command failure is visible, while offline status with nonzero exit is recognized', async () => {
    const client = new TwingateClient({run: async () => ({ok: false, stdout: 'not-running', stderr: ''})});
    assert.equal(await client.status(), 'not-running');
    await assert.rejects(client.resources(), /not-running/);
    const disconnected = new TwingateClient({run: async () => ({ok: false, stdout: 'Twingate must be connected to display available resources.\n'})});
    await assert.rejects(disconnected.resources(), /must be connected/);
});

test('ICMP uses a bounded argv-based probe and never probes a subnet or wildcard', async () => {
    const calls = [];
    const client = new TwingateClient({run: async (...args) => { calls.push(args); return {ok: false}; }});
    assert.equal(await client.probe('*.example.test'), 'unsupported');
    assert.equal(calls.length, 0);
    assert.equal(await client.probe('host.test'), 'no-reply');
    assert.deepEqual(calls[0], [['ping', '-n', '-c', '1', '-W', '2', '--', 'host.test'], 4000]);
});
