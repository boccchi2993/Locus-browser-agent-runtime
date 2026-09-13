// Full browser e2e orchestrator (npm run test:e2e):
//
//   1. runtime regression suite — real headless Chrome over
//      file://tests/e2e.html (Pyodide from CDN, OPFS native handles)
//   2. /fetch active-content isolation — tests/verify-active-content.cjs
//      (self-contained: own HTTP server + own Chrome)
//   3. Vue presentation e2e — builds the app, serves it with
//      `vite preview`, drives the REAL UI through CDP (tests/e2e-ui.cjs)
//
// Chrome path: CHROME env var or the default install location.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

const CHROME = process.env.CHROME
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kill(p) { try { p && p.kill(); } catch (e) {} }

// ---------- 1. runtime e2e (file://) ----------
async function runtimeE2e() {
  console.log('=== runtime e2e (tests/e2e.html, headless Chrome) ===');
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--allow-file-access-from-files',
    '--remote-debugging-port=9333',
    '--user-data-dir=' + path.join(os.tmpdir(), 'locus-e2e-' + Date.now()),
    'file:///' + path.join(__dirname, 'e2e.html').replace(/\\/g, '/'),
  ], { stdio: 'ignore' });
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'run-e2e.cjs')], { stdio: 'inherit' });
    return r.status === 0;
  } finally {
    kill(chrome);
  }
}

// ---------- 2. active-content isolation ----------
function activeContentE2e() {
  console.log('=== /fetch active-content isolation (tests/verify-active-content.cjs) ===');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'verify-active-content.cjs')], { stdio: 'inherit' });
  return r.status === 0;
}

// ---------- 3. Vue presentation e2e (vite preview + CDP) ----------
async function presentationE2e() {
  console.log('=== presentation e2e (built app, real UI events) ===');
  const build = spawnSync('npx', ['vite', 'build'], {
    stdio: 'inherit', cwd: path.join(__dirname, '..'), shell: true,
  });
  if (build.status !== 0) return false;

  const preview = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], {
    stdio: 'ignore', cwd: path.join(__dirname, '..'), shell: true,
  });
  try {
    let up = false;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch('http://localhost:4173/');
        if (res.ok) { up = true; break; }
      } catch (e) {}
      await sleep(300);
    }
    if (!up) { console.error('vite preview did not start'); return false; }
    const r = spawnSync(process.execPath, [path.join(__dirname, 'e2e-ui.cjs')], { stdio: 'inherit' });
    return r.status === 0;
  } finally {
    kill(preview);
  }
}

async function main() {
  const results = [];
  results.push(['runtime', await runtimeE2e()]);
  results.push(['active-content', activeContentE2e()]);
  results.push(['presentation', await presentationE2e()]);
  console.log('===');
  let failed = 0;
  for (const [name, ok] of results) {
    console.log((ok ? 'PASS' : 'FAIL') + ' suite: ' + name);
    if (!ok) failed++;
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
