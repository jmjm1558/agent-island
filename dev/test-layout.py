#!/usr/bin/env python3
"""Check compact groups, independent music and scrollbar allocation with WhiteSur."""
import importlib.util
import json
from pathlib import Path
import subprocess
import time

spec = importlib.util.spec_from_file_location('ui', Path(__file__).with_name('run-tests.py'))
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)
d = ui.Desktop()
i = ui.ISLAND
player = None
try:
    theme = Path.home()/'.themes/WhiteSur-Dark/gnome-shell/gnome-shell.css'
    if theme.exists():
        d.js(f'Main.setThemeStylesheet({json.dumps(str(theme))}); Main.loadTheme(); true')
    d.reset()
    d.check('closed notch does not cover app tabs', f'{i}._surface.height===Main.panel.height')
    player = subprocess.Popen(['/usr/bin/gjs','-m',str(ui.REPO/'dev/fake-player.js')], env=d.env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(25):
        if d.js(f'!!{i}._media.player'): break
        time.sleep(.2)
    for n in range(3):
        d.notify(f'Captura {n}', 'Captura guardada', app='Screenshot')
    d.click_actor(f'{i}._header')
    d.check('three screenshots form one group', f'{i}._notifications.groups.length===1 && {i}._content.get_n_children()===1')
    d.check('group shows latest notification only', f'{i}._content.get_first_child().get_children().filter(a=>a.has_style_class_name("agent-island-notification")).length===1')
    d.check('group preview is newest even in same second', f'{i}._notifications.groups[0].items[0].title==="Captura 2"')
    d.screenshot('notch-grouped-notifications')
    d.click_button('Agrupar Screenshot')
    d.check('group expands original notifications', f'{i}._content.get_first_child().get_children().filter(a=>a.has_style_class_name("agent-island-notification")).length===3')
    d.click_button('Agrupar Screenshot')
    d.click_button('Descartar avisos de Screenshot')
    d.check('group dismissal removes original notices', f'{i}._notifications.notifications.length===0')
    d.js(f'global._mediaCards=()=>{{const walk=a=>Number(!!a.has_style_class_name?.("agent-island-media"))+a.get_children().reduce((n,c)=>n+walk(c),0);return walk({i}._surface);}}; true')
    for tab in ['Avisos  0','Sesiones  0','Controles','Ajustes']:
        d.click_button(tab)
        d.check(f'no player in {tab}', 'global._mediaCards()===0')
    d.click_button('Música')
    d.check('player has own music section', 'global._mediaCards()===1')
    d.screenshot('notch-music-section')
    d.js(f'{i}._store._desktopSessions=Array.from({{length:12}},(_,n)=>({{agent:"codex-desktop",sessionId:"layout-"+n,title:"Sesión activa de prueba "+n,cwd:"/project",state:"working",ts:Date.now()/1000}})); {i}._queueSync(); true')
    time.sleep(.5)
    d.click_button('Sesiones  12')
    d.check('scrollbar has its own gutter', f'''(()=>{{const content={i}._content, scroll=content.get_parent(), bar=scroll.get_vscroll_bar();
        const bx=bar.get_transformed_position()[0];return !scroll.overlay_scrollbars && bar.visible && content.get_children().every(row=>row.get_transformed_position()[0]+row.width<=bx);}})()''')
    d.screenshot('notch-session-scroll')
    print('ALL LAYOUT TESTS PASSED', flush=True)
finally:
    if player:
        player.terminate(); player.wait(timeout=5)
    d.close()
