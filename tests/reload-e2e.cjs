// Reload e2e.html in the running Chrome and print the result (for
// old-code-fails verification without restarting the browser).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const target = list.find((t) => t.url.includes('e2e.html'));
  if (!target) throw new Error('page target not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === mid) { ws.removeEventListener('message', onMsg); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  const deadline = Date.now() + 280000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const res = await send('Runtime.evaluate', {
      expression: `document.getElementById('out') ? document.getElementById('out').textContent : ''`,
      returnByValue: true,
    });
    const text = (res.result && res.result.value) || '';
    if (/\nDONE$|E2E-FAIL/.test(text)) {
      console.log(text);
      process.exit(text.includes('E2E-FAIL') ? 1 : 0);
    }
  }
  console.log('TIMEOUT');
  process.exit(2);
}
main().catch((e) => { console.error(e); process.exit(1); });
