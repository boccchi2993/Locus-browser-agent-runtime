// Full browser e2e orchestrator (npm run test:e2e).
//
// Each browser suite owns its Chrome process, temporary profile, and dynamic
// CDP port. The presentation suites share one explicitly-owned, dynamically
// allocated Vite preview server and run serially.
const { spawnSync } = require('child_process');
const path = require('path');
const {
  allocateFreePort,
  closeChrome,
  closeManagedProcess,
  launchChrome,
  launchManagedProcess,
  waitForCdp,
  waitForHttp,
  waitForPageTarget,
} = require('./helpers/chrome.cjs');
const { runE2e } = require('./run-e2e.cjs');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME;
const VITE_CLI = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

// ---------- 1. runtime e2e (file://) ----------
async function runtimeE2e() {
  console.log('=== runtime e2e (tests/e2e.html, headless Chrome) ===');
  const pageUrl = 'file:///' + path.join(__dirname, 'e2e.html').replace(/\\/g, '/');
  const chrome = await launchChrome(pageUrl, {
    chromePath: CHROME,
    label: 'runtime Chrome',
    extraArgs: ['--allow-file-access-from-files'],
  });
  try {
    await waitForCdp(chrome, { timeoutMs: 15000 });
    await waitForPageTarget(chrome, pageUrl, { timeoutMs: 15000 });
    return await runE2e({ chrome, expectedUrl: pageUrl });
  } catch (error) {
    console.error(error && error.stack || error);
    return false;
  } finally {
    const cleanup = await closeChrome(chrome);
    if (!cleanup.exited) console.error('runtime Chrome did not exit after bounded cleanup');
    if (!cleanup.profileRemoved) console.error('runtime Chrome profile cleanup failed: ' + cleanup.profileError);
  }
}

// ---------- 2. active-content isolation ----------
function activeContentE2e() {
  console.log('=== /fetch active-content isolation (tests/verify-active-content.cjs) ===');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'verify-active-content.cjs')], {
    stdio: 'inherit',
    env: process.env,
  });
  return r.status === 0;
}

// ---------- 3. Vue presentation e2e (Vite preview + CDP) ----------
async function presentationE2e() {
  console.log('=== presentation e2e (built app, real UI events) ===');
  const build = spawnSync(process.execPath, [VITE_CLI, 'build'], {
    stdio: 'inherit', cwd: ROOT,
  });
  if (build.status !== 0) return false;

  const port = await allocateFreePort();
  const preview = launchManagedProcess(process.execPath, [
    VITE_CLI, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], {
    cwd: ROOT,
    port,
    label: 'Vite preview',
    env: process.env,
  });
  const appRoot = `http://127.0.0.1:${port}/`;
  const appUrl = `${appRoot}?e2e=1`;
  try {
    await waitForHttp(appRoot, { process: preview, timeoutMs: 15000 });
    const env = { ...process.env, E2E_APP_URL: appUrl };
    const ui = spawnSync(process.execPath, [path.join(__dirname, 'e2e-ui.cjs')], {
      stdio: 'inherit', env,
    });
    const resp = spawnSync(process.execPath, [path.join(__dirname, 'e2e-responsive.cjs')], {
      stdio: 'inherit', env,
    });
    const persistence = spawnSync(process.execPath, [path.join(__dirname, 'e2e-persistence.cjs')], {
      stdio: 'inherit', env,
    });
    const wire = spawnSync(process.execPath, [path.join(__dirname, 'e2e-wire.cjs')], {
      stdio: 'inherit', env,
    });
    const approval = spawnSync(process.execPath, [path.join(__dirname, 'e2e-approval.cjs')], {
      stdio: 'inherit', env,
    });
    const image = spawnSync(process.execPath, [path.join(__dirname, 'e2e-image.cjs')], {
      stdio: 'inherit', env,
    });
    const grep = spawnSync(process.execPath, [path.join(__dirname, 'e2e-grep.cjs')], {
      stdio: 'inherit', env,
    });
    return [
      ['presentation', ui.status === 0],
      ['responsive', resp.status === 0],
      ['persistence', persistence.status === 0],
      ['wire', wire.status === 0],
      ['approval', approval.status === 0],
      ['image', image.status === 0],
      ['grep', grep.status === 0],
    ];
  } catch (error) {
    console.error(error && error.stack || error);
    return false;
  } finally {
    const cleanup = await closeManagedProcess(preview);
    if (!cleanup.exited) console.error('Vite preview did not exit after bounded cleanup');
  }
}

// ---------- 4. network runtime e2e (own servers + Chrome) ----------
function networkE2e() {
  console.log('=== network e2e (tests/e2e-network.cjs) ===');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'e2e-network.cjs')], {
    stdio: 'inherit', env: process.env,
  });
  return r.status === 0;
}

async function main() {
  const results = [];
  results.push(['runtime', await runtimeE2e()]);
  results.push(['active-content', activeContentE2e()]);
  const pres = await presentationE2e();
  if (Array.isArray(pres)) results.push(...pres);
  else results.push(['presentation', !!pres], ['responsive', false]);
  results.push(['network', networkE2e()]);
  console.log('===');
  let failed = 0;
  for (const [name, ok] of results) {
    console.log((ok ? 'PASS' : 'FAIL') + ' suite: ' + name);
    if (!ok) failed++;
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
