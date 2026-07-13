#!/usr/bin/env -S gjs -m
// Minimal fake MPRIS player for the nested-shell harness.
//
// The nested shell runs on a private D-Bus, so your real Spotify/browser
// is invisible there. This script owns org.mpris.MediaPlayer2.agentislandfake
// and serves just enough of the MPRIS spec for the island's media row to
// light up: metadata (title, artist, cover), Playing status and the
// play/next/previous methods (no-ops that log).
//
// Usage (inside the nested session): gjs -m dev/fake-player.js &

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const ART = GLib.build_filenamev(
    [GLib.get_current_dir(), 'docs', 'img', 'island-expanded.png']);

const MPRIS_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="CanQuit" type="b" access="read"/>
    <method name="Raise"/>
    <method name="Quit"/>
  </interface>
</node>`;

const PLAYER_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Stop"/>
  </interface>
</node>`;

const loop = GLib.MainLoop.new(null, false);

class FakeBase {
    get Identity() { return 'Fake Player'; }
    get DesktopEntry() { return ''; }
    get CanRaise() { return false; }
    get CanQuit() { return true; }
    Raise() { print('fake-player: Raise()'); }
    Quit() { loop.quit(); }
}

class FakePlayer {
    get PlaybackStatus() { return 'Playing'; }
    get Metadata() {
        return {
            'xesam:title': GLib.Variant.new_string('Entropy'),
            'xesam:artist': GLib.Variant.new_strv(['Beach Bunny']),
            'mpris:artUrl': GLib.Variant.new_string(`file://${ART}`),
        };
    }
    get CanPlay() { return true; }
    get CanPause() { return true; }
    get CanGoNext() { return true; }
    get CanGoPrevious() { return true; }
    get CanControl() { return true; }
    PlayPause() { print('fake-player: PlayPause()'); }
    Next() { print('fake-player: Next()'); }
    Previous() { print('fake-player: Previous()'); }
    Play() {}
    Pause() {}
    Stop() {}
}

const base = Gio.DBusExportedObject.wrapJSObject(MPRIS_XML, new FakeBase());
base.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');
const player = Gio.DBusExportedObject.wrapJSObject(PLAYER_XML, new FakePlayer());
player.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');

Gio.bus_own_name(Gio.BusType.SESSION,
    'org.mpris.MediaPlayer2.agentislandfake',
    Gio.BusNameOwnerFlags.NONE,
    null,
    () => print('fake-player: up'),
    () => printerr('fake-player: could not own the MPRIS name'));

loop.run();
