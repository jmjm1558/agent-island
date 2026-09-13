#!/usr/bin/env python3
"""Test real PulseAudio loopback through the notch using a silent virtual sink."""
import importlib.util
import math
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('audio', root / 'extension/audio_spectrum.py')
audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio)
analyzer = audio.Analyzer()
try:
    assert analyzer.levels([0] * audio.SIZE) == [0] * 12
    def tone(f):
        return analyzer.levels([.15 * math.sin(2 * math.pi * f * n / audio.RATE) for n in range(audio.SIZE)])
    low, high = tone(125), tone(3000)
    assert low.index(max(low)) < high.index(max(high))
    print('PASS silence and frequency-dependent bands', flush=True)
finally:
    analyzer.close()

sink = f'agent_island_spectrum_test_{os.getpid()}'
module_id = subprocess.check_output(['pactl', 'load-module', 'module-null-sink', f'sink_name={sink}'], text=True).strip()
# Child-only environment; the user's default sink/source never changes.
os.environ['PULSE_SERVER'] = 'unix:' + str(Path(os.environ['XDG_RUNTIME_DIR']) / 'pulse/native')
os.environ['AGENT_ISLAND_AUDIO_MONITOR'] = sink + '.monitor'
spec = importlib.util.spec_from_file_location('ui', root / 'dev/run-tests.py')
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)
d = None
player = playback = None
try:
    d = ui.Desktop()
    player = subprocess.Popen(['/usr/bin/gjs', '-m', str(root / 'dev/fake-player.js')],
                              env=d.env, cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(30):
        if d.js(f'{ui.ISLAND}._spectrumBars.length===12'):
            break
        time.sleep(.2)
    d.check('playing MPRIS creates twelve spectrum bars', f'{ui.ISLAND}._spectrumBars.length===12')
    with tempfile.TemporaryFile() as pcm:
        pcm.write(b''.join(struct.pack('<f', .15 * math.sin(2 * math.pi * 500 * n / audio.RATE))
                           for n in range(audio.RATE * 5)))
        pcm.seek(0)
        playback = subprocess.Popen(['paplay', '--raw', f'--device={sink}', '--format=float32le',
                                     '--channels=1', f'--rate={audio.RATE}'], stdin=pcm)
        time.sleep(1)
        d.check('real loopback moves notch spectrum', f'{ui.ISLAND}._spectrum.levels.some(v=>v>.4) && {ui.ISLAND}._spectrumBars.some(b=>b.scale_y>.35)')
        d.screenshot('notch-spectrum')
        playback.wait(timeout=10)
    time.sleep(1.5)
    d.check('silence settles bars', f'{ui.ISLAND}._spectrum.levels.every(v=>v<.04)')
    d.click_actor(f'{ui.ISLAND}._header')
    d.check('hidden spectrum stops audio reader', f'!{ui.ISLAND}._spectrum.active && !{ui.ISLAND}._spectrum.process')
    d.click(1100, 700)
    d.check('collapsed music resumes spectrum', f'{ui.ISLAND}._spectrum.active')
    player.terminate()
    player.wait(timeout=5)
    time.sleep(.5)
    d.check('closed player releases audio reader', f'!{ui.ISLAND}._spectrum.active && !{ui.ISLAND}._spectrum.process')
    print('ALL SPECTRUM TESTS PASSED', flush=True)
finally:
    for process in (playback, player):
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
    if d:
        d.close()
        log = (ui.ARTIFACTS / 'shell.log').read_text()
        assert 'already disposed' not in log and 'JS ERROR' not in log, 'Extension error during shutdown'
    subprocess.run(['pactl', 'unload-module', module_id], check=True)
