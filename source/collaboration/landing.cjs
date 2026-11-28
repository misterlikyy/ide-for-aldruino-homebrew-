module.exports = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IDE-beta server is running</title>
<style>body{font:16px/1.6 system-ui,sans-serif;background:#0b1424;color:#e8f0ff;margin:0;padding:40px 20px}main{max-width:680px;margin:auto}h1{line-height:1.2}p,li{color:#b8c9e3}a{color:#83baff}.badge{color:#7fe1b2}section{padding:20px;border:1px solid #30435e;border-radius:14px;background:#142137;margin:22px 0}input{box-sizing:border-box;width:100%;font:16px monospace;padding:12px;color:#fff;background:#0b1424;border:1px solid #4a6591;border-radius:8px}strong{color:#fff}.note{border-left:3px solid #ffd080;padding-left:14px}button{margin-top:10px;padding:9px 14px;border:0;border-radius:7px;background:#83baff;color:#0b1424;cursor:pointer}</style>
<main><div class="badge">● Server is running</div><h1>Ready to share code.</h1>
<p>This PC can reach your IDE-beta collaboration server. Keep the server PC powered on while you work together.</p>
<section><strong>Server address for IDE-beta</strong><p>Use this in Share project on the host and guest PCs:</p>
<input id="address" aria-label="Server address" readonly><button id="copy">Copy address</button><p id="copyStatus" role="status"></p>
<p id="local" class="note" hidden>This is a localhost address. It works on this PC only. On another PC, use the server PC’s LAN address, such as http://192.168.1.50:1234. Create invitations using that LAN address too.</p></section>
<ol><li>In IDE-beta, open <strong>Share project</strong> and choose <strong>PCs on the same network</strong>.</li>
<li>Enter the server address, choose <strong>Check server</strong>, and enter your creation key from setup. The key is needed only to create a session.</li>
<li>Choose <strong>Share this project</strong>, copy an editor or viewer invitation, and send it to your collaborator.</li>
<li>They paste it into <strong>Join a session</strong>. They do not need the creation key.</li></ol>
<p>Local-network sharing is for PCs on the same network. For internet hosting, use your configured HTTPS address.</p>
<p><a href="/health">View server health</a> · This page confirms server access. Joining a session also needs a valid invitation and a working WebSocket connection.</p></main>
<script>const address=document.getElementById('address');address.value=location.origin;address.onclick=()=>address.select();document.getElementById('local').hidden=!/^(localhost\\.?|127(?:\\.\\d{1,3}){3}|\\[::1\\])$/.test(location.hostname);document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(address.value);document.getElementById('copyStatus').textContent='Address copied.'}catch{address.focus();address.select();document.getElementById('copyStatus').textContent='Press Ctrl+C to copy the selected address.'}};</script></html>`;
