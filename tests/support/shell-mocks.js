// Behavioral doubles for GNOME lifecycle tests. These are not a visual or real-session test.
export class Actor {
    constructor(...args) { this._init(...args); }
    _init(props = {}) {
        this.children = []; this.signals = new Map(); this.visible = true; this.reactive = true;
        this._classes = new Set(); this._pseudos = new Set();
        Object.assign(this, props);
    }
    connect(name, callback) { const id = Symbol(name); this.signals.set(id, {name, callback}); return id; }
    disconnect(id) { this.signals.delete(id); }
    emit(name, ...args) { for (const signal of [...this.signals.values()]) if (signal.name === name) signal.callback(this, ...args); }
    add_child(child) { this.children.push(child); child.parent = this; }
    remove_child(child) { this.children = this.children.filter(c => c !== child); child.parent = null; }
    set_child(child) { this.child = child; this.children = []; this.add_child(child); }
    get_children() { return this.children; }
    get_child_at_index(i) { return this.children[i]; }
    set_child_at_index(child, i) { this.children = this.children.filter(c => c !== child); this.children.splice(i, 0, child); }
    add_style_class_name(value) { this._classes.add(value); }
    remove_style_class_name(value) { this._classes.delete(value); }
    add_style_pseudo_class(value) { this._pseudos.add(value); }
    remove_style_pseudo_class(value) { this._pseudos.delete(value); }
    destroy() { this.destroyed = true; this.signals.clear(); for (const child of this.children) child.destroy();
        if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
    setSensitive(value) { this.sensitive = value; }
    get_transformed_position() { return [0, 227]; }
    get_style() { return this.style ?? null; }
    set_style(style) { this.style = style; }
}
class Text extends Actor { _init(props = {}) { super._init(props); this.clutter_text = new Actor(); } }
class Entry extends Text {
    get_text() { return this.text ?? ''; }
    set_text(text) { this.text = text; this.clutter_text.emit('text-changed'); }
}
export const clipboard = {text: '', set_text(_type, text) { this.text = text; }};
export const St = {BoxLayout: Actor, Label: Text, Icon: Actor, Button: Actor, Entry, ScrollView: Actor,
    ThemeContext: {get_for_stage: () => ({scale_factor: 1})},
    PolicyType: {NEVER: 0, AUTOMATIC: 1}, Clipboard: {get_default: () => clipboard}, ClipboardType: {CLIPBOARD: 1}};
export const Clutter = {Orientation: {HORIZONTAL: 0, VERTICAL: 1}, ActorAlign: {CENTER: 0}};
export const Pango = {EllipsizeMode: {NONE: 0, END: 1}};
export class Menu {
    constructor() { this.actor = new Actor(); this.box = new Actor(); this.actor.add_child(this.box);
        this.items = []; this.isOpen = false; this.signals = new Actor(); }
    addMenuItem(item) {
        // GNOME closes the open submenu whenever any nested submenu opens, so nesting is unusable.
        if (this.isSubMenu && item instanceof SubMenu) throw new Error('Nested submenus cannot be opened in GNOME Shell');
        this.items.push(item); this.box.add_child(item);
    }
    addAction(text, action) { const item = new MenuItem(text); item.connect('activate', action); this.addMenuItem(item); return item; }
    removeAll() { for (const item of this.items) item.destroy(); this.items = []; }
    close() { this.isOpen = false; this.signals.emit('open-state-changed', false); }
    open() { this.isOpen = true; this.signals.emit('open-state-changed', true); }
    connect(...args) { return this.signals.connect(...args); }
    disconnect(id) { this.signals.disconnect(id); }
    destroy() { this.removeAll(); this.actor.destroy(); this.signals.destroy(); }
}
class MenuItem extends Actor {
    _init(text = '', props = {}) { super._init(props); this.label = new Text({text}); this.add_child(this.label); }
    setOrnament(value) { this.ornament = value; }
}
class SubMenu extends MenuItem {
    _init(text) { super._init(text); this.menu = new Menu(); this.menu.isSubMenu = true; this.icon = new Actor(); }
    destroy() { this.menu.destroy(); super.destroy(); }
}
export const PopupMenu = {PopupBaseMenuItem: Actor, PopupMenuItem: MenuItem,
    PopupSeparatorMenuItem: Actor, PopupSubMenuMenuItem: SubMenu, Ornament: {CHECK: 1}};
export const ShellEntry = {addContextMenu() {}};
class PanelButton extends Actor {
    _init() { super._init(); this.menu = new Menu(); }
    destroy() { this.menu.destroy(); super.destroy(); }
}
export const PanelMenu = {Button: PanelButton};
class SystemIndicator extends Actor {
    _init() { super._init(); this.quickSettingsItems = []; }
    _addIndicator() { const icon = new Actor(); this.add_child(icon); return icon; }
}
export const QuickSettings = {SystemIndicator, QuickMenuToggle: class extends PanelButton {
    _init(props) { super._init(); Object.assign(this, props); this.height = 48; this.menu.sourceActor = this; }
}};
export const GObject = {registerClass: cls => cls};
export class Settings extends Actor {
    _init() { super._init(); this.values = {'show-panel-icon': true, 'notifications-enabled': false,
        'resource-authentication-popups': true,
        'poll-interval-seconds': 5, 'ping-enabled': false, 'favorite-resources': [], 'resource-links': '{}'}; }
    get_boolean(key) { return this.values[key]; }
    get_int(key) { return this.values[key]; }
    get_string(key) { return this.values[key]; }
    get_strv(key) { return [...this.values[key]]; }
    set_strv(key, value) { this.values[key] = value; this.emit('changed', key); }
}
export const network = new Actor();
export const stage = new Actor();
stage.get_key_focus = () => null;
globalThis.stage = stage;
export const settings = new Settings();
export class InjectionManager {
    constructor() { this.methods = []; }
    overrideMethod(target, key, override) {
        const original = target[key];
        this.methods.push(() => { target[key] = original; });
        target[key] = override(original);
    }
    clear() { this.methods.reverse().forEach(restore => restore()); this.methods = []; }
}
export const MessageTray = {Source: class extends Actor {}, Action: class {
    constructor(label, callback) { this.label = label; this.callback = callback; }
    activate() { return this.callback(); }
}};
export class Extension {
    constructor() {
        this.uuid = 'twingate-panel@urhend'; this.metadata = {'version-name': 'test'};
        this.dir = {resolve_relative_path: path => ({path})};
    }
    getSettings() { return settings; }
    openPreferences() {}
}
export const Gio = {
    NetworkMonitor: {get_default: () => network},
    FileIcon: {new: file => ({file})},
    ThemedIcon: {new: name => ({name})},
    AppInfo: {launch_default_for_uri() {}},
    SubprocessFlags: {STDOUT_PIPE: 1, STDERR_PIPE: 2},
    IOErrorEnum: {NOT_FOUND: 1},
    Subprocess: class { init() { const e = new Error('Client missing in test'); e.matches = () => true; throw e; } },
};
let timerId = 0;
export const timers = new Map();
export const GLib = {
    PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SpawnError: {NOENT: 1},
    timeout_add(_priority, ms, callback) { timers.set(++timerId, {ms, callback}); return timerId; },
    Source: {remove(id) { timers.delete(id); }},
};
export const quickSettingsMenu = new Menu();
export const notifications = [];
export const notificationSources = [];
export const Main = {panel: {addToStatusArea() {}, statusArea: {quickSettings: {addExternalIndicator() {}, menu: quickSettingsMenu}}},
    layoutManager: {findMonitorForActor: () => ({y: 0, height: 800})},
    messageTray: {getSources: () => notificationSources},
    notify(...args) { notifications.push(args); }};
export const Config = {PACKAGE_VERSION: '50.mock'};
