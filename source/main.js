const { app, BrowserWindow, Menu, dialog, ipcMain, session, net, webContents } = require('electron');
const { NativeSerial } = require('./native-serial.cjs');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { readCommand, validateHex } = require('./firmware.cjs');
const { serverUrl } = require('./collaboration/url.cjs');
const { checkServer } = require('./collaboration/connection.cjs');
const { validateProject: validateSharedProject } = require('./collaboration/model.cjs');
// Keep existing projects, settings, and downloaded upload tools across the rename.
const startupCheck = process.argv.includes('--smoke-test');
app.setPath('userData', startupCheck ? fs.mkdtempSync(path.join(os.tmpdir(), 'ide-startup-')) : path.join(app.getPath('appData'), 'ide-alpha'));

/* ---------- arduino-cli: use the copy this app installed, or the one on the PATH ---------- */
const cliDir = () => path.join(app.getPath('userData'), 'arduino-cli');
function cliCmd() {
  const local = path.join(cliDir(), process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
  return fs.existsSync(local) ? local : 'arduino-cli';
}
function run(args, onLine, command = cliCmd(), options = {}) {
  return new Promise(resolve => {
    let out = '', so = '', p;
    try { p = spawn(command, args, { windowsHide: true, cwd: options.cwd }); }
    catch (e) { return resolve({ code: -1, out: '', so: '', missing: true }); }
    p.on('error', e => resolve({ code: -1, out: '', so: '', missing: e.code === 'ENOENT' }));
    const h = d => {
      const t = d.toString(); out += t;
      if (onLine) t.split(/\r?\n/).filter(Boolean).forEach(onLine);
    };
    p.stdout.on('data', d => { so += d.toString(); h(d); }); p.stderr.on('data', h);
    const timer = options.timeout ? setTimeout(() => { out += '\nBoard read timed out.'; p.kill(); }, options.timeout) : null;
    p.on('error', () => clearTimeout(timer));
    p.on('close', code => { clearTimeout(timer); resolve({ code, out, so }); });
  });
}
function parseJson(s) {
  try { return JSON.parse(s); } catch {}
  const a = s.search(/[\[{]/), b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

/* 'cli' = arduino-cli missing, 'core' = Uno support missing, 'ok' */
async function toolsState() {
  const v = await run(['version']);
  if (v.missing || v.code !== 0) return 'cli';
  const c = await run(['core', 'list']);
  return /arduino:avr/.test(c.out) ? 'ok' : 'core';
}
let toolsOk = false;
async function needTools(fqbn) {
  const st = await toolsState();
  const core = (fqbn || 'arduino:avr:uno').split(':').slice(0, 2).join(':');
  if (st === 'cli') return { ok: false, needInstall: true, error: 'Building and uploading need the free Arduino tool arduino-cli, which is not installed on this computer.' };
  if (core === 'arduino:avr') return st === 'ok' ? null : { ok: false, needInstall: true, error: 'Building and uploading need the Arduino Uno support package, which is not installed yet.' };
  const c = await run(['core', 'list']);
  return c.out.includes(core) ? null : { ok: false, error: 'The board package ' + core + ' is not installed. Open Tools, Boards Manager and install it first.' };
}

/* Writes the project to a temporary sketch folder. The first .ino file becomes the main sketch file. */
function writeSketch(files) {
  const list = typeof files === 'string' ? [{ name: 'uno_bench_sketch.ino', text: files }] : files;
  let primary = list.findIndex(f => /^main\.ino$/i.test(f.name));
  if (primary < 0) primary = list.findIndex(f => /\.ino$/i.test(f.name));
  if (primary < 0) return null;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-build-'));
  const dir = path.join(parent, 'uno_bench_sketch');
  fs.mkdirSync(dir);
  list.forEach((f, i) => fs.writeFileSync(path.join(dir, i === primary ? 'uno_bench_sketch.ino' : path.basename(f.name)), f.text));
  return dir;
}

/* ---------- finding serial ports: arduino-cli when it is there, the operating system otherwise ---------- */
let osCache = { t: 0, list: [] };
function osPorts() {
  return new Promise(resolve => {
    if (Date.now() - osCache.t < 5000) return resolve(osCache.list);
    const done = list => { osCache = { t: Date.now(), list }; resolve(list); };
    if (process.platform === 'win32') {
      const cmd = "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM\\d+\\)' } | ForEach-Object { $_.Name + '|' + $_.PNPDeviceID }";
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 10000 }, (err, out) => {
        const list = [];
        (out || '').split(/\r?\n/).forEach(l => {
          const m = l.match(/^(.*)\((COM\d+)\)\|(.*)$/); if (!m) return;
          const v = m[3].match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i), name = m[1].trim();
          list.push({ address: m[2], board: /arduino/i.test(name) ? name : '', vid: v ? parseInt(v[1], 16) : null, pid: v ? parseInt(v[2], 16) : null });
        });
        done(list);
      });
    } else {
      let names = []; try { names = fs.readdirSync('/dev').filter(n => /^(ttyACM|ttyUSB|cu\.usb)/.test(n)); } catch (e) {}
      done(names.map(n => ({ address: '/dev/' + n, board: '', vid: null, pid: null })));
    }
  });
}
async function cliPorts() {
  const r = await Promise.race([run(['board', 'list', '--format', 'json']), new Promise(res => setTimeout(() => res({ code: -1, out: '' }), 5000))]);
  const list = [];
  try {
    const j = parseJson(r.so || r.out) || {}, arr = Array.isArray(j) ? j : (j.detected_ports || []);
    arr.forEach(x => {
      const p = x.port || x, pr = p.properties || {}; if (p.protocol !== 'serial' || !p.address) return;
      const b = (x.matching_boards || x.boards || [])[0];
      list.push({ address: p.address, board: b ? b.name : '', vid: pr.vid ? parseInt(pr.vid, 16) : null, pid: pr.pid ? parseInt(pr.pid, 16) : null });
    });
  } catch {}
  return list;
}
const ARDUINO_LIKE = new Set([0x2341, 0x2a03, 0x1a86, 0x0403, 0x10c4, 0x067b]);
async function allPorts() { const c = await cliPorts(); return c.length ? c : osPorts(); }

async function nativePorts() {
  let ports;
  try { ports = await require('serialport').SerialPort.list(); }
  catch { osCache.t = 0; return allPorts(); }
  return ports.map(p => ({ address: p.path, serialNumber: p.serialNumber || '',
    vid: p.vendorId ? parseInt(p.vendorId, 16) : null, pid: p.productId ? parseInt(p.productId, 16) : null,
    board: /arduino/i.test(p.manufacturer || '') ? p.manufacturer : '', label: p.friendlyName || p.manufacturer || p.path }));
}
const nativeSerial = new NativeSerial({ getPorts: nativePorts, emit: (owner, message) => {
  const target = webContents.fromId(owner); if (target && !target.isDestroyed()) target.send('serial:native:data', message);
} });
for (const [name, action] of Object.entries({
  ports: async () => ({ ok: true, ports: await nativePorts() }),
  open: async (e, address, baud, token) => {
    if (process.platform !== 'linux') throw Error('Native serial is enabled on Linux only.');
    if (boardOperation) throw Error('Wait for the current board operation to finish.');
    const result = await nativeSerial.open(e.sender.id, address, baud, token); lastPortName = address; return result;
  },
  write: async (e, token, data) => { await nativeSerial.write(e.sender.id, token, data); return { ok: true }; },
  close: async (e, token) => { await nativeSerial.close(e.sender.id, token); return { ok: true }; }
})) ipcMain.handle('serial:native:' + name, async (...args) => {
  try { return await action(...args); } catch (error) { return { ok: false, error: error.message }; }
});

let lastPortName = '';          // the port the window was connected to
async function pickPort(win) {
  const list = await allPorts();
  if (lastPortName && (!list.length || list.some(x => x.address === lastPortName))) return lastPortName;
  if (!list.length) return null;
  const likely = list.filter(x => x.board || ARDUINO_LIKE.has(x.vid));
  const pool = likely.length ? likely : list;
  if (pool.length === 1) return pool[0].address;
  const i = dialog.showMessageBoxSync(win, {
    type: 'question', message: 'Which port is your Arduino?',
    buttons: [...pool.map(x => x.address + (x.board ? ' (' + x.board + ')' : '')), 'Cancel'], cancelId: pool.length
  });
  if (win) { win.focus(); win.webContents.focus(); }
  return i < pool.length ? pool[i].address : null;
}
const NO_PORT = 'Could not find the serial port of your Arduino. Plug it in and press Connect Arduino first, so the app can see which port it is on.';
function uploadHint(out) {
  if (process.platform === 'linux' && /permission denied|access is denied/i.test(out)) return 'Linux denied access to the Arduino port. Check your account’s serial-port group permissions using the Linux setup instructions in the README.';
  if (/can't open device|access is denied|permission denied|busy/i.test(out)) return 'The port is busy. Close the Arduino IDE, any other serial monitor and other windows of this app that use the board, then try again.';
  if (/not in sync|stk500|programmer is not responding/i.test(out)) return 'The board did not answer. Check that it is an Arduino Uno, and try pressing the reset button on the board just before uploading.';
  return 'Upload failed. Read the messages above for the reason.';
}

/* ---------- interface updates: a newer index.html can be installed without rebuilding the exe ---------- */
const API_LEVEL = 5;
const uiDir = () => path.join(app.getPath('userData'), 'ui');
function meta(file, name) {
  try { const t = fs.readFileSync(file, 'utf8').slice(0, 4000), x = t.match(new RegExp('<meta name="' + name + '" content="(\\d+)"')); return x ? +x[1] : 0; } catch { return 0; }
}
function uiFile() {
  const bundled = path.join(__dirname, 'index.html'), ext = path.join(uiDir(), 'index.html');
  if (fs.existsSync(ext) && meta(ext, 'ide-api') <= API_LEVEL && meta(ext, 'ide-build') > meta(bundled, 'ide-build')) return ext;
  return bundled;
}
const reloadAll = () => wins.forEach(w => w.loadFile(uiFile(), { query: w._query }));

/* ---------- windows ---------- */
const wins = new Map();                       // id -> BrowserWindow. Every window is its own workspace.
let windowSequence = 0;
function nextId() { return ++windowSequence; }

function createWindow(o) {
  o = o || {};
  if (o.view === 'proj') {
    for (const [existingId, existing] of wins) {
      if (!existing.isDestroyed() && !existing._closing &&
          existing._query.view === 'proj' && existing._query.owner === String(o.owner || '')) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        return existingId;
      }
    }
  }
  const sat = !!o.view;                       // a view (Dashboard, Board, Monitor, Log) opened as its own window
  const id = nextId();
  const opts = {
    ...(startupCheck ? { show: false } : {}),
    width: sat ? 920 : 1280, height: sat ? 720 : 860, minWidth: sat ? 520 : 760, minHeight: sat ? 360 : 520,
    resizable: true, maximizable: true, minimizable: true,
    title: 'IDE-beta', autoHideMenuBar: true, backgroundColor: '#0A1426', icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  };
  if (o.view === 'proj') Object.assign(opts, { width: 1360, height: 900, minWidth: 900, minHeight: 600 });
  const f = BrowserWindow.getFocusedWindow();
  if (f) { const b = f.getBounds(); opts.x = b.x + 34; opts.y = b.y + 34; }
  const win = new BrowserWindow(opts);
  wins.set(id, win);
  win.on('close', () => { win._closing = true; });
  const serialOwner = win.webContents.id;
  win.on('closed', () => { wins.delete(id); nativeSerial.close(serialOwner).catch(() => {}); });
  win.on('focus', () => win.webContents.focus());      // keyboard goes to the page whenever the window is activated
  const query = { ws: String(id) }; if (sat) { query.view = String(o.view); query.owner = String(o.owner || ''); }
  win._query = query;
  const loaded = win.loadFile(uiFile(), { query });
  if (startupCheck) {
    const timeout = setTimeout(() => { console.error('Startup check timed out'); app.exit(1); }, 30000);
    loaded.then(() => {
      // bindings-cpp ships Node-API binaries; verify the packaged driver on both platforms.
      require('serialport').SerialPort;
      return win.webContents.executeJavaScript("Boolean(window.uno && window.IDESerial && window.IDECollab && window.ideCollaboration && navigator.serial && typeof openWorkspaceSetup === 'function' && document.querySelector('#workspaceDialog').open)");
    })
      .then(ok => {
        clearTimeout(timeout);
        console.log(JSON.stringify({ startup: !!ok, platform: process.platform, version: app.getVersion() }));
        app.exit(ok ? 0 : 1);
      }).catch(error => { clearTimeout(timeout); console.error(error.message); app.exit(1); });
  }
  return id;
}

/* serial permissions are set once for every window */
function setupSession() {
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((wc, permission) => permission === 'serial');
  ses.setDevicePermissionHandler(d => d.deviceType === 'serial');
  ses.on('select-serial-port', (event, portList, wc, callback) => {
    event.preventDefault();
    const win = BrowserWindow.fromWebContents(wc);
    if (!portList.length) return callback('');
    if (portList.length === 1) return callback(portList[0].portId);
    const i = dialog.showMessageBoxSync(win, {
      type: 'question', message: 'Which device?',
      buttons: [...portList.map(p => (p.displayName || 'Serial device') + ' (' + p.portName + ')'), 'Cancel'],
      cancelId: portList.length
    });
    if (win) { win.focus(); win.webContents.focus(); }
    callback(i < portList.length ? portList[i].portId : '');
  });
}

/* ---------- IPC ---------- */
ipcMain.handle('ui:info', () => ({ build: meta(uiFile(), 'ide-build'), bundled: meta(path.join(__dirname, 'index.html'), 'ide-build'), external: uiFile() !== path.join(__dirname, 'index.html') }));
ipcMain.handle('ui:install', async e => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Choose the interface update', filters: [{ name: 'Interface file', extensions: ['html'] }], properties: ['openFile'] });
  if (r.canceled) return { ok: false, cancelled: true };
  const f = r.filePaths[0], build = meta(f, 'ide-build'), api = meta(f, 'ide-api');
  if (!build) return { ok: false, error: 'That file is not an interface update for this app.' };
  if (api > API_LEVEL) return { ok: false, error: 'This update needs a newer IDE-beta.exe. Download the latest app ZIP first.' };
  if (build <= meta(path.join(__dirname, 'index.html'), 'ide-build')) return { ok: false, error: 'The built-in interface is already as new as this update (build ' + build + ').' };
  fs.mkdirSync(uiDir(), { recursive: true });
  fs.copyFileSync(f, path.join(uiDir(), 'index.html'));
  for (const name of ['workspace.js', 'serial-runtime.js', 'collaboration-ui.js', 'collaboration.bundle.js']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(uiDir(), name));
  }
  fs.mkdirSync(path.join(uiDir(), 'fonts'), { recursive: true });
  for (const name of fs.readdirSync(path.join(__dirname, 'fonts'))) {
    fs.copyFileSync(path.join(__dirname, 'fonts', name), path.join(uiDir(), 'fonts', name));
  }
  reloadAll();
  return { ok: true, build };
});
ipcMain.handle('ui:reset', () => { fs.rmSync(path.join(uiDir(), 'index.html'), { force: true }); reloadAll(); return { ok: true }; });
ipcMain.handle('window:new', (e, o) => createWindow(o));
ipcMain.on('window:focus', (e, id) => { const w = wins.get(Number(id)); if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
ipcMain.on('window:close', (e, id) => { const w = wins.get(Number(id)); if (w && w !== BrowserWindow.fromWebContents(e.sender)) w.close(); });

ipcMain.handle('serial:describe', () => allPorts());            // port names and board names for the device picker
ipcMain.on('serial:prefer', (e, name) => { lastPortName = String(name || ''); });

ipcMain.handle('cli:check', async () => {
  const st = await toolsState();
  if (st === 'cli') return { found: false };
  const v = await run(['version']);
  return { found: true, version: v.out.split(/\r?\n/)[0], hasAvr: st === 'ok' };
});

/* downloads arduino-cli from arduino.cc when it is missing, then installs the Uno support */
ipcMain.handle('cli:installCore', async e => {
  const send = l => e.sender.send('cli:output', l);
  try {
    if ((await toolsState()) === 'cli') {
      const plat = process.platform;
      const file = plat === 'win32' ? 'Windows_64bit.zip' : plat === 'darwin' ? (process.arch === 'arm64' ? 'macOS_ARM64.tar.gz' : 'macOS_64bit.tar.gz') : 'Linux_64bit.tar.gz';
      send('Downloading arduino-cli from arduino.cc (about 30 MB)…');
      const res = await net.fetch('https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_' + file);
      if (!res.ok) throw new Error('the download failed (HTTP ' + res.status + ')');
      fs.mkdirSync(cliDir(), { recursive: true });
      const archive = path.join(cliDir(), file);
      fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
      send('Unpacking…');
      await new Promise((ok, bad) => {
        const args = plat === 'win32'
          ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', "Expand-Archive -Force -LiteralPath '" + archive.replace(/'/g, "''") + "' -DestinationPath '" + cliDir().replace(/'/g, "''") + "'"]]
          : ['tar', ['-xzf', archive, '-C', cliDir()]];
        execFile(args[0], args[1], { windowsHide: true }, err => (err ? bad(err) : ok()));
      });
      fs.rmSync(archive, { force: true });
      if (plat !== 'win32') fs.chmodSync(path.join(cliDir(), 'arduino-cli'), 0o755);
      send('arduino-cli is installed.');
    }
    // Keep an already-installed Uno core. Reinstalling it on every setup click
    // wastes time and can look like the app forgot the previous download.
    const installed = await run(['core', 'list']);
    if (/arduino:avr\s+\S+/m.test(installed.out)) {
      toolsOk = true;
      send('Arduino Uno support is already installed.');
      return { ok: true, alreadyInstalled: true };
    }
    send('Downloading Arduino Uno support. This can take a few minutes…');
    let r = await run(['core', 'update-index'], send);
    if (r.missing) return { ok: false, error: 'arduino-cli could not be started after installing it.' };
    r = await run(['core', 'install', 'arduino:avr'], send);
    toolsOk = false;
    return r.code === 0 ? { ok: true } : { ok: false, error: 'The Uno support package did not install. Check your internet connection and try again.' };
  } catch (err) { return { ok: false, error: 'Install failed: ' + err.message }; }
});

ipcMain.handle('cli:compile', async (e, files, fqbn) => {
  const send = l => e.sender.send('cli:output', l);
  fqbn = fqbn || 'arduino:avr:uno';
  const need = await needTools(fqbn); if (need) return need;
  const dir = writeSketch(files);
  if (!dir) return { ok: false, error: 'The project needs a .ino file.' };
  try {
    send('Compiling…');
    const r = await run(['compile', '--warnings', 'more', '--fqbn', fqbn, dir], send);
    return r.code === 0 ? { ok: true } : { ok: false, error: 'Build failed. See Problems for the details.' };
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

ipcMain.handle('collab:check', async (event, address) => {
  try { return await checkServer(address, (url, options) => net.fetch(url, options)); }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('collab:create', async (event, address, project, key) => {
  try {
    validateSharedProject(project);
    const body = { name: project.name, files: project.files.map(file => ({ name: file.name, text: file.text })) };
    const response = await net.fetch(serverUrl(address) + '/api/rooms', {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + String(key).slice(0, 256) } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000)
    });
    const text = await response.text();
    if (text.length > 20000) throw Error('The server returned an invalid response.');
    const result = JSON.parse(text);
    if (!response.ok) throw Error(result.error || 'Could not create the shared session.');
    if (result.protocol !== 1 || !/^[a-f0-9-]{36}$/.test(result.room) || !['owner', 'editor', 'viewer'].every(role => /^[A-Za-z0-9_-]{43}$/.test(result.keys?.[role]))) throw Error('This address is not a compatible collaboration server.');
    return { ok: true, ...result };
  } catch (error) { return { ok: false, error: 'Could not create session: ' + error.message }; }
});

let boardOperation = false;
ipcMain.handle('cli:upload', async (e, files, fqbn) => {
  if (boardOperation) return { ok: false, error: 'Another board operation is running. Wait for it to finish.' };
  const send = l => e.sender.send('cli:output', l);
  const win = BrowserWindow.fromWebContents(e.sender);
  fqbn = fqbn || 'arduino:avr:uno';
  boardOperation = true;
  let dir;
  try {
    const need = await needTools(fqbn); if (need) return need;
    dir = writeSketch(files);
    if (!dir) return { ok: false, error: 'The project needs a .ino file.' };
    send('Looking for the Arduino…');
    const port = await pickPort(win);
    if (!port) return { ok: false, error: NO_PORT };
    await nativeSerial.close(e.sender.id);
    if ([...nativeSerial.connections.values()].some(record => record.address === port)) return { ok: false, error: 'Disconnect this board in the other app window before uploading.' };
    send('Using port ' + port);

    send('Compiling…');
    let r = await run(['compile', '--warnings', 'more', '--fqbn', fqbn, dir], send);
    if (r.code !== 0) return { ok: false, error: 'Build failed. See Problems for the details.' };

    send('Uploading to ' + port + '…');
    r = await run(['upload', '-p', port, '--fqbn', fqbn, dir], send);
    if (r.code !== 0) return { ok: false, error: uploadHint(r.out) };
    lastPortName = r.out.match(/New upload port:\s*([^\s(]+)/i)?.[1] || port;
    return { ok: true, port: lastPortName };
  } finally {
    boardOperation = false;
    if (dir) fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

ipcMain.handle('cli:readFirmware', async (e, fqbn) => {
  if (boardOperation) return { ok: false, error: 'Another board operation is running. Wait for it to finish.' };
  if ((fqbn || 'arduino:avr:uno') !== 'arduino:avr:uno') return { ok: false, error: 'Select Arduino Uno first. Firmware download currently supports the classic Uno (ATmega328P).' };
  boardOperation = true;
  let directory;
  const send = line => { if (!e.sender.isDestroyed()) e.sender.send('cli:output', line); };
  try {
    const need = await needTools('arduino:avr:uno'); if (need) return need;
    const win = BrowserWindow.fromWebContents(e.sender);
    const save = await dialog.showSaveDialog(win, { title: 'Save compiled firmware backup', defaultPath: 'Uno-firmware.hex', filters: [{ name: 'Intel HEX firmware (not Arduino source)', extensions: ['hex'] }] });
    if (save.canceled || !save.filePath) return { ok: false, cancelled: true };
    const port = await pickPort(win);
    if (!port) return { ok: false, cancelled: true, error: NO_PORT };
    send('Finding the installed Uno firmware reader…');
    const properties = await run(['board', 'details', '--fqbn', 'arduino:avr:uno', '--show-properties=expanded']);
    if (properties.code !== 0) return { ok: false, error: 'Could not read the Uno tool settings. Check your installed Uno board package.' };
    const reader = readCommand(properties.so, port);
    if (!fs.existsSync(reader.command) || !fs.existsSync(reader.config)) return { ok: false, error: 'The Uno firmware reader is missing. Reinstall Arduino AVR Boards from Tools → Boards Manager.' };
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-firmware-'));
    send('Reading compiled firmware from ' + port + '. The board will reset; its flash will not be changed.');
    const result = await run(reader.args, send, reader.command, { cwd: directory, timeout: 60000 });
    if (result.code !== 0) return { ok: false, error: /timed out/i.test(result.out) ? 'The board read timed out. Check the port and Uno bootloader, then try again.' : 'Firmware download failed. ' + uploadHint(result.out).replace('Upload failed.', 'Read the messages above.').replace('before uploading', 'before downloading firmware') };
    const text = fs.readFileSync(path.join(directory, 'firmware.hex'), 'utf8');
    const bytes = validateHex(text);
    fs.writeFileSync(save.filePath, text);
    send('Saved ' + bytes + ' bytes to ' + save.filePath + '. This contains compiled flash, not the original .ino source. EEPROM is not included.');
    return { ok: true, path: save.filePath, text, bytes, port };
  } catch (error) { return { ok: false, error: 'Could not download firmware: ' + error.message }; }
  finally {
    boardOperation = false;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

/* ---------- Boards Manager and Library Manager ---------- */
const indexed = { core: false, lib: false };
const TOOLS_MISSING = { ok: false, needInstall: true, error: 'The Boards Manager and Library Manager need the free Arduino tool arduino-cli, which is not installed on this computer.' };
function normCores(j) {
  const arr = Array.isArray(j) ? j : ((j && j.platforms) || []);
  return arr.map(p => {
    const rel = p.releases || {}, latest = p.latest_version || (typeof p.latest === 'string' ? p.latest : '') || Object.keys(rel).pop() || '';
    const inst = p.installed_version || (typeof p.installed === 'string' ? p.installed : '') || '', r = rel[latest] || rel[inst] || {};
    return { id: p.id, name: p.name || r.name || p.id, maintainer: p.maintainer || '', latest, installed: inst, boards: (r.boards || p.boards || []).map(b => b.name).slice(0, 12) };
  });
}
function normLibs(j) {
  return (((j && j.libraries) || [])).map(l => {
    const lat = l.latest || {}, rel = l.releases || {}, ver = lat.version || Object.keys(rel).pop() || '', r = rel[ver] || lat;
    return { name: l.name, latest: ver, author: r.author || lat.author || '', sentence: r.sentence || lat.sentence || '', paragraph: r.paragraph || lat.paragraph || '' };
  });
}
function normInstalledLibs(j) {
  const arr = Array.isArray(j) ? j : ((j && j.installed_libraries) || []);
  return arr.map(x => { const l = x.library || x; return { name: l.name, version: l.version || '', includes: l.provides_includes || [], author: l.author || '', sentence: l.sentence || '' }; });
}
async function jsonCmd(args) { const r = await run(args); return r.missing ? null : parseJson(r.so || r.out); }

ipcMain.handle('pkg:search', async (e, kind, query) => {
  if ((await toolsState()) === 'cli') return TOOLS_MISSING;
  const q = String(query || '').trim();
  if (kind === 'core') {
    if (!indexed.core) { await run(['core', 'update-index']); indexed.core = true; }
    return { ok: true, items: normCores(await jsonCmd(['core', 'search', ...(q ? [q] : []), '--format', 'json'])).slice(0, 120) };
  }
  if (q.length < 2) return { ok: true, items: [] };
  if (!indexed.lib) { await run(['lib', 'update-index']); indexed.lib = true; }
  return { ok: true, items: normLibs(await jsonCmd(['lib', 'search', q, '--format', 'json'])).slice(0, 80) };
});
ipcMain.handle('pkg:installed', async () => {
  if ((await toolsState()) === 'cli') return TOOLS_MISSING;
  return { ok: true, cores: normCores(await jsonCmd(['core', 'list', '--format', 'json'])), libs: normInstalledLibs(await jsonCmd(['lib', 'list', '--format', 'json'])) };
});
async function pkgRun(e, kind, verb, key) {
  const send = l => e.sender.send('cli:output', l);
  if ((await toolsState()) === 'cli') return TOOLS_MISSING;
  const r = await run([kind === 'core' ? 'core' : 'lib', verb, key], send);
  toolsOk = false;
  return r.code === 0 ? { ok: true } : { ok: false, error: 'That did not work. Read the messages above for the reason.' };
}
ipcMain.handle('pkg:install', (e, kind, key) => pkgRun(e, kind, 'install', key));
ipcMain.handle('pkg:upgrade', (e, kind, key) => pkgRun(e, kind, 'upgrade', key));
ipcMain.handle('pkg:remove', (e, kind, key) => pkgRun(e, kind, 'uninstall', key));
ipcMain.handle('pkg:boards', async () => {
  if ((await toolsState()) === 'cli') return TOOLS_MISSING;
  const j = await jsonCmd(['board', 'listall', '--format', 'json']), arr = Array.isArray(j) ? j : ((j && j.boards) || []);
  return { ok: true, boards: arr.filter(b => b.fqbn).map(b => ({ name: b.name, fqbn: b.fqbn })) };
});
ipcMain.handle('pkg:urls', async (e, action, url) => {
  const send = l => e.sender.send('cli:output', l);
  if ((await toolsState()) === 'cli') return TOOLS_MISSING;
  const key = 'board_manager.additional_urls', u = String(url || '').trim();
  if (action === 'add' && /^https?:\/\//.test(u)) { await run(['config', 'add', key, u]); send('Updating the list of boards…'); await run(['core', 'update-index'], send); indexed.core = true; }
  if (action === 'remove' && u) await run(['config', 'remove', key, u]);
  const g = await run(['config', 'get', key]);
  return { ok: true, urls: [...new Set((g.so || g.out).match(/https?:\/\/[^\s\]\[,'"]+/g) || [])] };
});

ipcMain.handle('file:open', async e => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { filters: [{ name: 'Arduino files', extensions: ['ino', 'h', 'hpp', 'cpp', 'c'] }], properties: ['openFile'] });
  return r.canceled ? null : { name: path.basename(r.filePaths[0]), text: fs.readFileSync(r.filePaths[0], 'utf8'), path: r.filePaths[0] };
});
function validateProject(value) {
  if (!value || value.format !== 'ide-beta-project' || value.version !== 1 ||
      !Array.isArray(value.files) || !value.files.length) throw new Error('Choose an IDE-beta project file.');
  const names = new Set();
  for (const file of value.files) {
    if (!file || !/^[A-Za-z0-9_][\w.-]*\.(ino|h|hpp|cpp|c)$/i.test(file.name) ||
        typeof file.text !== 'string' || names.has(file.name.toLowerCase())) throw new Error('The project contains an invalid or duplicate file.');
    names.add(file.name.toLowerCase());
  }
  if (!value.files.some(file => /\.ino$/i.test(file.name))) throw new Error('The project needs at least one .ino file.');
  return value;
}
ipcMain.handle('project:open', async e => {
  try {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Open project or Arduino sketch files',
      filters: [{ name: 'IDE-beta projects and sketches', extensions: ['ideproj', 'ino', 'h', 'hpp', 'cpp', 'c'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return { cancelled: true };
    const bundles = result.filePaths.filter(file => /\.ideproj$/i.test(file));
    if (bundles.length) {
      if (result.filePaths.length !== 1) throw new Error('Open one .ideproj project at a time.');
      const file = bundles[0];
      return { ok: true, project: validateProject(JSON.parse(fs.readFileSync(file, 'utf8'))), path: file };
    }
    const files = result.filePaths.map(file => ({ name: path.basename(file), text: fs.readFileSync(file, 'utf8') }));
    const value = validateProject({ format: 'ide-beta-project', version: 1,
      name: path.basename(result.filePaths[0], path.extname(result.filePaths[0])), files,
      open: files.map(file => file.name), active: files[0].name });
    return { ok: true, project: value, path: '' };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('project:save', async (e, value, existingPath, saveAs) => {
  let temporary = '';
  try {
    validateProject(value);
    let file = existingPath && /\.ideproj$/i.test(existingPath) ? existingPath : '';
    if (!file || saveAs) {
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
        title: 'Save IDE-beta project', defaultPath: file || (value.name || 'Arduino project').replace(/[<>:"/\\|?*]/g, '_') + '.ideproj',
        filters: [{ name: 'IDE-beta project', extensions: ['ideproj'] }]
      });
      if (result.canceled) return { cancelled: true };
      file = /\.ideproj$/i.test(result.filePath) ? result.filePath : result.filePath + '.ideproj';
    }
    temporary = file + '.' + require('crypto').randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
    fs.renameSync(temporary, file);
    return { ok: true, path: file };
  } catch (error) { return { ok: false, error: error.message }; }
  finally { if (temporary && fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); }
});
ipcMain.handle('file:save', async (e, text, name) => {
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: name || 'sketch.ino', filters: [{ name: 'Arduino files', extensions: ['ino', 'h', 'hpp', 'cpp', 'c'] }] });
  if (!r.canceled) fs.writeFileSync(r.filePath, text);
  return { ok: !r.canceled, path: r.filePath };
});
ipcMain.handle('file:write', (e, p, text) => { try { fs.writeFileSync(p, text); return true; } catch { return false; } });
ipcMain.on('edit:cmd', (e, c) => {          // Edit menu: act on the focused text box of the window that asked
  const wc = e.sender, f = { undo: () => wc.undo(), redo: () => wc.redo(), cut: () => wc.cut(), copy: () => wc.copy(), paste: () => wc.paste(), selectAll: () => wc.selectAll() }[c];
  if (f) f();
});

app.whenReady().then(() => { Menu.setApplicationMenu(null); setupSession(); createWindow(); });
app.on('window-all-closed', () => app.quit());
