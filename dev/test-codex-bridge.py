#!/usr/bin/env python3
"""Regression checks for the real SQLite + versioned IPC adapter."""
import importlib.util
import json
from pathlib import Path
import select
import socket
import sqlite3
import struct
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parent.parent
MODULE = REPO / 'extension/codex_bridge.py'
spec = importlib.util.spec_from_file_location('codex_bridge', MODULE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.runtime_state({'type': 'active', 'activeFlags': ['waitingOnUserInput']}) == ('waiting', 'Te necesita')
assert module.runtime_state({'type': 'systemError'}) == ('waiting', 'Error')
assert module.runtime_state(None) == ('idle', 'Reciente')

with tempfile.TemporaryDirectory(prefix='island-ipc-test-') as temp:
    home = Path(temp)
    (home / 'ipc').mkdir()
    identifier = '00000000-1111-2222-3333-444444444444'
    with sqlite3.connect(home / 'state_5.sqlite') as db:
        db.execute('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, recency_at INTEGER, updated_at INTEGER, archived INTEGER, source TEXT, thread_source TEXT)')
        db.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)',
            (identifier, 'Título real', 'Primer mensaje', '/project', int(time.time()), int(time.time()), 0, 'vscode', 'user'))
        db.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)',
            ('hidden', 'Archived task', '', '', 500, 500, 1, 'vscode', 'user'))
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(str(home / 'ipc/ipc.sock'))
    listener.listen()
    listener.settimeout(4)
    child = subprocess.Popen(['/usr/bin/python3', str(MODULE), '--home', str(home)], stdout=subprocess.PIPE)
    buffer = bytearray()
    output = bytearray()
    def receive(conn):
        conn.settimeout(3)
        while len(buffer) < 4 or len(buffer) < 4 + struct.unpack_from('<I', buffer)[0]:
            buffer.extend(conn.recv(65536))
        size = struct.unpack_from('<I', buffer)[0]
        result = json.loads(buffer[4:4+size]); del buffer[:4+size]
        return result
    def send(conn, data):
        payload = json.dumps(data).encode()
        conn.sendall(struct.pack('<I', len(payload)) + payload)
    def expect(predicate):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if b'\n' not in output:
                if not select.select([child.stdout], [], [], .2)[0]: continue
                output.extend(child.stdout.read1(65536))
            while b'\n' in output:
                line, _, rest = output.partition(b'\n');output[:] = rest
                items = json.loads(line)
                assert all('SECRET' not in json.dumps(item) for item in items)
                assert len(items) == 1, items
                if predicate(items[0]): return
        raise AssertionError('Expected session state was not emitted')
    def snapshot(conn, revision, status, version=11):
        send(conn, dict(type='broadcast', method='thread-stream-state-changed', version=version,
            sourceClientId='owner', params=dict(hostId='local', conversationId=identifier,
            change=dict(type='snapshot', revision=revision, conversationState=dict(
                title='Nombre actualizado', threadRuntimeStatus=status, turns=[{'body': 'SECRET'}])))))
    try:
        expect(lambda s: s['title']=='Título real' and s['statusLabel']=='Reciente')
        conn, _ = listener.accept()
        init = receive(conn)
        assert init['method'] == 'initialize'
        send(conn, dict(type='response', method='initialize', resultType='success', requestId=init['requestId'], result={'clientId': 'test-reader'}))
        following = receive(conn)
        assert following['method']=='thread-stream-following-changed' and following['params']['following'] is True
        snapshot(conn, 0, {'type': 'idle'})
        expect(lambda s: s['state']=='idle' and s['ts'] > time.time()-10)
        print('PASS loaded context refreshes visibility without fabricating work')
        snapshot(conn, 1, {'type': 'active', 'activeFlags': []})
        expect(lambda s: s['state']=='working' and s['title']=='Nombre actualizado')
        print('PASS SQLite catalog + live snapshot; archived tasks and message bodies excluded')
        send(conn, dict(type='broadcast', method='thread-stream-state-changed', version=11, sourceClientId='owner',
            params=dict(hostId='local', conversationId=identifier, change=dict(type='patches', baseRevision=1,
                revision=2, patches=[dict(op='add', path=['threadRuntimeStatus','activeFlags',0], value='waitingOnApproval')]))))
        expect(lambda s: s['state']=='waiting')
        print('PASS live approval patch updates status')
        snapshot(conn, 3, {'type': 'active'}, version=999)
        expect(lambda s: s['statusLabel']=='Reciente')
        print('PASS unknown protocol never fabricates active status')
        snapshot(conn, 4, {'type': 'active'})
        expect(lambda s: s['state']=='working')
        conn.close()
        expect(lambda s: s['statusLabel']=='Reciente')
        print('PASS disconnect clears stale active state')
    finally:
        child.terminate(); child.wait(timeout=4); listener.close()
print('ALL BRIDGE TESTS PASSED')
