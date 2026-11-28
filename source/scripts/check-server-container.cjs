const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const key = crypto.randomBytes(32).toString('hex');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
(async () => {
  const id = docker(['run', '-d', '--read-only', '--tmpfs', '/tmp', '-e', 'COLLAB_CREATE_KEY=' + key, '-p', '127.0.0.1::1234', 'ide-beta-collaboration-check']);
  try {
    const binding = JSON.parse(docker(['inspect', id]))[0].NetworkSettings.Ports['1234/tcp'][0];
    const address = 'http://127.0.0.1:' + binding.HostPort;
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(address + '/health')).ok; } catch {} if (ready) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    if (!ready) throw Error('The production server container did not become ready');
    const home = await fetch(address); if (!home.ok || !(await home.text()).includes('Server is running')) throw Error('Server homepage is unavailable');
    const response = await fetch(address + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ name: 'Container check', files: [{ name: 'main.ino', text: 'void setup() {}\nvoid loop() {}' }] }) });
    if (!response.ok) throw Error('The production container could not create a session');
    const room = await response.json();
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(address.replace('http:', 'ws:') + '/sync');
      const timeout = setTimeout(() => { socket.terminate(); reject(Error('Container WebSocket timed out')); }, 10000);
      socket.on('open', () => socket.send(JSON.stringify({ t: 'auth', room: room.room, token: room.keys.viewer, name: 'Check' })));
      socket.on('error', reject);
      socket.on('message', raw => { if (JSON.parse(raw).t === 'welcome') { clearTimeout(timeout); socket.close(); resolve(); } });
    });
    console.log('Production container health, session storage and WebSocket authentication passed.');
  } finally { docker(['rm', '-f', '-v', id]); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
