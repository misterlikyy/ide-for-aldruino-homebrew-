const Y = require('yjs');
const { validateCircuit, circuitSnapshot, syncCircuit } = require('./circuit.cjs');
const LOCAL = 'local-edit';
const REMOTE = 'network';
const FILE_NAME = /^[A-Za-z0-9_][\w.-]*\.(ino|h|hpp|cpp|c)$/i;
const LIMITS = { files: 100, fileBytes: 256 * 1024, projectBytes: 1024 * 1024, stateBytes: 4 * 1024 * 1024 };
const byteLength = text => new TextEncoder().encode(text).length;

function validateProject(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > LIMITS.files) throw Error('Use a named project with 1–100 sketch files.');
  let size = 0;
  for (const file of value.files) {
    if (!file || typeof file.name !== 'string' || file.name.length > 120 || !FILE_NAME.test(file.name) || typeof file.text !== 'string') throw Error('The shared project contains an invalid sketch file.');
    const bytes = byteLength(file.text); size += bytes;
    if (bytes > LIMITS.fileBytes) throw Error('A shared file is larger than 256 KB.');
  }
  if (size > LIMITS.projectBytes) throw Error('The shared project is larger than 1 MB.');
  if (value.circuit !== undefined) validateCircuit(value.circuit);
  return value;
}

function snapshot(doc) {
  const meta = doc.getMap('project'), files = doc.getMap('files');
  const used = new Set();
  const result = [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => {
    if (!(entry instanceof Y.Map) || !(entry.get('text') instanceof Y.Text)) throw Error('Invalid shared file data.');
    const raw = entry.get('name');
    if (typeof raw !== 'string' || !FILE_NAME.test(raw) || raw.length > 120) throw Error('Invalid shared file name.');
    let name = raw, suffix = 2;
    while (used.has(name.toLowerCase())) { const dot = raw.lastIndexOf('.'); name = raw.slice(0, dot) + '_' + suffix++ + raw.slice(dot); }
    used.add(name.toLowerCase());
    return { id, name, text: entry.get('text').toString() };
  });
  return validateProject({ name: meta.get('name'), files: result, circuit: circuitSnapshot(doc) });
}

function createDocument(value) {
  validateProject(value);
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getMap('project').set('name', value.name.trim());
    syncCircuit(doc, value.circuit || { parts: [] });
    value.files.forEach((file, index) => {
      const entry = new Y.Map(); entry.set('name', file.name); entry.set('text', new Y.Text(file.text));
      doc.getMap('files').set('initial-' + String(index).padStart(3, '0'), entry);
    });
  }, REMOTE);
  return doc;
}

function replaceText(text, value) {
  const before = text.toString(); if (before === value) return;
  let start = 0, end = 0;
  while (start < before.length && start < value.length && before[start] === value[start]) start++;
  while (end < before.length - start && end < value.length - start && before[before.length - 1 - end] === value[value.length - 1 - end]) end++;
  // Yjs cannot splice the two UTF-16 halves of one character independently.
  const high = code => code >= 0xd800 && code <= 0xdbff;
  const low = code => code >= 0xdc00 && code <= 0xdfff;
  if (start && high(before.charCodeAt(start - 1)) && low(before.charCodeAt(start))) start--;
  if (end && low(before.charCodeAt(before.length - end)) && high(before.charCodeAt(before.length - end - 1))) end--;
  const removed = before.length - start - end;
  if (removed) text.delete(start, removed);
  const added = value.slice(start, value.length - end); if (added) text.insert(start, added);
}

function syncProject(doc, value) {
  validateProject(value);
  const files = doc.getMap('files'), shown = new Map(snapshot(doc).files.map(file => [file.id, file]));
  doc.transact(() => {
    if (value.circuit !== undefined) syncCircuit(doc, value.circuit);
    if (doc.getMap('project').get('name') !== value.name) doc.getMap('project').set('name', value.name);
    const keep = new Set();
    for (const file of value.files) {
      const id = file.collabId || (file.collabId = crypto.randomUUID()); keep.add(id);
      let entry = files.get(id);
      if (!entry) { entry = new Y.Map(); entry.set('name', file.name); entry.set('text', new Y.Text()); files.set(id, entry); }
      else if (shown.get(id)?.name !== file.name) entry.set('name', file.name);
      replaceText(entry.get('text'), file.text);
    }
    for (const id of files.keys()) if (!keep.has(id)) files.delete(id);
  }, LOCAL);
}

function cursor(doc, id, start, end) {
  const text = doc.getMap('files').get(id)?.get('text');
  if (!text) return null;
  return { file: id, anchor: Y.createRelativePositionFromTypeIndex(text, Math.min(start, text.length)), head: Y.createRelativePositionFromTypeIndex(text, Math.min(end, text.length)) };
}
function resolveCursor(doc, position) {
  try {
    if (!position) return null;
    const text = doc.getMap('files').get(position.file)?.get('text');
    const anchor = Y.createAbsolutePositionFromRelativePosition(position.anchor, doc), head = Y.createAbsolutePositionFromRelativePosition(position.head, doc);
    return anchor?.type === text && head?.type === text ? { file: position.file, start: anchor.index, end: head.index } : null;
  } catch { return null; }
}
module.exports = { Y, LOCAL, REMOTE, LIMITS, snapshot, createDocument, syncProject, validateProject, cursor, resolveCursor };
