// Keep GNOME's notification ownership and policy; replace only presentation.
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {NotificationDestroyedReason} from 'resource:///org/gnome/shell/ui/messageTray.js';

export class NotificationWatcher extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._settingsId = settings.connect('changed', () => this.emit('changed'));
        this._items = new Map();
        this._sources = new Map();
        this._injection = new InjectionManager();
        this._drainId = 0;
        this._trayHandlers = [
            Main.messageTray.connect('source-added', (_, source) => this._watchSource(source)),
            Main.messageTray.connect('source-removed', (_, source) => this._unwatchSource(source)),
        ];
        for (const source of Main.messageTray.getSources())
            this._watchSource(source);
    }

    get notifications() {
        return [...this._items.keys()].reverse().sort((a, b) =>
            b.datetime.compare(a.datetime));
    }

    get groups() {
        const groups = new Map();
        for (const notification of this.notifications) {
            const id = this._sourceId(notification.source);
            if (!groups.has(id))
                groups.set(id, {id, title: notification.source.title, items: []});
            groups.get(id).items.push(notification);
        }
        return [...groups.values()];
    }

    get defaultRoute() { return this._settings.get_string('default-route'); }
    set defaultRoute(route) { this._settings.set_string('default-route', route); }

    get applications() {
        const apps = this._settings.get_value('known-apps').deepUnpack();
        return Object.entries(apps).map(([id, title]) => ({id, title, route: this.routeForId(id)}))
            .sort((a, b) => a.title.localeCompare(b.title));
    }

    routeForId(id) {
        return this._settings.get_value('app-routes').deepUnpack()[id] ?? this.defaultRoute;
    }

    routeFor(notification) { return this.routeForId(this._sourceId(notification.source)); }

    setRoute(id, route) {
        const routes = this._settings.get_value('app-routes').deepUnpack();
        routes[id] = route;
        this._settings.set_value('app-routes', new GLib.Variant('a{ss}', routes));
    }

    _sourceId(source) {
        return source.policy.id && source.policy.id !== 'generic'
            ? `app:${source.policy.id}` : `source:${source.title}`;
    }

    // _showNotification is called dynamically after GNOME has checked DND,
    // per-app policy, urgency, fullscreen, session mode and banner blocking.
    // Intercepting notification-added instead would bypass those decisions.
    startPresentation(present) {
        const watcher = this;
        this._injection.overrideMethod(Main.messageTray, '_showNotification', original => function () {
            const notification = this._notificationQueue[0];
            try {
                if (!notification || watcher.routeFor(notification) !== 'notch' || !present(notification))
                    return original.call(this);
            } catch (error) {
                console.error('Agent Island: using native banner', error);
                return original.call(this);
            }
            this._notificationQueue.shift();
            notification.acknowledged = true;
            notification.playSound();
            this.emit('queue-changed');
            // Avoid recursing into the tray while it is updating its state.
            if (!watcher._drainId) {
                watcher._drainId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    watcher._drainId = 0;
                    this._updateState();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }

    dismiss(notification) {
        if (this._items.has(notification))
            notification.destroy(NotificationDestroyedReason.DISMISSED);
    }

    clear() {
        for (const notification of this.notifications)
            this.dismiss(notification);
    }

    destroy() {
        this._injection.clear();
        this._settings.disconnect(this._settingsId);
        if (this._drainId)
            GLib.source_remove(this._drainId);
        this._drainId = 0;
        this._trayHandlers.forEach(id => Main.messageTray.disconnect(id));
        for (const source of [...this._sources.keys()])
            this._unwatchSource(source);
    }

    _watchSource(source) {
        if (this._sources.has(source))
            return;
        this._sources.set(source, source.connect('notification-added',
            (_, notification) => this._add(notification)));
        source.notifications.forEach(notification => this._add(notification));
    }

    _unwatchSource(source) {
        const id = this._sources.get(source);
        if (id)
            source.disconnect(id);
        this._sources.delete(source);
        for (const notification of [...this._items.keys()]) {
            if (notification.source === source)
                this._forget(notification);
        }
    }

    _add(notification) {
        if (this._items.has(notification))
            return;
        const source = notification.source;
        if (source.title) {
            const apps = this._settings.get_value('known-apps').deepUnpack();
            const key = this._sourceId(source);
            if (apps[key] !== source.title) {
                apps[key] = source.title;
                this._settings.set_value('known-apps', new GLib.Variant('a{ss}', apps));
            }
        }
        const changed = () => this.emit('changed');
        this._items.set(notification, [
            notification.connect('destroy', () => this._forget(notification)),
            notification.connect('notify::title', changed),
            notification.connect('notify::body', changed),
            notification.connect('notify::gicon', changed),
            notification.connect('notify::datetime', changed),
            notification.connect('action-added', changed),
            notification.connect('action-removed', changed),
        ]);
        this.emit('changed');
    }

    _forget(notification) {
        const ids = this._items.get(notification);
        if (!ids)
            return;
        this._items.delete(notification);
        ids.forEach(id => notification.disconnect(id));
        this.emit('changed');
    }
}
