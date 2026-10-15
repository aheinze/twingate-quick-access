import {registerHooks} from 'node:module';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Menu, Settings, MessageTray, clipboard, settings as extensionSettings, network, stage, timers, notifications, notificationSources, quickSettingsMenu} from './support/shell-mocks.js';
import {parseResources} from '../model.js';

const mockUrl = new URL('./support/shell-mocks.js', import.meta.url).href;
registerHooks({
    resolve(specifier, context, next) {
        if (specifier.startsWith('gi://')) return {url: `mock:gi/${specifier.slice(5)}`, shortCircuit: true};
        if (specifier.startsWith('resource://')) return {url: `mock:resource/${specifier.split('/').pop()}`, shortCircuit: true};
        return next(specifier, context);
    },
    load(url, context, next) {
        if (!url.startsWith('mock:')) return next(url, context);
        const name = url.split('/').pop().replace('.js', '');
        const exports = {main: 'Main', panelMenu: 'PanelMenu', quickSettings: 'QuickSettings',
            popupMenu: 'PopupMenu', shellEntry: 'ShellEntry', messageTray: 'MessageTray', config: 'Config'};
        const source = url.startsWith('mock:gi/') ? `export {${name} as default} from '${mockUrl}';` :
            name === 'extension' ? `export {Extension, InjectionManager} from '${mockUrl}';` :
                `import {${exports[name]} as module} from '${mockUrl}'; ${Object.keys((awaitMockModules())[exports[name]]).map(key => `export const ${key}=module.${key};`).join(' ')}`;
        return {format: 'module', source, shortCircuit: true};
    },
});
// Explicit mock export inventory keeps the loader synchronous.
function awaitMockModules() {
    return {Main: {panel: 0, notify: 0, messageTray: 0, layoutManager: 0}, MessageTray: {Source: 0, Action: 0}, PanelMenu: {Button: 0},
        QuickSettings: {SystemIndicator: 0, QuickMenuToggle: 0},
        PopupMenu: {PopupBaseMenuItem: 0, PopupMenuItem: 0, PopupSeparatorMenuItem: 0, PopupSubMenuMenuItem: 0, Ornament: 0},
        ShellEntry: {addContextMenu: 0}, Config: {PACKAGE_VERSION: 0}};
}
const {MenuContent} = await import('../menu.js');
const {default: Extension} = await import('../extension.js');

const LOGO = {file: {path: 'icons/twingate-panel-symbolic.svg'}};

function fixture(options = {}) {
    const menu = new Menu(), settings = new Settings(), calls = [], notices = [];
    const state = {status: 'online', resources: parseResources('NAME\tADDRESS\nWiki\twiki.test\nOffice\t10.0.0.0/8'),
        accounts: [{id: 'a', network: 'Example', email: 'a@example.test', active: true}], exitNodes: [],
        capabilities: {pause: true, resume: 'notifier', accounts: true, auth: true, exitNodes: true, signIn: true},
        resourcesLoaded: true, updatedAt: Date.now()};
    const controller = {state, primaryAction: () => calls.push('primary'), retry: () => calls.push('retry'),
        act: (...args) => calls.push(args), client: {probe: async () => 'no-reply'}};
    const view = new MenuContent(menu, controller, settings, {settings() {}, diagnostics() {}, notify: text => notices.push(text)},
        {logo: LOGO, ...options});
    settings.connect('changed', () => view.update(state));
    view.update(state);
    return {view, state, menu, settings, calls, notices};
}

test('menu renders, searches, favorites, and copies without rebuilding unchanged resource actors', () => {
    const {view, state, menu, settings, notices} = fixture();
    const wiki = state.resources[0];
    const row = view._rows.get(wiki.id);
    assert.equal(view._primary.label, 'Pause');
    assert.equal(view._resourceCount.text, '2');
    view.update({...state, refreshing: true});
    assert.equal(view._rows.get(wiki.id), row);
    row.favorite.emit('clicked');
    assert.deepEqual(settings.get_strv('favorite-resources'), [wiki.id]);
    row.actor.children[0].emit('clicked');
    assert.equal(clipboard.text, 'wiki.test');
    assert.match(notices[0], /Address copied/);
    view._search.set_text('office');
    assert.equal(row.actor.visible, false);
    assert.equal(view._resourceCount.text, '1 / 2');
    view._search.set_text('no match');
    assert.equal(view._emptyTitle.text, 'No matching resources');
    view.destroy(); menu.destroy();
});

