// Agent Island - entry point.
//
// GNOME Shell calls enable() when the extension is turned on and disable()
// when it is turned off (including every screen lock/unlock). Everything we
// create in enable() must be undone in disable(); that is a hard requirement
// of the extensions.gnome.org review guidelines.
//
// The extension has two moving parts, each in its own file:
//   sessions.js - watches $XDG_RUNTIME_DIR/agent-island/*.json (the state
//                 files written by the agent hooks) and keeps a session list.
//   island.js   - the pill in the panel + the expandable overlay.
//
// This file only wires them together and relocates the clock so the island
// can live in the center of the top bar, where the clock used to be.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SessionStore} from './sessions.js';
import {MediaWatcher} from './media.js';
import {NotificationWatcher} from './notifications.js';
import {Island} from './island.js';

export default class AgentIslandExtension extends Extension {
    enable() {
        this._store = new SessionStore(this.path);
        this._media = new MediaWatcher();
        this._notifications = new NotificationWatcher(this.getSettings());

        this._island = new Island(
            this._store, this._media, this._notifications, this.path, this.getSettings());

        // 'agentIsland' is our role name in the panel's status area.
        // Position 0 in the 'center' box = leftmost slot of the center.
        Main.panel.addToStatusArea('agentIsland', this._island, 0, 'center');

        this._moveClockToTheLeft();
    }

    disable() {
        this._restoreClock();

        this._island?.destroy();
        this._island = null;

        this._notifications?.destroy();
        this._notifications = null;

        this._media?.destroy();
        this._media = null;

        this._store?.destroy();
        this._store = null;
    }

    // The clock (dateMenu) normally sits alone in the panel's center box.
    // We move its container to the left box so the island takes its place.
    // We remember where it was so disable() can put it back exactly.
    _moveClockToTheLeft() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu)
            return;

        const container = dateMenu.container;
        const parent = container.get_parent();
        if (!parent)
            return;

        this._clockOriginalParent = parent;
        this._clockOriginalIndex = parent.get_children().indexOf(container);

        parent.remove_child(container);
        Main.panel._leftBox.add_child(container);
    }

    _restoreClock() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu || !this._clockOriginalParent)
            return;

        const container = dateMenu.container;
        container.get_parent()?.remove_child(container);

        const children = this._clockOriginalParent.get_children().length;
        this._clockOriginalParent.insert_child_at_index(
            container, Math.min(this._clockOriginalIndex ?? 0, children));

        this._clockOriginalParent = null;
        this._clockOriginalIndex = null;
    }
}
