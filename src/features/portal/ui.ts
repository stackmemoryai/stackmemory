/**
 * StackMemory Portal — embedded UI.
 *
 * Returned as a string so it survives the esbuild transpile (which only
 * processes .ts files) and ships inside the npm `dist/`. The terminal is
 * rendered with xterm.js loaded from a pinned CDN; data is streamed over
 * the same-origin Socket.io connection exposed by the portal server.
 */

const XTERM_VERSION = '5.3.0';
const FIT_VERSION = '0.10.0';
const SOCKET_IO_VERSION = '4.7.5';

export function renderPortalPage(opts: { session: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0b0f17" />
<title>StackMemory Portal — ${escapeHtml(opts.session)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}/css/xterm.min.css" />
<style>
  :root {
    --bg: #0b0f17;
    --panel: #11161f;
    --border: #1e2733;
    --accent: #7c5cff;
    --accent-dim: #4a3a99;
    --ok: #2ecc71;
    --warn: #f1c40f;
    --err: #e74c3c;
    --text: #c7d0dc;
    --muted: #6b7686;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%;
    background: var(--bg); color: var(--text);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    overflow: hidden;
  }
  #app { display: flex; flex-direction: column; height: 100dvh; }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; background: var(--panel);
    border-bottom: 1px solid var(--border);
    -webkit-app-region: drag; user-select: none;
  }
  .brand { display: flex; align-items: center; gap: 9px; font-weight: 700; letter-spacing: .3px; }
  .logo {
    width: 22px; height: 22px; border-radius: 6px;
    background: linear-gradient(135deg, var(--accent), #34d3ff);
    box-shadow: 0 0 18px rgba(124, 92, 255, .55);
  }
  .session { color: var(--muted); font-size: 12px; }
  .session b { color: var(--text); font-weight: 600; }
  .spacer { flex: 1; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 0 rgba(0,0,0,0); transition: background .2s; }
  .dot.ok { background: var(--ok); box-shadow: 0 0 10px var(--ok); }
  .dot.err { background: var(--err); box-shadow: 0 0 10px var(--err); }
  .status { font-size: 12px; color: var(--muted); min-width: 92px; text-align: right; }
  button.tool {
    background: transparent; color: var(--muted); border: 1px solid var(--border);
    border-radius: 7px; padding: 5px 10px; font: inherit; font-size: 12px; cursor: pointer;
    transition: all .15s;
  }
  button.tool:hover { color: var(--text); border-color: var(--accent-dim); }
  #term-wrap { flex: 1; padding: 8px 10px 10px; min-height: 0; }
  #terminal { height: 100%; }
  #overlay {
    position: fixed; inset: 0; display: none; place-items: center;
    background: rgba(5, 8, 13, .85); backdrop-filter: blur(3px); z-index: 10;
  }
  #overlay.show { display: grid; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
    padding: 26px 30px; max-width: 380px; text-align: center;
    box-shadow: 0 24px 60px rgba(0,0,0,.5);
  }
  .card h2 { margin: 0 0 8px; font-size: 17px; }
  .card p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .reconnect { margin-top: 16px; }
  .reconnect button {
    background: var(--accent); color: #fff; border: 0; border-radius: 8px;
    padding: 8px 18px; font: inherit; font-weight: 600; cursor: pointer;
  }
</style>
</head>
<body>
<div id="app">
  <header>
    <span class="brand"><span class="logo"></span>StackMemory Portal</span>
    <span class="session">session <b>${escapeHtml(opts.session)}</b></span>
    <span class="spacer"></span>
    <button class="tool" id="btn-clear" title="Clear the local view">clear</button>
    <button class="tool" id="btn-fit" title="Re-fit the terminal">fit</button>
    <span class="dot" id="dot"></span>
    <span class="status" id="status">connecting…</span>
  </header>
  <div id="term-wrap"><div id="terminal"></div></div>
</div>

<div id="overlay">
  <div class="card">
    <h2 id="ov-title">Disconnected</h2>
    <p id="ov-msg">The connection to your agent was lost.</p>
    <div class="reconnect"><button id="btn-reconnect">Reconnect</button></div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@${FIT_VERSION}/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/socket.io-client@${SOCKET_IO_VERSION}/dist/socket.io.min.js"></script>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get('token') || '';

  var term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    scrollback: 10000,
    theme: {
      background: '#0b0f17', foreground: '#c7d0dc', cursor: '#7c5cff',
      selectionBackground: '#2a3550', black: '#0b0f17', brightBlack: '#3a4658'
    }
  });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('terminal'));
  fit.fit();

  var dot = document.getElementById('dot');
  var status = document.getElementById('status');
  var overlay = document.getElementById('overlay');
  var ovTitle = document.getElementById('ov-title');
  var ovMsg = document.getElementById('ov-msg');

  function setStatus(text, state) {
    status.textContent = text;
    dot.className = 'dot' + (state ? ' ' + state : '');
  }
  function showOverlay(title, msg) {
    ovTitle.textContent = title; ovMsg.textContent = msg; overlay.classList.add('show');
  }
  function hideOverlay() { overlay.classList.remove('show'); }

  var socket = io({ auth: { token: token }, query: { token: token }, reconnectionAttempts: 8 });

  socket.on('connect', function () {
    setStatus('connected', 'ok'); hideOverlay(); term.focus(); sendResize();
  });
  socket.on('output', function (data) { term.write(data); });
  socket.on('portal:error', function (msg) {
    setStatus('error', 'err'); showOverlay('Cannot start session', String(msg));
  });
  socket.on('disconnect', function () {
    setStatus('disconnected', 'err');
    showOverlay('Disconnected', 'The portal connection dropped. Your tmux session keeps running in the background.');
  });
  socket.on('connect_error', function (err) {
    setStatus('auth failed', 'err');
    showOverlay('Connection refused', (err && err.message) || 'Check your access token and try again.');
  });

  term.onData(function (data) { socket.emit('input', data); });

  function sendResize() {
    socket.emit('resize', { cols: term.cols, rows: term.rows });
  }
  function doFit() { try { fit.fit(); sendResize(); } catch (e) {} }

  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(doFit, 120); });
  document.getElementById('btn-fit').addEventListener('click', doFit);
  document.getElementById('btn-clear').addEventListener('click', function () { term.clear(); term.focus(); });
  document.getElementById('btn-reconnect').addEventListener('click', function () { hideOverlay(); socket.connect(); });

  setStatus('connecting…');
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] as string
  );
}
