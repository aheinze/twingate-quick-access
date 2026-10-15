// SPDX-License-Identifier: GPL-3.0-or-later
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';
import {STATES, accountLabel, filteredResources, objectSetting, safeWebUri, isProbeable} from './model.js';
import {IconTooltips} from './tooltips.js';

const HELP_URI = 'https://www.twingate.com/docs/linux';
const BUSY_LABELS = {start: 'Connecting…', resume: 'Resuming…', pause: 'Pausing…',
    stop: 'Stopping client…', authenticate: 'Waiting for authentication…', signIn: 'Opening sign-in…',
    authenticateNotification: 'Waiting for authentication…',
    switchAccount: 'Switching account…', exitStart: 'Changing traffic routing…', exitSwitch: 'Changing traffic routing…',
    exitStop: 'Changing traffic routing…'};

// The Twingate mark identifies the connection; states that need the user keep a distinct icon.
export function stateIcon(status, logo) {
    const info = STATES[status] ?? STATES.error;
    return info.attention ? Gio.ThemedIcon.new(info.icon) : logo;
}

function box(style = '', vertical = false) {
    return new St.BoxLayout({style_class: style, orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        x_expand: true});
}

function label(text, style = '') {
    const widget = new St.Label({text, style_class: style, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    // St CSS doesn't implement the browser's opacity property.
    if (['tp-caption', 'tp-network-title', 'tp-resource-address', 'tp-eyebrow'].includes(style))
        widget.opacity = 170;
    widget.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return widget;
}

function linkFor(links, resource) {
    const key = [resource.address, resource.alias].find(value => value && Object.hasOwn(links, value));
    return key ? safeWebUri(links[key]) : null;
}

// Most important first: narrow menus ellipsize the end, and the alias is what people use.
function resourceDetail(row, compact = false) {
    const {alias, address, authorization} = row.resource;
    if (compact) {
        const status = (authorization || '').replace(/^auth expires in /i, '').trim();
        const expiry = /^auth expires in /i.test(authorization || '') ? `${status} left` :
            /^(pending|locked|expired)$/i.test(status) ? 'Sign-in required' :
            /^(authenticated|authorized)$/i.test(status) ? '' : status;
        return [alias || address, row.probeStatus || expiry].filter(Boolean).join(' · ');
    }
    return [alias, authorization && `Auth ${authorization.toLocaleLowerCase()}`, row.probeStatus, address]
        .filter(Boolean).join(' · ');
}

function iconButton(icon, title, callback) {
    const button = new St.Button({style_class: 'tp-icon-button', can_focus: true, y_align: Clutter.ActorAlign.CENTER,
        accessible_name: title, child: new St.Icon({icon_name: icon, icon_size: 16})});
    button.connect('clicked', callback);
    return button;
}

function contentItem(content, style = '') {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    // These are containers for interactive children, not disabled menu actions.
    // Native insensitive menu styling would dim every label and control inside.
    item.remove_style_class_name('popup-menu-item');
    item.remove_style_class_name('popup-inactive-menu-item');
    item.add_style_class_name('tp-content');
    if (style) item.add_style_class_name(style);
    item.add_child(content);
    return item;
}

export class MenuContent {
    constructor(menu, controller, settings, actions, {compact = false, logo = null} = {}) {
        this.menu = menu;
        this._logo = logo;
        this.controller = controller;
        this.settings = settings;
        this.actions = actions;
        this._compact = compact;
        this._rows = new Map();
        this._query = '';
        this._favoritesOnly = false;
        this._state = controller.state;
        this._destroyed = false;
        this._probeCount = 0;
        this._accountSignature = '';
        this._exitSignature = '';
        this._resourceSignature = '';
        this._tooltips = new IconTooltips(menu);
        this._build();
    }

    _iconButton(icon, title, callback) {
        const button = iconButton(icon, title, callback);
        this._tooltips.add(button);
        return button;
    }

    _build() {
        this.menu.actor.add_style_class_name('twingate-menu');
        if (this._compact) this.menu.actor.add_style_class_name('twingate-compact');
        const heading = box('tp-heading');
        const wordmark = box('', true);
        wordmark.add_child(label('Twingate', 'tp-heading-title'));
        this._network = label('Private network', 'tp-network-title');
        wordmark.add_child(this._network);
        heading.add_child(wordmark);
        heading.add_child(this._iconButton('preferences-system-symbolic', 'Twingate preferences', () => {
            this.menu.close(); this.actions.settings();
        }));
        const headingItem = contentItem(heading);
        headingItem.visible = !this._compact;
        this.menu.addMenuItem(headingItem);

        const card = box('tp-connection-card');
        this._statusIcon = new St.Icon({gicon: this._logo, icon_size: 16, style_class: 'tp-state-icon',
            y_align: Clutter.ActorAlign.CENTER});
        card.add_child(this._statusIcon);
        const statusText = box('tp-status-text', true);
        this._statusTitle = label('Checking connection…', 'tp-status-title');
        this._statusDescription = label('Reading client status', 'tp-caption');
        statusText.add_child(this._statusTitle);
        statusText.add_child(this._statusDescription);
        card.add_child(statusText);
        this._primary = new St.Button({label: 'Connect', style_class: 'tp-primary-button', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._primary.connect('clicked', () => {
            if (this._state.status === 'missing') this._openUri(HELP_URI);
            else if (this._state.status === 'error') void this.controller.retry();
            else void this.controller.primaryAction();
        });
        card.add_child(this._primary);
        this.menu.addMenuItem(contentItem(card));

        const feedback = box('tp-feedback', true);
        this._feedback = label('', 'tp-caption');
        this._feedback.clutter_text.line_wrap = true;
        this._feedback.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        feedback.add_child(this._feedback);
        this._feedbackItem = contentItem(feedback);
        this._feedbackItem.visible = false;
        this.menu.addMenuItem(this._feedbackItem);

        const search = box('tp-search-bar');
        this._search = new St.Entry({hint_text: 'Filter resources…', style_class: 'search-entry tp-search',
            can_focus: true, x_expand: true, accessible_name: 'Search Twingate resources',
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 16})});
        ShellEntry.addContextMenu(this._search);
        this._search.clutter_text.connect('text-changed', () => {
            this._query = this._search.get_text();
            this._renderResources();
        });
        search.add_child(this._search);
        this._favoritesButton = this._iconButton('starred-symbolic', 'Show favorites only', () => {
            this._favoritesOnly = !this._favoritesOnly;
            if (this._favoritesOnly) this._favoritesButton.add_style_pseudo_class('checked');
            else this._favoritesButton.remove_style_pseudo_class('checked');
            this._favoritesButton.accessible_name = this._favoritesOnly ? 'Show all resources' : 'Show favorites only';
            this._renderResources();
        });
        search.add_child(this._favoritesButton);
        this._searchItem = contentItem(search);
        this.menu.addMenuItem(this._searchItem);

        const resourceHeading = box('tp-resource-heading');
        this._resourceTitle = label('RESOURCES', 'tp-eyebrow');
        this._resourceCount = label('', 'tp-caption');
        this._resourceCount.x_expand = false;
        resourceHeading.add_child(this._resourceTitle);
        resourceHeading.add_child(this._resourceCount);
        this._resourceHeadingItem = contentItem(resourceHeading);
        this.menu.addMenuItem(this._resourceHeadingItem);

        this._resourceBox = box('tp-resource-list', true);
        const scroll = new St.ScrollView({style_class: 'tp-scroll', x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
        scroll.set_child(this._resourceBox);
        this._scrollItem = contentItem(scroll);
        this.menu.addMenuItem(this._scrollItem);

        const empty = box('tp-empty', true);
        this._emptyTitle = label('No resources available', 'tp-empty-title');
        this._emptyDescription = label('Connect to find your private resources.', 'tp-caption');
        this._emptyDescription.clutter_text.line_wrap = true;
        this._emptyDescription.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        empty.add_child(this._emptyTitle);
        empty.add_child(this._emptyDescription);
        this._emptyItem = contentItem(empty);
        this.menu.addMenuItem(this._emptyItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        // Submenus must be siblings: opening a nested submenu makes GNOME close its parent.
        this._accounts = new PopupMenu.PopupSubMenuMenuItem('Accounts');
        this.menu.addMenuItem(this._accounts);
        this._routing = new PopupMenu.PopupSubMenuMenuItem('Traffic routing');
        this.menu.addMenuItem(this._routing);
        this._advanced = new PopupMenu.PopupSubMenuMenuItem(this._compact ? 'Options' : 'Client controls');
        this._stop = this._advanced.menu.addAction('Stop client', () => void this.controller.act('stop'));
        if (this._compact) {
            this._advanced.menu.addAction('Copy diagnostics', () => this.actions.diagnostics());
            this._advanced.menu.addAction('Add an account…', () => this._openUri(HELP_URI));
        }
        this._advanced.menu.addAction('Setup guide', () => this._openUri(HELP_URI));
        this.menu.addMenuItem(this._advanced);

        const footer = box('tp-footer');
        this._footerLabel = label('Twingate Panel', 'tp-caption');
        footer.add_child(this._footerLabel);
        this._refreshButton = this._iconButton('view-refresh-symbolic', 'Refresh connection and resources', () => {
            this._notice = '';
            void this.controller.retry();
        });
        footer.add_child(this._refreshButton);
        if (!this._compact) {
            footer.add_child(this._iconButton('edit-copy-symbolic', 'Copy diagnostics without private details', () => this.actions.diagnostics()));
            footer.add_child(this._iconButton('help-browser-symbolic', 'Twingate setup and help', () => this._openUri(HELP_URI)));
        }
        if (this._compact) footer.add_child(this._iconButton('emblem-system-symbolic', 'Twingate preferences', () => {
            this.menu.close(); this.actions.settings();
        }));
        this.menu.addMenuItem(contentItem(footer));

    }

    update(state) {
        if (this._destroyed) return;
        const statusChanged = this._state.status !== state.status;
        this._state = state;
        if (statusChanged || state.busy) this._notice = '';
        const info = STATES[state.status] ?? STATES.error;
        this._network.text = accountLabel(state.accounts);
        this._statusIcon.gicon = stateIcon(state.status, this._logo);
        this._statusIcon.style_class = `tp-state-icon ${state.status === 'online' ? 'tp-connected' : ''}`;
        this._statusIcon.opacity = state.status === 'online' ? 255 : 160;
        this._statusTitle.text = BUSY_LABELS[state.busy] ?? info.label;
        const count = state.resources.length;
        this._statusDescription.text = ['authenticate', 'authenticateNotification'].includes(state.busy) ? 'Complete authentication in your browser.' :
            state.busy === 'signIn' ? 'Select the Twingate notification to sign in.' :
            ['start', 'stop'].includes(state.busy) ? 'Approve the system prompt if asked.' :
            state.status === 'online' ? (this._compact ? accountLabel(state.accounts) :
                state.resourcesLoaded ? `${count} ${count === 1 ? 'resource' : 'resources'} available` : 'Private network connected') :
            state.status === 'paused' ? 'Session preserved' :
            state.status === 'authenticating' ? 'Select the Twingate notification to sign in.' :
            state.status === 'not-running' ? 'Connect to start the service.' :
            state.status === 'connecting' ? 'Establishing connection…' :
            state.status === 'missing' ? 'Install and configure the Linux client.' :
            state.status === 'error' ? 'Refresh to check the service.' : 'Private resources are offline.';
        this._primary.label = state.status === 'online' ? (state.capabilities.pause ? 'Pause' : 'Disconnect') :
            state.status === 'paused' ? 'Resume' : state.status === 'missing' ? 'Get started' :
            state.status === 'error' ? 'Retry' : state.status === 'authenticating' ? 'Sign in' :
            state.status === 'connecting' ? 'Connecting…' : 'Connect';
        this._primary.reactive = this._primary.can_focus = !state.busy && !['unknown', 'connecting'].includes(state.status);
        this._primary.opacity = state.busy ? 130 : 255;
        this._refreshButton.reactive = this._refreshButton.can_focus = !state.refreshing && !state.busy;
        this._stop.setSensitive(!state.busy && !['missing', 'not-running', 'unknown'].includes(state.status));
        this._footerLabel.text = state.refreshing ? 'Refreshing…' : state.updatedAt ?
            `Updated ${new Date(state.updatedAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}` : 'Waiting for the client';
        if (this._compact && state.updatedAt && !state.refreshing) {
            const minutes = Math.max(0, Math.floor((Date.now() - state.updatedAt) / 60000));
            this._footerLabel.text = minutes < 1 ? 'Updated just now' : `Updated ${minutes} min ago`;
        }
        this._feedback.text = state.actionError || state.error || this._notice || '';
        this._feedbackItem.visible = Boolean(this._feedback.text);
        this._renderResources();
        this._renderAccounts();
        this._renderRouting();
    }

    _renderResources() {
        if (this._destroyed) return;
        const state = this._state;
        const online = state.status === 'online';
        // Small lists are quicker to scan. Keep active filters visible even if a
        // refresh reduces the list, so the user can always clear them.
        this._searchItem.visible = online && (!this._compact || state.resources.length > 5 ||
            Boolean(this._query) || this._favoritesOnly);
        this._resourceHeadingItem.visible = online;
        const favorites = this.settings.get_strv('favorite-resources');
        const links = objectSetting(this.settings.get_string('resource-links'));
        const probes = this.settings.get_boolean('ping-enabled');
        const signature = JSON.stringify([state.resources, state.status, state.busy, state.resourceError,
            state.resourcesLoaded, state.capabilities.auth, favorites, links, probes, this._query, this._favoritesOnly]);
        if (signature === this._resourceSignature) return;
        this._resourceSignature = signature;
        const visible = filteredResources(state.resources, this._query, favorites, this._favoritesOnly);
        const visibleIds = new Set(visible.map(r => r.id));
        const availableIds = new Set(state.resources.map(r => r.id));
        for (const [id, row] of this._rows) {
            if (!availableIds.has(id)) { row.actor.destroy(); this._rows.delete(id); }
            else row.actor.visible = visibleIds.has(id);
        }
        visible.forEach((resource, index) => {
            let row = this._rows.get(resource.id);
            if (!row) {
                row = this._createResource(resource);
                this._rows.set(resource.id, row);
                this._resourceBox.add_child(row.actor);
            }
            row.actor.visible = true;
            row.resource = resource;
            row.address.text = resourceDetail(row, this._compact);
            if (this._resourceBox.get_child_at_index(index) !== row.actor)
                this._resourceBox.set_child_at_index(row.actor, index);
            row.favorite.child.icon_name = favorites.includes(resource.id) ? 'starred-symbolic' : 'non-starred-symbolic';
            row.favorite.accessible_name = `${favorites.includes(resource.id) ? 'Unfavorite' : 'Favorite'} ${resource.name}`;
            row.favorite.child.opacity = this._compact && !favorites.includes(resource.id) ? 150 : 255;
            row.open.visible = Boolean(linkFor(links, resource));
            row.auth.visible = Boolean(state.capabilities.auth);
            row.auth.reactive = row.auth.can_focus = !state.busy;
            row.probe.visible = probes && isProbeable(resource.address);
        });
        this._resourceCount.text = state.resourcesLoaded ? `${visible.length}${visible.length !== state.resources.length ? ` / ${state.resources.length}` : ''}` : '';
        this._resourceTitle.text = this._compact ? (this._favoritesOnly ? 'Favorites' : 'Resources') :
            this._favoritesOnly ? 'FAVORITES' : 'RESOURCES';
        this._scrollItem.visible = online && visible.length > 0;
        this._emptyItem.visible = online && visible.length === 0;
        if (state.resourceError) {
            this._emptyTitle.text = 'Resources could not be refreshed';
            this._emptyDescription.text = state.resourceError;
        } else if (online && !state.resourcesLoaded) {
            this._emptyTitle.text = 'Loading resources…';
            this._emptyDescription.text = 'Reading your resources from the client.';
        } else if (online) {
            this._emptyTitle.text = this._query ? 'No matching resources' : this._favoritesOnly ? 'No favorites yet' : 'No resources available';
            this._emptyDescription.text = this._query ? 'Try a different name, alias, or address.' : this._favoritesOnly ?
                'Star a resource to pin it here.' : 'Refresh or check access with your administrator.';
        }
    }

    _createResource(resource) {
        const actor = box('tp-resource-row');
        const titles = box('tp-resource-titles', true);
        titles.add_child(label(resource.name, 'tp-resource-name'));
        const address = label(resource.address, 'tp-resource-address');
        titles.add_child(address);
        const row = {actor, address, resource, probeStatus: ''};
        const copy = new St.Button({style_class: 'tp-resource-copy', x_expand: true, can_focus: true,
            accessible_name: `Copy address for ${resource.name}: ${resource.address}`, child: titles});
        copy.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, resource.address);
            this.actions.notify(`Address copied · ${resource.name}`);
        });
        actor.add_child(copy);
        const favorite = this._iconButton('non-starred-symbolic', `Favorite ${resource.name}`, () => {
            const values = this.settings.get_strv('favorite-resources');
            this.settings.set_strv('favorite-resources', values.includes(resource.id) ?
                values.filter(id => id !== resource.id) : [...values, resource.id]);
        });
        actor.add_child(favorite);
        const auth = this._iconButton('dialog-password-symbolic', `Authenticate access to ${resource.name}`, () => {
            void this.controller.act('authenticate', resource.name);
        });
        actor.add_child(auth);
        const open = this._iconButton('external-link-symbolic', `Open saved website for ${resource.name}`, () => {
            const uri = linkFor(objectSetting(this.settings.get_string('resource-links')), row.resource);
            if (uri) this._openUri(uri);
        });
        actor.add_child(open);
        const probe = this._iconButton('network-transmit-receive-symbolic', `Check ICMP response from ${resource.name}`, async () => {
            if (this._probeCount >= 3 || !probe.reactive) return;
            this._probeCount++;
            probe.reactive = false;
            row.probeStatus = 'Checking ICMP…';
            address.text = resourceDetail(row, this._compact);
            let result;
            try { result = await this.controller.client.probe(resource.address); }
            catch { result = 'failed'; }
            this._probeCount--;
            if (this._destroyed || this._rows.get(resource.id)?.actor !== actor) return;
            probe.reactive = true;
            row.probeStatus = result === 'reply' ? 'ICMP reply' : result === 'no-reply' ? 'No ICMP reply' : 'Check unavailable';
            address.text = resourceDetail(row, this._compact);
            if (result === 'no-reply') this.actions.notify('No ICMP reply. The application may still be available.');
        });
        actor.add_child(probe);
        return Object.assign(row, {favorite, auth, open, probe});
    }

    _renderAccounts() {
        const state = this._state;
        const signature = JSON.stringify([state.accounts, state.accountError]);
        this._accounts.visible = Boolean(state.capabilities.accounts) &&
            (!this._compact || state.accounts.length !== 1 || Boolean(state.accountError));
        this._accounts.setSensitive(!state.busy);
        if (signature === this._accountSignature) return;
        this._accountSignature = signature;
        this._accounts.menu.removeAll();
        if (state.accountError || !state.accounts.length)
            this._accounts.menu.addMenuItem(new PopupMenu.PopupMenuItem(state.accountError ?
                'Accounts unavailable · try refreshing' : 'No accounts configured', {reactive: false}));
        for (const account of state.accounts) {
            // The only account is the active one; switching to it would only reconnect.
            const current = account.active || state.accounts.length === 1;
            const item = this._accounts.menu.addAction(`${account.network} · ${account.email}`, () => {
                if (!current) void this.controller.act('switchAccount', account.id);
            });
            if (current) item.setOrnament(PopupMenu.Ornament.CHECK);
        }
        this._accounts.menu.addAction('Add an account · setup guide', () => this._openUri(HELP_URI));
    }

    _renderRouting() {
        const state = this._state;
        // Most networks have no exit nodes; the submenu appears once there is something to choose.
        this._routing.visible = Boolean(state.capabilities.exitNodes) && state.status === 'online' &&
            (state.exitNodes.length > 0 || Boolean(state.exitError));
        this._routing.setSensitive(!state.busy);
        const signature = JSON.stringify([state.exitNodes, state.exitError]);
        if (signature === this._exitSignature) return;
        this._exitSignature = signature;
        this._routing.menu.removeAll();
        if (state.exitError) {
            this._routing.menu.addMenuItem(new PopupMenu.PopupMenuItem('Routing details unavailable · refresh to retry', {reactive: false}));
            return;
        }
        this._routing.menu.addAction('Use private resources only', () => void this.controller.act('exitStop'));
        if (!state.exitNodes.length)
            this._routing.menu.addMenuItem(new PopupMenu.PopupMenuItem('No exit nodes listed', {reactive: false}));
        // The client switches between exit nodes with its own command.
        const routing = state.exitNodes.some(node => node.active);
        for (const node of state.exitNodes) {
            const item = this._routing.menu.addAction(`Route all traffic through ${node.name}`, () => {
                if (!node.active) void this.controller.act(routing ? 'exitSwitch' : 'exitStart', node.name);
            });
            if (node.active) item.setOrnament(PopupMenu.Ornament.CHECK);
        }
    }

    _openUri(uri) {
        try { Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1)); }
        catch { this.actions.notify('Could not open a browser. Check your default application.'); }
    }

    showNotice(text) {
        this._notice = text;
        this._feedback.text = text;
        this._feedbackItem.visible = true;
    }

    destroy() {
        this._destroyed = true;
        this._tooltips.destroy();
        this._rows.clear();
    }
}
