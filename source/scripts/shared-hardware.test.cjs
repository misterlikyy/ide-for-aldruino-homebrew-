const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { WebSocket } = require('ws');
const { createServer } = require('../collaboration/server.cjs');
const { Session } = require('../collaboration/client.cjs');
const model = require('../collaboration/model.cjs');
global.WebSocket = WebSocket;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n = 0; n < 250; n++) { if (fn()) return; await wait(15); } throw Error('Shared hardware timed out'); }
const part = id => ({ id, type: 'led', label: 'LED', x: 100, y: 200, pins: { sig: 'D13' }, props: { color: 'red' } });
const project = () => ({ name: 'Shared Uno', files: [{ name: 'main.ino', text: 'void setup() {}\nvoid loop() {}' }], circuit: { parts: [part('initial')] } });

test('Visualization merges concurrent parts and properties, validates input and preserves code-only clients', () => {
  const a = model.createDocument(project()), b = new model.Y.Doc(); model.Y.applyUpdate(b, model.Y.encodeStateAsUpdate(a), model.REMOTE);
  const edit = (doc, run) => { const p = model.snapshot(doc); p.files.forEach(f => { f.collabId = f.id; }); run(p); model.syncProject(doc, p); };
  edit(a, p => { p.circuit.parts[0].x = 500; p.circuit.parts.push(part('alice')); });
  edit(b, p => { p.circuit.parts[0].label = 'Status LED'; p.circuit.parts.push(part('bob')); });
  model.Y.applyUpdate(a, model.Y.encodeStateAsUpdate(b), model.REMOTE); model.Y.applyUpdate(b, model.Y.encodeStateAsUpdate(a), model.REMOTE);
  assert.deepEqual(model.snapshot(a), model.snapshot(b)); assert.equal(model.snapshot(a).circuit.parts.length, 3);
  const original = model.snapshot(a).circuit.parts.find(p => p.id === 'initial'); assert.equal(original.x, 500); assert.equal(original.label, 'Status LED');
  edit(a, p => { delete p.circuit; p.files[0].text += '\n// older client'; }); assert.equal(model.snapshot(a).circuit.parts.length, 3);
  for (const invalid of [{ parts: [{ ...part('x'), x: Infinity }] }, { parts: [part('x'), part('x')] }, { parts: [{ ...part('x'), props: { color: {} } }] }]) assert.throws(() => model.validateProject({ ...project(), circuit: invalid }));
  a.destroy(); b.destroy();
});

test('Real session routes jobs only to an opted-in owner, sends snapshots, and refuses spoofing and replay', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-hardware-')), clients = [];
  const service = createServer({ directory }); await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { clients.forEach(c => c.close()); await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const server = 'http://127.0.0.1:' + service.server.address().port;
  const room = await (await fetch(server + '/api/rooms', { method: 'POST', body: JSON.stringify(project()) })).json();
  async function connect(role) {
    const events = [], errors = [], c = new Session({ server, room: room.room, token: room.keys[role], name: role, onHardware: event => events.push(event), onError: error => errors.push(error) });
    clients.push(c); c.events = events; c.errors = errors; c.connect(); await until(() => c.status === 'connected'); return c;
  }
  const owner = await connect('owner'), editor = await connect('editor'), viewer = await connect('viewer');
  const request = (c, action = 'upload', id = randomUUID()) => { c.send({ t: 'hardware-request', id, action }); return id; };
  const result = async (c, id) => { await until(() => c.events.some(e => e.t === 'hardware-result' && e.id === id)); return c.events.find(e => e.t === 'hardware-result' && e.id === id); };
  assert.equal((await result(editor, request(editor))).ok, false);
  viewer.send({ t: 'hardware-host', enabled: true }); await until(() => viewer.errors.length); assert.match(viewer.errors[0], /owner/);
  owner.send({ t: 'hardware-host', enabled: true }); await until(() => editor.events.some(e => e.t === 'hardware-state' && e.enabled));
  owner.send({ t: 'hardware-events', events: [{ kind: 'state', connected: true, busy: false, label: 'Uno COM5', board: { name: 'Arduino Uno', fqbn: 'arduino:avr:uno' } }, { kind: 'program', files: project().files, label: 'Uploaded sketch' }, { kind: 'line', text: 'DISPLAY:real host LCD' }] });
  await until(() => viewer.events.some(e => e.t === 'hardware-events'));
  const late = await connect('viewer'); await until(() => late.events.some(e => e.t === 'hardware-snapshot'));
  const cache = late.events.find(e => e.t === 'hardware-snapshot'); assert.deepEqual(cache.lines, ['DISPLAY:real host LCD']); assert.equal(cache.program.label, 'Uploaded sketch');
  assert.equal((await result(viewer, request(viewer))).ok, false);
  editor.send({ t: 'hardware-events', events: [{ kind: 'line', text: 'forged' }] }); await until(() => editor.errors.length); assert.match(editor.errors[0], /active Arduino host/);
  const value = model.snapshot(editor.doc); value.files.forEach(f => { f.collabId = f.id; }); value.files[0].text += '\n// snapshot uploaded'; editor.sync(value); editor.flush();
  const id = request(editor); await until(() => owner.events.some(e => e.t === 'hardware-job' && e.id === id));
  const job = owner.events.find(e => e.t === 'hardware-job' && e.id === id); assert.ok(job.project.files[0].text.includes('snapshot uploaded'));
  assert.equal((await result(editor, request(editor))).ok, false, 'Concurrent jobs must be refused');
  editor.send({ t: 'hardware-result', id, ok: true }); await until(() => editor.errors.length > 1);
  owner.send({ t: 'hardware-result', id, ok: true }); assert.equal((await result(editor, id)).ok, true);
  for (let n = editor.events.length - 1; n >= 0; n--) if (editor.events[n].id === id) editor.events.splice(n, 1);
  assert.equal((await result(editor, request(editor, 'upload', id))).ok, false, 'Old job IDs must not execute twice');
  const waitingId = request(editor); await until(() => owner.events.some(e => e.t === 'hardware-job' && e.id === waitingId));
  owner.close(); assert.equal((await result(editor, waitingId)).ok, false);
  await until(() => editor.events.some(e => e.t === 'hardware-state' && !e.enabled));
  assert.equal(owner.events.filter(e => e.t === 'hardware-job' && e.id === waitingId).length, 1);
});
