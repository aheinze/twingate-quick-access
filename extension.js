// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import St from 'gi://St';
import GObject from 'gi://GObject';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {CommandRunner, scheduler} from './runner.js';
import {TwingateClient} from './client.js';
import {Controller} from './controller.js';
import {MenuContent, stateIcon} from './menu.js';
import {STATES, accountLabel} from './model.js';

function isResourceAuthentication(source, notification) {
    return source.title === 'twingate-notifier' &&
        notification?.title === 'Twingate Client: Additional authentication required';
}

const PanelIndicator = GObject.registerClass(class TwingatePanelIndicator extends PanelMenu.Button {
    _init(logo) {
        super._init(0, 'Twingate', false);
        this.icon = new St.Icon({gicon: logo, style_class: 'system-status-icon'});
        this.add_child(this.icon);
    }
});

const QuickIndicator = GObject.registerClass(class TwingateQuickIndicator extends QuickSettings.SystemIndicator {
    _init(logo) {
        super._init();
        this.icon = this._addIndicator();
        this.icon.gicon = logo;
        this.toggle = new QuickSettings.QuickMenuToggle({title: 'Twingate',
            subtitle: 'Checking…', gicon: logo, toggleMode: false});
        this.quickSettingsItems.push(this.toggle);
    }
    destroy() {
        // GNOME parents the dropdown under its shared overlay, not under the tile.
        this.toggle.menu.destroy();
        this.toggle.destroy();
        this.toggle = null;
        this.quickSettingsItems = [];
        super.destroy();
        this.icon = null;
    }
});

