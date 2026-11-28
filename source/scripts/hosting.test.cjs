const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const script = path.join(root, 'hosting/linux/setup-server.sh').replace(/\\/g, '/');
for (const [id, family, packages] of [
  ['ubuntu', 'ubuntu', 'docker.io docker-compose-v2 docker-buildx openssl'],
  ['linuxmint', 'ubuntu', 'docker.io docker-compose-v2 docker-buildx openssl'],
  ['debian', 'debian', 'docker.io docker-compose docker-buildx openssl'],
  ['fedora', 'fedora', 'moby-engine docker-compose docker-buildx openssl']
]) test('Server setup detects ' + id + ' without installing packages or writing credentials', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-hosting-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const release = path.join(directory, 'os-release');
  fs.writeFileSync(release, `ID=${id}\nPRETTY_NAME="Test ${id}"\n`);
  const output = execFileSync(bash, [script, '--check-platform'], { encoding: 'utf8', env: { ...process.env, IDE_OS_RELEASE_FILE: release.replace(/\\/g, '/') } });
  assert.match(output, new RegExp('Package family: ' + family));
  assert.ok(output.includes('Default packages: ' + packages));
  assert.deepEqual(fs.readdirSync(directory), ['os-release']);
});
test('The Mint compatibility command uses the generic Linux setup', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-hosting-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const release = path.join(directory, 'os-release'); fs.writeFileSync(release, 'ID=fedora\nPRETTY_NAME="Fedora test"\n');
  const wrapper = path.join(root, 'hosting/linux/setup-mint.sh').replace(/\\/g, '/');
  const output = execFileSync(bash, [wrapper, '--check-platform'], { encoding: 'utf8', env: { ...process.env, IDE_OS_RELEASE_FILE: release.replace(/\\/g, '/') } });
  assert.match(output, /Package family: fedora/);
});

function serverHarness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ide server helpers '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const hosting = path.join(directory, 'server folder'), bin = path.join(directory, 'bin');
  fs.cpSync(path.join(root, 'hosting/linux'), hosting, { recursive: true }); fs.mkdirSync(bin);
  const key = 'a'.repeat(64), original = `COLLAB_CREATE_KEY=${key}\nCOLLAB_DOMAIN=localhost\nCOLLAB_BIND=0.0.0.0\n`;
  fs.writeFileSync(path.join(hosting, '.env'), original);
  const executable = (name, text) => fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env bash\n' + text + '\n', { mode: 0o755 });
  executable('sudo', 'exec "$@"');
  executable('systemctl', 'exit 0');
  executable('ip', 'if [ "$1" = -4 ]; then echo "1.1.1.1 via 10.20.30.1 dev eth0 src 10.20.30.40"; else echo "2: eth0 inet 10.20.30.40/24 scope global eth0"; fi');
  executable('hostname', 'echo "10.20.30.40 172.17.0.1"');
  executable('docker', `
    case "$*" in
      '--version') echo 'Docker version 27' ;;
      'compose version --short') echo '2.35.0' ;;
      'compose version') echo 'Docker Compose version v2.35.0' ;;
      'buildx version') echo 'github.com/docker/buildx v0.20.0' ;;
      'compose ps') echo 'collaboration Up (healthy)' ;;
      *'exec -T collaboration'*) exit "\u0024{IDE_FAKE_UNHEALTHY:-0}" ;;
    esac
    exit 0
  `);
  const release = path.join(directory, 'os-release'); fs.writeFileSync(release, 'ID=linuxmint\nPRETTY_NAME="Mint test"\n');
  const unix = value => value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
  const run = (name, action, env = {}, input) => execFileSync(bash,
    ['-c', 'export PATH="$1:$PATH"; exec bash "$2" "$3"', '_', unix(bin), unix(path.join(hosting, name)), action],
    { cwd: directory, input, encoding: 'utf8', env: { ...process.env, IDE_OS_RELEASE_FILE: unix(release), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  return { directory, hosting, key, original, run };
}

test('Server menu checks from another folder with spaces, prints usable LAN addresses and keeps secrets private', t => {
  const f = serverHarness(t), output = f.run('server.sh', 'status');
  assert.match(output, /Server is running and responding/); assert.match(output, /http:\/\/10\.20\.30\.40:1234/);
  assert.match(output, /\/health/); assert.match(output, /Check again from any folder: bash/);
  assert.ok(!output.includes('172.17.0.1')); assert.ok(!output.includes(f.key));
  assert.equal(fs.readFileSync(path.join(f.hosting, '.env'), 'utf8'), f.original);
  assert.match(f.run('server.sh', '--help'), /status \| start/);
});

test('Server status explains missing settings and stopped containers instead of claiming network connectivity', t => {
  const f = serverHarness(t);
  assert.throws(() => f.run('status-server.sh', '', { IDE_FAKE_UNHEALTHY: '1' }), error => {
    assert.match(error.stderr.toString(), /not responding yet/); return true;
  });
  fs.unlinkSync(path.join(f.hosting, '.env'));
  assert.throws(() => f.run('server.sh', 'status'), error => {
    assert.match(error.stderr.toString(), /settings.*missing/); return true;
  });
});

test('Updating a server retains its key and writes public connection instructions without credentials', t => {
  const f = serverHarness(t), output = f.run('setup-server.sh', '', {}, '1\n');
  assert.match(output, /Server is running and responding/);
  assert.ok(fs.readFileSync(path.join(f.hosting, '.env'), 'utf8').includes(f.key));
  const info = fs.readFileSync(path.join(f.hosting, 'CONNECT.txt'), 'utf8');
  assert.match(info, /Address for all PCs/); assert.match(info, /10\.20\.30\.40/); assert.ok(!info.includes(f.key));
  assert.ok(output.includes(f.key), 'Setup must display the private key to its operator');
});
