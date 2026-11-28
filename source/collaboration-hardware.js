/* The session owner executes hardware jobs. The server never opens a USB port. */
(() => {
  if (VIEW || !window.ideCollaboration) return;
  const api = window.ideCollaboration;
  let state = { enabled: false, host: null, connected: false }, wanted = false, applying = false, timer = null, queue = [];
  const waiting = new Map(), executed = new Set();
  const session = () => api.session;
  Object.defineProperties(api, {
    hardwareState: { get: () => state },
    hardwareHost: { get: () => !!session()?.ready && state.enabled && state.host === session().id },
    hardwareRemote: { get: () => !!session() && state.enabled && state.host !== session().id },
    shouldRouteHardware: { get: () => !!session() && (session().role !== 'owner' || (state.enabled && state.host !== session().id)) },
    hardwareConnected: { get: () => !!session() && state.enabled && state.connected }
  });
  function flush() {
    clearTimeout(timer); timer = null;
    if (!api.hardwareHost) { queue = []; return; }
    if (queue.length) session().send({ t: 'hardware-events', events: queue.splice(0, 64) });
    if (queue.length) timer = setTimeout(flush, 60);
  }
  function emit(event) {
    if (!api.hardwareHost || applying) return;
    queue.push(event); if (queue.length > 500) queue.splice(0, queue.length - 500);
    if (!timer) timer = setTimeout(flush, 60);
  }
  function localState() { return { kind: 'state', connected, busy, label: $('#status').textContent.slice(0, 200), board: { ...currentBoard } }; }
  function render() {
    const checkbox = $('#collabHardware');
    if (checkbox) { checkbox.checked = api.hardwareHost; checkbox.disabled = !session()?.ready || !session()?.sharedHardware; }
    const status = $('#collabHardwareStatus');
    if (status) status.textContent = !session()?.sharedHardware ? 'Update the collaboration server to share the host Arduino and visualization.' : state.enabled ? 'Host Arduino: ' + (state.label || 'waiting') + (state.pending ? ' · ' + state.pending.action + ' requested by ' + state.pending.name : '') : 'Arduino is not shared. The owner can enable Share my Arduino.';
    if (!api.shouldRouteHardware) { $('#connect').disabled = $('#sendBtn').disabled = $('#connectMan').disabled = $('#sbBoard').disabled = false; return; }
    const label = state.enabled ? 'Host: ' + (state.label || 'Arduino') : 'Host Arduino is not shared';
    $('#status').textContent = label; $('#dot').classList.toggle('on', !!state.connected && state.enabled);
    $('#connect').textContent = state.connected && state.enabled ? 'Disconnect host' : 'Connect host';
    $('#sbBoard').textContent = state.board ? 'Host: ' + state.board.name : 'Host board';
    if (!state.connected || !state.enabled) $('#liveState').textContent = label + (lastRxAt ? ' · showing last received data' : '');
    else if (!lastRxAt) $('#liveState').textContent = 'Host connected · waiting for sketch output';
    setBusy(!!state.pending || !!state.busy || waiting.size > 0);
    if (api.readOnly) { $('#sbBuild').disabled = $('#sbUpload').disabled = true; }
    $('#connect').disabled = $('#sendBtn').disabled = api.readOnly;
    $('#connectMan').disabled = $('#sbBoard').disabled = true;
    post({ t: 'conn', name: WIN_NAME, connected: !!state.connected && state.enabled, label });
  }
  function consume(event) {
    if (event.kind === 'state') state = { ...state, ...event };
    else if (event.kind === 'line') { onLine(event.text); if (dataLinks()) post({ t: 'line', text: event.text }); }
    else if (event.kind === 'reset') resetView();
    else if (event.kind === 'program') setBoardCode(event.files, event.label);
    else if (event.kind === 'output') out(event.text, !!event.clear);
    else if (event.kind === 'tx') { log('› ' + event.text, 'tx'); monLine('› ' + event.text, 'tx'); if (dataLinks()) post({ t: 'tx', text: event.text }); }
    else if (event.kind === 'history') {
      resetView(); event.lines.forEach(onLine); if (event.pins) onLine(event.pins);
      lastRxAt = event.ageMs == null ? 0 : Date.now() - event.ageMs;
      if (dataLinks()) post({ t: 'hist', lines: event.lines, pins: event.pins, ageMs: event.ageMs });
    }
  }
  api.hardwareLine = text => { if (connected) emit({ kind: 'line', text: text.slice(0, 4096) }); };
  api.hardwareOutput = (text, clear) => emit({ kind: 'output', text: String(text).slice(0, 4096), clear: !!clear });
  api.hardwareTransmit = text => emit({ kind: 'tx', text: String(text).slice(0, 1024) });
  api.hardwareStatus = () => emit(localState());
  api.hardwareReset = () => emit({ kind: 'reset' });
  api.hardwareProgram = (files, label) => emit({ kind: 'program', files, label: String(label).slice(0, 200) });
  api.shareHardware = enabled => {
    if (!session()?.ready || session().role !== 'owner') throw Error('Only a connected session owner can share an Arduino.');
    if (!session().sharedHardware) throw Error('Update the collaboration server before sharing hardware.');
    wanted = !!enabled; session().send({ t: 'hardware-host', enabled: wanted });
    if (!wanted) { queue = []; clearTimeout(timer); timer = null; state = { ...state, enabled: false }; render(); }
  };
  api.hardwareReady = () => { if (wanted && session()?.role === 'owner' && session().sharedHardware) session().send({ t: 'hardware-host', enabled: true }); render(); };
  api.hardwareOffline = () => {
    state = { ...state, enabled: false, connected: false, pending: null, busy: false, label: 'Host connection lost' };
    for (const item of waiting.values()) { clearTimeout(item.timer); item.resolve({ ok: false, error: 'Connection lost. The request will not be replayed automatically; the host may already be finishing it.' }); }
    waiting.clear(); queue = []; clearTimeout(timer); timer = null; render();
  };
  api.hardwareLeave = () => {
    const remote = api.shouldRouteHardware; api.hardwareOffline(); wanted = false; executed.clear();
    if (remote) queueMicrotask(() => { if (!session()) { setBusy(false); $('#connect').disabled = $('#sendBtn').disabled = $('#connectMan').disabled = $('#sbBoard').disabled = false; setStatus(false, 'Not connected'); updateBoardLabel(); } });
  };
  api.requestHardware = async (action, text = '') => {
    const current = session();
    if (!current?.ready) return { ok: false, error: 'Connect to the shared session first.' };
    if (!['editor', 'owner'].includes(current.role)) return { ok: false, error: 'Viewers can watch the host but cannot control or upload to it.' };
    if (!current.sharedHardware) return { ok: false, error: 'Update the collaboration server to use host uploads.' };
    if (!state.enabled) return { ok: false, error: 'Ask the owner to enable Share my Arduino in Share project.' };
    if (waiting.size) return { ok: false, error: 'Wait for your current host request to finish.' };
    try { current.sync(current.sharedVisualization ? project : { ...project, circuit: undefined }); current.flush(); }
    catch (error) { return { ok: false, error: 'The shared project could not be synchronized: ' + error.message }; }
    const id = crypto.randomUUID();
    const result = new Promise(resolve => {
      const timeout = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: 'The host has not finished this request. Check its output before trying again.' }); render(); }, 600000);
      waiting.set(id, { resolve, timer: timeout });
    });
    current.send({ t: 'hardware-request', id, action, text }); render();
    return result;
  };
  api.runRemoteHardware = async (action, text = '') => {
    out('Requesting ' + action + ' on the host Arduino…', ['upload', 'build'].includes(action));
    const result = await api.requestHardware(action, text);
    if (!result.ok) out(result.error); return result;
  };
  async function job(message) {
    const current = session();
    if (!api.hardwareHost || executed.has(message.id)) return;
    executed.add(message.id); if (executed.size > 200) executed.delete(executed.values().next().value);
    let result = { ok: false, error: 'Host is busy.' };
    try {
      if (busy) throw Error('The host is already running a board operation.');
      out('Host ' + message.action + ' requested by ' + message.name + '.');
      if (message.action === 'upload') result = await uploadMyCode(message.project.files);
      else if (message.action === 'build') result = await buildProject(message.project.files);
      else if (message.action === 'connect') result = { ok: await connect(false), error: lastError };
      else if (message.action === 'disconnect') { await disconnect(); result = { ok: true }; }
      else if (message.action === 'command') {
        if (!connected || !writer) throw Error('Connect the host Arduino before sending commands.');
        await writer.write(new TextEncoder().encode(message.text.trim() + '\n')); log('› ' + message.text + ' (from ' + message.name + ')', 'tx'); monLine('› ' + message.text, 'tx'); api.hardwareTransmit(message.text); result = { ok: true };
      }
    } catch (error) { result = { ok: false, error: error.message }; out(error.message); }
    finally {
      api.hardwareStatus(); flush();
      if (session() === current && api.hardwareHost && state.pending?.id === message.id) current.send({ t: 'hardware-result', id: message.id, ok: result?.ok === true, error: String(result?.error || '').slice(0, 500) });
    }
  }
  api.onHardware = message => {
    if (message.t === 'hardware-job') { job(message); return; }
    if (message.t === 'hardware-result') {
      const item = waiting.get(message.id); if (item) { clearTimeout(item.timer); waiting.delete(message.id); item.resolve(message); } render(); return;
    }
    applying = true;
    try {
      if (message.t === 'hardware-state') {
        const becameHost = !api.hardwareHost && message.enabled && message.host === session()?.id;
        state = message;
        if (becameHost) {
          applying = false; emit(localState()); emit({ kind: 'program', files: boardFiles || null, label: boardLabel || '' });
          emit({ kind: 'history', lines: demoTimer ? [] : lineHistory.slice(-100).map(line => line.slice(0, 4096)), pins: demoTimer ? '' : lastPins, ageMs: !demoTimer && lastRxAt ? Date.now() - lastRxAt : null }); flush(); applying = true;
        }
      } else if (message.t === 'hardware-snapshot') {
        state = message.state;
        if (!api.hardwareHost && (message.lines.length || message.pins || message.program)) {
          resetView(); if (message.program) consume({ kind: 'program', ...message.program });
          message.lines.forEach(text => consume({ kind: 'line', text })); if (message.pins) consume({ kind: 'line', text: message.pins });
          lastRxAt = message.ageMs == null ? 0 : Date.now() - message.ageMs;
        }
        if (!api.hardwareHost) message.output.forEach((text, index) => consume({ kind: 'output', text, clear: index === 0 }));
      } else if (message.t === 'hardware-events' && message.host === state.host) {
        if (!api.hardwareHost) message.events.forEach(consume);
        else for (const event of message.events) if (event.kind === 'state') state = { ...state, ...event };
      }
      render();
    } finally { applying = false; }
  };
  $('#collabHardware').onchange = event => { try { api.shareHardware(event.target.checked); } catch (error) { $('#collabError').textContent = error.message; render(); } };
})();
