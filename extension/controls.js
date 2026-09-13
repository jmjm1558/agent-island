// Keep the original panel controls alive, including their menus and state.
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Controls {
    constructor(settings, island) {
        this.settings = settings;
        this.island = island;
        this.actor = new St.BoxLayout({vertical: true, style_class: 'agent-island-controls'});
        this.shortcuts = new St.Widget({layout_manager: new Clutter.GridLayout(), x_expand: false, x_align: Clutter.ActorAlign.START});
        this.actor.add_child(this.shortcuts);
        this.items = new Map();
        this.signals = [];
        this.pending = 0;
        this.settingsId = settings.connect('changed::clean-panel', () => this.sync());
        for (const box of [Main.panel._leftBox, Main.panel._rightBox]) {
            const id = box.connect('child-added', () => {
                if (!this.pending) {
                    this.pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        this.pending = 0;
                        this.sync();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
            const tracked = {actor: box, id};
            tracked.destroyId = box.connect('destroy', () => { tracked.actor = null; });
            this.signals.push(tracked);
        }
        this.sync();
    }

    get menuOpen() {
        return [...this.items.values()].some(item => item.indicator.menu?.isOpen);
    }

    sync() {
        if (!this.settings.get_boolean('clean-panel')) {
            this.restore();
            return;
        }
        for (const [role, indicator] of Object.entries(Main.panel.statusArea)) {
            if (['activities', 'dateMenu', 'agentIsland', 'quickSettings', 'screenRecording', 'screenSharing', 'a11y', 'keyboard', 'dwellClick'].includes(role) || this.items.has(role))
                continue;
            const actor = indicator.container;
            const parent = actor?.get_parent();
            if (![Main.panel._leftBox, Main.panel._rightBox].includes(parent))
                continue;
            const item = {indicator, actor, parent, index: parent.get_children().indexOf(actor)};
            const wide = /resource/i.test(role);
            const row = new St.BoxLayout({vertical: wide, style_class: wide ?
                'agent-island-control-wide' : 'agent-island-control-shortcut'});
            if (wide)
                row.add_child(new St.Label({text: 'Rendimiento',
                    style_class: 'agent-island-app-name'}));
            this.items.set(role, item);
            item.row = row;
            item.wide = wide;
            const syncVisible = () => {
                row.visible = actor.visible && indicator.visible;
                this._arrange();
            };
            item.visibleId = actor.connect('notify::visible', syncVisible);
            item.indicatorVisibleId = indicator.connect('notify::visible', syncVisible);
            row.visible = actor.visible && indicator.visible;
            item.destroyId = actor.connect('destroy', () => {
                if (item.menuId)
                    indicator.menu.disconnect(item.menuId);
                this.items.delete(role);
                // Never destroy a parent recursively from its child's destroy signal.
                actor.get_parent()?.remove_child(actor);
                row.destroy();
                this._arrange();
            });
            if (indicator.menu) {
                item.menuId = indicator.menu.connect('open-state-changed', (_, open) => {
                    if (open && this.island._grab) {
                        Main.popModal(this.island._grab);
                        this.island._grab = null;
                    } else if (!open && this.island._expanded) {
                        this.island._collapse();
                    }
                });
            }
            parent.remove_child(actor);
            row.add_child(actor);
            if (wide)
                this.actor.insert_child_below(row, this.shortcuts);
            else
                this.shortcuts.add_child(row);
            this._arrange();
        }
    }

    _arrange() {
        let index = 0;
        for (const {row, wide} of this.items.values()) {
            if (!wide && row.visible && row.get_parent() === this.shortcuts) {
                const layout = this.shortcuts.layout_manager.get_child_meta(this.shortcuts, row);
                layout.set_property('left-attach', index % 7);
                layout.set_property('top-attach', Math.floor(index / 7));
                index++;
            }
        }
        this.shortcuts.visible = index > 0;
    }

    detach() {
        this.actor.get_parent()?.remove_child(this.actor);
    }

    restore() {
        // Reverse order preserves positions of consecutive indicators.
        for (const item of [...this.items.values()].reverse()) {
            if (item.menuId)
                item.indicator.menu.disconnect(item.menuId);
            item.indicator.menu?.close();
            item.actor.disconnect(item.visibleId);
            item.indicator.disconnect(item.indicatorVisibleId);
            item.actor.disconnect(item.destroyId);
            item.actor.get_parent()?.remove_child(item.actor);
            if (this.signals.some(tracked => tracked.actor === item.parent))
                item.parent.insert_child_at_index(item.actor, Math.min(item.index, item.parent.get_n_children()));
            else
                item.actor.destroy();
            item.row.destroy();
        }
        this.items.clear();
        this._arrange();
    }

    destroy() {
        this.settings.disconnect(this.settingsId);
        for (const tracked of this.signals) {
            if (tracked.actor) {
                tracked.actor.disconnect(tracked.id);
                tracked.actor.disconnect(tracked.destroyId);
            }
        }
        if (this.pending)
            GLib.source_remove(this.pending);
        this.restore();
        this.detach();
        this.actor.destroy();
    }
}
