const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkServer, addressKind } = require('../collaboration/connection.cjs');
const { serverUrl } = require('../collaboration/url.cjs');
const { createServer } = require('../collaboration/server.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('Connection checks accept browser health URLs and explain the scope of localhost', async () => {
  assert.equal(serverUrl('http://10.20.30.40:1234/health'), 'http://10.20.30.40:1234');
  assert.equal(addressKind('http://127.0.0.0:1234'), 'computer');
  assert.equal(addressKind('http://10.20.30.40:1234'), 'network');
  assert.equal(addressKind('https://collab.example.com'), 'internet');
  await assert.rejects(checkServer('http://127.0.0.1:1234', async () => { throw Error('refused'); }), /this PC only/);
  await assert.rejects(checkServer('http://10.20.30.40:1234', async () => { throw Error('refused'); }), /host firewall/);
  await assert.rejects(checkServer('http://example.com', async () => { throw Error('must not fetch'); }), /HTTPS/);
});

test('Health check validates protocol, response limits and redirects without sending credentials', async () => {
  for (const response of [new Response('<html>other website</html>'), new Response(JSON.stringify({ ok: true, protocol: 2 })), new Response('x'.repeat(20001)), new Response('{}', { status: 404 })]) {
    await assert.rejects(checkServer('http://127.0.0.1:1234', async () => response), /compatible IDE-beta/);
  }
  let request;
  const result = await checkServer('http://10.20.30.40:1234/health', async (url, options) => {
    request = { url, options }; return new Response(JSON.stringify({ ok: true, service: 'IDE-beta collaboration', protocol: 1 }));
  });
  assert.equal(result.address, 'http://10.20.30.40:1234'); assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers, undefined); assert.equal(request.url, result.address + '/health'); assert.ok(request.options.signal);
});

test('Real server homepage explains sharing, health stays machine-readable, and neither exposes secrets', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-connection-'));
  const server = createServer({ directory, createKey: 'private-test-key' });
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.server.listen(0, '127.0.0.1', resolve));
  const address = 'http://127.0.0.1:' + server.server.address().port;
  const page = await fetch(address), html = await page.text();
  assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(html, /Server is running/); assert.match(html, /localhost address/); assert.match(html, /\/health/);
  assert.ok(!html.includes('private-test-key')); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.deepEqual(await checkServer(address + '/health'), { ok: true, address, kind: 'computer' });
  assert.equal((await fetch(address + '/not-a-page')).status, 404);
});