export default class TwingatePanelExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._notificationFilter = new InjectionManager();
        const settings = this._settings;
        // Filter the banner request, not notification delivery: the notification list
        // keeps its Authenticate action. This also catches replacements from sources
        // created before enable(), whose tray callbacks are already bound.
        this._notificationFilter.overrideMethod(MessageTray.Source.prototype, 'emit', original => function (signal, ...args) {
            if (signal === 'notification-request-banner' &&
                !settings.get_boolean('resource-authentication-popups') &&
                isResourceAuthentication(this, args[0]))
                return;
            return original.call(this, signal, ...args);
        });
        const extension = this;
        // Resolve the action at click time so existing and replaced notifications work,
        // including those retained in the notification list with banners disabled.
        this._notificationFilter.overrideMethod(MessageTray.Action.prototype, 'activate', original => function (...args) {
            if (this.label === 'Authenticate') {
                for (const source of Main.messageTray.getSources()) {
                    const notification = source.notifications.find(item =>
                        isResourceAuthentication(source, item) && item.actions.includes(this));
                    if (notification) return extension._authenticateNotification(notification);
                }
            }
            return original.call(this, ...args);
        });
        this._views = [];
        this._previousStatus = null;
        // A -symbolic SVG is recolored by the Shell to match the panel and theme.
        this._logo = Gio.FileIcon.new(this.dir.resolve_relative_path('icons/twingate-panel-symbolic.svg'));
        this._client = new TwingateClient(new CommandRunner());
        this._controller = new Controller(this._client, scheduler, state => this._render(state));
        const actions = {
            settings: () => this.openPreferences(),
            diagnostics: () => this._copyDiagnostics(),
            notify: text => this._notice(text),
        };
        this._panel = new PanelIndicator(this._logo);
        Main.panel.addToStatusArea(this.uuid, this._panel);
        this._quick = new QuickIndicator(this._logo);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._quick);
        const quickMenu = this._quick.toggle.menu;
        quickMenu.actor.remove_child(quickMenu.box);
        this._quickScroll = new St.ScrollView({hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true});
        this._quickScroll.set_child(quickMenu.box);
        quickMenu.actor.add_child(this._quickScroll);
        this._toggleClicked = this._quick.toggle.connect('clicked', () => {
            const {status, busy} = this._controller.state;
            if (busy || status === 'unknown') return;
            if (status === 'missing' || status === 'error') this._quick.toggle.menu.open();
            else void this._controller.primaryAction();
        });
        for (const menu of [this._panel.menu, this._quick.toggle.menu]) {
            const view = new MenuContent(menu, this._controller, this._settings, actions,
                {compact: menu === this._quick.toggle.menu, logo: this._logo});
            this._views.push(view);
        }
        this._panelMenuChanged = this._panel.menu.connect('open-state-changed', menu => this._menuOpenChanged(menu));
        this._quickMenuChanged = this._quick.toggle.menu.connect('open-state-changed', menu => this._menuOpenChanged(menu));
        this._toggleAllocationChanged = this._quick.toggle.connect('notify::allocation', () => this._syncQuickMenuHeight());
        this._menuAllocationChanged = this._quick.toggle.menu.actor.connect('notify::allocation', () => this._syncQuickMenuHeight());
        this._keyFocusChanged = global.stage.connect('notify::key-focus', () => this._revealQuickMenuFocus());
        this._settingsChanged = this._settings.connect('changed', () => {
            this._panel.visible = this._settings.get_boolean('show-panel-icon');
            this._syncPolling();
            this._render(this._controller.state);
        });
        this._network = Gio.NetworkMonitor.get_default();
        this._networkChanged = this._network.connect('network-changed', () => void this._controller.refresh());
        // Keep the tile's subtitle current when Quick Settings opens. This is a status-only
        // read; resources load when the Twingate menu itself is expanded.
        this._quickSettingsMenu = Main.panel.statusArea.quickSettings.menu;
        this._quickSettingsChanged = this._quickSettingsMenu.connect('open-state-changed', (_menu, open) => {
            if (open) void this._controller.refresh();
        });
        this._panel.visible = this._settings.get_boolean('show-panel-icon');
        this._syncPolling();
        this._render(this._controller.state);
        void this._controller.refresh();
    }

    _syncPolling() {
        this._controller.setPolling(this._settings.get_int('poll-interval-seconds'),
            this._views.some(view => view.menu.isOpen));
    }

    _menuOpenChanged(menu) {
        if (menu === this._quick.toggle.menu && menu.isOpen) this._syncQuickMenuHeight();
        this._syncPolling();
        if (menu.isOpen) void this._controller.refresh();
    }

    _syncQuickMenuHeight() {
        const menu = this._quick?.toggle.menu;
        if (!menu?.isOpen) return;
        const monitor = Main.layoutManager.findMonitorForActor(menu.sourceActor);
        if (!monitor) return;
        const [, y] = menu.sourceActor.get_transformed_position();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // Leave room for the tile-to-menu gap and the outer Quick Settings padding.
        // Scroll the whole dropdown so expanded submenus cannot squeeze individual
        // controls below their usable height on a short screen.
        const height = Math.max(1, Math.floor((monitor.y + monitor.height - y - menu.sourceActor.height) / scale - 40));
        const style = `max-height: ${height}px;`;
        if (this._quickScroll.get_style() !== style) this._quickScroll.set_style(style);
    }

    _revealQuickMenuFocus() {
        const focus = global.stage.get_key_focus();
        if (!this._quick.toggle.menu.isOpen || !focus || !this._quickScroll.contains(focus)) return;
        const [, focusY] = focus.get_transformed_position();
        const [, focusHeight] = focus.get_transformed_size();
        let shift = 0;
        for (let actor = focus.get_parent(); actor; actor = actor.get_parent()) {
            if (actor instanceof St.ScrollView) {
                const [, y] = actor.get_transformed_position();
                const [, height] = actor.get_transformed_size();
                const scale = height / actor.height || 1;
                const top = focusY - shift - y;
                const delta = top < 0 ? top : Math.max(0, top + focusHeight - height);
                const adjustment = actor.get_vadjustment();
                const previous = adjustment.value;
                adjustment.value = Math.max(adjustment.lower,
                    Math.min(adjustment.upper - adjustment.page_size, previous + delta / scale));
                shift += (adjustment.value - previous) * scale;
            }
            if (actor === this._quickScroll) break;
        }
    }

    _render(state) {
        const info = STATES[state.status] ?? STATES.error;
        for (const view of this._views) view.update(state);
        const icon = stateIcon(state.status, this._logo);
        this._panel.icon.gicon = icon;
        // A dimmed mark means "not connected"; attention states keep full contrast.
        this._panel.icon.opacity = info.connected || info.attention ? 255 : 128;
        this._panel.accessible_name = `Twingate: ${info.label}`;
        this._quick.toggle.checked = state.status === 'online';
        this._quick.toggle.gicon = icon;
        this._quick.toggle.subtitle = state.busy ? 'Working…' :
            state.status === 'online' ? accountLabel(state.accounts) : info.label;
        this._quick.icon.gicon = icon;
        this._quick.icon.visible = !this._panel.visible && ['online', 'authenticating', 'error'].includes(state.status);
        const previous = this._previousStatus;
        // A reconnect passes through 'authenticating' briefly, so it is not remembered as a
        // change; otherwise each network change would announce "Connected" again.
        if (state.status !== 'authenticating') this._previousStatus = state.status;
        // Extensions are re-enabled at every login and unlock; the first status read is not a change.
        if (!previous || previous === 'unknown' || previous === state.status || state.busy ||
            !this._settings.get_boolean('notifications-enabled'))
            return;
        if (state.status === 'online') Main.notify('Twingate', 'Connected to your private network');
        else if (state.status === 'paused') Main.notify('Twingate', 'Connection paused');
        else if (state.status === 'error') Main.notify('Twingate', 'Connection unavailable. Open Twingate to retry.');
    }

    _notice(text) {
        for (const view of this._views) view.showNotice(text);
    }

    async _authenticateNotification(notification) {
        const controller = this._controller;
        if (!controller) return;
        if (controller.state.busy) {
            Main.notify('Twingate', 'Another Twingate action is in progress. Try Authenticate again when it finishes.');
            return;
        }
        // The CLI initiates authentication directly, avoiding the notifier's dead
        // action callback. The shared controller serializes this with menu actions.
        const operation = controller.act('authenticateNotification', notification.body);
        if (!notification.resident) notification.destroy();
        let success = false;
        try { success = await operation; } catch { /* Report an actionable error below. */ }
        if (this._controller !== controller) return;
        if (!success) {
            Main.notify('Twingate', 'Resource authentication did not complete. Open Twingate to retry.');
            if (this._panel.visible) this._panel.menu.open();
            else {
                this._quickSettingsMenu.open();
                this._quick.toggle.menu.open();
            }
        }
    }

    _copyDiagnostics() {
        const state = this._controller.state;
        const text = [
            `${this.metadata.name} ${this.metadata['version-name']}`,
            `GNOME ${Config.PACKAGE_VERSION}`,
            `Client: ${state.version || 'unavailable'}`,
            `State: ${state.status}`,
            `Capabilities: ${Object.entries(state.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(', ')}`,
            `Status error: ${Boolean(state.error)}`,
            `Action error: ${Boolean(state.actionError)}`,
            `Resource refresh error: ${Boolean(state.resourceError)}`,
            `Account refresh error: ${Boolean(state.accountError)}`,
            `Routing refresh error: ${Boolean(state.exitError)}`,
            'Account identities, resource addresses, command output, and tokens are excluded.',
        ].join('\n');
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._notice('Diagnostics copied · private details excluded');
    }

    disable() {
        this._notificationFilter?.clear();
        this._notificationFilter = null;
        if (this._settingsChanged) this._settings.disconnect(this._settingsChanged);
        if (this._networkChanged) this._network.disconnect(this._networkChanged);
        if (this._quickSettingsChanged) this._quickSettingsMenu.disconnect(this._quickSettingsChanged);
        if (this._keyFocusChanged) global.stage.disconnect(this._keyFocusChanged);
        if (this._toggleClicked) this._quick.toggle.disconnect(this._toggleClicked);
        if (this._panelMenuChanged) this._panel.menu.disconnect(this._panelMenuChanged);
        if (this._quickMenuChanged) this._quick.toggle.menu.disconnect(this._quickMenuChanged);
        if (this._toggleAllocationChanged) this._quick.toggle.disconnect(this._toggleAllocationChanged);
        if (this._menuAllocationChanged) this._quick.toggle.menu.actor.disconnect(this._menuAllocationChanged);
        this._controller?.dispose();
        this._views?.forEach(view => view.destroy());
        if (this._quickScroll) {
            // Restore the menu's box before destroying our wrapper, so each owner
            // destroys its own actors and the menu can still close normally.
            this._quickScroll.set_child(null);
            this._quick.toggle.menu.actor.add_child(this._quick.toggle.menu.box);
            this._quickScroll.destroy();
        }
        this._quickScroll = null;
        this._quick?.destroy();
        this._quick = null;
        this._panel?.destroy();
        this._panel = null;
        this._settingsChanged = this._networkChanged = this._quickSettingsChanged = 0;
        this._keyFocusChanged = 0;
        this._toggleClicked = 0;
        this._panelMenuChanged = 0;
        this._quickMenuChanged = 0;
        this._toggleAllocationChanged = 0;
        this._menuAllocationChanged = 0;
        this._controller = null;
        this._client = null;
        this._settings = null;
        this._network = null;
        this._quickSettingsMenu = null;
        this._logo = null;
        this._views = [];
    }
}
