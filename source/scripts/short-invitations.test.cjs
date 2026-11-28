const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { WebSocket } = require('ws');
const { createServer } = require('../collaboration/server.cjs');
const { Session, invitation, shortInvitation, parseInvitation } = require('../collaboration/client.cjs');
const { resolveInvitation } = require('../collaboration/connection.cjs');
global.WebSocket = WebSocket;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await wait(20); } throw Error('Invitation check timed out'); }
const project = { name: 'Short invitations', files: [{ name: 'main.ino', text: 'void setup() {}\nvoid loop() {}' }] };

test('Short invitations parse alone or with an address; full invitations remain compatible', () => {
  const key = 'a'.repeat(43), room = '01234567-89ab-cdef-0123-456789abcdef', server = 'http://10.20.30.40:1234';
  const code = shortInvitation(key); assert.equal(code.length, 27);
  assert.deepEqual(parseInvitation(code), { shortCode: key.slice(0, 22) });
  assert.deepEqual(parseInvitation(server + '\n' + code), { server, shortCode: key.slice(0, 22) });
  assert.deepEqual(parseInvitation(code + ' ' + server), { server, shortCode: key.slice(0, 22) });
  assert.deepEqual(parseInvitation(key.slice(0, 22)), { shortCode: key.slice(0, 22) });
  assert.deepEqual(parseInvitation(invitation(server, room, key)), { server, room, token: key });
  for (const input of ['IDE2.too-short', 'IDE2.' + 'a'.repeat(23), 'http://example.com ' + code, code + ' junk garbage']) assert.throws(() => parseInvitation(input));
});

test('Short codes enforce roles, persist hashed, reconnect, rotate and expire with the session', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-short-')), clients = [];
  let service = createServer({ directory, createKey: 'test-only' });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const port = service.server.address().port, server = 'http://127.0.0.1:' + port;
  t.after(async () => { clients.forEach(client => client.close()); await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const response = await fetch(server + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only' }, body: JSON.stringify(project) });
  const created = await response.json(); let keys = created.keys;
  async function connect(role, short = true) {
    const invite = short ? await resolveInvitation(server, keys[role].slice(0, 22)) : { server, room: created.room, token: keys[role] };
    const errors = [], client = new Session({ ...invite, name: role, onError: error => errors.push(error) });
    clients.push(client); client.errors = errors; client.connect(); await until(() => client.status === 'connected'); assert.equal(client.role, role); return client;
  }
  const owner = await connect('owner', false), editor = await connect('editor'), viewer = await connect('viewer');
  assert.equal(owner.shortInvitations, true);
  editor.doc.transact(() => editor.doc.getMap('files').get('initial-000').get('text').insert(0, '// short code edit\n'), require('../collaboration/model.cjs').LOCAL); editor.flush();
  await until(() => viewer.doc.getMap('files').get('initial-000').get('text').toString().includes('short code edit'));
  viewer.send({ t: 'update', state: Buffer.from(require('yjs').encodeStateAsUpdate(viewer.doc)).toString('base64') });
  editor.send({ t: 'rotate' }); await until(() => viewer.errors.length && editor.errors.length);
  assert.match(viewer.errors[0], /Viewer/); assert.match(editor.errors[0], /owner/);
  const saved = fs.readFileSync(path.join(directory, created.room + '.json'), 'utf8');
  for (const key of Object.values(keys)) { assert.ok(!saved.includes(key)); assert.ok(!saved.includes(key.slice(0, 22))); }
  await service.close(); service = createServer({ directory, createKey: 'test-only' });
  await new Promise(resolve => service.server.listen(port, '127.0.0.1', resolve));
  await resolveInvitation(server, keys.editor.slice(0, 22)); await until(() => owner.status === 'connected' && editor.status === 'connected');
  const previous = keys.editor.slice(0, 22); let rotated;
  owner.options.onInvites = value => { rotated = value; }; owner.send({ t: 'rotate' });
  await until(() => rotated && editor.status === 'ended' && viewer.status === 'ended'); keys = { ...keys, ...rotated };
  await assert.rejects(resolveInvitation(server, previous), /invalid, replaced or expired/);
  const replacement = await connect('editor'); assert.equal(replacement.role, 'editor');
  owner.send({ t: 'end' }); await until(() => owner.status === 'ended');
  await assert.rejects(resolveInvitation(server, keys.editor.slice(0, 22)), /invalid, replaced or expired/);
});

test('Short-code lookup is bounded, rate limited, and explains older servers', async t => {
  await assert.rejects(resolveInvitation('http://127.0.0.1:1234', 'a'.repeat(22), async () => new Response('{}', { status: 404 })), /server needs an update/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-code-limit-'));
  const service = createServer({ directory }); await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const endpoint = 'http://127.0.0.1:' + service.server.address().port + '/api/invitations/resolve';
  const post = body => fetch(endpoint, { method: 'POST', body });
  assert.equal((await post('x'.repeat(513))).status, 413);
  for (let i = 0; i < 29; i++) assert.equal((await post(JSON.stringify({ code: 'a'.repeat(22) }))).status, 401);
  assert.equal((await post(JSON.stringify({ code: 'a'.repeat(22) }))).status, 429);
});

test('Existing persisted sessions keep full invitations and gain short codes when the owner rotates', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-old-invites-'));
  let service = createServer({ directory }); await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const port = service.server.address().port, server = 'http://127.0.0.1:' + port;
  const created = await (await fetch(server + '/api/rooms', { method: 'POST', body: JSON.stringify(project) })).json();
  await service.close();
  const file = path.join(directory, created.room + '.json'), saved = JSON.parse(fs.readFileSync(file));
  delete saved.shortHashes; fs.writeFileSync(file, JSON.stringify(saved));
  service = createServer({ directory }); await new Promise(resolve => service.server.listen(port, '127.0.0.1', resolve));
  let rotated;
  const owner = new Session({ server, room: created.room, token: created.keys.owner, name: 'Owner', onInvites: keys => { rotated = keys; } });
  t.after(async () => { owner.close(); await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  owner.connect(); await until(() => owner.status === 'connected'); assert.equal(owner.shortInvitations, false);
  owner.send({ t: 'rotate' }); await until(() => rotated); assert.equal(owner.shortInvitations, true);
  const resolved = await resolveInvitation(server, rotated.editor.slice(0, 22)); assert.equal(resolved.room, created.room);
  assert.equal(service.rooms.get(created.room).hashes.owner, saved.hashes.owner);
});
