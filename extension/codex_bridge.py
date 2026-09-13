#!/usr/bin/env python3
"""Read-only adapter for Codex Desktop's local catalog and live IPC stream.

No prompts are submitted, tasks resumed, or Codex files written. Only metadata
is retained from snapshots. IPC is an internal, versioned desktop protocol;
unrecognized versions degrade to 'Reciente', never fabricated live activity.
The process is owned by the extension and exits when its stdout is closed.
"""
import argparse
import copy
import ctypes
import json
import os
from pathlib import Path
import select
import socket
import sqlite3
import struct
import time
import uuid

STREAM_VERSION = 11  # Codex Desktop 26.909 / bundled app-server 0.154
KEEP_FIELDS = {'threadRuntimeStatus', 'title', 'cwd'}


def runtime_state(status):
    kind = status.get('type') if isinstance(status, dict) else None
    if kind == 'active':
        flags = status.get('activeFlags', [])
        if 'waitingOnApproval' in flags or 'waitingOnUserInput' in flags:
            return 'waiting', 'Te necesita'
        return 'working', 'Trabajando'
    if kind == 'idle':
        return 'idle', 'En pausa'
    if kind == 'systemError':
        return 'waiting', 'Error'
    return 'idle', 'Reciente'


def metadata_patch(state, patch):
    path = patch.get('path', [])
    if not path or path[0] not in KEEP_FIELDS:
        return
    node = state
    for key in path[:-1]:
        node = node[key]
    key = path[-1]
    value = copy.deepcopy(patch.get('value'))
    if patch['op'] == 'remove':
        if isinstance(node, list):
            node.pop(int(key))
        else:
            node.pop(key, None)
    elif isinstance(node, list):
        if patch['op'] == 'add':
            node.insert(int(key), value)
        else:
            node[int(key)] = value
    else:
        node[key] = value


