const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-ui-check-'));
const bundle = path.join(profile, 'Project.ideproj');
const setPath = app.setPath.bind(app);
app.setPath = (name, value) => setPath(name, name === 'userData' ? profile : value);
app.setPath('userData', profile);
app.disableHardwareAcceleration();
dialog.showSaveDialog = async () => ({ canceled: false, filePath: bundle });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [bundle] });
const errors = [];
app.on('web-contents-created', (event, contents) => {
  contents.setBackgroundThrottling(false);
  contents.on('console-message', (event, level, message) => { if (level === 3) errors.push(message); });
});
const main = new Module(path.join(root, 'main.js'), module);
main.filename = path.join(root, 'main.js');
main.paths = Module._nodeModulePaths(root);
main._compile(fs.readFileSync(main.filename, 'utf8').replace('const opts = {', 'const opts = { show: false,'), main.filename);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(win, expression) {
  for (let i = 0; i < 150; i++) {
    if (win && !win.isDestroyed() && await win.webContents.executeJavaScript(expression)) return;
    await wait(50);
  }
  throw new Error('Timed out waiting for ' + expression);
}
const timeout = setTimeout(() => { console.error('UI check timed out'); app.exit(1); }, 120000);
app.whenReady().then(async () => {
  let editor;
  try {
    await wait(150);
    editor = BrowserWindow.getAllWindows()[0];
    if (editor.webContents.isLoading()) await new Promise(resolve => editor.webContents.once('did-finish-load', resolve));
    await until(editor, "typeof openWorkspaceSetup === 'function'");
    const projectId = await editor.webContents.executeJavaScript(`
      (async () => {
        if (!navigator.serial || !window.uno.platform) throw new Error('Serial API or preload bridge missing');
        if (!$('#workspaceDialog').open || $('#tabProj') || $('#tabExt')) throw new Error('Workspace startup failed');
        const faces = await document.fonts.load('19px "Russo One"');
        if (!faces.length) throw new Error('Bundled font failed to load');
        document.querySelectorAll('#workspaceTabChoices input').forEach(input => { input.checked = ['code', 'board'].includes(input.value); });
        await finishWorkspaceSetup();
        document.querySelector('input[name="workspaceMode"][value="new"]').checked = true;
        $('#workspaceName').value = 'Cross-platform project';
        $('#workspaceFileCount').value = '2';
        await finishWorkspaceSetup();
        if ($('#workspaceDialog').open || project.open.length !== 2 || !$('#tabDash').hidden) throw new Error('Project creation failed');
        await saveProjectToDisk(false);
        return project.id;
      })()
    `);
    if (JSON.parse(fs.readFileSync(bundle, 'utf8')).open.length !== 2) throw new Error('Project did not save both files');
    await editor.webContents.executeJavaScript('openVisualization()');
    await wait(200);
    const visual = BrowserWindow.getAllWindows().find(win => win !== editor);
    if (!visual) throw new Error('Visualization did not open');
    if (visual.webContents.isLoading()) await new Promise(resolve => visual.webContents.once('did-finish-load', resolve));
    await until(visual, 'typeof project !== "undefined" && project.id === ' + JSON.stringify(projectId));
    await visual.webContents.executeJavaScript("addPart('led')");
    await until(editor, 'project.circuit && project.circuit.parts.length === 1');
    await visual.webContents.executeJavaScript('saveProjectToDisk(false)');
    await wait(200);
    if (JSON.parse(fs.readFileSync(bundle, 'utf8')).circuit.parts.length !== 1) throw new Error('Diagram did not save');
    await editor.webContents.executeJavaScript(`
      (async () => {
        replaceWorkspace(newWorkspace('Other', 1), '');
        openWorkspaceSetup(true);
        await finishWorkspaceSetup();
        document.querySelector('input[name="workspaceMode"][value="open"]').checked = true;
        await finishWorkspaceSetup();
        if (project.open.length !== 2 || project.circuit.parts.length !== 1) throw new Error('Project reopen failed');
      })()
    `);
    if (errors.length) throw new Error(errors.join('\n'));
    ipcMain.removeHandler('cli:readFirmware');
    ipcMain.handle('cli:readFirmware', () => ({ ok: true, bytes: 4, port: 'test port', path: 'Uno-firmware.hex', text: ':0400000001020304F2\n:00000001FF\n' }));
    await editor.webContents.executeJavaScript(`
      (async () => {
        const before = JSON.stringify(project.files);
        const confirm = askConfirm;
        try {
          askConfirm = async () => true;
          await downloadFirmware();
          const hex = document.querySelector('#infoBody textarea');
          if (!hex || !hex.readOnly || !hex.value.includes(':04000000') || !$('#infoDlg').open) throw new Error('Firmware viewer failed');
          if (JSON.stringify(project.files) !== before || busy) throw new Error('Firmware download changed the sketch or left controls busy');
          $('#infoDlg').close();
        } finally { askConfirm = confirm; }
      })()
    `);
    await require('./smoke-serial.cjs')(editor, ipcMain);
    const service = require('../collaboration/server.cjs').createServer({ directory: path.join(profile, 'server'), createKey: 'ui-test-key' });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    const address = 'http://127.0.0.0:' + service.server.address().port;
    await editor.webContents.executeJavaScript(`
      $('#collabName').value = 'Owner'; $('#collabServer').value = ${JSON.stringify(address)};
      $('#collabMode').value = 'network'; $('#collabCreate').click();
    `);
    await until(editor, "$('#collabError').textContent.includes('host’s LAN address') && !$('#collabCreate').disabled");
    if (service.rooms.size) throw Error('Localhost invitation was created in cross-PC mode');
    await editor.webContents.executeJavaScript("$('#collabMode').value = 'computer'; $('#collabCheck').click();");
    await until(editor, "$('#collabCheckStatus').textContent.includes('Server reachable') && !$('#collabCheck').disabled");
    await editor.webContents.executeJavaScript(`
      $('#collabKey').value = 'wrong-key'; $('#collabCreate').click();
    `);
    await until(editor, "$('#collabError').textContent.includes('creation key') && !$('#collabCreate').disabled");
    await editor.webContents.executeJavaScript(`
      $('#collabKey').value = 'ui-test-key'; $('#collabCreate').click();
    `);
    await until(editor, 'ideCollaboration.session?.status === "connected"');
    const editorCode = await editor.webContents.executeJavaScript("$('#collabEditorCode').value");
    const viewerCode = await editor.webContents.executeJavaScript("$('#collabViewerCode').value");
    async function joinWindow(code, name) {
      const before = new Set(BrowserWindow.getAllWindows());
      await editor.webContents.executeJavaScript('window.uno.newWindow()');
      const win = BrowserWindow.getAllWindows().find(win => !before.has(win));
      if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
      await until(win, 'typeof ideCollaboration !== "undefined"');
      await win.webContents.executeJavaScript(`
        $('#workspaceDialog').close(); workspaceStarted = true; askConfirm = async () => true;
        $('#collabJoinTab').click();
        $('#collabName').value = ${JSON.stringify(name)}; $('#collabInvite').value = ${JSON.stringify(code)};
        $('#collabInvite').dispatchEvent(new Event('input'));
        $('#collabJoin').click();
      `);
      await until(win, "$('#collabError').textContent.includes('localhost') && !$('#collabJoin').disabled");
      if (await win.webContents.executeJavaScript('ideCollaboration.active')) throw Error('A localhost invitation joined without explaining its scope');
      await win.webContents.executeJavaScript(`
        const invite = IDECollab.parseInvitation($('#collabInvite').value);
        $('#collabInvite').value = IDECollab.invitation('http://127.0.0.1:1', invite.room, invite.token);
        $('#collabInvite').dispatchEvent(new Event('input'));
        $('#collabJoinServer').value = ${JSON.stringify(address + '/health')};
        $('#collabSamePC').checked = true;
        $('#collabJoin').click();
      `);
      await until(win, 'ideCollaboration.session?.status === "connected"');
      return win;
    }
    const guest = await joinWindow(editorCode, 'Editor');
    await Promise.all([editor.webContents.executeJavaScript("openFile('main.ino'); $('#code').value += '\\n// from owner'; onEdit(); onCaret();"),
      guest.webContents.executeJavaScript("openFile('main.ino'); $('#code').value += '\\n// from editor'; onEdit(); onCaret();")]);
    for (const win of [editor, guest]) await until(win, "fileOf('main.ino').text.includes('from owner') && fileOf('main.ino').text.includes('from editor')");
    await editor.webContents.executeJavaScript("createFile('online.h', '// shared helper');");
    await until(guest, "!!fileOf('online.h')");
    await editor.webContents.executeJavaScript("renameFile('online.h'); const inp = $('#files input'); inp.value = 'shared.h'; inp.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter'}));");
    await until(guest, "!!fileOf('shared.h') && !fileOf('online.h')");
    await editor.webContents.executeJavaScript("askConfirm = async () => true; deleteFile('shared.h');");
    await until(guest, "!fileOf('shared.h')");
    const viewer = await joinWindow(viewerCode, 'Viewer');
    await viewer.webContents.executeJavaScript(`
      const before = JSON.stringify(project.files);
      if (!$('#code').readOnly || !$('#newFileBtn').disabled) throw new Error('Viewer controls are editable');
      if (createFile('forbidden.h', '// no')) throw new Error('Viewer created a file');
      $('#code').value += 'forbidden edit'; onEdit();
      if (JSON.stringify(project.files) !== before) throw new Error('Viewer changed shared code');
    `);
    await editor.webContents.executeJavaScript('ideCollaboration.session.delay = 1000; ideCollaboration.session.socket.close();');
    await until(editor, '!ideCollaboration.session.ready');
    await editor.webContents.executeJavaScript("if (!$('#collabEnd').disabled || !$('#collabRotate').disabled) throw new Error('Offline session controls should be disabled');");
    await editor.webContents.executeJavaScript("openFile('main.ino'); $('#code').value += '\\n// offline owner'; onEdit();");
    await guest.webContents.executeJavaScript("$('#code').value += '\\n// while owner offline'; onEdit();");
    await until(editor, 'ideCollaboration.session.status === "connected"');
    for (const win of [editor, guest, viewer]) await until(win, "fileOf('main.ino').text.includes('offline owner') && fileOf('main.ino').text.includes('while owner offline')");
    await guest.webContents.executeJavaScript('saveProjectToDisk(false)');
    await wait(200);
    const saved = fs.readFileSync(bundle, 'utf8');
    if (saved.includes('IDE1.') || saved.includes('ui-test-key')) throw new Error('Session credentials leaked into the project file');
    await editor.webContents.executeJavaScript("$('#shareProject').click()");
    await until(editor, "$('#collabDialog').open");
    await wait(250);
    if (process.env.IDE_CAPTURE_COLLAB) fs.writeFileSync(path.join(root, 'dist', 'collaboration-preview.png'), (await editor.webContents.capturePage()).toPNG());
    await editor.webContents.executeJavaScript("$('#collabEnd').click()");
    await until(guest, '!ideCollaboration.active');
    await until(viewer, '!ideCollaboration.active');
    await service.close();
    if (process.env.IDE_CAPTURE_COLLAB) {
      await editor.webContents.executeJavaScript("$('#collabCreateTab').click(); $('#collabMode').value = 'network'; $('#collabMode').dispatchEvent(new Event('change')); $('#collabServer').value = 'http://192.168.1.50:1234'; $('#collabKey').value = ''; $('#collabDialog').scrollTop = 0;");
      await editor.webContents.capturePage();
      await wait(100);
      fs.writeFileSync(path.join(root, 'dist', 'sharing-host-preview.png'), (await editor.webContents.capturePage()).toPNG());
      await editor.webContents.executeJavaScript("$('#collabJoinTab').click(); $('#collabInvite').value = IDECollab.invitation('http://127.0.0.1:1234', '01234567-89ab-cdef-0123-456789abcdef', 'a'.repeat(43)); $('#collabInvite').dispatchEvent(new Event('input')); $('#collabDialog').scrollTop = 0;");
      await wait(100);
      fs.writeFileSync(path.join(root, 'dist', 'sharing-join-preview.png'), (await editor.webContents.capturePage()).toPNG());
    }
    if (errors.length) throw new Error(errors.join('\n'));
    clearTimeout(timeout);
    console.log(JSON.stringify({ ok: true, platform: process.platform, projectSaveOpen: true, visualization: true, firmwareViewer: true, serialReconnect: true, collaboration: true, bundledFont: true }));
    app.exit(0);
  } catch (error) {
    clearTimeout(timeout);
    console.error(error.stack || error);
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'smoke-error.txt'), String(error.stack || error) + '\n' + errors.join('\n'));
    if (editor && !editor.isDestroyed()) fs.writeFileSync(path.join(root, 'dist', 'smoke-error.png'), (await editor.webContents.capturePage()).toPNG());
    app.exit(1);
  }
});
