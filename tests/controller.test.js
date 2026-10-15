import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../controller.js';

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return {promise, resolve};
}
const CAPABILITIES = {pause: true, resume: 'notifier', accounts: true, auth: true, exitNodes: true, signIn: true};

// `details` mirrors an open menu, where resources and routing are read.
function fixture(overrides = {}, {details = true, capabilities = CAPABILITIES} = {}) {
    const events = [], timers = new Map(), reads = {resources: 0, accounts: 0, exitNodes: 0};
    let id = 0;
    const scheduler = {later: (delay, callback) => {
        const timer = ++id;
        timers.set(timer, {delay, callback});
        // Settling checks are short and run at once; poll timers stay pending for inspection.
        if (delay < 1000) setImmediate(() => { if (timers.delete(timer)) callback(); });
        return timer;
    }, cancel: n => timers.delete(n)};
    const client = {
        discover: async () => ({version: 'Test client', capabilities}),
        status: async () => 'online',
        resources: async () => { reads.resources++; return [{id: 'a', name: 'A', address: 'a.test'}]; },
        accounts: async () => { reads.accounts++; return []; },
        exitNodes: async () => { reads.exitNodes++; return []; },
        action: async () => {}, dispose() {}, ...overrides,
    };
    const controller = new Controller(client, scheduler, state => events.push(state));
    if (details) controller.setPolling(5, true);
    return {controller, client, events, timers, reads};
}

test('refresh is single-flight and schedules exactly one background poll', async () => {
    const status = deferred();
    const {controller, timers} = fixture({status: () => status.promise}, {details: false});
    const first = controller.refresh();
    assert.equal(controller.refresh(), first);
    status.resolve('online');
    await first;
    // A changed status is confirmed soon; an unchanged one waits for the background interval.
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].delay, 2000);
    await controller.refresh();
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].delay, 30000);
    controller.setPolling(3, true);
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].delay, 3000);
    controller.dispose();
    assert.equal(timers.size, 0);
});

test('a delayed old-account response cannot repopulate resources during account switching', async () => {
    const resources = deferred();
    let reads = 0;
    const {controller, events} = fixture({resources: () => ++reads === 1 ? resources.promise : Promise.resolve([{id: 'new'}])});
    const refresh = controller.refresh();
    await new Promise(r => setImmediate(r));
    const switchIndex = events.length;
    const action = controller.act('switchAccount', 'new@example.test:other');
    resources.resolve([{id: 'old-private-resource'}]);
    await Promise.all([refresh, action]);
    assert.deepEqual(controller.state.resources, [{id: 'new'}]);
    assert.equal(events.slice(switchIndex).some(s => s.resources.some(r => r.id === 'old-private-resource')), false);
    controller.dispose();
});

test('resource failures are distinguishable from an empty successful response', async () => {
    const {controller} = fixture({resources: async () => { throw new Error('Access denied'); }});
    await controller.refresh();
    assert.equal(controller.state.status, 'online');
    assert.equal(controller.state.resourceError, 'Access denied');
    assert.deepEqual(controller.state.resources, []);
    controller.dispose();
});

test('account names and resources from the same refresh are published together', async () => {
    const accounts = deferred();
    const {controller, events} = fixture({accounts: () => accounts.promise});
    const refresh = controller.refresh();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.some(state => state.resources.length > 0), false);
    accounts.resolve([{network: 'example', email: 'user@example.test'}]);
    await refresh;
    assert.equal(controller.state.accounts.length, 1);
    assert.equal(controller.state.resources.length, 1);
    controller.dispose();
});

test('status failure clears previously displayed resources and routing', async () => {
    const {controller, client} = fixture();
    await controller.refresh();
    assert.equal(controller.state.resources.length, 1);
    client.status = async () => { throw new Error('Unavailable'); };
    await controller.refresh();
    assert.equal(controller.state.status, 'error');
    assert.deepEqual(controller.state.resources, []);
    controller.dispose();
});

test('action failure persists through polling until an explicit retry', async () => {
    const {controller} = fixture({action: async () => { throw new Error('Authorization cancelled'); }});
    await controller.refresh();
    assert.equal(await controller.act('pause'), false);
    await controller.refresh();
    assert.equal(controller.state.actionError, 'Authorization cancelled');
    await controller.retry();
    assert.equal(controller.state.actionError, '');
    controller.dispose();
});

test('busy action rejects double clicks and chooses token-preserving pause/resume', async () => {
    const gate = deferred(), calls = [];
    const {controller, client} = fixture({action: async name => { calls.push(name); await gate.promise; }});
    await controller.refresh();
    const action = controller.primaryAction();
    assert.equal(await controller.primaryAction(), false);
    gate.resolve();
    await action;
    assert.deepEqual(calls, ['pause']);
    client.status = async () => 'paused';
    await controller.refresh();
    await controller.primaryAction();
    assert.deepEqual(calls, ['pause', 'resume']);
    controller.dispose();
});

