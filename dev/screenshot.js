#!/usr/bin/env -S gjs -m
// Take a screenshot of the GNOME Shell instance on the CURRENT session bus.
// Meant for the nested development shell started by dev/run-nested.sh.
//
// Why the bus-name dance: the Shell's Screenshot D-Bus API only answers
// callers that own an allow-listed name (see DBusSenderChecker in
// js/ui/screenshot.js). 'org.gnome.Screenshot' - the GNOME screenshot
// app's name - is on that list, so we briefly own it. On the private bus
// of a nested shell nobody else is using it.
//
// Usage: gjs -m dev/screenshot.js /absolute/path/output.png

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const outputPath = ARGV[0] ?? GLib.build_filenamev([GLib.get_tmp_dir(), 'nested-shell.png']);
const loop = GLib.MainLoop.new(null, false);
let exitCode = 1;

Gio.bus_own_name(
    Gio.BusType.SESSION,
    'org.gnome.Screenshot',
    Gio.BusNameOwnerFlags.NONE,
    null,
    () => {
        // Name acquired; now we pass the Shell's sender check.
        Gio.DBus.session.call(
            'org.gnome.Shell.Screenshot',
            '/org/gnome/Shell/Screenshot',
            'org.gnome.Shell.Screenshot',
            'Screenshot',
            new GLib.Variant('(bbs)', [false, false, outputPath]),
            null, Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                try {
                    const [success, usedName] = connection.call_finish(result).deepUnpack();
                    print(`screenshot ${success ? 'saved' : 'FAILED'}: ${usedName}`);
                    exitCode = success ? 0 : 1;
                } catch (e) {
                    printerr(`screenshot call failed: ${e.message}`);
                }
                loop.quit();
            });
    },
    () => {
        printerr('could not own org.gnome.Screenshot on this bus');
        loop.quit();
    });

loop.run();
imports.system.exit(exitCode);
