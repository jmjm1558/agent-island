#!/usr/bin/env python3
"""Exercise the extension in a disposable GNOME 46 compositor, never the desktop.

Dependencies: python3-gi, gnome-shell, gjs, dbus-daemon, gsettings.
The private bus can activate only notifications and dconf. No portals, input
methods, user configuration, agent state or extensions from the real session.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

from gi.repository import Gio, GLib

REPO = Path(__file__).resolve().parent.parent
UUID = 'agent-island@jmjm1558.github.io'
ISLAND = 'Main.panel.statusArea.agentIsland'
ARTIFACTS = REPO / 'dev' / 'artifacts'


class Desktop:
    def __init__(self, extra_extensions=()):
        ARTIFACTS.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='agent-island-test-')
        self.root = Path(self.temp.name)
        self.env = dict(os.environ)
        for key in ('DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'):
            self.env.pop(key, None)
        for key, directory in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_RUNTIME_DIR', 'runtime'), ('XDG_CACHE_HOME', 'cache'), ('HOME', 'home')]:
            path = self.root / directory
            path.mkdir(mode=0o700)
            self.env[key] = str(path)
        self.env.update(GIO_USE_VFS='local', NO_AT_BRIDGE='1', AGENT_ISLAND_CODEX_HOME=str(self.root / 'codex'))
        subprocess.run(['/usr/bin/glib-compile-schemas', str(REPO / 'extension/schemas')], check=True)
        services = self.root / 'services'
        services.mkdir()
        for service in ('ca.desrt.dconf.service', 'org.gnome.Shell.Notifications.service'):
            shutil.copy(Path('/usr/share/dbus-1/services') / service, services)
        config = self.root / 'dbus.conf'
        config.write_text(f'''<busconfig><type>session</type>
<listen>unix:tmpdir={self.root}/runtime</listen><auth>EXTERNAL</auth>
<servicedir>{services}</servicedir><policy context="default">
<allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/>
<allow own="*"/></policy></busconfig>''')
        self.log = (ARTIFACTS / 'shell.log').open('w')
        self.daemon = subprocess.Popen(['/usr/bin/dbus-daemon', '--nofork', '--print-address=1', f'--config-file={config}'],
                                       env=self.env, stdout=subprocess.PIPE, stderr=self.log, text=True)
        address = self.daemon.stdout.readline().strip()
        if not address:
            raise RuntimeError('Private D-Bus failed to start')
        self.env['DBUS_SESSION_BUS_ADDRESS'] = address
        (ARTIFACTS / 'bus').write_text(address)
        extensions = self.root / 'data/gnome-shell/extensions'
        extensions.mkdir(parents=True)
        (extensions / UUID).symlink_to(REPO / 'extension')
        for source in extra_extensions:
            (extensions / source.name).symlink_to(source)
        driver = extensions / 'agent-island-test@local'
        driver.mkdir()
        (driver / 'metadata.json').write_text(json.dumps(dict(uuid=driver.name, name='Private test driver',
             description='Only installed in the disposable test environment', **{'shell-version': ['46']})))
        (driver / 'extension.js').write_text('''import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
export default class TestDriver extends Extension {
    enable() { global.context.unsafe_mode = true; }
    disable() { global.context.unsafe_mode = false; }
}
''')
        self.command('/usr/bin/gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str([driver.name, *[p.name for p in extra_extensions], UUID]))
        self.command('/usr/bin/gsettings', 'set', 'org.gnome.desktop.notifications', 'show-banners', 'true')
        self.command('/usr/bin/gsettings', 'set', 'org.gnome.desktop.interface', 'enable-animations', 'true')
        # GNOME tries to spawn ibus-daemon directly even on a private bus.
        # This compositor needs no external graphical helpers or input methods.
        no_helpers = self.root / 'no-helpers'
        no_helpers.mkdir()
        shell_env = dict(self.env, PATH=str(no_helpers))
        self.shell = subprocess.Popen(['/usr/bin/gnome-shell', '--headless', '--mode=user', '--wayland',
                                       '--virtual-monitor=1600x900', '--no-x11'],
                                      env=shell_env, stdout=self.log, stderr=self.log)
        self.bus = Gio.DBusConnection.new_for_address_sync(address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
        for _ in range(80):
            try:
                if self.js(f'!!{ISLAND} && !Main.layoutManager._startingUp'):
                    break
            except Exception:
                pass
            if self.shell.poll() is not None:
                raise RuntimeError(f'GNOME exited; inspect {ARTIFACTS / "shell.log"}')
            time.sleep(.2)
        else:
            raise RuntimeError('Extension did not load')
        self.js("Main.overview.hide(); global._testPointer=imports.gi.Clutter.get_default_backend().get_default_seat().create_virtual_device(imports.gi.Clutter.InputDeviceType.POINTER_DEVICE); global._testKeyboard=imports.gi.Clutter.get_default_backend().get_default_seat().create_virtual_device(imports.gi.Clutter.InputDeviceType.KEYBOARD_DEVICE); true")
        self.js(f'''global._testButton = name => {{
            const find = a => {{
                if ((a.accessible_name === name || a.label === name) && a instanceof imports.gi.St.Button) return a;
                for (const child of a.get_children()) {{ const found = find(child); if (found) return found; }}
                return null;
            }};
            return find({ISLAND}._surface);
        }}; true''')
        time.sleep(.6)

    def command(self, *args):
        return subprocess.run(args, env=self.env, cwd=REPO, check=True, capture_output=True, text=True)

    def js(self, source):
        ok, result = self.bus.call_sync('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell', 'Eval',
            GLib.Variant('(s)', [source]), None, 0, 3000, None).unpack()
        if not ok:
            raise AssertionError(result)
        return json.loads(result) if result else None

    def move(self, x, y):
        self.js(f'global._testPointer.notify_absolute_motion(imports.gi.GLib.get_monotonic_time(), {x}, {y}); true')
        time.sleep(.1)

    def click(self, x, y):
        self.move(x, y)
        for state in ('PRESSED', 'RELEASED'):
            self.js(f'global._testPointer.notify_button(imports.gi.GLib.get_monotonic_time(), 1, imports.gi.Clutter.ButtonState.{state}); true')
            time.sleep(.08)
        time.sleep(.5)

    def click_actor(self, expression):
        coords = self.js(f'(() => {{const a={expression}; if(!a) throw new Error("Button missing"); return [...a.get_transformed_position(), ...a.get_transformed_size()];}})()')
        x, y, w, h = coords
        self.click(x + w/2, y + h/2)

    def click_button(self, label):
        self.click_actor(f'global._testButton({json.dumps(label)})')

    def key(self, key):
        for state in ('PRESSED', 'RELEASED'):
            self.js(f'global._testKeyboard.notify_keyval(imports.gi.GLib.get_monotonic_time(), imports.gi.Clutter.KEY_{key}, imports.gi.Clutter.KeyState.{state}); true')
            time.sleep(.08)
        time.sleep(.5)

    def notify(self, title, body='Mensaje de prueba', app='Island E2E', urgency=1, replace=0, actions=None, hints=None):
        values = {'urgency': GLib.Variant('y', urgency), **(hints or {})}
        args = GLib.Variant('(susssasa{sv}i)', (app, replace, 'dialog-information-symbolic', title, body, actions or [], values, -1))
        result = self.bus.call_sync('org.freedesktop.Notifications', '/org/freedesktop/Notifications',
            'org.freedesktop.Notifications', 'Notify', args, None, 0, 5000, None).unpack()[0]
        time.sleep(.2)
        return result

    def reset(self):
        self.move(1100, 700)
        self.js('Main.overview.hide(); true')
        time.sleep(.4)
        self.js(f"{ISLAND}._collapse(); {ISLAND}._notifications.clear(); {ISLAND}._settings.set_boolean('show-banners', true); true")
        time.sleep(.6)

    def screenshot(self, name):
        self.command('/usr/bin/gjs', '-m', str(REPO / 'dev/screenshot.js'), str(ARTIFACTS / f'{name}.png'))

    def check(self, name, expression):
        if not self.js(expression):
            self.screenshot('failure')
            raise AssertionError(name)
        print(f'PASS {name}', flush=True)

    def close(self):
        if getattr(self, 'shell', None) and self.shell.poll() is None:
            try:
                self.js('global.context.terminate(); true')
                self.shell.wait(timeout=5)
            except Exception:
                self.shell.terminate()
                self.shell.wait(timeout=5)
        if getattr(self, 'daemon', None):
            self.daemon.terminate()
            self.daemon.wait(timeout=5)
        self.log.close()
        self.temp.cleanup()
        (ARTIFACTS / 'bus').unlink(missing_ok=True)


def run_tests(d):
    i = ISLAND
    d.reset()
    d.check('centered top-edge notch', f'{i}._surface.y===0 && Math.abs({i}._surface.x+{i}._surface.width/2-800)<1 && {i}._surface.height===Main.panel.height')
    d.screenshot('notch-idle')
    focus = d.js('String(global.stage.get_key_focus())')
    first = d.notify('Notificación real', '<b>Hola Juan</b> &amp; bienvenido a tu isla.')
    time.sleep(.6)
    d.check('single presentation in island', f'{i}._preview?.title==="Notificación real" && Main.messageTray._banner===null')
    assert focus == d.js('String(global.stage.get_key_focus())'), 'Preview stole keyboard focus'
    print('PASS automatic preview leaves keyboard focus alone', flush=True)
    d.screenshot('notch-notification')
    d.notify('Actualizada', 'Un aviso se actualiza sin duplicarse.', replace=first)
    time.sleep(.6)
    d.check('replacement updates original notification', f'{i}._preview?.title==="Actualizada" && {i}._notifications.notifications.length===1')
    d.move(800, 85)
    time.sleep(6.3)
    d.check('hover pauses dismissal', f'{i}._preview!==null')
    d.move(1100, 700)
    time.sleep(2.9)
    d.check('timeout collapses but keeps history', f'{i}._preview===null && {i}._surface.height===Main.panel.height && {i}._notifications.notifications.length===1')
    d.click_actor(f'{i}._header')
    d.check('real pointer opens center', f'{i}._expanded && {i}._grab!==null')
    d.screenshot('notch-center')
    d.click(1100, 700)
    d.check('outside click closes and releases grab', f'!{i}._expanded && {i}._grab===null && Main.modalCount===0')
    d.click_actor(f'{i}._header')
    d.key('Escape')
    d.check('Escape closes center', f'!{i}._expanded && Main.modalCount===0')
    d.reset()
    d.js(f"{i}._settings.set_boolean('show-banners', false); true")
    d.notify('Silenciosa')
    time.sleep(.6)
    d.check('DND retains silent notification', f'{i}._preview===null && {i}._notifications.notifications.length===1 && Main.messageTray._banner===null')
    d.notify('Crítica', urgency=2)
    time.sleep(6.4)
    d.check('GNOME critical DND exception stays visible', f'{i}._preview?.title==="Crítica"')
    d.click_button('Descartar notificación')
    d.check('dismiss removes original notification', f'{i}._preview===null && {i}._notifications.notifications.every(n=>n.title!=="Crítica")')
    d.reset()
    for n in range(6):
        d.notify(f'Ráfaga {n}', app=f'Fuente {n}')
    time.sleep(.6)
    d.check('burst queues without duplicate banners', f'{i}._pending.length===5 && {i}._notifications.notifications.length===6 && Main.messageTray._banner===null')
    d.click_actor(f'{i}._header')
    d.check('center includes all six sources', f'{i}._expanded && {i}._content.get_n_children()===6')
    d.screenshot('notch-burst')
    d.click_button('Limpiar todo')
    d.check('clear all clears GNOME sources', f'{i}._notifications.notifications.length===0 && Main.messageTray.getSources().length===0')
    d.reset()
    received = []
    subscription = d.bus.signal_subscribe(None, 'org.freedesktop.Notifications', None,
        '/org/freedesktop/Notifications', None, 0,
        lambda c, s, p, interface, name, args: received.append((name, args.unpack())))
    def pump():
        context = GLib.MainContext.default()
        for _ in range(20):
            while context.pending():
                context.iteration(False)
            time.sleep(.02)
    d.notify('Con acción', actions=['default', 'Abrir', 'accept', 'Aceptar'])
    time.sleep(.6)
    d.click_button('Aceptar')
    pump()
    assert any(n=='ActionInvoked' and a[1]=='accept' for n,a in received), received
    print('PASS action emits original DBus ActionInvoked', flush=True)
    d.check('action dismisses nonresident notice', f'{i}._notifications.notifications.length===0')
    d.notify('Abrir aplicación', actions=['default', 'Abrir'])
    time.sleep(.6)
    d.click_button('Abrir Island E2E: Abrir aplicación')
    pump()
    assert any(n=='ActionInvoked' and a[1]=='default' for n,a in received), received
    print('PASS notification click activates default app action', flush=True)
    d.bus.signal_unsubscribe(subscription)
    d.reset()
    d.notify('Transitoria', hints={'transient': GLib.Variant('b', True)})
    time.sleep(2.9)
    d.check('transient notice expires', f'{i}._notifications.notifications.length===0')
    identifier = d.notify('Cancelada por aplicación')
    d.bus.call_sync('org.freedesktop.Notifications', '/org/freedesktop/Notifications',
        'org.freedesktop.Notifications', 'CloseNotification', GLib.Variant('(u)', [identifier]), None, 0, 5000, None)
    time.sleep(.6)
    d.check('app cancellation removes preview', f'{i}._preview===null && {i}._notifications.notifications.length===0')
    d.reset()
    d.notify('Preferencias de ejemplo', app='A Editor')
    d.click_actor(f'{i}._header')
    d.click_button('Ajustes')
    d.click_button('A Editor: Normal')
    d.check('app preference is saved', f'{i}._notifications.routeForId("source:A Editor")==="native"')
    d.screenshot('notch-settings')
    d.click(1100, 700)
    d.notify('Banner elegido', app='A Editor')
    time.sleep(.6)
    d.check('unselected app uses native banner', f'{i}._preview===null && Main.messageTray._banner!==null')
    d.js('Main.messageTray._notification.destroy(); true')
    time.sleep(.5)
    d.notify('App elegida', app='Notch E2E')
    time.sleep(.6)
    d.check('selected app still uses notch', f'{i}._preview?.title==="App elegida" && Main.messageTray._banner===null')
    d.reset()
    d.click_actor(f'{i}._header')
    d.click_button('Controles')
    d.check('system indicators stay in right panel', 'Main.panel.statusArea.quickSettings.container.get_parent()===Main.panel._rightBox')
    d.screenshot('notch-controls')
    d.click_button('Barra limpia: activada')
    d.check('toggle restores native panel controls', 'Main.panel.statusArea.quickSettings.container.get_parent()===Main.panel._rightBox')
    d.click_button('Barra limpia: desactivada')
    d.check('clean panel still preserves system indicators', 'Main.panel.statusArea.quickSettings.container.get_parent()===Main.panel._rightBox')
    d.reset()
    d.js(f'global._testClockParent={i}._clockOriginalParent; true')
    d.command('/usr/bin/gnome-extensions', 'disable', UUID)
    time.sleep(.8)
    d.check('disable removes notch and releases modal', f'!{i} && Main.modalCount===0 && !Main.layoutManager.uiGroup.get_children().some(a=>a.name==="agent-island-notch")')
    d.check('disable restores system controls', 'Main.panel.statusArea.quickSettings.container.get_parent()===Main.panel._rightBox')
    d.notify('Restaurada', app='Notch E2E')
    time.sleep(.6)
    d.check('disable restores native notifications', 'Main.messageTray._banner!==null')
    d.js('Main.messageTray._notification.destroy(); true')
    d.command('/usr/bin/gnome-extensions', 'enable', UUID)
    time.sleep(.8)
    d.check('re-enable preserves per-app preference', f'{i}._notifications.routeForId("source:A Editor")==="native"')
    d.check('re-enable creates exactly one notch', 'Main.layoutManager.uiGroup.get_children().filter(a=>a.name==="agent-island-notch").length===1')



if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--interactive', action='store_true', help='Keep private desktop alive for debugging')
    args = parser.parse_args()
    desktop = Desktop()
    try:
        if args.interactive:
            print(f'Private GNOME ready. Bus address: {ARTIFACTS / "bus"}', flush=True)
            while desktop.shell.poll() is None:
                time.sleep(1)
        else:
            run_tests(desktop)
            print('ALL TESTS PASSED', flush=True)
    finally:
        desktop.close()
