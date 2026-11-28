const { serverUrl } = require('./url.cjs');

function addressKind(value) {
  const url = new URL(serverUrl(value));
  if (/^(localhost\.?|127(?:\.\d{1,3}){3}|\[::1\])$/.test(url.hostname)) return 'computer';
  return url.protocol === 'http:' ? 'network' : 'internet';
}

async function checkServer(value, request = fetch, timeout = 6000) {
  const address = serverUrl(value);
  let response;
  try { response = await request(address + '/health', { redirect: 'error', signal: AbortSignal.timeout(timeout) }); }
  catch {
    throw Error('Cannot reach ' + address + '. ' + (addressKind(address) === 'computer'
      ? 'This address checks this PC only. Start the server here, or use the host PC’s LAN address to connect from another PC.'
      : 'Keep the server PC on, check its address, and open ' + address + '/health in this PC’s browser. For local sharing, both PCs must be on the same network; check the host firewall if the browser also cannot connect.'));
  }
  try {
    if (!response.ok) throw Error();
    const text = await response.text(); if (text.length > 20000) throw Error();
    const result = JSON.parse(text);
    if (result.ok !== true || result.service !== 'IDE-beta collaboration' || result.protocol !== 1) throw Error();
  } catch { throw Error('This address did not return a compatible IDE-beta server health response. Check ' + address + '/health and the server logs.'); }
  return { ok: true, address, kind: addressKind(address) };
}
module.exports = { addressKind, checkServer };
