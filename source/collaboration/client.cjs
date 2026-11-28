const model = require('./model.cjs');
const { serverUrl } = require('./url.cjs');
const { addressKind } = require('./connection.cjs');
const { Y, REMOTE, LOCAL } = model;
const encode = bytes => { let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte); return btoa(raw); };
const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
function invitation(server, room, token) { return 'IDE1.' + btoa(JSON.stringify({ server: serverUrl(server), room, token })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function parseInvitation(value) {
  try {
    if (typeof value !== 'string' || value.length > 3000 || !value.trim().startsWith('IDE1.')) throw Error();
    const data = JSON.parse(atob(value.trim().slice(5).replace(/-/g, '+').replace(/_/g, '/')));
    if (!/^[a-f0-9-]{36}$/.test(data.room) || !/^[A-Za-z0-9_-]{43}$/.test(data.token)) throw Error();
    return { server: serverUrl(data.server), room: data.room, token: data.token };
  } catch { throw Error('Paste the complete IDE1 invitation code.'); }
}
class Session {
  constructor(options) {
    this.options = options; this.server = serverUrl(options.server); this.room = options.room; this.token = options.token;
    this.name = options.name.trim().slice(0, 40) || 'Guest'; this.role = ''; this.status = 'connecting'; this.closed = false; this.ready = false;
    this.delay = 500; this.pending = []; this.doc = null; this.socket = null; this.people = []; this.awaiting = new Set(); this.sequence = 0; this.deferred = [];
  }
  notify(status, message) { this.status = status; this.options.onStatus?.(status, message); }
  setDocument(state) {
    this.undoManager?.destroy(); this.doc?.destroy();
    this.doc = new Y.Doc(); Y.applyUpdate(this.doc, decode(state), REMOTE); model.snapshot(this.doc);
    this.undoManager = new Y.UndoManager([this.doc.getMap('files'), this.doc.getMap('project')], { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 });
    this.doc.on('update', (update, origin) => {
      if (origin === REMOTE || this.role === 'viewer') return;
      this.pending.push(update); this.notify(this.ready ? 'saving' : 'offline', this.ready ? '' : 'Edits are kept locally until reconnection.');
      clearTimeout(this.flushTimer); this.flushTimer = setTimeout(() => this.flush(), 70);
      if (origin !== LOCAL) this.options.onProject?.(model.snapshot(this.doc));
    });
  }
  connect() {
    if (this.closed) return;
    this.notify(this.doc ? 'reconnecting' : 'connecting');
    const socket = this.socket = new WebSocket(this.server.replace(/^http/, 'ws') + '/sync');
    const timeout = setTimeout(() => socket.close(), 15000);
    socket.onopen = () => socket.send(JSON.stringify({ t: 'auth', room: this.room, token: this.token, name: this.name }));
    socket.onmessage = event => {
      if (this.socket !== socket || this.closed) return;
      try {
        const message = JSON.parse(event.data);
        if (this.composing && ['welcome', 'update', 'rejected'].includes(message.t)) { this.deferred.push({ socket, data: event.data }); return; }
        if (message.t === 'welcome') {
          if (!['owner', 'editor', 'viewer'].includes(message.role)) throw Error('Unknown session role.');
          clearTimeout(timeout); this.id = message.id; this.role = message.role; this.ready = true; this.delay = 500;
          const selection = this.options.beforeRemote?.();
          if (!this.doc) this.setDocument(message.state); else Y.applyUpdate(this.doc, decode(message.state), REMOTE);
          this.options.onProject?.(model.snapshot(this.doc), selection); this.options.onReady?.();
          this.awaiting.clear();
          if (this.role !== 'viewer') { this.pending = []; this.sendUpdate(encode(Y.encodeStateAsUpdate(this.doc))); this.notify('saving'); }
          else this.notify('connected');
        } else if (message.t === 'update') {
          const selection = this.options.beforeRemote?.(); Y.applyUpdate(this.doc, decode(message.state), REMOTE);
          this.options.onProject?.(model.snapshot(this.doc), selection); this.options.onPeople?.(this.people);
        } else if (message.t === 'saved') { this.awaiting.delete(message.seq); this.notify(this.pending.length || this.awaiting.size ? 'saving' : 'connected'); }
        else if (message.t === 'people') { this.people = message.people; this.options.onPeople?.(message.people); }
        else if (message.t === 'invites') this.options.onInvites?.(message.keys);
        else if (message.t === 'error') this.options.onError?.(message.message);
        else if (message.t === 'rejected') {
          this.options.beforeReject?.(); this.pending = []; this.awaiting.clear(); this.setDocument(message.state);
          this.options.onProject?.(model.snapshot(this.doc)); this.notify('connected'); this.options.onError?.(message.message + ' Your unsent version was backed up locally.');
        }
      } catch (error) { this.notify('ended', 'Could not synchronize this session: ' + error.message); this.close(); this.options.onEnded?.(); }
    };
    socket.onerror = () => {};
    socket.onclose = event => {
      clearTimeout(timeout); if (this.socket !== socket || this.closed) return;
      this.ready = false;
      if (event.code >= 4400 && event.code < 4500) { this.notify('ended', event.reason || 'The session is no longer available.'); this.closed = true; this.options.onEnded?.(); return; }
      this.notify('offline', 'Connection lost. Your draft is kept locally; reconnecting…');
      this.reconnectTimer = setTimeout(() => this.connect(), this.delay); this.delay = Math.min(this.delay * 2, 15000);
    };
  }
  send(message) { if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  resumeUpdates() { this.composing = false; const updates = this.deferred; this.deferred = []; for (const update of updates) if (update.socket === this.socket) this.socket.onmessage({ data: update.data }); }
  sendUpdate(state) { const seq = ++this.sequence; this.awaiting.add(seq); this.send({ t: 'update', state, seq }); }
  flush() { if (this.pending.length && this.ready) { const state = encode(Y.mergeUpdates(this.pending)); this.pending = []; this.sendUpdate(state); } }
  sync(project) { if (this.doc && this.role !== 'viewer') model.syncProject(this.doc, project); }
  cursor(id, start, end) { return this.doc ? model.cursor(this.doc, id, start, end) : null; }
  resolve(position) { return this.doc ? model.resolveCursor(this.doc, position) : null; }
  undo() { if (this.role !== 'viewer') this.undoManager?.undo(); }
  redo() { if (this.role !== 'viewer') this.undoManager?.redo(); }
  close() { this.closed = true; this.ready = false; clearTimeout(this.reconnectTimer); clearTimeout(this.flushTimer); this.socket?.close(); this.undoManager?.destroy(); this.doc?.destroy(); }
}
module.exports = { Session, invitation, parseInvitation, serverUrl, addressKind };