class Bridge:
    def __init__(self, home):
        self.home = Path(home)
        self.rows = {}
        self.live = {}
        self.revisions = {}
        self.owners = {}
        self.activity = {}
        self.subscribed = set()
        self.sock = None
        self.client = None
        self.last_output = None
        self.last_refresh = 0
        self.refresh_at = time.monotonic()
        self.reconnect_at = time.monotonic()
        self.buffer = bytearray()
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.watch = self.libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.watch < 0:
            raise OSError(ctypes.get_errno(), 'inotify_init1')
        if self.home.is_dir():
            self.libc.inotify_add_watch(self.watch, os.fsencode(self.home), 0x2 | 0x8 | 0x80 | 0x100 | 0x200)

    def refresh(self):
        self.refresh_at = None
        self.last_refresh = time.monotonic()
        databases = sorted(self.home.glob('state_*.sqlite'), key=lambda p: int(p.stem.split('_')[-1]), reverse=True)
        if not databases:
            self.rows = {}
            self.emit()
            return
        try:
            with sqlite3.connect(f'file:{databases[0]}?mode=ro', uri=True, timeout=.5) as db:
                db.row_factory = sqlite3.Row
                rows = db.execute('''SELECT id, name, title, cwd, recency_at, updated_at FROM threads
                    WHERE archived=0 AND source='vscode'
                    AND (thread_source IS NULL OR thread_source='user')
                    ORDER BY recency_at DESC, updated_at DESC''').fetchall()
            self.rows = {r['id']: dict(r) for r in rows}
        except sqlite3.Error:
            # Schema changes and busy databases must not turn stale status into fact.
            self.rows = {}
        if self.client:
            targets = self.targets()
            for identifier in self.subscribed - targets:
                self.follow(identifier, False)
            self.subscribed.intersection_update(targets)
            for identifier in targets - self.subscribed:
                self.follow(identifier, True)
        self.emit()

    def targets(self):
        recent = {key for key, ts in self.activity.items() if time.time() - ts < 1800}
        busy = {key for key, value in self.live.items()
                if runtime_state(value.get('threadRuntimeStatus'))[0] != 'idle'}
        return (set(list(self.rows)[:24]) | recent | busy) & self.rows.keys()

    def send(self, message):
        payload = json.dumps(message).encode()
        self.sock.sendall(struct.pack('<I', len(payload)) + payload)

    def connect(self):
        self.reconnect_at = None
        path = self.home / 'ipc/ipc.sock'
        try:
            if path.stat().st_uid != os.getuid():
                raise OSError('foreign socket')
            self.sock = socket.socket(socket.AF_UNIX)
            self.sock.settimeout(2)
            self.sock.connect(str(path))
            self.send({'type': 'request', 'requestId': str(uuid.uuid4()), 'version': 0,
                       'method': 'initialize', 'params': {'clientType': 'agent-island'}})
        except OSError:
            self.disconnect()

    def disconnect(self):
        if self.sock:
            self.sock.close()
        self.sock = None
        self.client = None
        self.buffer.clear()
        self.live.clear()
        self.revisions.clear()
        self.owners.clear()
        self.subscribed.clear()
        self.reconnect_at = time.monotonic() + 5
        self.emit()

    def follow(self, identifier, following):
        self.send({'type': 'broadcast', 'method': 'thread-stream-following-changed', 'version': 1,
                   'sourceClientId': self.client, 'params': {
                       'conversationId': identifier, 'hostId': 'local', 'following': following}})
        if following:
            self.subscribed.add(identifier)

    def message(self, msg):
        if msg.get('type') == 'client-discovery-request':
            self.send({'type': 'client-discovery-response', 'requestId': msg['requestId'], 'response': {'canHandle': False}})
            return
        if msg.get('method') == 'initialize' and msg.get('resultType') == 'success':
            self.client = msg['result']['clientId']
            for identifier in self.targets():
                self.follow(identifier, True)
            return
        if msg.get('type') != 'broadcast':
            return
        params = msg.get('params', {})
        if (msg.get('method') == 'thread-stream-following-changed' and
                msg.get('sourceClientId') != self.client and params.get('hostId') == 'local' and
                params.get('following') is True):
            identifier = params.get('conversationId')
            if identifier in self.rows:
                self.activity[identifier] = time.time()
                if self.client and identifier not in self.subscribed:
                    self.follow(identifier, True)
                self.emit()
            return
        if msg.get('method') == 'client-status-changed' and params.get('status') == 'disconnected':
            for identifier, owner in list(self.owners.items()):
                if owner == params.get('clientId'):
                    self.live.pop(identifier, None)
                    self.revisions.pop(identifier, None)
            self.emit()
            return
        if msg.get('method') != 'thread-stream-state-changed' or params.get('hostId') != 'local':
            return
        identifier = params.get('conversationId')
        if identifier not in self.rows:
            return
        if msg.get('version') != STREAM_VERSION:
            self.live.pop(identifier, None)
            self.emit()
            return
        previous = (self.live.get(identifier, {}).get('threadRuntimeStatus') or {}).get('type')
        change = params.get('change', {})
        if change.get('type') == 'snapshot':
            full = change.get('conversationState', {})
            self.live[identifier] = {k: copy.deepcopy(v) for k, v in full.items() if k in KEEP_FIELDS}
        elif change.get('type') == 'patches':
            if identifier not in self.live or self.revisions.get(identifier) != change.get('baseRevision'):
                self.live.pop(identifier, None)
                self.follow(identifier, True)
                self.emit()
                return
            try:
                for patch in change.get('patches', []):
                    metadata_patch(self.live[identifier], patch)
            except (KeyError, TypeError, IndexError, ValueError):
                self.live.pop(identifier, None)
                self.follow(identifier, True)
                self.emit()
                return
        else:
            return
        current = (self.live[identifier].get('threadRuntimeStatus') or {}).get('type')
        if (current in ('active', 'idle', 'systemError') and current != previous) or any(
                p.get('path', [None])[0] == 'turns' for p in change.get('patches', []) if p.get('path')):
            self.activity[identifier] = time.time()
        self.revisions[identifier] = change.get('revision')
        self.owners[identifier] = msg.get('sourceClientId')
        self.emit()

    def emit(self):
        sessions = []
        for identifier, row in self.rows.items():
            live = self.live.get(identifier, {})
            state, label = runtime_state(live.get('threadRuntimeStatus'))
            timestamp = max(row['recency_at'] or row['updated_at'], self.activity.get(identifier, 0))
            if state == 'idle' and time.time() - timestamp >= 1800:
                continue
            sessions.append(dict(agent='codex-desktop', sessionId=identifier,
                title=live.get('title') or row['name'] or row['title'][:100], task='',
                cwd=live.get('cwd') or row['cwd'], state=state, statusLabel=label,
                ts=timestamp))
        payload = json.dumps(sessions, ensure_ascii=False)
        if payload != self.last_output:
            print(payload, flush=True)
            self.last_output = payload

    def read_events(self):
        data = os.read(self.watch, 65536)
        offset = 0
        dirty = False
        while offset + 16 <= len(data):
            _, _, _, size = struct.unpack_from('iIII', data, offset)
            name = data[offset+16:offset+16+size].split(b'\0')[0]
            dirty |= name.startswith(b'state_') or name == b'ipc'
            offset += 16 + size
        if dirty and self.refresh_at is None:
            self.refresh_at = max(time.monotonic(), self.last_refresh + 1)

    def run(self):
        if not self.home.is_dir():
            self.emit()
            return
        while True:
            now = time.monotonic()
            if self.refresh_at is not None and now >= self.refresh_at:
                try:
                    self.refresh()
                except OSError:
                    self.disconnect()
                    self.refresh_at = time.monotonic() + 1
            if self.reconnect_at is not None and now >= self.reconnect_at:
                self.connect()
            deadlines = [v for v in [self.refresh_at, self.reconnect_at] if v is not None]
            timeout = max(0, min(deadlines) - time.monotonic()) if deadlines else None
            try:
                ready, _, _ = select.select([self.watch] + ([self.sock] if self.sock else []), [], [], timeout)
                if self.watch in ready:
                    self.read_events()
                if self.sock and self.sock in ready:
                    chunk = self.sock.recv(65536)
                    if not chunk:
                        self.disconnect()
                        continue
                    self.buffer.extend(chunk)
                    while len(self.buffer) >= 4:
                        size = struct.unpack_from('<I', self.buffer)[0]
                        if size <= 0 or size > 32 * 1024 * 1024:
                            raise ValueError('Unsupported IPC frame size')
                        if len(self.buffer) < size + 4:
                            break
                        message = json.loads(self.buffer[4:size+4])
                        del self.buffer[:size+4]
                        self.message(message)
            except (OSError, ValueError, KeyError, TypeError):
                self.disconnect()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', required=True)
    options = parser.parse_args()
    try:
        Bridge(options.home).run()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
