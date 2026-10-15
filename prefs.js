// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {objectSetting, safeWebUri} from './model.js';

export default class TwingatePanelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(620, 720);
        // The preferences process outlives its windows, so the path is added once.
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        const icons = this.dir.get_child('icons').get_path();
        if (!theme.get_search_path().includes(icons)) theme.add_search_path(icons);
        const page = new Adw.PreferencesPage({title: 'Twingate', icon_name: 'twingate-panel-symbolic'});
        window.add(page);
        const appearance = new Adw.PreferencesGroup({title: 'At home in GNOME',
            description: 'Your private network is always available in Quick Settings.'});
        page.add(appearance);
        const toggle = (group, key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };
        toggle(appearance, 'show-panel-icon', 'Panel shortcut', 'Also show a dedicated icon for one-click access to resources.');
        const polling = new Adw.SpinRow({title: 'Refresh interval',
            subtitle: 'Seconds while a menu is open; six times slower in the background.',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1})});
        settings.bind('poll-interval-seconds', polling, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearance.add(polling);

        const notifications = new Adw.PreferencesGroup({title: 'Notifications'});
        page.add(notifications);
        toggle(notifications, 'notifications-enabled', 'Connection notifications',
            'Notify when connected, paused, or unavailable.');
        toggle(notifications, 'resource-authentication-popups', 'Resource authentication popups',
            'Show “Additional authentication required” banners. When off, requests stay in the notification list. Account sign-in prompts still appear.');

        const resources = new Adw.PreferencesGroup({title: 'Your resources',
            description: 'Select a resource name to copy its address. Stars keep favorites at the top.'});
        page.add(resources);
        toggle(resources, 'ping-enabled', 'Show ICMP check buttons',
            'Checks run only when clicked. No response does not mean an application is unavailable.');
        const reset = new Adw.ActionRow({title: 'Clear favorites', subtitle: 'Resource access and client configuration are unaffected.'});
        const resetButton = new Gtk.Button({label: 'Clear', valign: Gtk.Align.CENTER});
        resetButton.connect('clicked', () => {
            settings.set_strv('favorite-resources', []);
            window.add_toast(new Adw.Toast({title: 'Favorites cleared'}));
        });
        reset.add_suffix(resetButton);
        resources.add(reset);

        const linksPage = new Adw.PreferencesPage({title: 'Resource links', icon_name: 'external-link-symbolic'});
        window.add(linksPage);
        const addGroup = new Adw.PreferencesGroup({title: 'A shortcut to the right place',
            description: 'Save a website for an exact resource address or alias. An Open button appears beside matching resources. HTTP and HTTPS only; destinations are never guessed.'});
        linksPage.add(addGroup);
        const address = new Adw.EntryRow({title: 'Resource address or alias · exactly as listed'});
        const destination = new Adw.EntryRow({title: 'Website URL · https://…'});
        addGroup.add(address);
        addGroup.add(destination);
        const saveRow = new Adw.ActionRow({title: 'Save website shortcut'});
        const save = new Gtk.Button({label: 'Save link', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
        saveRow.add_suffix(save);
        addGroup.add(saveRow);
        const savedGroup = new Adw.PreferencesGroup({title: 'Saved destinations'});
        linksPage.add(savedGroup);
        let rows = [];
        const renderLinks = () => {
            for (const row of rows) savedGroup.remove(row);
            rows = [];
            for (const [host, uri] of Object.entries(objectSetting(settings.get_string('resource-links'))).sort()) {
                const row = new Adw.ActionRow({title: host, subtitle: String(uri), use_markup: false});
                const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
                    tooltip_text: `Remove link for ${host}`});
                remove.connect('clicked', () => {
                    const links = objectSetting(settings.get_string('resource-links'));
                    delete links[host];
                    settings.set_string('resource-links', JSON.stringify(links));
                });
                row.add_suffix(remove);
                savedGroup.add(row);
                rows.push(row);
            }
            savedGroup.visible = rows.length > 0;
        };
        save.connect('clicked', () => {
            const host = address.text.trim();
            const uri = safeWebUri(destination.text);
            if (!host || /\s/.test(host) || !uri) {
                window.add_toast(new Adw.Toast({title: 'Enter a resource address and a valid HTTP or HTTPS URL.'}));
                return;
            }
            const links = objectSetting(settings.get_string('resource-links'));
            Object.defineProperty(links, host, {value: uri, enumerable: true, configurable: true, writable: true});
            settings.set_string('resource-links', JSON.stringify(links));
            address.text = destination.text = '';
            window.add_toast(new Adw.Toast({title: 'Website shortcut saved'}));
        });
        const linksChanged = settings.connect('changed::resource-links', renderLinks);
        window.connect('close-request', () => { settings.disconnect(linksChanged); return false; });
        renderLinks();

        const about = new Adw.PreferencesGroup({title: `Twingate Panel ${this.metadata['version-name']}`,
            description: 'A community interface for the official Twingate Linux client. Not affiliated with or endorsed by Twingate. Your existing client manages credentials and network policy.'});
        page.add(about);
        const help = new Adw.ActionRow({title: 'Setup and troubleshooting', subtitle: 'Official Twingate Linux documentation'});
        help.add_suffix(new Gtk.LinkButton({label: 'Open guide', uri: 'https://www.twingate.com/docs/linux', valign: Gtk.Align.CENTER}));
        about.add(help);
    }
}
