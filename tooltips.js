// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from 'gi://GLib';
import St from 'gi://St';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// One transient label per menu, using the Shell's own tooltip styling.
export class IconTooltips {
    constructor(menu) {
        this._menu = menu;
        this._buttons = new Map();
        this._scrollSignals = [];
        this._timer = 0;
        this._target = null;
        this._label = null;
        this._menuChanged = menu.connect('open-state-changed', () => this.hide());
        this._allocationChanged = menu.actor.connect('notify::allocation', () => {
            if (this._label?.visible) this.hide();
        });
        this._mappedChanged = menu.actor.connect('notify::mapped', () => {
            if (!menu.actor.mapped) this.hide();
        });
    }

    add(button) {
        button.track_hover = true;
        const hide = () => { if (this._target === button) this.hide(); };
        const signals = [
            button.connect('notify::hover', () => button.hover ? this._schedule(button) : hide()),
            button.connect('key-focus-in', () => this._schedule(button)),
            button.connect('key-focus-out', hide),
            button.connect('clicked', hide),
            button.connect('notify::pressed', () => { if (button.pressed) hide(); }),
            button.connect('notify::mapped', () => { if (!button.mapped) hide(); }),
            button.connect('notify::reactive', () => { if (!button.reactive) hide(); }),
            button.connect('notify::accessible-name', () => {
                if (this._target === button && this._label?.visible) this._label.text = button.accessible_name;
            }),
            button.connect('destroy', () => { hide(); this._buttons.delete(button); }),
        ];
        this._buttons.set(button, signals);
    }

    _schedule(button) {
        this.hide();
        if (!this._menu.isOpen || !button.mapped || !button.reactive) return;
        this._target = button;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
            this._timer = 0;
            this._show();
            return GLib.SOURCE_REMOVE;
        });
    }

    _show() {
        const button = this._target;
        if (!button || !this._menu.isOpen || !button.mapped || !button.reactive ||
            !(button.hover || button.has_key_focus()) || !button.accessible_name) {
            this.hide();
            return;
        }
        const monitor = Main.layoutManager.findMonitorForActor(button);
        if (!monitor) return;
        const [x, y] = button.get_transformed_position();
        const [width, height] = button.get_transformed_size();
        for (let parent = button.get_parent(); parent; parent = parent.get_parent()) {
            if (!(parent instanceof St.ScrollView)) continue;
            const [, top] = parent.get_transformed_position();
            const [, viewportHeight] = parent.get_transformed_size();
            if (y + height / 2 < top || y + height / 2 > top + viewportHeight) {
                this.hide();
                return;
            }
            const adjustment = parent.get_vadjustment();
            this._scrollSignals.push([adjustment, adjustment.connect('notify::value', () => this.hide())]);
        }
        if (!this._label) {
            this._label = new St.Label({style_class: 'dash-label tp-tooltip', reactive: false, visible: false});
            this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            Main.layoutManager.addTopChrome(this._label);
        }
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const margin = 8 * scale;
        this._label.set_style(`max-width: ${Math.min(320, (monitor.width - 2 * margin) / scale)}px;`);
        this._label.text = button.accessible_name;
        this._label.show();
        const [, labelWidth] = this._label.get_preferred_width(-1);
        const [, labelHeight] = this._label.get_preferred_height(labelWidth);
        const left = Math.max(monitor.x + margin,
            Math.min(x + (width - labelWidth) / 2, monitor.x + monitor.width - labelWidth - margin));
        const above = y - labelHeight - margin;
        const top = above >= monitor.y + margin ? above : y + height + margin;
        this._label.set_position(Math.round(left), Math.round(Math.max(monitor.y + margin,
            Math.min(top, monitor.y + monitor.height - labelHeight - margin))));
    }

    hide() {
        if (this._timer) GLib.Source.remove(this._timer);
        this._timer = 0;
        this._target = null;
        for (const [adjustment, signal] of this._scrollSignals) adjustment.disconnect(signal);
        this._scrollSignals = [];
        this._label?.hide();
    }

    destroy() {
        this.hide();
        this._menu.disconnect(this._menuChanged);
        this._menu.actor.disconnect(this._allocationChanged);
        this._menu.actor.disconnect(this._mappedChanged);
        for (const [button, signals] of this._buttons)
            for (const signal of signals) button.disconnect(signal);
        this._buttons.clear();
        this._label?.destroy();
        this._label = null;
    }
}
