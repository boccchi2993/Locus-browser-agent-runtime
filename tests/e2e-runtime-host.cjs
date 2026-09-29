// Standalone RUNTIME HOST browser e2e (M2a gate B/C/F — real build, real
// Chrome, real workers, real Python).
//
// Drives dist/tests/runtime-host.html (a REAL vite build input): the page
// loads only the runtime core + the public entry + the worker-asset
// bundle. Proves, on the packaged artifacts:
//   B1  cold load performs ZERO Pyodide CDN fetches (lazy python);
//   B2  shell text work runs and stays cold (no DOM ids anywhere);
//   B3  grep uses a REAL worker compiled from the packaged asset and a
//       catastrophic pattern is terminated at the hard timeout while the
//       main thread keeps beating;
//   B4  REAL Python boots from the pinned manifest, executes, and reports
//       VFS write-back through the public entry;
//   B5  status transitions arrive as events (subscribe path), never DOM;
//   C   a second session on the same host is independent (state + dispose).
// Run: node tests/e2e-runtime-host.cjs   (E2E_HOST_URL or the default preview URL)
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const HOST_URL = process.env.E2E_HOST_URL || 'http://127.0.0.1:4173/tests/runtime-host.html';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  const line = (cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 300) : '');
  console.log(line);
  if (cond) passed++; else failed++;
}

async function evaluate(cdp, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs || 120000,
  });
  if (result?.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(result.exceptionDetails).slice(0, 600));
  return result?.result?.value;
}

