// Lightweight contract tests for tests/helpers/chrome.cjs. These tests use a
// local fake CDP HTTP endpoint; they do not launch real Chrome.
const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');
const {
  targetMatches,
  urlMatches,
  waitForCdp,
  waitForPageTarget,
} = require('./helpers/chrome.cjs');

function fakeChrome(port) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  return {
    kind: 'chrome',
    executable: 'fake-chrome.exe',
    child,
    pid: 43210,
    port,
    startedAt: Date.now(),
    exitCode: null,
    signal: null,
    spawnError: null,
    exited: false,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function main() {
  let mode = 'delayed';
  let versionRequests = 0;
  let listRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      versionRequests++;
      if (mode === 'delayed' && versionRequests < 3) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/fake' }));
      return;
    }
    if (req.url === '/json/list') {
      listRequests++;
      const correct = {
        type: 'page',
        title: 'Expected',
        url: `http://127.0.0.1:${server.address().port}/expected?x=1`,
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/correct',
      };
      const wrong = {
        type: 'page',
        title: 'Wrong page',
        url: `http://127.0.0.1:${server.address().port}/wrong?x=1`,
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/wrong',
      };
      const targets = mode === 'delayed' && listRequests < 3
        ? [{ type: 'page', title: 'New tab', url: 'about:blank' }, { type: 'service_worker', url: 'chrome-extension://x' }]
        : mode === 'timeout'
          ? [wrong, { type: 'service_worker', title: 'worker', url: 'chrome-extension://x' }]
          : [wrong, correct];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);
  try {
    const chrome = fakeChrome(port);
    const version = await waitForCdp(chrome, { timeoutMs: 1000, pollIntervalMs: 20 });
    assert.ok(version.webSocketDebuggerUrl, 'delayed CDP readiness resolves');
    const target = await waitForPageTarget(chrome, `http://127.0.0.1:${port}/expected/?x=1`, {
      timeoutMs: 1000,
      pollIntervalMs: 20,
    });
    assert.strictEqual(target.title, 'Expected', 'delayed page target resolves');
    assert.strictEqual(listRequests, 3, 'about:blank and wrong targets are ignored');
    assert.ok(urlMatches(target.url, `http://127.0.0.1:${port}/expected/?x=1`), 'URL matching parses components');
    assert.strictEqual(targetMatches({ type: 'service_worker', url: target.url }, target.url), false,
      'non-page target is ignored');

    mode = 'timeout';
    versionRequests = 0;
    listRequests = 0;
    chrome.cdpVersion = null;
    await assert.rejects(
      waitForPageTarget(chrome, `http://127.0.0.1:${port}/expected?x=1`, { timeoutMs: 180, pollIntervalMs: 20 }),
      (error) => error.message.includes('Page target unavailable')
        && error.message.includes('debug port=' + port)
        && error.message.includes('/json/list snapshot')
        && error.message.includes('Wrong page'),
      'timeout includes target diagnostics',
    );

    const earlyExit = fakeChrome(port + 1);
    setTimeout(() => {
      earlyExit.exited = true;
      earlyExit.exitCode = 7;
      earlyExit.child.exitCode = 7;
      earlyExit.child.emit('exit', 7, null);
    }, 20);
    await assert.rejects(
      waitForCdp(earlyExit, { timeoutMs: 1000, pollIntervalMs: 20 }),
      (error) => error.message.includes('CDP browser endpoint unavailable')
        && error.message.includes('exitCode=7'),
      'early process exit fails immediately with exit code',
    );
    console.log('all chrome helper tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