test('menu clearly distinguishes action failure, resource failure, and empty success', () => {
    const {view, state, menu} = fixture();
    view.update({...state, resources: [], resourceError: 'Permission denied', actionError: 'Sign-in cancelled'});
    assert.equal(view._feedback.text, 'Sign-in cancelled');
    assert.equal(view._emptyTitle.text, 'Resources could not be refreshed');
    view.update({...state, resources: []});
    assert.equal(view._emptyTitle.text, 'No resources available');
    view.destroy(); menu.destroy();
});

test('compact filters remain clearable when a refresh shrinks the resource list', () => {
    const {view, state, menu} = fixture({compact: true});
    try {
        assert.equal(view._searchItem.visible, false);
        const resources = parseResources('NAME\tADDRESS\n' +
            Array.from({length: 6}, (_, i) => `Server ${i}\tserver${i}.test`).join('\n'));
        view.update({...state, resources});
        assert.equal(view._searchItem.visible, true);
        view._search.set_text('server 5');
        view.update({...state, resources: resources.slice(0, 1)});
        assert.equal(view._searchItem.visible, true);
        assert.equal(view._emptyTitle.text, 'No matching resources');
        view._search.set_text('');
        assert.equal(view._searchItem.visible, false);
        assert.equal(view._scrollItem.visible, true);
        view.update({...state, resources});
        view._favoritesButton.emit('clicked');
        view.update({...state, resources: resources.slice(0, 1)});
        assert.equal(view._searchItem.visible, true);
        assert.equal(view._emptyTitle.text, 'No favorites yet');
        view._favoritesButton.emit('clicked');
        assert.equal(view._searchItem.visible, false);
        assert.equal(view._scrollItem.visible, true);
    } finally {
        view.destroy(); menu.destroy();
    }
});

test('actions use the selected resource and account; busy state disables controls', () => {
    const {view, state, calls, menu} = fixture();
    view._rows.get(state.resources[0].id).auth.emit('clicked');
    assert.deepEqual(calls.pop(), ['authenticate', 'Wiki']);
    view._accounts.menu.items[0].emit('activate');
    assert.deepEqual(calls, [], 'the account in use is not switched to again');
    view.update({...state, accounts: [...state.accounts, {id: 'b', network: 'Other', email: 'b@example.test', active: false}]});
    view._accounts.menu.items[1].emit('activate');
    assert.deepEqual(calls.pop(), ['switchAccount', 'b']);
    view.update({...state, busy: 'pause'});
    assert.equal(view._primary.reactive, false);
    assert.equal(view._rows.get(state.resources[0].id).auth.reactive, false);
    view.destroy(); menu.destroy();
});

test('offline menu keeps connection recovery visible without unavailable resource controls', () => {
    const {view, state, menu} = fixture();
    view.update({...state, status: 'not-running', resources: []});
    assert.equal(view._primary.label, 'Connect');
    assert.equal(view._primary.reactive, true);
    assert.equal(view._searchItem.visible, false);
    assert.equal(view._resourceHeadingItem.visible, false);
    assert.equal(view._scrollItem.visible, false);
    assert.equal(view._emptyItem.visible, false);
    view.update({...state, status: 'authenticating', resources: []});
    assert.equal(view._primary.label, 'Sign in');
    view.update({...state, status: 'connecting', resources: []});
    assert.equal(view._primary.reactive, false);
    view.update(state);
    assert.equal(view._searchItem.visible, true);
    assert.equal(view._scrollItem.visible, true);
    view.destroy(); menu.destroy();
});

