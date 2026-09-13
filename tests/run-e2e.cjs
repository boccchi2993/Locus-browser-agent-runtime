// Minimal CDP runner: waits until the e2e page reports DONE/FAIL, then prints the log.
// Usage: launch Chrome with --headless=new --remote-debugging-port=9333
//        --allow-file-access-from-files <path-to>/tests/e2e.html, then `node tests/run-e2e.cjs`.
const DEBUG_PORT = 9333;
const DEADLINE = Date.now() + 280000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // find the page target
  let target = null;
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find((t) => t.url.includes('e2e.html'));
      if (target) break;
    } catch (e) {}
    await sleep(500);
  }
  if (!target) throw new Error('page target not found');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
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

  while (Date.now() < DEADLINE) {
    const res = await send('Runtime.evaluate', {
      expression: `document.getElementById('out') ? document.getElementById('out').textContent : ''`,
      returnByValue: true,
    });
    const text = (res.result && res.result.value) || '';
    if (/\nDONE$|E2E-FAIL/.test(text)) {
      console.log(text);
      process.exit(text.includes('E2E-FAIL') ? 1 : 0);
    }
    await sleep(2000);
  }
  console.log('TIMEOUT waiting for DONE');
  process.exit(2);
}

main().catch((e) => { console.error('RUNNER FAIL:', e.message); process.exit(1); });
