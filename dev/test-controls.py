#!/usr/bin/env python3
"""Exercise installed indicator code using private settings, never the real panel."""
import importlib.util
from pathlib import Path
import subprocess
import time
import json

spec = importlib.util.spec_from_file_location('island_tests', Path(__file__).with_name('run-tests.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
installed = Path.home() / '.local/share/gnome-shell/extensions'
extras = [installed / name for name in ('Resource_Monitor@Ory0n', 'clipboard-indicator@tudmotu.com')
          if (installed / name).exists()]
d = module.Desktop(extras)
i = module.ISLAND
try:
    d.reset()
    d.js("import('resource:///org/gnome/shell/ui/panelMenu.js').then(P => {for (let n=0;n<2;n++){const b=new P.Button(0,'App '+n);b.add_child(new imports.gi.St.Icon({icon_name:'applications-system-symbolic',icon_size:16}));Main.panel.addToStatusArea('appindicator-test-'+n,b);}}); true")
    time.sleep(.5)
    d.click_actor(f'{i}._header')
    d.click_button('Controles')
    d.check('installed indicators are collected', f'{i}._controls.items.size === {len(extras)+2}')
    d.check('resource row fits notch width', f'[...{i}._controls.items.values()].every(item => item.actor.width <= {i}._surface.width)')
    d.screenshot('notch-installed-controls')
    if any(p.name.startswith('clipboard') for p in extras):
        d.click_actor('Main.panel.statusArea.clipboardIndicator')
        d.check('native clipboard menu opens', 'Main.panel.statusArea.clipboardIndicator.menu.isOpen')
        d.click(1400, 800)
        d.check('clipboard closes and releases focus', f'!{i}._expanded && Main.modalCount===0')
    process = subprocess.Popen(['/usr/bin/sleep', '60'])
    try:
        stat = Path(f'/proc/{process.pid}/stat').read_text().rsplit(')', 1)[1].split()
        state = d.root / 'runtime/agent-island/codex-liveness.json'
        data = dict(agent='codex', session_id='liveness', agent_pid=process.pid,
                    agent_started=stat[19], state='working', cwd='/tmp', ts=int(time.time()))
        state.write_text(json.dumps(data))
        time.sleep(.8)
        d.check('file monitor shows process-verified session', f'{i}._store.sessions.some(s => s.sessionId==="liveness")')
        data.update(state='idle', ts=int(time.time())-1801)
        state.write_text(json.dumps(data))
        time.sleep(.5)
        d.check('inactive terminal over 30 minutes is hidden', f'!{i}._store.sessions.some(s => s.sessionId==="liveness")')
        data.update(ts=int(time.time()))
        state.write_text(json.dumps(data))
        time.sleep(.5)
        d.check('newly loaded terminal context appears', f'{i}._store.sessions.some(s => s.sessionId==="liveness")')
        d.js(f'{i}._store._desktopSessions=[{{agent:"codex-desktop",sessionId:"old",state:"idle",ts:1}},{{agent:"codex-desktop",sessionId:"busy",state:"working",ts:1}}]; true')
        d.check('desktop history hidden but live work retained', f'!{i}._store.sessions.some(s=>s.sessionId==="old") && {i}._store.sessions.some(s=>s.sessionId==="busy")')
        d.js(f'{i}._store._desktopSessions=[]; true')
        data['agent_started'] = 'wrong-start-time' 
        state.write_text(json.dumps(data))
        time.sleep(.5)
        d.check('PID reuse cannot create live session', f'!{i}._store.sessions.some(s => s.sessionId==="liveness")')
        data['agent_started'] = stat[19]
        state.write_text(json.dumps(data))
        time.sleep(.5)
        process.terminate()
        process.wait()
        d.check('exited process cannot appear live', f'!{i}._store.sessions.some(s => s.sessionId==="liveness")')
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait()
    print('ALL INSTALLED CONTROL AND LIVENESS TESTS PASSED', flush=True)
finally:
    d.close()