test('ICMP remains on demand and late probe results cannot touch a removed resource', async () => {
    const {view, state, menu, settings, notices} = fixture();
    let finish, probes = 0;
    view.controller.client.probe = () => { probes++; return new Promise(resolve => { finish = resolve; }); };
    settings.values['ping-enabled'] = true;
    view.update(state);
    const row = view._rows.get(state.resources[0].id);
    assert.equal(probes, 0);
    row.probe.emit('clicked');
    assert.equal(probes, 1);
    view.update({...state, status: 'paused', resources: []});
    finish('no-reply');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notices.length, 0);
    view.destroy(); menu.destroy();
});

test('submenus are siblings, because GNOME collapses a parent when a nested submenu opens', () => {
    const {view, menu} = fixture();
    for (const submenu of [view._accounts, view._routing, view._advanced])
        assert.ok(menu.items.includes(submenu));
    assert.equal(view._advanced.menu.items.some(item => item.menu), false);
    view.destroy(); menu.destroy();
});

test('routing appears only when there are exit nodes or a real error', () => {
    const {view, state, menu, calls} = fixture();
    assert.equal(view._routing.visible, false);
    view.update({...state, exitNodes: [{name: 'Berlin', active: true}, {name: 'Tokyo', active: false}]});
    assert.equal(view._routing.visible, true);
    assert.match(view._routing.menu.items[1].label.text, /Berlin/);
    view._routing.menu.items[1].emit('activate');
    view._routing.menu.items[2].emit('activate');
    assert.deepEqual(calls, [['exitSwitch', 'Tokyo']], 'the active node is kept; another one is switched to');
    view.update({...state, exitNodes: [{name: 'Berlin', active: false}]});
    view._routing.menu.items[1].emit('activate');
    assert.deepEqual(calls.pop(), ['exitStart', 'Berlin']);
    view.update({...state, exitError: 'Permission denied'});
    assert.equal(view._routing.visible, true);
    assert.match(view._routing.menu.items[0].label.text, /unavailable/);
    view.destroy(); menu.destroy();
});

test('resource rows show alias and auth status, and saved links match an alias', () => {
    const {view, menu, settings} = fixture();
    const resources = parseResources('RESOURCE NAME\tADDRESS\tALIAS\tAUTH STATUS\nNAS\t192.0.2.10\tnas.example.test\tPending');
    const state = {...view._state, resources};
    view.update(state);
    const row = view._rows.get(resources[0].id);
    assert.equal(row.address.text, 'nas.example.test · Auth pending · 192.0.2.10');
    assert.equal(row.open.visible, false);
    settings.values['resource-links'] = '{"nas.example.test":"http://nas.example.test"}';
    view.update({...state});
    assert.equal(row.open.visible, true);
    view.update({...state, resources: parseResources('RESOURCE NAME\tADDRESS\tALIAS\tAUTH STATUS\nNAS\t192.0.2.10\tnas.example.test\tAuthenticated')});
    assert.equal(row.address.text, 'nas.example.test · Auth authenticated · 192.0.2.10');
    view.destroy(); menu.destroy();
});

test('resources that are still loading are not reported as missing', () => {
    const {view, state, menu} = fixture();
    view.update({...state, resources: [], resourcesLoaded: false});
    assert.equal(view._emptyTitle.text, 'Loading resources…');
    assert.equal(view._statusDescription.text, 'Private network connected');
    view.update({...state, resources: state.resources.slice(0, 1)});
    assert.equal(view._statusDescription.text, '1 resource available');
    view.update({...state, status: 'authenticating', busy: 'signIn', resources: []});
    assert.equal(view._statusTitle.text, 'Opening sign-in…');
    assert.match(view._statusDescription.text, /notification/);
    view.destroy(); menu.destroy();
});

test('connection notifications report changes, not the first status after login or unlock', () => {
    extensionSettings.values['notifications-enabled'] = true;
    notifications.length = 0;
    const extension = new Extension();
    extension.enable();
    const state = extension._controller.state;
    extension._render({...state, status: 'online'});
    assert.deepEqual(notifications, []);
    extension._render({...state, status: 'paused'});
    assert.deepEqual(notifications, [['Twingate', 'Connection paused']]);
    // Every reconnect passes through 'authenticating'; it is not a change of its own.
    for (const status of ['authenticating', 'online', 'authenticating', 'online'])
        extension._render({...state, status});
    assert.deepEqual(notifications, [['Twingate', 'Connection paused'], ['Twingate', 'Connected to your private network']]);
    extension.disable();
    extensionSettings.values['notifications-enabled'] = false;
});

