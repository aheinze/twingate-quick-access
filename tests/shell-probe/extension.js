// Test-only driver for tools/shell_smoke.py. Runs inside an isolated headless GNOME Shell,
// operates the real Twingate Panel menus, and reports results as `TPPROBE <key> <json>` lines.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const UUID = 'twingate-panel@urhend';
const SHOTS = GLib.getenv('TP_SHOTS');
const LIVE_ACTIONS = GLib.getenv('TP_LIVE_ACTIONS') === '1';

// Disabling Twingate Panel also disables and re-enables the extensions enabled after it,
// including this probe. The module stays loaded, so this keeps the run from starting twice.
let started = false;

const out = (key, value) => console.log(`TPPROBE ${key} ${JSON.stringify(value)}`);
const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function shot(name) {
    if (!SHOTS) return;
    const stream = Gio.File.new_for_path(`${SHOTS}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    const shooter = new Shell.Screenshot();
    await new Promise((resolve, reject) => shooter.screenshot(false, stream, (source, result) => {
        try {
            source.screenshot_finish(result);
            resolve();
        } catch (error) {
            reject(error);
        }
    }));
    stream.close(null);
}

function panel() {
    return Main.extensionManager.lookup(UUID)?.stateObj;
}

async function settled(tp) {
    for (let i = 0; i < 120 && (tp._controller.state.busy || tp._controller.state.refreshing); i++)
        await wait(250);
    const {status, actionError} = tp._controller.state;
    return {status, actionError, title: tp._views[0]._statusTitle.text, button: tp._views[0]._primary.label,
        subtitle: tp._quick.toggle.subtitle};
}

async function run() {
    let tp = null;
    for (let i = 0; i < 80 && !(tp?._controller && tp._controller.state.status !== 'unknown'); i++) {
        tp = panel();
        await wait(250);
    }
    const extension = Main.extensionManager.lookup(UUID);
    out('extension', {state: extension?.state, error: extension?.error ?? ''});
    if (!tp?._controller)
        throw new Error('Twingate Panel did not enable');
    const controller = tp._controller;
    // While one top-bar menu is open, hovering another top-bar button opens that one instead.
    // Keep the pointer off every top-bar button; the headless Shell can report it at y=0.
    const backend = global.stage.context?.get_backend() ?? Clutter.get_default_backend();
    backend.get_default_seat().warp_pointer(300, 400);
    await wait(200);
    out('pointer', global.get_pointer().slice(0, 2));
    out('background', {status: controller.state.status, capabilities: controller.state.capabilities,
        resourcesLoaded: controller.state.resourcesLoaded, error: controller.state.error});

    // Opening Quick Settings is a status-only read; expanding the tile loads details.
    const quickSettings = Main.panel.statusArea.quickSettings;
    quickSettings.menu.open(false);
    await wait(800);
    const menus = () => ({quickSettings: quickSettings.menu.isOpen, panel: tp._panel.menu.isOpen,
        tile: tp._quick.toggle.menu.isOpen, pointer: global.get_pointer().slice(0, 2)});
    out('qs-open', {details: controller._details, ...menus()});
    await shot('1-quick-settings');
    tp._quick.toggle.menu.open(false);
    await wait(2500);
    const quickView = tp._views[1];
    out('qs-menu', {...menus(), status: controller.state.status, details: controller._details,
        resourcesLoaded: controller.state.resourcesLoaded, feedback: quickView._feedback.text,
        resourceError: controller.state.resourceError, exitError: controller.state.exitError,
        rows: [...quickView._rows.values()].map(row => row.address.text)});
    await shot('2-quick-settings-twingate');
    // Enough resources and sibling controls to reproduce the short-screen overflow.
    // Freeze publication while rendering fixtures; no resource or account action runs.
    const publish = controller.onChange;
    controller.onChange = () => {};
    try {
        quickView.update({...controller.state, status: 'online', resourcesLoaded: true,
            resources: Array.from({length: 6}, (_, i) => ({id: `preview-${i}`, name: `Server ${i}`,
                address: `192.0.2.${i + 1}`, alias: `server${i}.example.test`, authorization: 'Pending'})),
            accounts: [{network: 'Work', email: 'you@example.test', id: 'work', active: true},
                {network: 'Home', email: 'you@example.test', id: 'home', active: false}],
            exitNodes: [{name: 'Office', active: false}]});
        await wait(300);
        const authButton = quickView._rows.get('preview-0').auth;
        authButton.set_hover(true);
        await wait(150);
        const delayed = !quickView._tooltips._label?.visible;
        await wait(400);
        const tooltip = quickView._tooltips._label;
        const hovered = tooltip?.visible && tooltip.text === authButton.accessible_name;
        await shot('2c-icon-tooltip');
        authButton.set_hover(false);
        const left = !tooltip?.visible;
        authButton.grab_key_focus();
        await wait(550);
        const keyboard = tooltip?.visible && tooltip.text === authButton.accessible_name;
        quickView._primary.grab_key_focus();
        const blurred = !tooltip?.visible;
        out('icon-tooltips', {delayed, hovered, left, keyboard, blurred});
        quickView._advanced.setSubmenuShown(true);
        await wait(500);
        const submenu = quickView._advanced.menu;
        const adjustment = tp._quickScroll.get_vadjustment();
        adjustment.value = adjustment.upper - adjustment.page_size;
        await wait(200);
        const bottom = actor => actor.get_transformed_position()[1] + actor.get_transformed_size()[1];
        const last = submenu._getMenuItems().at(-1);
        const monitor = Main.layoutManager.findMonitorForActor(tp._quick.toggle);
        out('compact-overflow', {fits: bottom(quickSettings.menu._boxPointer) <= monitor.y + monitor.height,
            scrollable: adjustment.upper > adjustment.page_size,
            lastActionVisible: last.get_transformed_position()[1] >= tp._quickScroll.get_transformed_position()[1] - 1 &&
                bottom(last) <= bottom(tp._quickScroll) + 1});
        await shot('2b-quick-settings-scrolled-options');
        adjustment.value = 0;
        last.grab_key_focus();
        await wait(300);
        out('compact-keyboard', {lastActionVisible: bottom(last) <= bottom(tp._quickScroll) + 1});
    } finally {
        quickView._advanced.setSubmenuShown(false);
        controller.onChange = publish;
        quickView.update(controller.state);
    }
    tp._quick.toggle.menu.close(false);
    out('tooltip-closed', {hidden: !quickView._tooltips._label?.visible, timer: quickView._tooltips._timer});
    quickSettings.menu.close(false);
    await wait(500);

    // Submenus are siblings: Accounts stays open, and opening another one closes it.
    tp._panel.menu.open(false);
    await wait(1500);
    const view = tp._views[0];
    view._accounts.setSubmenuShown(true);
    await wait(800);
    out('accounts-submenu', {open: view._accounts.menu.isOpen});
    await shot('3-panel-accounts');
    view._advanced.setSubmenuShown(true);
    await wait(800);
    out('controls-submenu', {open: view._advanced.menu.isOpen, accountsOpen: view._accounts.menu.isOpen});
    // Selecting the account in use must not switch to it again. Actions are recorded, not run.
    // Activating an item closes the whole menu, as in GNOME, so this comes last.
    view._accounts.setSubmenuShown(true);
    const acts = [], act = controller.act;
    controller.act = (...args) => { acts.push(args); return Promise.resolve(false); };
    view._accounts.menu._getMenuItems()[0]?.emit('activate', null);
    controller.act = act;
    out('account-click', {accounts: controller.state.accounts.length, acts});
    tp._panel.menu.close(false);
    await wait(300);

    // Exercise the real notification daemon, including replacement of an acknowledged
    // critical notification. Test content never contacts Twingate or opens a browser.
    const daemon = Main.notificationDaemon._fdoNotificationDaemon;
    const originalEmit = MessageTray.Source.prototype.emit;
    const notify = (title, replaces = 0, app = 'twingate-notifier') => {
        let id;
        daemon.NotifyAsync([app, replaces, '', title, 'Example NAS - nas.example.test(192.0.2.10)', ['authenticate', 'Authenticate'],
            {'x-shell-sender-pid': new GLib.Variant('u', 2147483647), urgency: new GLib.Variant('y', 2)}, -1],
        {return_value(value) { [id] = value.deepUnpack(); }, get_sender() { return Gio.DBus.session.get_unique_name(); }});
        return daemon._notifications.get(id);
    };
    const title = 'Twingate Client: Additional authentication required';
    tp._settings.set_boolean('resource-authentication-popups', false);
    const muted = notify(title);
    const source = muted.source;
    let bannerRequests = 0;
    source.connect('notification-request-banner', () => bannerRequests++);
    const queued = notification => Main.messageTray._notification === notification ||
        Main.messageTray._notificationQueue.includes(notification);
    const mutedId = [...daemon._notifications].find(([, n]) => n === muted)[0];
    muted.acknowledged = true;
    notify(title, mutedId);
    out('notification-muted', {inList: source.notifications.includes(muted),
        actions: muted.actions.map(action => action.label), bannerRequests, queued: queued(muted)});
    const signIn = notify('Twingate Client: Sign in to Connect');
    const unrelated = notify(title, 0, 'another-app');
    out('notification-exceptions', {signIn: queued(signIn), otherApp: queued(unrelated)});
    signIn.destroy(); unrelated.destroy();
    bannerRequests = 0;
    tp._settings.set_boolean('resource-authentication-popups', true);
    muted.acknowledged = true;
    notify(title, mutedId);
    out('notification-unmuted', {bannerRequests, queued: queued(muted)});
    muted.destroy();
    tp._settings.set_boolean('resource-authentication-popups', false);
    // Keep a source alive across disable/enable so we exercise its already bound callbacks.
    const kept = notify(title);

    let tooltipDestroyed = false;
    quickView._tooltips._label?.connect('destroy', () => { tooltipDestroyed = true; });
    await Main.extensionManager.disableExtension(UUID);
    await wait(500);
    out('disabled', {state: Main.extensionManager.lookup(UUID).state});
    out('tooltip-disabled', {destroyed: tooltipDestroyed, timer: quickView._tooltips._timer});
    const restored = notify(title);
    out('notification-disabled', {queued: queued(restored), restoredEmit: MessageTray.Source.prototype.emit !== originalEmit});
    restored.destroy();
    await Main.extensionManager.enableExtension(UUID);
    await wait(1500);
    out('re-enabled', {state: Main.extensionManager.lookup(UUID).state, error: Main.extensionManager.lookup(UUID).error ?? ''});
    const afterEnable = notify(title);
    out('notification-reenabled', {inList: afterEnable.source.notifications.includes(afterEnable),
        sameSource: afterEnable.source === kept.source, queued: queued(afterEnable)});
    // Activate an actual daemon-created notification button. Only the CLI transport is
    // stubbed: resolving the resource, the shared controller, and the action are real.
    const active = panel();
    const runner = active._client.runner;
    const runCommand = runner.run;
    const authCommands = [];
    runner.run = async function (argv, timeout) {
        if (argv[2] === 'resources') {
            authCommands.push(argv);
            return {ok: true, stdout: 'NAME\tADDRESS\tALIAS\nExample NAS\t192.0.2.10\tnas.example.test', stderr: ''};
        }
        if (argv[2] === 'auth') {
            authCommands.push(argv);
            return {ok: true, stdout: 'Authentication successful', stderr: ''};
        }
        return runCommand.call(this, argv, timeout);
    };
    const actionSource = afterEnable.source;
    try {
        await afterEnable.actions[0].activate();
        out('notification-authenticate', {commands: authCommands,
            dismissed: !actionSource.notifications.includes(afterEnable), error: active._controller.state.actionError});
        // Failed authentication must expose recovery in the user's visible menu.
        active._settings.set_boolean('show-panel-icon', false);
        runner.run = async function (argv, timeout) {
            if (argv[2] === 'resources')
                return {ok: true, stdout: 'NAME\tADDRESS\tALIAS\nExample NAS\t192.0.2.10\tnas.example.test', stderr: ''};
            if (argv[2] === 'auth')
                return {ok: false, stdout: '', stderr: 'Authentication cancelled'};
            return runCommand.call(this, argv, timeout);
        };
        await notify(title).actions[0].activate();
        await wait(500);
        out('notification-recovery', {quickSettings: quickSettings.menu.isOpen,
            tile: active._quick.toggle.menu.isOpen, panel: active._panel.menu.isOpen,
            feedback: active._views[1]._feedback.text.includes('Authentication cancelled')});
        await shot('4-authentication-recovery');
    } finally {
        active._quick.toggle.menu.close(false);
        quickSettings.menu.close(false);
        active._settings.set_boolean('show-panel-icon', true);
        runner.run = runCommand;
    }
    kept.destroy();
    // The first source was destroyed with muted, which removed its signal handler.
    panel()._settings.set_boolean('resource-authentication-popups', true);

    if (!LIVE_ACTIONS)
        return;
    // Pauses the real connection for a few seconds through the actual buttons.
    const live = panel();
    out('before-pause', await settled(live));
    if (live._controller.state.status !== 'online')
        return;
    live._panel.menu.open(false);
    await wait(1000);
    live._views[0]._primary.emit('clicked', 1);
    await wait(300);
    out('pause-busy', {busy: live._controller.state.busy, reactive: live._views[0]._primary.reactive});
    out('pause', await settled(live));
    await shot('4-paused');
    live._views[0]._primary.emit('clicked', 1);
    await wait(300);
    out('resume', await settled(live));
    live._panel.menu.close(false);
    if (live._controller.state.status !== 'online') {
        await live._controller.act('resume');
        out('safety-resume', await settled(live));
    }
}

export default class ShellProbe extends Extension {
    enable() {
        if (started)
            return;
        started = true;
        this._source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._source = 0;
            run().catch(error => out('fatal', `${error}\n${error.stack}`)).finally(() => {
                out('done', true);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    global.context.terminate();
                    return GLib.SOURCE_REMOVE;
                });
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._source)
            GLib.Source.remove(this._source);
        this._source = 0;
    }
}
