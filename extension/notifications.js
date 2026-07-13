// NotificationWatcher - the notification side of Agent Island.
//
// Every desktop notification (Telegram, a browser tab shouting about
// WhatsApp or YouTube, email clients...) flows through the Shell's
// message tray. We do not implement any notification protocol here: we
// just mirror what the tray already holds, keeping the most recent few
// so the island can show them. Removing them from the island does not
// dismiss them anywhere else; we are a viewer, not the owner.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const MAX_NOTIFICATIONS = 4;

export class NotificationWatcher extends Signals.EventEmitter {
    constructor() {
        super();

        this._items = [];             // newest first: {notification, ids}
        this._sourceHandlers = new Map();  // source -> handler id

        this._trayHandlers = [
            Main.messageTray.connect('source-added',
                (_tray, source) => this._watchSource(source)),
            Main.messageTray.connect('source-removed',
                (_tray, source) => this._unwatchSource(source)),
        ];
        for (const source of Main.messageTray.getSources())
            this._watchSource(source);
    }

    // Most recent notifications, newest first.
    get notifications() {
        return this._items.map(item => item.notification);
    }

    destroy() {
        this._trayHandlers.forEach(id => Main.messageTray.disconnect(id));
        this._trayHandlers = [];

        for (const [source, id] of this._sourceHandlers)
            source.disconnect(id);
        this._sourceHandlers.clear();

        for (const item of this._items)
            item.ids.forEach(id => item.notification.disconnect(id));
        this._items = [];
    }

    _watchSource(source) {
        if (this._sourceHandlers.has(source))
            return;

        this._sourceHandlers.set(source,
            source.connect('notification-added',
                (_source, notification) => this._add(notification)));

        // A source that existed before us may already hold notifications.
        source.notifications.forEach(n => this._add(n));
    }

    _unwatchSource(source) {
        const id = this._sourceHandlers.get(source);
        if (id) {
            source.disconnect(id);
            this._sourceHandlers.delete(source);
        }
    }

    _add(notification) {
        if (this._items.some(item => item.notification === notification))
            return;

        const ids = [
            notification.connect('destroy', () => this._forget(notification)),
            // Chat apps update one notification with new messages.
            notification.connect('notify::title', () => this.emit('changed')),
            notification.connect('notify::body', () => this.emit('changed')),
        ];
        this._items.unshift({notification, ids});

        // Only remember the latest few; older ones keep living in the
        // message tray, we simply stop showing them.
        while (this._items.length > MAX_NOTIFICATIONS) {
            const dropped = this._items.pop();
            dropped.ids.forEach(id => dropped.notification.disconnect(id));
        }

        this.emit('changed');
    }

    _forget(notification) {
        const index =
            this._items.findIndex(item => item.notification === notification);
        if (index === -1)
            return;

        // Disconnecting the handler we are currently inside of is fine.
        this._items[index].ids.forEach(id => notification.disconnect(id));
        this._items.splice(index, 1);
        this.emit('changed');
    }
}
