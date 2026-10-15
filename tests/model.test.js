import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseStatus, parseResources, parseAccounts, parseExitNodes, capabilitiesFromHelp,
    filteredResources, safeWebUri, isProbeable, accountLabel, isEmptyListMessage} from '../model.js';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('status recognizes paused, transitions, stopped, ANSI, and unexpected output', () => {
    for (const [input, expected] of [['online\n', 'online'], ['\x1b[32mconnected\x1b[0m', 'online'],
        ['disconnected', 'paused'], ['not-running', 'not-running'], ['authenticating', 'authenticating'],
        ['connecting', 'connecting'], ['offline', 'offline'], ['fatal: socket unavailable', 'error'], ['', 'error']])
        assert.equal(parseStatus(input), expected);
});

test('resources preserve wildcard, subnet, IPv6, names with spaces, and tabular headers', () => {
    const resources = parseResources('RESOURCE NAME\tADDRESS\nCompany wiki\twiki.example.test\nAll apps\t*.example.test\nOffice subnet\t10.0.0.0/24\nIPv6 host\t2001:db8::10\n');
    assert.deepEqual(resources.map(r => r.address), ['wiki.example.test', '*.example.test', '10.0.0.0/24', '2001:db8::10']);
    assert.equal(resources[0].name, 'Company wiki');
});

test('resource parser tolerates padding and extra columns, but surfaces incompatible output', () => {
    assert.equal(parseResources('NAME            ADDRESS           STATUS\nWiki            wiki.test         locked')[0].authorization, 'locked');
    assert.deepEqual(parseResources('RESOURCE NAME\tADDRESS\n'), []);
    assert.deepEqual(parseResources('No resources available'), []);
    assert.throws(() => parseResources('Permission denied'), /unrecognized/);
    assert.throws(() => parseResources('RESOURCE NAME\tADDRESS\nTruncated'), /incomplete/);
});

test('duplicate records are deduplicated without merging distinct resources', () => {
    assert.equal(parseResources('NAME\tADDRESS\nA\ta.test\nA\ta.test\nB\ta.test').length, 2);
});

test('accounts use exact CLI identifiers and never guess the current account in multi-account output', () => {
    const rows = parseAccounts('EMAIL             \tNETWORK \tNETWORK URL\na@example.test\talpha\talpha.twingate.com\nb@example.test\tbeta\tbeta.twingate.com');
    assert.equal(rows[0].id, 'a@example.test:alpha');
    assert.equal(accountLabel(rows), '2 accounts');
    assert.equal(accountLabel(rows.slice(0, 1)), 'alpha');
    assert.equal(parseAccounts('EMAIL\tNETWORK\tACTIVE\na@b.test\tcompany\tyes')[0].active, true);
});

test('routing reports only explicit active markers', () => {
    const nodes = parseExitNodes('NAME\tACTIVE\nBerlin\ttrue\nLondon\tfalse');
    assert.equal(nodes[0].active, true);
    assert.equal(nodes[1].active, false);
    assert.throws(() => parseExitNodes('unsupported output'), /unrecognized/);
});

test('capabilities come from command entries rather than prose', () => {
    assert.deepEqual(capabilitiesFromHelp(fixture('cli-help.txt'), fixture('notifier-help.txt')),
        {pause: true, resume: 'notifier', accounts: true, auth: true, exitNodes: true, signIn: true});
    assert.deepEqual(capabilitiesFromHelp('Commands:\n  connect    Reconnect\n  disconnect   Pause\n  account   Accounts\n  auth   Authenticate\n  exit-node   Routing'),
        {pause: true, resume: 'cli', accounts: true, auth: true, exitNodes: true, signIn: false});
    assert.equal(capabilitiesFromHelp('This client can connect and disconnect.').pause, false);
    assert.equal(capabilitiesFromHelp('Commands:\n  disconnect   Pause').pause, false);
});

test('empty-list sentences from the client are recognized, other failures are not', () => {
    for (const output of [fixture('exit-nodes-empty.txt'), fixture('resources-empty.txt'), 'No accounts configured', 'No available resources'])
        assert.ok(isEmptyListMessage(output), output);
    for (const output of ['Twingate must be connected to display available resources.', 'not-running', '', 'Nothing here'])
        assert.equal(isEmptyListMessage(output), false, output);
    assert.deepEqual(parseExitNodes(fixture('exit-nodes-empty.txt')), []);
});

test('real resource table keeps alias and auth status, and search matches the alias', () => {
    const [resource] = parseResources(fixture('resources.txt'));
    assert.equal(resource.alias, 'nas.example.test');
    assert.equal(resource.authorization, 'Pending');
    assert.equal(resource.id, JSON.stringify(['Example NAS', '192.0.2.10']));
    assert.equal(filteredResources([resource], 'nas.example').length, 1);
    assert.equal(accountLabel(parseAccounts(fixture('accounts.txt'))), 'example');
});

test('search matches every term, prioritizes favorites, and filters only current resources', () => {
    const rows = parseResources('NAME\tADDRESS\nZeta wiki\twiki.test\nAlpha app\tapp.test');
    assert.equal(filteredResources(rows, '', [rows[0].id])[0].name, 'Zeta wiki');
    assert.equal(filteredResources(rows, 'zeta test')[0].name, 'Zeta wiki');
    assert.deepEqual(filteredResources(rows, '', ['other-account-resource'], true), []);
});

test('destinations accept explicit web URLs and reject commands, userinfo, whitespace, and scripts', () => {
    for (const uri of ['https://wiki.test', 'http://server.test:8080/path?q=1', 'https://[2001:db8::1]/'])
        assert.equal(safeWebUri(uri), uri);
    for (const uri of ['javascript:alert(1)', 'file:///etc/passwd', 'ssh://host', 'https://user:password@host/',
        'https://host/\ncommand', 'https://host\\@evil.test/', 'https:///missing-host', 'https://host/"x'])
        assert.equal(safeWebUri(uri), null);
});

test('ICMP probes accept only concrete host addresses', () => {
    for (const address of ['host.example', '10.0.0.5', '2001:db8::1']) assert.ok(isProbeable(address));
    for (const address of ['*.example', '10.0.0.0/8', '-c', 'x;touch /tmp/x']) assert.equal(isProbeable(address), false);
});
