// MediaWatcher - the music side of Agent Island.
//
// MPRIS is the freedesktop standard every Linux media app speaks (Spotify,
// browsers, mpv...): each running player owns a D-Bus name starting with
// org.mpris.MediaPlayer2. We watch those names appear and disappear and
// wrap each one in GNOME Shell's own MprisPlayer class, which gives us
// track title, artists, cover art URL, playback status and the
// play-pause/next/previous controls. Same pattern as the Shell's built-in
// media section in the calendar; event-driven, no polling.

import Gio from 'gi://Gio';

import * as Mpris from 'resource:///org/gnome/shell/ui/mpris.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

const DBusIface = loadInterfaceXML('org.freedesktop.DBus');
const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIface);

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

export class MediaWatcher extends Signals.EventEmitter {
    constructor() {
        super();

        this._players = new Map();        // bus name -> MprisPlayer
        this._playerSignals = new Map();  // MprisPlayer -> [handler ids]
        this._visible = new Set();        // players that can actually play
        this._nameOwnerSignalId = 0;

        this._dbusProxy = new DBusProxy(Gio.DBus.session,
            'org.freedesktop.DBus', '/org/freedesktop/DBus',
            this._onProxyReady.bind(this));
    }

    // The player worth showing: one that is playing, else any that could.
    get player() {
        const visible = [...this._visible];
        return visible.find(p => p.status === 'Playing') ?? visible[0] ?? null;
    }

    destroy() {
        if (this._nameOwnerSignalId) {
            this._dbusProxy.disconnectSignal(this._nameOwnerSignalId);
            this._nameOwnerSignalId = 0;
        }
        this._dbusProxy = null;

        // Disconnect OUR handlers; the MprisPlayer proxies themselves close
        // when their bus name vanishes (that is how the Shell handles them).
        for (const [player, ids] of this._playerSignals)
            ids.forEach(id => player.disconnect(id));
        this._playerSignals.clear();
        this._players.clear();
        this._visible.clear();
    }

    async _onProxyReady() {
        const [names] = await this._dbusProxy.ListNamesAsync();
        for (const name of names) {
            if (name.startsWith(MPRIS_PREFIX))
                this._addPlayer(name);
        }
        this._nameOwnerSignalId = this._dbusProxy.connectSignal(
            'NameOwnerChanged', (_proxy, _sender, [name, oldOwner, newOwner]) => {
                if (name.startsWith(MPRIS_PREFIX) && newOwner && !oldOwner)
                    this._addPlayer(name);
            });
    }

    _addPlayer(busName) {
        if (this._players.has(busName))
            return;

        const player = new Mpris.MprisPlayer(busName);
        const ids = [
            player.connect('changed', () => this.emit('changed')),
            player.connect('show', () => {
                this._visible.add(player);
                this.emit('changed');
            }),
            player.connect('hide', () => {
                this._visible.delete(player);
                this.emit('changed');
            }),
            player.connect('closed', () => {
                this._visible.delete(player);
                this._players.delete(busName);
                this._playerSignals.delete(player);
                this.emit('changed');
            }),
        ];
        this._players.set(busName, player);
        this._playerSignals.set(player, ids);
    }
}
