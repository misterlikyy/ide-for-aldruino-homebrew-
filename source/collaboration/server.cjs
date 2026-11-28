const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { Y, LIMITS, snapshot, createDocument } = require('./model.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
// The first 22 random base64url characters retain 132 bits of entropy.
const shortHashes = keys => Object.fromEntries(['editor', 'viewer'].map(role => [role, digest(keys[role].slice(0, 22))]));
const hasCredential = (room, role, hash) => room.hashes[role] === hash || room.shortHashes?.[role] === hash;
const hasShortCodes = room => ['editor', 'viewer'].every(role => /^[a-f0-9]{64}$/.test(room.shortHashes?.[role]));
const encode = doc => Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
const decode = value => {
  if (typeof value !== 'string' || value.length > LIMITS.stateBytes * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw Error('Invalid document update.');
  return new Uint8Array(Buffer.from(value, 'base64'));
};

function createServer(options = {}) {
  const directory = path.resolve(options.directory || process.env.COLLAB_DATA_DIR || './collaboration-data');
  const createKey = options.createKey ?? process.env.COLLAB_CREATE_KEY ?? '';
  const rooms = new Map(), requests = new Map(), resolutions = new Map();
  const ttl = 7 * 24 * 60 * 60 * 1000;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const roomPath = id => path.join(directory, id + '.json');
  const save = room => {
    const state = encode(room.doc);
    if (state.length > LIMITS.stateBytes * 1.4) throw Error('Session history is full. Save a local copy and start a new session.');
    const temporary = roomPath(room.id) + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ id: room.id, hashes: room.hashes, shortHashes: room.shortHashes || {}, updated: room.updated, state }), { mode: 0o600 });
    fs.renameSync(temporary, roomPath(room.id));
  };
  for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).slice(0, 100)) {
    try {
      const file = path.join(directory, name), value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value.id + '.json' !== name || Date.now() - value.updated > ttl) { fs.unlinkSync(file); continue; }
      if (!['owner', 'editor', 'viewer'].every(role => /^[a-f0-9]{64}$/.test(value.hashes?.[role]))) continue;
      if (!hasShortCodes(value)) value.shortHashes = {};
      const doc = new Y.Doc(); Y.applyUpdate(doc, decode(value.state)); snapshot(doc);
      rooms.set(value.id, { ...value, doc, peers: new Map() });
    } catch { /* Invalid persisted sessions are never made accessible. */ }
  }
  const send = (socket, value) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  const broadcast = (room, value, except) => { for (const peer of room.peers.values()) if (peer.socket !== except) send(peer.socket, value); };
  const presence = room => broadcast(room, { t: 'people', people: [...room.peers.values()].map(({ id, name, role, cursor }) => ({ id, name, role, cursor })) });
  const reply = (response, code, value) => { response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); };
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url.split('?')[0] === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
      return response.end(require('./landing.cjs'));
    }
    if (request.method === 'GET' && request.url === '/health') return reply(response, 200, { ok: true, service: 'IDE-beta collaboration', protocol: 1 });
    if (request.method === 'POST' && request.url === '/api/invitations/resolve') {
      const ip = request.socket.remoteAddress, now = Date.now(), rate = resolutions.get(ip) || { start: now, count: 0 };
      if (now - rate.start > 60000) { rate.start = now; rate.count = 0; }
      rate.count++; resolutions.set(ip, rate);
      if (rate.count > 30) return reply(response, 429, { error: 'Too many invitation checks. Wait a minute and try again.' });
      try {
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 512) { reply(response, 413, { error: 'Invitation is too large.' }); request.resume(); return; } chunks.push(chunk); }
        const { code } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(code)) return reply(response, 400, { error: 'Paste a complete short invitation.' });
        const hash = digest(code);
        const room = [...rooms.values()].find(room => Date.now() - room.updated <= ttl && ['editor', 'viewer'].some(role => room.shortHashes?.[role] === hash));
        if (!room) return reply(response, 401, { error: 'This invitation is invalid, replaced or expired. Check the server address or ask the host for a new code.' });
        return reply(response, 200, { room: room.id, protocol: 1 });
      } catch { return reply(response, 400, { error: 'Paste a complete short invitation.' }); }
    }
    if (request.method !== 'POST' || request.url !== '/api/rooms') return reply(response, 404, { error: 'Not found.' });
    if (createKey && digest(request.headers.authorization || '') !== digest('Bearer ' + createKey)) return reply(response, 401, { error: 'The server creation key is missing or incorrect.' });
    // Request limits are deliberately per socket address; forwarded headers are not trusted.
    const ip = request.socket.remoteAddress, now = Date.now(), rate = requests.get(ip) || { start: now, count: 0 };
    if (now - rate.start > 3600000) { rate.start = now; rate.count = 0; }
    rate.count++; requests.set(ip, rate);
    if (rate.count > 20 || rooms.size >= 100) return reply(response, 429, { error: 'Session creation limit reached. Try again later.' });
    const chunks = []; let size = 0;
    try {
      for await (const chunk of request) { size += chunk.length; if (size > 1500000) { reply(response, 413, { error: 'Project is too large.' }); request.resume(); return; } chunks.push(chunk); }
      const project = JSON.parse(Buffer.concat(chunks).toString('utf8')), doc = createDocument(project);
      const keys = { owner: token(), editor: token(), viewer: token() };
      const room = { id: crypto.randomUUID(), doc, hashes: Object.fromEntries(Object.entries(keys).map(([role, key]) => [role, digest(key)])), shortHashes: shortHashes(keys), updated: Date.now(), peers: new Map() };
      save(room); rooms.set(room.id, room);
      reply(response, 201, { room: room.id, keys, protocol: 1 });
    } catch (error) { reply(response, 400, { error: error.message }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 15000;
  const sockets = new WebSocketServer({ server, path: '/sync', maxPayload: 6 * 1024 * 1024, perMessageDeflate: false });
  sockets.on('connection', socket => {
    if (sockets.clients.size > 128) { socket.close(4429, 'The server is full'); return; }
    let room, peer, count = 0, rateStart = Date.now();
    const authTimeout = setTimeout(() => socket.close(4401, 'Invitation required'), 10000);
    socket.on('error', () => {});
    socket.on('message', raw => {
      try {
        if (Date.now() - rateStart > 1000) { rateStart = Date.now(); count = 0; }
        if (++count > 80) return socket.close(4429, 'Too many updates');
        const message = JSON.parse(raw.toString());
        if (!peer) {
          if (message.t !== 'auth' || typeof message.token !== 'string' || message.token.length > 100) return socket.close(4401, 'Invalid invitation');
          room = rooms.get(message.room);
          const hash = digest(message.token), role = room && Object.keys(room.hashes).find(role => hasCredential(room, role, hash));
          if (!role || Date.now() - room.updated > ttl) return socket.close(4401, 'Invitation is invalid or expired');
          if (room.peers.size >= 12) return socket.close(4429, 'This session is full');
          peer = { id: crypto.randomUUID(), name: typeof message.name === 'string' ? message.name.trim().slice(0, 40) || 'Guest' : 'Guest', role, credentialHash: hash, socket, cursor: null };
          room.peers.set(peer.id, peer); clearTimeout(authTimeout);
          send(socket, { t: 'welcome', id: peer.id, role, shortInvitations: hasShortCodes(room), state: encode(room.doc) }); presence(room); return;
        }
        if (!rooms.has(room.id) || !hasCredential(room, peer.role, peer.credentialHash)) return socket.close(4403, 'Session access was revoked');
        if (message.t === 'update') {
          if (peer.role === 'viewer') return send(socket, { t: 'error', message: 'Viewer access does not allow edits.' });
          const candidate = new Y.Doc();
          try {
            Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc)); Y.applyUpdate(candidate, decode(message.state)); snapshot(candidate);
            if (Y.encodeStateAsUpdate(candidate).length > LIMITS.stateBytes) throw Error('Session history is full. Start a new session.');
            const previous = room.doc; room.doc = candidate; room.updated = Date.now();
            try { save(room); } catch (error) { room.doc = previous; throw error; }
            previous.destroy();
            broadcast(room, { t: 'update', state: message.state }, socket); send(socket, { t: 'saved', seq: message.seq });
          } catch (error) { if (candidate !== room.doc) candidate.destroy(); send(socket, { t: 'rejected', message: error.message, state: encode(room.doc) }); }
        } else if (message.t === 'presence') {
          if (JSON.stringify(message.cursor || null).length > 4096) return;
          peer.cursor = message.cursor || null; presence(room);
        } else if (message.t === 'rotate') {
          if (peer.role !== 'owner') return send(socket, { t: 'error', message: 'Only the owner can replace invitations.' });
          const keys = { editor: token(), viewer: token() }, previous = { ...room.hashes }, previousShort = room.shortHashes;
          for (const [role, key] of Object.entries(keys)) room.hashes[role] = digest(key);
          room.shortHashes = shortHashes(keys);
          try { save(room); } catch (error) { room.hashes = previous; room.shortHashes = previousShort; throw error; }
          send(socket, { t: 'invites', keys, shortInvitations: true });
          for (const person of room.peers.values()) if (person.role !== 'owner') person.socket.close(4403, 'Invitations were replaced by the owner');
        } else if (message.t === 'end') {
          if (peer.role !== 'owner') return send(socket, { t: 'error', message: 'Only the owner can end this session.' });
          fs.unlinkSync(roomPath(room.id)); rooms.delete(room.id);
          for (const person of room.peers.values()) person.socket.close(4404, 'The owner ended this session');
          room.doc.destroy();
        }
      } catch { send(socket, { t: 'error', message: 'The server could not process this request.' }); }
    });
    socket.on('close', () => { clearTimeout(authTimeout); if (peer) { room.peers.delete(peer.id); presence(room); } });
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
  });
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) { if (!socket.isAlive) socket.terminate(); else { socket.isAlive = false; socket.ping(); } }
    for (const [ip, rate] of requests) if (Date.now() - rate.start > 3600000) requests.delete(ip);
    for (const [ip, rate] of resolutions) if (Date.now() - rate.start > 60000) resolutions.delete(ip);
    for (const [id, room] of rooms) if (!room.peers.size && Date.now() - room.updated > ttl) { fs.unlinkSync(roomPath(id)); room.doc.destroy(); rooms.delete(id); }
  }, 30000);
  heartbeat.unref();
  return { server, rooms, async close() { clearInterval(heartbeat); for (const socket of sockets.clients) socket.terminate(); await new Promise(resolve => sockets.close(resolve)); if (server.listening) await new Promise(resolve => server.close(resolve)); for (const room of rooms.values()) room.doc.destroy(); } };
}

if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 1234);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (!process.env.COLLAB_CREATE_KEY || process.env.COLLAB_CREATE_KEY.length < 24)) throw Error('Set COLLAB_CREATE_KEY to at least 24 random characters before accepting network connections.');
  const service = createServer();
  service.server.listen(port, host, () => console.log('IDE-beta collaboration server listening on port ' + port));
  const shutdown = async () => { await service.close(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
module.exports = { createServer };
