// Standalone HARNESS HOST browser e2e (M2b review round F4) — real build,
// real Chrome, the packaged public entry.
//
// Drives dist/tests/harness-host.html (a REAL vite build input): the page
// imports ONLY src/harness/index.js and awaits ensureHarnessCore()
// (self-assembly). Proves, on the packaged artifacts:
//   H0   the harness host page is ready with zero page errors;
//   H0b  the page carries ZERO classic scripts (pure module self-assembly);
//   H0c  the self-assembled core published the declared table (v1) and no
//        Locus product DOM exists;
//   R    the loaded resource set contains ONLY the harness host chunk and
//        the harness self-assembly chunk — NO Runtime/Product chunk, no
//        classic dist/src scripts, no product CSS, no CDN;
//   T1   a complete native tool → result → final answer task runs;
//   T2   strict text-fallback rules hold (prose-wrapped fence is plain
//        text; a pure fence executes exactly once);
//   T3   a parked task is cancelled through the session;
//   T4   provider-session restore runs against an in-memory store with
//        the harness's REAL replay validators (valid restore + corrupt
//        tail → checkpoint_beyond_tail + replay blocked).
// Run: node tests/e2e-harness-host.cjs   (E2E_HARNESS_HOST_URL or the default preview URL)
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const HOST_URL = process.env.E2E_HARNESS_HOST_URL || 'http://127.0.0.1:4173/tests/harness-host.html';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  const line = (cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 400) : '');
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

// The ONLY resources a standalone harness host may load: its own entry
// chunk, Vite's dynamic-import preload helper, the shared chunk holding
// the harness-owned task-runner/provider-session/replay-validation
// modules, and the harness self-assembly chunk — plus the page itself.
// Anything else — the product main chunk/CSS, the runtime-host entry, the
// runtime worker-asset bundle, the copied classic dist/src scripts, any
// CDN — is a boundary violation.
function resourceVerdict(names) {
  const violations = [];
  const allowed = [];
  for (const full of names) {
    const name = full.replace(/^https?:\/\/[^/]+\//, '');
    if (name === 'tests/harness-host.html' || name === 'harness-host.html') { allowed.push(name); continue; }
    if (name === 'favicon.ico') { allowed.push(name); continue; } // browser-automatic
    if (/^assets\/(harnessHost|core|index|preload-helper)-[A-Za-z0-9_-]+\.js$/.test(name)) { allowed.push(name); continue; }
    violations.push(name);
  }
  return { allowed, violations };
}

async function main() {
  let chrome = null;
  let cdp = null;
  let profileDir = null;
  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-harness-host-profile-'));
    chrome = await launchChrome(HOST_URL, {
      chromePath: process.env.CHROME,
      label: 'harness-host Chrome',
      profileDir,
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, HOST_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, 'document.title === "harness-host-ready"',
      { process: chrome, phase: 'harness-host-boot', timeoutMs: 15000 });
    check('H0 the standalone harness host page is ready', true);

    const results = await evaluate(cdp, 'window.__harnessHost');
    check('H0b the page carries ZERO classic scripts (pure module self-assembly)',
      results.assembly.classicScriptTags === 0, JSON.stringify(results.assembly));
    check('H0c the self-assembled core published the declared table (v1); no product DOM',
      results.assembly.registryPresent === true && results.assembly.contractVersion === 1
      && results.assembly.domProductNodes === 0,
      JSON.stringify(results.assembly));

    // ---- R: the loaded resource set is harness-only ----
    const names = await evaluate(cdp, 'window.__harnessHost.resources()');
    const verdict = resourceVerdict(names);
    check('R every loaded resource is the harness host chunk or its self-assembly chunk',
      verdict.violations.length === 0,
      JSON.stringify({ violations: verdict.violations, allowed: verdict.allowed }));
    check('Rb the harness entry chunk AND the self-assembly chunk both loaded',
      verdict.allowed.filter((n) => /harnessHost-/.test(n)).length === 1
      && verdict.allowed.some((n) => /assets\/core-/.test(n))
      && verdict.allowed.some((n) => /assets\/index-/.test(n)),
      JSON.stringify(verdict.allowed));

    // ---- T1: native tool → tool result → final answer ----
    const nat = results.native;
    check('T1 the full native tool task ran (events, execution, replay history)',
      nat.chain === 'task_start,tool_call,tool_result,assistant_text,task_end'
      && nat.execs.length === 1 && nat.execs[0][0] === 'lookup' && nat.execs[0][1] === 'q1'
      && nat.requestTools.length === 1 && nat.requestTools[0] === 'lookup'
      && nat.historyRoles.join(',') === 'user,assistant,tool_result,assistant'
      && nat.toolCallId === 't1'
      && nat.finalText === 'final answer after tool',
      JSON.stringify(nat));

    // ---- T2: strict text fallback ----
    const fb = results.textFallback;
    check('T2 strict text fallback: prose-wrapped fence is plain text; pure fence executes once',
      fb.proseExecuted === 0 && fb.proseIsPlainText === true
      && fb.fencedExecuted.join(',') === 'fenced' && fb.fencedCompleted === true,
      JSON.stringify(fb));

    // ---- T3: cancellation ----
    check('T3 a parked task cancels through the session',
      results.cancel.cancelled === true && results.cancel.chain === 'task_start,warning,task_end',
      JSON.stringify(results.cancel));

    // ---- T4: REAL replay validation over the in-memory store ----
    const rp = results.replay;
    check('T4 a valid raw prefix restores through the REAL validators',
      rp.validRestore.id === 'provider-session-host' && rp.validRestore.blocked === false
      && rp.validRestore.historyRoles.join(',') === 'user,assistant,tool_result'
      && rp.validRestore.toolCallId === 'call-1',
      JSON.stringify(rp.validRestore));
    check('T4b a tail corrupted behind the checkpoint is rejected by code and blocks replay',
      rp.invalidRestore.rawInvalid === true && rp.invalidRestore.code === 'checkpoint_beyond_tail'
      && rp.invalidRestore.blocked === true,
      JSON.stringify(rp.invalidRestore));
    check('T4c the entry validator export runs in the browser',
      rp.directValid === true, JSON.stringify(rp.directValid));

    // ---- console hygiene ----
    check('H1 zero page errors / unhandled rejections',
      (await evaluate(cdp, 'window.__harnessHost.errors.length')) === 0,
      JSON.stringify(results.errors));
  } catch (e) {
    console.error('HARNESS-HOST-E2E ERROR:', e && e.stack || e);
    failed++;
  } finally {
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('harness-host Chrome did not exit after bounded cleanup');
    }
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main();
