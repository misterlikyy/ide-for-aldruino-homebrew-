function serverUrl(value) {
  const url = new URL(String(value).trim());
  if (url.pathname === '/health' || url.pathname === '/health/') url.pathname = '/';
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)) throw Error('Use the server address only, for example https://collab.example.com.');
  // These common bind/loopback aliases should reach a normally bound localhost server.
  if (url.hostname === '127.0.0.0' || url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  const local = /^(localhost\.?|127(?:\.\d{1,3}){3}|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname);
  if (url.protocol !== 'https:' && !local) throw Error('Internet collaboration servers must use HTTPS. HTTP is allowed only for localhost or private network addresses.');
  return url.origin;
}
module.exports = { serverUrl };
