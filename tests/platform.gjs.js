// Real installed GNOME library contracts and stylesheet parsing without a compositor.
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
function assert(value, message) { if (!value) throw new Error(message); }
for (const [klass, names] of [
    [St.BoxLayout, ['orientation', 'x-expand']],
    [St.Entry, ['primary-icon', 'hint-text', 'clutter-text']],
    [St.ScrollView, ['child', 'hscrollbar-policy', 'vscrollbar-policy', 'overlay-scrollbars']],
    [St.Button, ['child', 'can-focus', 'accessible-name', 'label']],
    [Adw.ActionRow, ['use-markup', 'title', 'subtitle']],
    [Adw.EntryRow, ['text', 'title']],
    [Adw.SwitchRow, ['active']],
]) {
    const properties = klass.list_properties().map(p => p.name);
    for (const name of names) assert(properties.includes(name), `${klass.name} has no property ${name}`);
}
assert(Clutter.Orientation.VERTICAL !== undefined, 'Vertical orientation unavailable');
assert(typeof St.ScrollView.prototype.set_child === 'function', 'ScrollView child API unavailable');
assert(typeof Adw.PreferencesWindow.prototype.add_toast === 'function', 'Toast API unavailable');
assert(Gtk.Align.CENTER !== undefined, 'GTK alignment unavailable');
print('PASS: installed GNOME and GTK/libadwaita property and method contracts');
const root = GLib.get_current_dir();
const theme = new St.Theme();
theme.load_stylesheet(Gio.File.new_for_path(`${root}/stylesheet.css`));
print('PASS: real St stylesheet parser');
const source = Gio.SettingsSchemaSource.new_from_directory(`${root}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
const schema = source.lookup('org.gnome.shell.extensions.twingate-panel', false);
// Never touch the desktop user's dconf: the schema path is the installed extension's.
const settings = new Gio.Settings({settings_schema: schema, backend: Gio.memory_settings_backend_new()});
assert(settings.get_int('poll-interval-seconds') === 5, 'polling default');
assert(settings.get_boolean('ping-enabled') === false, 'no background checks by default');
assert(settings.get_boolean('resource-authentication-popups') === true, 'resource banners enabled by default');
settings.set_boolean('resource-authentication-popups', false);
assert(settings.get_boolean('resource-authentication-popups') === false, 'resource banners can be disabled');
settings.set_strv('favorite-resources', ['example']);
assert(settings.get_strv('favorite-resources')[0] === 'example', 'favorites persistence');
settings.set_string('resource-links', '{"host.test":"https://host.test/"}');
assert(settings.get_string('resource-links').includes('https://host.test/'), 'resource link persistence');
print('PASS: compiled GSettings schema defaults and round-trip storage (memory backend)');
