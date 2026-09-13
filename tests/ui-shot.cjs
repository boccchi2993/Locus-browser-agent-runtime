// UI screenshot helper for visual QA. Loads a URL in real-time headless
// Chrome, waits, optionally clicks timeline disclosures to expand them,
// then captures a PNG via CDP (virtual-time-budget free, so async demo
// flows like OPFS mounts complete normally).
//
// Usage: node tests/ui-shot.cjs <url> <out.png> [waitMs] [expand] [scroll=top] [media=light]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [url, out, waitMs = '9000', expand = '', scroll = '', media = ''] = process.argv.slice(2);
const PORT = 9342;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'locus-shot-' + Date.now()),
    '--remote-debugging-port=' + PORT,
    '--window-size=1440,900',
    url,
  ], { stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 50; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.url.startsWith(url.split('?')[0]));
        if (target) break;
      } catch (e) {}
      await sleep(400);
    }
    if (!target) throw new Error('target not found');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params) => new Promise((res, rej) => {
      const mid = ++id; pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    await new Promise((r) => ws.addEventListener('open', r));
    if (media) {
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: media }],
      });
    }
    await sleep(parseInt(waitMs, 10));
    if (expand) {
      await send('Runtime.evaluate', {
        expression: `document.querySelectorAll('.item-reasoning .disclosure, .item-tool .tool-head').forEach(b => {
          const c = b.querySelector('.chev');
          if (c && !c.classList.contains('open')) b.click();
        })`,
      });
      await sleep(400);
    }
    if (scroll === 'top') {
      await send('Runtime.evaluate', {
        expression: `const el = document.querySelector('.timeline-scroll'); if (el) el.scrollTop = 0;`,
      });
      await sleep(300);
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('written: ' + out);
  } finally {
    chrome.kill();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