test('resource authentication banners can be muted without dropping notifications or sign-in requests', () => {
    const source = new MessageTray.Source({title: 'twingate-notifier'});
    const other = new MessageTray.Source({title: 'another-app'});
    const resource = {title: 'Twingate Client: Additional authentication required'};
    const signIn = {title: 'Twingate Client: Sign in to Connect'};
    const banners = [], delivered = [];
    for (const s of [source, other]) {
        s.connect('notification-request-banner', (_s, n) => banners.push(n));
        s.connect('notification-added', (_s, n) => delivered.push(n));
    }
    const originalEmit = MessageTray.Source.prototype.emit;
    const extension = new Extension();
    extension.enable();
    try {
        source.emit('notification-request-banner', resource);
        assert.deepEqual(banners, [resource]);
        banners.length = 0;
        extensionSettings.values['resource-authentication-popups'] = false;
        source.emit('notification-added', resource);
        source.emit('notification-request-banner', resource);
        source.emit('notification-request-banner', resource); // replacement / reminder
        assert.deepEqual(delivered, [resource]);
        assert.deepEqual(banners, []);
        source.emit('notification-request-banner', signIn);
        other.emit('notification-request-banner', resource);
        assert.deepEqual(banners, [signIn, resource]);
        extensionSettings.values['resource-authentication-popups'] = true;
        source.emit('notification-request-banner', resource);
        assert.equal(banners.length, 3);
        extensionSettings.values['resource-authentication-popups'] = false;
    } finally {
        extension.disable();
    }
    assert.equal(MessageTray.Source.prototype.emit, originalEmit);
    source.emit('notification-request-banner', resource);
    assert.equal(banners.length, 4);
    extensionSettings.values['resource-authentication-popups'] = true;
    source.destroy(); other.destroy();
});

test('existing Authenticate buttons use the controller, including muted requests, and restore on disable', async () => {
    const source = new MessageTray.Source({title: 'twingate-notifier', notifications: []});
    const calls = [];
    let nativeCalls = 0;
    const action = new MessageTray.Action('Authenticate', () => nativeCalls++);
    const request = {title: 'Twingate Client: Additional authentication required',
        body: 'Example NAS - nas.example.test(192.0.2.10)', actions: [action],
        destroy() { this.destroyed = true; }};
    source.notifications.push(request);
    notificationSources.push(source);
    const originalActivate = MessageTray.Action.prototype.activate;
    const extension = new Extension();
    extensionSettings.values['resource-authentication-popups'] = false;
    extension.enable();
    extension._controller.act = async (...args) => { calls.push(args); return true; };
    try {
        await action.activate();
        assert.deepEqual(calls, [['authenticateNotification', request.body]]);
        assert.equal(nativeCalls, 0);
        assert.equal(request.destroyed, true);
        // Sign-in and another app's identically named action use their native callbacks.
        request.title = 'Twingate Client: Sign in to Connect';
        await action.activate();
        source.title = 'another-app';
        request.title = 'Twingate Client: Additional authentication required';
        await action.activate();
        assert.equal(nativeCalls, 2);
    } finally {
        extension.disable();
        notificationSources.length = 0;
        extensionSettings.values['resource-authentication-popups'] = true;
        source.destroy();
    }
    assert.equal(MessageTray.Action.prototype.activate, originalActivate);
    await action.activate();
    assert.equal(nativeCalls, 3);
});