test('disable prevents callbacks and rescheduling from an in-flight refresh', async () => {
    const pending = deferred();
    const {controller, events, timers} = fixture({status: () => pending.promise});
    const refresh = controller.refresh();
    await new Promise(r => setImmediate(r));
    const count = events.length;
    controller.dispose();
    pending.resolve('online');
    await refresh;
    assert.equal(events.length, count);
    assert.equal(timers.size, 0);
});

test('a missing client becomes an onboarding state rather than a disconnected claim', async () => {
    const {controller} = fixture({discover: async () => { const error = new Error('Not installed'); error.kind = 'missing'; throw error; }});
    await controller.refresh();
    assert.equal(controller.state.status, 'missing');
    controller.dispose();
});

test('background polls read only status, while an open menu reads resources and routing', async () => {
    const {controller, reads} = fixture({accounts: async () => { reads.accounts++; return [{network: 'example', email: 'a@b.test'}]; }},
        {details: false});
    await controller.refresh();
    await controller.refresh();
    assert.deepEqual(reads, {resources: 0, accounts: 1, exitNodes: 0});
    assert.equal(controller.state.resourcesLoaded, false);
    controller.setPolling(5, true);
    await controller.refresh();
    assert.deepEqual(reads, {resources: 1, accounts: 2, exitNodes: 1});
    assert.equal(controller.state.resourcesLoaded, true);
    controller.dispose();
});

test('opening a menu during a background poll queues a full read', async () => {
    const status = deferred();
    let calls = 0;
    const {controller, reads} = fixture({status: () => ++calls === 1 ? status.promise : Promise.resolve('online')}, {details: false});
    const background = controller.refresh();
    controller.setPolling(5, true);
    const opened = controller.refresh();
    assert.notEqual(opened, background);
    status.resolve('online');
    await opened;
    assert.equal(reads.resources, 1);
    assert.equal(controller.state.resourcesLoaded, true);
    controller.dispose();
});

test('paused and offline resume without a service prompt; a stopped service starts', async () => {
    for (const [status, expected] of [['paused', 'resume'], ['offline', 'resume'], ['not-running', 'start']]) {
        const calls = [];
        const {controller} = fixture({status: async () => status, action: async name => calls.push(name)});
        await controller.refresh();
        await controller.primaryAction();
        assert.deepEqual(calls, [expected], status);
        controller.dispose();
    }
    const calls = [];
    const {controller} = fixture({status: async () => 'paused', action: async name => calls.push(name)},
        {capabilities: {...CAPABILITIES, pause: false, resume: ''}});
    await controller.refresh();
    await controller.primaryAction();
    assert.deepEqual(calls, ['start']);
    controller.dispose();
});

test('an action stays busy until the daemon reports the new status, so a second click cannot repeat it', async () => {
    const statuses = ['online', 'online', 'online', 'paused'], calls = [];
    const {controller, client} = fixture({action: async name => calls.push(name)});
    await controller.refresh();
    client.status = async () => statuses.shift() ?? 'paused';
    const pause = controller.act('pause');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.state.busy, 'pause');
    assert.equal(await controller.primaryAction(), false);
    assert.equal(await pause, true);
    assert.equal(controller.state.status, 'paused');
    assert.equal(controller.state.busy, '');
    assert.deepEqual(calls, ['pause']);
    controller.dispose();
});

test('the half-second authenticating step of a reconnect is not taken for a sign-in request', async () => {
    const {controller, client} = fixture({status: async () => 'paused'});
    await controller.refresh();
    const statuses = ['paused', 'authenticating', 'online'];
    client.status = async () => statuses.shift() ?? 'online';
    assert.equal(await controller.act('resume'), true);
    assert.equal(controller.state.status, 'online');
    assert.deepEqual(statuses, []);
    let reads = 0;
    client.status = async () => { reads++; return 'authenticating'; };
    controller.state.status = 'paused';
    assert.equal(await controller.act('resume'), true);
    assert.equal(controller.state.status, 'authenticating');
    // Three settling checks, then the post-action refresh.
    assert.equal(reads, 4);
    controller.dispose();
});

test('settling gives up after a bounded wait and disable releases it at once', async () => {
    let reads = 0;
    const {controller, client} = fixture();
    await controller.refresh();
    client.status = async () => { reads++; return 'online'; };
    assert.equal(await controller.act('pause'), true);
    assert.ok(reads >= 20 && reads <= 22, `${reads} status reads`);
    const slow = fixture({}, {details: false});
    await slow.controller.refresh();
    slow.client.status = async () => 'online';
    slow.controller.scheduler.later = (_delay, _callback) => 99;
    const pending = slow.controller.act('pause');
    await new Promise(resolve => setImmediate(resolve));
    slow.controller.dispose();
    assert.equal(await pending, false);
});

test('sign-in restarts the notifier, while connecting cannot start duplicate sessions', async () => {
    const calls = [];
    const {controller, client} = fixture({status: async () => 'authenticating', action: async name => calls.push(name)});
    await controller.refresh();
    await controller.primaryAction();
    assert.deepEqual(calls, ['signIn']);
    client.status = async () => 'connecting';
    await controller.refresh();
    assert.equal(await controller.primaryAction(), false);
    assert.deepEqual(calls, ['signIn']);
    controller.dispose();
});
