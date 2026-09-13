// F05 verification: active content served by a /fetch-style relay must not
// execute as a same-origin page. Spins up a local HTTP server that mimics
// the relay response (harmless payload that tries to read sessionStorage
// and beacon it back), navigates REAL headless Chrome to it, and checks
// whether the payload ran.
//
//   /set-secret  app page: sessionStorage.setItem('apiKey', 'sk-demo')
//   /control     payload WITHOUT isolation headers (pre-fix behavior)
//   /fixed       payload WITH CSP sandbox + nosniff (functions/fetch.js behavior)
//
// Expected: control exfiltrates (GET /exfil?k=sk-demo hits the server);
// fixed does not run the script at all (no /exfil hit, window.__pwned unset).
//
// Run: node tests/verify-active-content.cjs
// Uses its own Chrome instance on port 9334. No external network needed.

const http = require('http');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HTTP_PORT = 8899;
const DEBUG_PORT = 9334;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAYLOAD = '<!doctype html><html><body><script>\n' +
  'window.__pwned = true;\n' +
  'document.title = "PWNED";\n' +
  'try { fetch("/exfil?k=" + encodeURIComponent(sessionStorage.getItem("apiKey") || "none")); } catch (e) {}\n' +
  '</script></body></html>';

const FIXED_HEADERS = {
  'content-type': 'text/html',
  'x-content-type-options': 'nosniff',
  'content-security-policy': 'sandbox',
};

const exfilHits = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/set-secret') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><script>sessionStorage.setItem("apiKey","sk-demo");document.title="APP";</script>');
  } else if (u.pathname === '/control') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAYLOAD);
  } else if (u.pathname === '/fixed') {
    res.writeHead(200, FIXED_HEADERS);
    res.end(PAYLOAD);
  } else if (u.pathname === '/exfil') {
    exfilHits.push(u.searchParams.get('k'));
    res.writeHead(204);
    res.end();
  } else {
    res.writeHead(404);
    res.end();
  }
});

async function main() {
  await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + DEBUG_PORT,
    '--user-data-dir=/tmp/chrome-secverify',
    '--no-first-run',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch (e) {}
      await sleep(500);
    }
    if (!target) throw new Error('chrome target not found');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const send = (method, params) => new Promise((resolve, reject) => {
      const mid = ++id;
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === mid) {
          ws.removeEventListener('message', onMsg);
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    await new Promise((r) => ws.addEventListener('open', r));

    const visit = async (path) => {
      await send('Page.enable');
      await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}${path}` });
      await sleep(1500);
      const res = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({pwned: !!window.__pwned, title: document.title})',
        returnByValue: true,
      });
      return JSON.parse(res.result.value);
    };

    let passed = 0, failed = 0;
    const check = (name, cond, detail) => {
      if (cond) { passed++; console.log('PASS ' + name); }
      else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
    };

    await visit('/set-secret');

    // control: same payload WITHOUT isolation headers → script executes and
    // can read same-origin sessionStorage after navigation
    const before = exfilHits.length;
    const control = await visit('/control');
    await sleep(800);
    check('CONTROL payload executes without isolation (proves the risk is real)',
      control.pwned === true && exfilHits.length > before && exfilHits[exfilHits.length - 1] === 'sk-demo',
      JSON.stringify(control) + ' exfil=' + JSON.stringify(exfilHits));

    // fixed: the headers functions/fetch.js now sends → script never runs
    const beforeFixed = exfilHits.length;
    const fixed = await visit('/fixed');
    await sleep(800);
    check('FIXED payload neutralized by CSP sandbox (no script execution)',
      fixed.pwned === false && fixed.title !== 'PWNED' && exfilHits.length === beforeFixed,
      JSON.stringify(fixed) + ' exfil=' + JSON.stringify(exfilHits));

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } finally {
    try { ws && ws.close(); } catch (e) {}
    chrome.kill();
    server.close();
  }
}

main().catch((e) => { console.error('VERIFY FAIL:', e); process.exit(1); });