test('notification authentication shows failures, keeps busy requests retryable, and ignores late results after disable', async () => {
    const extension = new Extension();
    extension.enable();
    const controller = extension._controller;
    let calls = 0;
    controller.act = async () => { calls++; return false; };
    const request = {body: 'Example NAS - 192.0.2.10', destroy() { this.destroyed = true; }};
    notifications.length = 0;
    controller.state.busy = 'switchAccount';
    await extension._authenticateNotification(request);
    assert.equal(calls, 0);
    assert.equal(request.destroyed, undefined);
    assert.match(notifications.at(-1)[1], /in progress/);
    controller.state.busy = '';
    await extension._authenticateNotification(request);
    assert.equal(calls, 1);
    assert.equal(extension._panel.menu.isOpen, true);
    assert.match(notifications.at(-1)[1], /did not complete/);
    let finish;
    controller.act = () => new Promise(resolve => { finish = resolve; });
    const pending = extension._authenticateNotification(request);
    extension.disable();
    const count = notifications.length;
    finish(false);
    await pending;
    assert.equal(notifications.length, count);
});

test('opening Quick Settings refreshes the tile, and disable disconnects the listener', async () => {
    const extension = new Extension();
    extension.enable();
    await new Promise(resolve => setImmediate(resolve));
    let refreshes = 0;
    extension._controller.refresh = async () => { refreshes++; };
    quickSettingsMenu.open();
    assert.equal(refreshes, 1);
    assert.equal(extension._controller._details, false);
    quickSettingsMenu.close();
    extension.disable();
    assert.equal(quickSettingsMenu.signals.signals.size, 0);
});

test('failed notification authentication opens Quick Settings when the panel shortcut is hidden', async () => {
    const extension = new Extension();
    extensionSettings.values['show-panel-icon'] = false;
    extension.enable();
    try {
        extension._controller.act = async () => false;
        await extension._authenticateNotification({body: 'Example NAS - 192.0.2.10', destroy() {}});
        assert.equal(quickSettingsMenu.isOpen, true);
        assert.equal(extension._quick.toggle.menu.isOpen, true);
        assert.equal(extension._panel.menu.isOpen, false);
    } finally {
        quickSettingsMenu.close();
        extension.disable();
        extensionSettings.values['show-panel-icon'] = true;
    }
});

test('the Twingate mark is the icon, dimmed when disconnected; attention states keep their own icon', () => {
    const {view, state, menu} = fixture();
    assert.equal(view._statusIcon.gicon, LOGO);
    view.update({...state, status: 'paused'});
    assert.equal(view._statusIcon.gicon, LOGO);
    view.update({...state, status: 'error'});
    assert.deepEqual(view._statusIcon.gicon, {name: 'dialog-warning-symbolic'});
    view.destroy(); menu.destroy();

    const extension = new Extension();
    extension.enable();
    const logo = extension._logo;
    assert.equal(logo.file.path, 'icons/twingate-panel-symbolic.svg');
    assert.equal(extension._panel.icon.gicon, logo);
    assert.equal(extension._quick.toggle.gicon, logo);
    extension._render({...extension._controller.state, status: 'online'});
    assert.equal(extension._panel.icon.opacity, 255);
    extension._render({...extension._controller.state, status: 'paused'});
    assert.equal(extension._panel.icon.gicon, logo);
    assert.equal(extension._panel.icon.opacity, 128);
    extension._render({...extension._controller.state, status: 'authenticating'});
    assert.deepEqual(extension._panel.icon.gicon, {name: 'dialog-password-symbolic'});
    assert.equal(extension._panel.icon.opacity, 255);
    assert.deepEqual(extension._quick.icon.gicon, {name: 'dialog-password-symbolic'});
    extension.disable();
});

test('extension enable/disable cycles remove timers, monitor signals, and settings listeners', async () => {
    for (let i = 0; i < 3; i++) {
        const extension = new Extension();
        extension.enable();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(extension._views.length, 2);
        const panel = extension._panel, quick = extension._quick;
        extension.disable();
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(panel.destroyed && quick.destroyed);
        assert.equal(extensionSettings.signals.size, 0);
        assert.equal(network.signals.size, 0);
        assert.equal(stage.signals.size, 0);
        assert.equal(quickSettingsMenu.signals.signals.size, 0);
        assert.equal(timers.size, 0);
    }
});
