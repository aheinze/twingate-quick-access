// SPDX-License-Identifier: GPL-3.0-or-later
// Pure data transformations. No GNOME, process, or network dependencies.
// States without an attention icon are shown with the Twingate mark.
export const STATES = {
    online: {label: 'Connected', connected: true},
    offline: {label: 'Disconnected'},
    paused: {label: 'Paused'},
    'not-running': {label: 'Client stopped'},
    connecting: {label: 'Connecting…'},
    authenticating: {label: 'Sign-in required', icon: 'dialog-password-symbolic', attention: true},
    missing: {label: 'Install Twingate', icon: 'software-install-symbolic', attention: true},
    unknown: {label: 'Checking connection…'},
    error: {label: 'Connection unavailable', icon: 'dialog-warning-symbolic', attention: true},
};

export function cleanText(value) {
    return String(value ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
}

export function parseStatus(output) {
    const first = cleanText(output).split('\n')[0].toLowerCase().trim();
    const token = first.split(/[\s:]+/)[0];
    const aliases = {connected: 'online', disconnected: 'paused', stopped: 'not-running',
        'not-connected': 'offline', 'authentication-required': 'authenticating'};
    return aliases[token] ?? (Object.hasOwn(STATES, token) ? token : 'error');
}

// The CLI reports an empty list as a sentence, often with a nonzero exit code:
// "No resources currently available", "No exit nodes are available".
export function isEmptyListMessage(output) {
    return /^no (?:\w+ )?(?:resources|accounts|exit nodes)\b/i.test(cleanText(output).split('\n')[0]);
}

function table(output, aliases, required) {
    const lines = cleanText(output).split('\n').filter(l => l.trim());
    if (!lines.length || isEmptyListMessage(lines[0]))
        return [];
    const split = line => (line.includes('\t') ? line.split('\t') : line.trim().split(/ {2,}/)).map(v => v.trim());
    const normalize = value => value.toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
    const header = split(lines[0]).map(normalize);
    const columns = {};
    for (const [field, names] of Object.entries(aliases))
        columns[field] = header.findIndex(h => names.includes(h));
    if (required.some(key => columns[key] < 0))
        throw new Error('The client returned an unrecognized table format. Update Twingate Quick Access or report this client version.');
    return lines.slice(1).filter(l => !/^[-─+\s]+$/.test(l)).map(line => {
        const fields = split(line);
        if (required.some(key => !fields[columns[key]]))
            throw new Error('The client returned an incomplete table row. Try refreshing.');
        return Object.fromEntries(Object.entries(columns).map(([key, index]) => [key, index < 0 ? '' : fields[index] ?? '']));
    });
}

export function parseResources(output) {
    const rows = table(output, {
        name: ['resource name', 'name', 'resource'],
        address: ['address', 'resource address', 'host'],
        alias: ['alias', 'aliases', 'resource alias'],
        authorization: ['auth status', 'authentication status', 'status', 'authorization', 'authentication'],
    }, ['name', 'address']);
    const seen = new Set();
    return rows.map(row => ({...row, id: JSON.stringify([row.name, row.address])}))
        .filter(row => { if (seen.has(row.id)) return false; seen.add(row.id); return true; });
}

export function parseAccounts(output) {
    return table(output, {
        email: ['email', 'account email'], network: ['network', 'tenant', 'tenant slug'],
        id: ['id', 'account id'], active: ['active', 'current'],
    }, ['email', 'network']).map(row => ({...row,
        active: /^(yes|true|active|current|\*|✓)$/i.test(row.active) || row.email.startsWith('*'),
        email: row.email.replace(/^\*\s*/, ''),
        id: row.id || `${row.email.replace(/^\*\s*/, '')}:${row.network}`,
    }));
}

export function parseExitNodes(output) {
    return table(output, {
        name: ['name', 'node name', 'exit node', 'exit node name'],
        active: ['active', 'current', 'status'],
    }, ['name']).map(row => ({...row,
        active: /^(yes|true|active|current|connected|\*|✓)$/i.test(row.active),
    }));
}

// `resume` names the transport: the notifier sends sdwan-start without sudo, while
// `twingate connect` writes a root-owned intention file in background daemon mode.
export function capabilitiesFromHelp(output, notifierOutput = '') {
    const has = (text, command) => new RegExp(`^[ \\t]*${command}[ \\t]+`, 'm').test(text);
    const resume = has(notifierOutput, 'sdwan-start') ? 'notifier' : has(output, 'connect') ? 'cli' : '';
    return {pause: has(output, 'disconnect') && Boolean(resume), resume, accounts: has(output, 'account'),
        auth: has(output, 'auth'), exitNodes: has(output, 'exit-node'), signIn: has(output, 'desktop-restart')};
}

export function filteredResources(resources, query, favorites = [], onlyFavorites = false) {
    const wanted = new Set(favorites);
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return resources.filter(r => (!onlyFavorites || wanted.has(r.id)) &&
        terms.every(term => `${r.name} ${r.address} ${r.alias ?? ''}`.toLocaleLowerCase().includes(term)))
        .sort((a, b) => Number(wanted.has(b.id)) - Number(wanted.has(a.id)) ||
            a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}

// A concrete host can be probed; a wildcard or a network cannot.
export function isProbeable(address) {
    return /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(address);
}

export function safeWebUri(value) {
    // Explicit user-saved destinations only. No shell commands or guessed protocols.
    const uri = String(value ?? '').trim();
    return /^https?:\/\/[^\s/@?#]+(?::\d+)?(?:[/?#][^\s]*)?$/i.test(uri) &&
        !/[\x00-\x20\x7f<>"\\]/.test(uri) ? uri : null;
}

export function objectSetting(text) {
    try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch { return {}; }
}

export function accountLabel(accounts) {
    const active = accounts.find(a => a.active) ?? (accounts.length === 1 ? accounts[0] : null);
    return active?.network ?? (accounts.length ? `${accounts.length} accounts` : 'Private network');
}