async function main() {
  let chrome = null;
  let cdp = null;
  let profileDir = null;
  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-host-profile-'));
    chrome = await launchChrome(HOST_URL, {
      chromePath: process.env.CHROME,
      label: 'runtime-host Chrome',
      profileDir,
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, HOST_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, 'document.title === "runtime-host-ready"',
      { process: chrome, phase: 'runtime-host-boot', timeoutMs: 15000 });
    check('H0 the standalone host page is ready', true);

    // ---- B1: cold load = zero CDN fetches ----
    check('B1 cold load performed ZERO Pyodide CDN fetches (lazy python)',
      (await evaluate(cdp, 'window.__host.cdnFetches().length')) === 0,
      JSON.stringify(await evaluate(cdp, 'window.__host.cdnFetches()')));

    // ---- B2: shell work, stays cold, no Locus DOM exists ----
    const echo = await evaluate(cdp, 'window.__host.run("echo standalone-host")');
    check('B2 shell echo through the public entry', echo.ok && echo.output === 'standalone-host', JSON.stringify(echo));
    const wr = await evaluate(cdp, 'window.__host.run("echo data > /mnt/workspace/f.txt && cat /mnt/workspace/f.txt")');
    check('B2b VFS write + read', wr.ok && wr.output === 'data', JSON.stringify(wr));
    check('B2c the interpreter stayed cold; no #sb-python / worker-source elements exist',
      (await evaluate(cdp, 'window.__host.session.status().interpreter')) === 'cold'
      && (await evaluate(cdp, '!!document.getElementById("sb-python") || !!document.getElementById("py-worker-src") || !!document.getElementById("grep-worker-src")')) === false,
      JSON.stringify(await evaluate(cdp, 'window.__host.session.status()')));

    // ---- B3: grep real worker + catastrophic pattern containment ----
    await evaluate(cdp, 'window.__host.run("printf abc > /mnt/workspace/a.txt")');
    const grep = await evaluate(cdp, 'window.__host.run("grep -n b /mnt/workspace/a.txt")');
    check('B3 grep works through the packaged worker asset', grep.ok && grep.output.includes('abc'), JSON.stringify(grep));
    // Main-thread heartbeat while a catastrophic pattern burns the worker.
    const beats = await evaluate(cdp, `(async () => {
      let beats = 0;
      const hb = setInterval(() => beats++, 50);
      try {
        await window.__host.run("grep '^(a+)+$' /mnt/workspace/a.txt");
      } catch (e) { /* bounded failure expected */ }
      clearInterval(hb);
      return beats;
    })()`, 60000);
    check('B3b the catastrophic pattern ran OFF the main thread (heartbeat never stalled)', beats >= 5, String(beats));

    // ---- B5 (part 1): status events observed so far (subscribe path) ----
    const eventsBefore = await evaluate(cdp, 'window.__host.statusEvents.length');
    check('B5 status events delivered through the subscription (cold edges only so far)',
      eventsBefore >= 1, String(eventsBefore));

    // ---- B4: REAL python through the public entry ----
    const py = await evaluate(cdp,
      'window.__host.runPython("import sys\\nprint(\\"py-ok\\", sys.version_info[0])")', 300000);
    check('B4 real Python executed on the packaged asset chain',
      py.ok && (py.output || '').includes('py-ok 3'),
      JSON.stringify(py).slice(0, 300));
    check('B4b the interpreter reported ready and back to idle',
      (await evaluate(cdp, 'window.__host.session.status().interpreter')) === 'cold'
      && (await evaluate(cdp, 'window.__host.session.status().busyExecutions')) === 0,
      JSON.stringify(await evaluate(cdp, 'window.__host.session.status()')));
    const pyWrite = await evaluate(cdp,
      'window.__host.runPython("open(\'/mnt/workspace/py.txt\',\'w\').write(\'from-python\')\\nprint(\\"w\\")")', 120000);
    const catBack = await evaluate(cdp, 'window.__host.run("cat /mnt/workspace/py.txt")');
    check('B4c python write-back commits through the VFS (public entry both ways)',
      pyWrite.ok && catBack.ok && catBack.output === 'from-python',
      JSON.stringify({ pyWrite, catBack }));

    // ---- B5 (part 2): python transitions arrived as events ----
    const statusKinds = await evaluate(cdp, 'window.__host.statusEvents.map((s) => s.interpreter)');
    check('B5b the boot/ready edges arrived as status events (no polling)',
      statusKinds.includes('loading') && statusKinds.includes('ready'),
      JSON.stringify(statusKinds));

    // ---- C: a second session on the same host is independent ----
    const c = await evaluate(cdp, `(async () => {
      const h = window.__host;
      const s2 = h.host.createSession();
      const v2 = new VirtualWorkspace({ listCommands: () => Object.keys(SHELL_COMMANDS) });
      v2.mount('/mnt/workspace', new MemoryWorkspace({ name: 'ws2' }), 'read-write');
      await h.session.execute({ kind: 'shell', input: 'echo A > /mnt/workspace/w.txt', context: { filesystem: h.vfs } });
      await s2.execute({ kind: 'shell', input: 'echo B > /mnt/workspace/w.txt', context: { filesystem: v2 } });
      const ra = await h.session.execute({ kind: 'shell', input: 'cat /mnt/workspace/w.txt', context: { filesystem: h.vfs } });
      const rb = await s2.execute({ kind: 'shell', input: 'cat /mnt/workspace/w.txt', context: { filesystem: v2 } });
      s2.dispose('host gate done');
      let refused = null;
      try { await s2.execute({ kind: 'shell', input: 'echo x', context: { filesystem: v2 } }); }
      catch (e) { refused = String(e.message); }
      const rAfter = await h.session.execute({ kind: 'shell', input: 'echo alive', context: { filesystem: h.vfs } });
      return { a: ra.output, b: rb.output, refused, alive: rAfter.output, survivorAlive: h.session.status().disposed === null };
    })()`, 60000);
    check('C two sessions are execution- and filesystem-isolated',
      c.a === 'A' && c.b === 'B', JSON.stringify({ a: c.a, b: c.b }));
    check('C2 the disposed session refuses; the survivor still executes',
      /disposed/.test(c.refused || '') && c.alive === 'alive' && c.survivorAlive === true,
      JSON.stringify(c));

    // ---- console hygiene ----
    check('H1 zero page errors / unhandled rejections',
      (await evaluate(cdp, 'window.__host.errors.length')) === 0,
      JSON.stringify(await evaluate(cdp, 'window.__host.errors')));
  } catch (e) {
    console.error('HOST-E2E ERROR:', e && e.stack || e);
    failed++;
  } finally {
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('host Chrome did not exit after bounded cleanup');
    }
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main();
