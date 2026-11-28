const { validateProject } = require('./model.cjs');
const ID = /^[a-f0-9-]{36}$/;
const text = (value, max) => typeof value === 'string' && value.length <= max;
class HardwareRelay {
  constructor({ send, broadcast, project, peers }) {
    this.send = send; this.broadcast = broadcast; this.project = project; this.peers = peers;
    this.host = null; this.pending = null; this.recent = new Set(); this.clear();
  }
  clear() { this.state = { connected: false, busy: false, label: 'Host Arduino is not shared' }; this.lines = []; this.pins = ''; this.program = null; this.output = []; this.lastDataAt = 0; }
  summary() { return { t: 'hardware-state', enabled: !!this.host, host: this.host, pending: this.pending ? { id: this.pending.id, action: this.pending.action, name: this.pending.name } : null, ...this.state }; }
  snapshot() { return { t: 'hardware-snapshot', state: this.summary(), lines: this.lines, pins: this.pins, program: this.program, output: this.output, ageMs: this.lastDataAt ? Math.max(0, Date.now() - this.lastDataAt) : null }; }
  welcome(peer) { this.send(peer.socket, this.snapshot()); }
  stop(reason) {
    if (this.pending) { const peer = this.peers.get(this.pending.peer); if (peer) this.send(peer.socket, { t: 'hardware-result', id: this.pending.id, ok: false, error: reason }); }
    this.host = null; this.pending = null; this.state.connected = false; this.state.busy = false; this.state.label = reason; this.broadcast(this.summary());
  }
  leave(peer) { if (this.host === peer.id) this.stop('The host stopped sharing or disconnected. Last received readings are retained.'); }
  handle(peer, message) {
    if (!['hardware-host', 'hardware-events', 'hardware-request', 'hardware-result'].includes(message.t)) return false;
    try {
      if (message.t === 'hardware-host') {
        if (peer.role !== 'owner') throw Error('Only the session owner can share an Arduino.');
        if (message.enabled !== true) { if (this.host === peer.id) this.stop('The host stopped sharing its Arduino.'); return true; }
        if (this.host && this.host !== peer.id) throw Error('Another owner window is already sharing the Arduino. Stop sharing there first.');
        if (!this.host) { this.clear(); this.host = peer.id; this.state.label = 'Host Arduino · waiting for connection'; }
        this.broadcast(this.summary()); return true;
      }
      if (message.t === 'hardware-request') {
        if (!ID.test(message.id)) throw Error('Invalid hardware request.');
        if (!['owner', 'editor'].includes(peer.role)) throw Error('Viewer access cannot control or upload to the host Arduino.');
        if (!this.host || !this.peers.has(this.host)) throw Error('The host Arduino is not shared. Ask the owner to enable Share my Arduino.');
        if (peer.id === this.host) throw Error('Use the local controls on the host.');
        if (this.pending || this.state.busy) throw Error('The host Arduino is busy. Wait for the current operation to finish.');
        if (!['upload', 'build', 'connect', 'disconnect', 'command'].includes(message.action)) throw Error('Unsupported hardware action.');
        if (message.action === 'command' && (!text(message.text, 1024) || !message.text.trim() || /[\x00-\x08\x0e-\x1f]/.test(message.text))) throw Error('Invalid Arduino command.');
        if (this.recent.has(message.id)) throw Error('This hardware request has already been handled.');
        this.recent.add(message.id); if (this.recent.size > 200) this.recent.delete(this.recent.values().next().value);
        this.pending = { id: message.id, peer: peer.id, name: peer.name, action: message.action };
        this.broadcast(this.summary());
        this.send(this.peers.get(this.host).socket, { t: 'hardware-job', ...this.pending, text: message.text || '', ...(['upload', 'build'].includes(message.action) ? { project: this.project() } : {}) });
        return true;
      }
      if (peer.id !== this.host || peer.role !== 'owner') throw Error('Only the active Arduino host can publish hardware data.');
      if (message.t === 'hardware-result') {
        if (!this.pending || message.id !== this.pending.id) throw Error('This hardware job is no longer active.');
        const target = this.peers.get(this.pending.peer);
        if (target) this.send(target.socket, { t: 'hardware-result', id: message.id, ok: message.ok === true, error: text(message.error, 500) ? message.error : '' });
        this.pending = null; this.broadcast(this.summary()); return true;
      }
      if (!Array.isArray(message.events) || message.events.length > 64 || JSON.stringify(message.events).length > 1500000) throw Error('Hardware data exceeded its limit.');
      for (const event of message.events) {
        if (event.kind === 'state') {
          if (typeof event.connected !== 'boolean' || typeof event.busy !== 'boolean' || !text(event.label, 200)) throw Error('Invalid Arduino status.');
          const board = event.board;
          if (!board || !text(board.name, 120) || !text(board.fqbn, 120) || !/^[A-Za-z0-9_.:=,-]+$/.test(board.fqbn)) throw Error('Invalid host board.');
        } else if (event.kind === 'line' || event.kind === 'output' || event.kind === 'tx') {
          if (!text(event.text, 4096)) throw Error('Arduino text exceeded its limit.');
        } else if (event.kind === 'program') {
          if (!text(event.label, 200)) throw Error('Invalid program label.');
          if (event.files !== null) validateProject({ name: 'Uploaded program', files: event.files });
        } else if (event.kind === 'history') {
          if (!Array.isArray(event.lines) || event.lines.length > 400 || event.lines.some(line => !text(line, 4096)) || !text(event.pins, 4096) ||
            (event.ageMs !== null && (!Number.isFinite(event.ageMs) || event.ageMs < 0))) throw Error('Invalid live-data history.');
        } else if (event.kind !== 'reset') throw Error('Unknown hardware event.');
      }
      for (const event of message.events) {
        if (event.kind === 'state') { this.state = { connected: event.connected, busy: event.busy, label: event.label, board: { name: event.board.name, fqbn: event.board.fqbn } }; }
        else if (event.kind === 'line') { this.lastDataAt = Date.now(); if (event.text.startsWith('PINS:')) this.pins = event.text; else { this.lines.push(event.text); if (this.lines.length > 400) this.lines.shift(); } }
        else if (event.kind === 'output') { if (event.clear) this.output = []; this.output.push(event.text); if (this.output.length > 200) this.output.shift(); }
        else if (event.kind === 'program') this.program = { files: event.files, label: event.label };
        else if (event.kind === 'history') { this.lines = event.lines.slice(); this.pins = event.pins; this.lastDataAt = event.ageMs == null ? 0 : Date.now() - Math.min(event.ageMs, 31536000000); }
        else if (event.kind === 'reset') { this.lines = []; this.pins = ''; this.lastDataAt = 0; }
      }
      this.broadcast({ t: 'hardware-events', events: message.events, host: this.host }); return true;
    } catch (error) {
      if (message.t === 'hardware-request' && ID.test(message.id)) this.send(peer.socket, { t: 'hardware-result', id: message.id, ok: false, error: error.message });
      else this.send(peer.socket, { t: 'error', message: error.message });
      return true;
    }
  }
}
module.exports = { HardwareRelay };
