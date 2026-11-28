const Y = require('yjs');
const clean = value => JSON.parse(JSON.stringify(value));
function validateCircuit(value = { parts: [] }) {
  if (!value || !Array.isArray(value.parts) || value.parts.length > 300 || JSON.stringify(value).length > 200000) throw Error('The shared visualization is too large or invalid.');
  const ids = new Set();
  for (const part of value.parts) {
    if (!part || typeof part.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(part.id) || ids.has(part.id) ||
      typeof part.type !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(part.type) ||
      !Number.isFinite(part.x) || !Number.isFinite(part.y) || Math.abs(part.x) > 1000000 || Math.abs(part.y) > 1000000 ||
      typeof part.label !== 'string' || part.label.length > 160) throw Error('Invalid shared visualization part.');
    ids.add(part.id);
    for (const key of Object.keys(part)) if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('Invalid visualization property.');
    for (const key of ['pins', 'props']) if (part[key] != null && (typeof part[key] !== 'object' || Array.isArray(part[key]))) throw Error('Invalid visualization properties.');
    for (const key of ['pins', 'props']) for (const [name, data] of Object.entries(part[key] || {})) {
      if (!/^[A-Za-z0-9_-]{1,50}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name) ||
        !['string', 'number', 'boolean'].includes(typeof data) || (typeof data === 'string' && data.length > 200) || (typeof data === 'number' && !Number.isFinite(data))) throw Error('Invalid visualization property value.');
      if (key === 'pins' && typeof data !== 'string') throw Error('Invalid visualization pin.');
    }
    if (part.props?.color != null && typeof part.props.color !== 'string') throw Error('Invalid component colour.');
  }
  return value;
}
function circuitSnapshot(doc) {
  const parts = [...doc.getMap('circuit').entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => {
    if (!(entry instanceof Y.Map)) throw Error('Invalid shared visualization.');
    return { ...entry.toJSON(), id };
  });
  return validateCircuit({ parts });
}
function syncCircuit(doc, value) {
  validateCircuit(value); const parts = doc.getMap('circuit'), keep = new Set();
  for (const part of value.parts) {
    keep.add(part.id); let entry = parts.get(part.id);
    if (!entry) { entry = new Y.Map(); parts.set(part.id, entry); }
    for (const [key, data] of Object.entries(part)) if (key !== 'id' && data !== undefined && JSON.stringify(entry.get(key)) !== JSON.stringify(data)) entry.set(key, clean(data));
    for (const key of [...entry.keys()]) if (!Object.hasOwn(part, key)) entry.delete(key);
  }
  for (const id of [...parts.keys()]) if (!keep.has(id)) parts.delete(id);
}
module.exports = { validateCircuit, circuitSnapshot, syncCircuit };
