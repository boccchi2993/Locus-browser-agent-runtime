// M2c joint browser gate (product-joint): the PACKAGED product page
// (vite build + preview, ?e2e=1&wire=1) driven through its REAL production
// chain — real store submit → real task runner → real Harness (public
// entry) → real product ToolPort (src/product/tool-adapter.js + tools.js)
// → real RuntimeSession (public entry) → real VFS/shell/Python → tool
// result back through the real adapter serialization. The ONLY fake is the
// scripted provider transport living at Model.transport (below the real
// model boundary — the wire-suite rule); the standalone runtime/harness
// host pages stay separate gates and are NOT joint evidence.
//
//   J1  full chain: native tool call → real shell writes+reads the VFS →
//       the tool result reaches the next provider request → final answer
//   J2  real Python path: bash python heredoc → REAL worker asset
//       assembly + REAL verified Pyodide bootstrap (recorded as REAL
//       network, distinct from every faked model hop)
//   J3  cancel: an abort-aware parked transport (real-transport fidelity)
//       → REAL composer cancel → honest cancelled terminal
//   J4  permission denial: curl -X POST through the real chain → real
//       ApprovalCard → Deny → ZERO fetch dispatch (recording stub)
//   J5  compatibility failure: the retained runtime host patched to an
//       unsupported contract version → core_incompatible through the REAL
//       entry, zero model calls; restore → next legal task runs
//   J6  zero page errors / unhandled rejections
//
// Registered in tests/e2e.cjs (presentation block: shares that block's
// build + vite preview lifecycle via E2E_APP_URL).

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const APP_URL = process.env.E2E_APP_URL || 'http://127.0.0.1:4173/?e2e=1';
const JOINT_URL = APP_URL + (APP_URL.includes('?') ? '&' : '?') + 'wire=1';

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: 240000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result?.result?.value;
}

function literal(value) { return JSON.stringify(value); }

async function main() {
  let profileDir;
  let chrome;
  let cdp;
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
  };

  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-product-joint-'));
    chrome = await launchChrome(JOINT_URL, {
      chromePath: process.env.CHROME,
      label: 'product joint Chrome',
      profileDir,
      extraArgs: ['--window-size=1440,900'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, JOINT_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, '!!(window.__locus && document.querySelector(".app-shell") && window.__locusWire)', {
      process: chrome, phase: 'joint-app-boot', timeoutMs: 15000,
    });

    // Fresh settings on the production path (the wire-suite pattern): the
    // OpenAI dialect through the REAL adapter + fake transport.
    await evaluate(cdp, `(async () => {
      await window.__locus.actions.resetAllData();
      const s = window.__locus.store.settings;
      s.apiBase = 'https://joint.invalid/v1'; s.dialect = 'openai';
      s.model = 'joint-model'; s.apiKey = 'JOINT-KEY'; s.remember = false;
      window.__locus.actions.applySettings();
      await window.__locus.actions.persistSettingsIfNeeded();
    })()`);

    // ---------- J1: full chain ----------
    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'pj-call-1', type: 'function', function: { name: 'bash', arguments: '{"input":"echo m2c-browser-joint > /tmp/pj-j1.txt && cat /tmp/pj-j1.txt"}' } }] }, finish_reason: 'tool_calls' }],
    })}, ${literal({
      choices: [{ message: { role: 'assistant', content: 'Joint J1 final answer' }, finish_reason: 'stop' }],
    })}); window.__locus.actions.submit('joint J1: browser chain')`);
    await waitForRuntimeCondition(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'joint J1: browser chain');
      return !!c && c.status === 'completed' && c.items.some(i => i.content === 'Joint J1 final answer');
    })()`, { process: chrome, phase: 'joint-j1', timeoutMs: 30000 });
    const j1 = await evaluate(cdp, `(async () => {
      const calls = window.__locusWire.calls;
      const second = JSON.stringify(calls[1] && calls[1].body && calls[1].body.messages || []);
      const file = await window.__locus.vfs.read('/tmp/pj-j1.txt').catch(() => null);
      const conv = window.__locus.store.conversations.find(x => x.title === 'joint J1: browser chain');
      const toolItem = conv.items.find(i => i.kind === 'tool');
      return {
        calls: calls.length,
        url: calls[0] && calls[0].url,
        tools: calls[0] && calls[0].body && calls[0].body.tools && calls[0].body.tools[0],
        toolResultInSecondRequest: second.includes('m2c-browser-joint') && second.includes('pj-call-1'),
        file: typeof file === 'string' && file.includes('m2c-browser-joint'),
        toolCard: !!toolItem,
      };
    })()`);
    check('J1 full chain completed through the production path', j1.calls === 2 && j1.toolCard, JSON.stringify(j1).slice(0, 200));
    check('J1 the real OpenAI adapter serialized the real registry', j1.tools && j1.tools.type === 'function' && j1.tools.function && j1.tools.function.name === 'bash', JSON.stringify(j1.tools));
    check('J1 the real runtime shell wrote and read back the real VFS file', j1.file === true, JSON.stringify(j1.file));
    check('J1 the tool result reached the next provider request', j1.toolResultInSecondRequest === true);

    // ---------- J2: real Python path ----------
    const j2ToolArgs = JSON.stringify({ input: "python <<'PY'" + String.fromCharCode(10) + "print('m2c-py-joint-ok')" + String.fromCharCode(10) + "PY" });
    const j2Response = {
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'pj-call-2', type: 'function', function: { name: 'bash', arguments: j2ToolArgs } }] }, finish_reason: 'tool_calls' }],
    };
    const j2Final = { choices: [{ message: { role: 'assistant', content: 'Joint J2 python answer' }, finish_reason: 'stop' }] };
    await evaluate(cdp, 'window.__locusWire.responses.push(' + literal(j2Response) + ', ' + literal(j2Final) + '); window.__locus.actions.newTask(); window.__locus.actions.submit("joint J2: real python")');
    await waitForRuntimeCondition(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.title === "joint J2: real python");
      return !!c && c.status === 'completed' && c.items.some(i => i.content === 'Joint J2 python answer');
    })()`, { process: chrome, phase: 'joint-j2', timeoutMs: 420000 }); // beyond the runtime's own bootstrap budgets
    const j2 = await evaluate(cdp, `(async () => {
      const calls = window.__locusWire.calls;
      const second = JSON.stringify(calls[3] && calls[3].body && calls[3].body.messages || []);
      // REAL network record: the verified Pyodide bootstrap assets are
      // genuinely downloaded (never faked) — kept distinct from the faked
      // model hops by construction.
      const realAssetFetches = performance.getEntriesByType('resource')
        .map(r => r.name).filter(n => /pyodide|cdn\\.jsdelivr/i.test(n));
      return {
        toolResultHasOutput: second.includes('m2c-py-joint-ok'),
        pythonStatus: window.__locus.store.pythonStatus,
        realAssetFetches: realAssetFetches.length,
        sample: realAssetFetches[0] || null,
      };
    })()`);
    check('J2 the REAL python worker executed and its output reached the provider request', j2.toolResultHasOutput === true, JSON.stringify(j2));
    check('J2 the python status projected through the runtime status events', j2.pythonStatus === 'ready', JSON.stringify(j2.pythonStatus));
    check('J2 the Pyodide bootstrap was a REAL verified download (recorded distinctly)', j2.realAssetFetches >= 1, JSON.stringify({ n: j2.realAssetFetches, sample: j2.sample }));

    // ---------- J3: cancel (abort-aware parked transport) ----------
    await evaluate(cdp, `(() => {
      const wireTransport = window.Model.transport;
      window.__jointRestoreTransport = wireTransport;
      window.Model.transport = async (url, init) => {
        window.__locusWire.calls.push({ url, body: JSON.parse(init.body || '{}') });
        return new Promise((resolve, reject) => {
          const signal = init && init.signal;
          const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          if (signal && signal.aborted) { onAbort(); return; }
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
      };
    })(); window.__locus.actions.newTask(); (function () { window.__locus.actions.submit('joint J3: parked then cancelled'); return 'submitted'; })()`);
    const j3state = await evaluate(cdp, `({ busy: window.__locus.store.busy,
      calls: window.__locusWire.calls.length,
      transportIsParker: String(window.Model.transport).includes('onAbort'),
      convs: window.__locus.store.conversations.map(c => c.title + ':' + c.status) })`);
    console.log('J3 pre-wait state: ' + JSON.stringify(j3state));
    await waitForRuntimeCondition(cdp, 'window.__locusWire.calls.length >= 5', {
      process: chrome, phase: 'joint-j3-parked', timeoutMs: 40000,
    });
    await evaluate(cdp, 'window.__locus.actions.cancelTask()');
    await waitForRuntimeCondition(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'joint J3: parked then cancelled');
      return !!c && c.status === 'cancelled' && window.__locus.store.busy === false;
    })()`, { process: chrome, phase: 'joint-j3-cancelled', timeoutMs: 20000 });
    const j3 = await evaluate(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'joint J3: parked then cancelled');
      return {
        status: c.status,
        warning: c.items.some(i => i.kind === 'warning' && i.code === 'task_cancelled'),
        calls: window.__locusWire.calls.length,
      };
    })()`);
    check('J3 the parked task cancelled through the REAL composer path', j3.status === 'cancelled' && j3.warning === true, JSON.stringify(j3));
    check('J3 the parked request stayed dispatched exactly once (no further calls)', j3.calls === 5, JSON.stringify(j3.calls));
    await evaluate(cdp, 'window.Model.transport = window.__jointRestoreTransport;');

    // ---------- J4: permission denial (zero fetch dispatch) ----------
    await evaluate(cdp, `(() => {
      const of = window.fetch;
      window.__jointRealFetch = of;
      window.__jointFetchCalls = [];
      window.fetch = function (...a) { window.__jointFetchCalls.push(String(a[0])); return of.apply(window, a); };
    })(); window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'pj-call-4', type: 'function', function: { name: 'bash', arguments: '{"input":"curl -X POST -o /tmp/pj-j4.txt https://joint-deny.invalid/probe"}' } }] }, finish_reason: 'tool_calls' }],
    })}, ${literal({
      choices: [{ message: { role: 'assistant', content: 'Joint J4 acknowledged denial' }, finish_reason: 'stop' }],
    })}); window.__locus.actions.newTask(); (function () { window.__locus.actions.submit('joint J4: denied network write'); return 'submitted'; })()`);
    await waitForRuntimeCondition(cdp, '!!window.__locus.store.pendingApproval', {
      process: chrome, phase: 'joint-j4-pending', timeoutMs: 20000,
    });
    const j4pending = await evaluate(cdp, `({ kind: window.__locus.store.pendingApproval.kind,
      fetches: window.__jointFetchCalls.length })`);
    check('J4 the real network-write approval card is pending with zero fetch dispatch',
      j4pending.kind === 'permission' && j4pending.fetches === 0, JSON.stringify(j4pending));
    await evaluate(cdp, `window.__locus.actions.resolveApproval(window.__locus.store.pendingApproval.id, { outcome: 'deny', scope: 'once' })`);
    await waitForRuntimeCondition(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'joint J4: denied network write');
      return !!c && c.status === 'completed' && !window.__locus.store.pendingApproval;
    })()`, { process: chrome, phase: 'joint-j4-denied', timeoutMs: 30000 });
    const j4 = await evaluate(cdp, `({ fetches: window.__jointFetchCalls.length,
      second: JSON.stringify(window.__locusWire.calls[window.__locusWire.calls.length - 1].body.messages) })`);
    check('J4 the denial reached the runtime port: zero real network dispatch', j4.fetches === 0, JSON.stringify(j4.fetches));
    check('J4 the denial was reported to the model as a failed tool result', /denied|denial|refused|approval/i.test(j4.second), j4.second.slice(0, 200));
    await evaluate(cdp, 'window.fetch = window.__jointRealFetch;');

    // ---------- J5: compatibility failure through the REAL entry ----------
    // NOTE: the blocked path emits NO task_start backfill, so the
    // conversation keeps its default title — look it up by id.
    await evaluate(cdp, 'window.__locus.actions.newTask(); window.__jointJ5ConvId = window.__locus.store.liveConversationId');
    await evaluate(cdp, `(() => {
      const h = window.__locus.runtimeHost();
      window.__jointRealCaps = h.capabilities;
      const real = h.capabilities.bind(h);
      h.capabilities = () => Object.assign({}, real(), { contractVersion: 999 });
      window.__jointJ5CallsBefore = window.__locusWire.calls.length;
    })(); (function () { window.__locus.actions.submit('joint J5: incompatible runtime'); return 'submitted'; })()`);
    await waitForRuntimeCondition(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.id === window.__jointJ5ConvId);
      return !!c && c.status === 'interrupted';
    })()`, { process: chrome, phase: 'joint-j5-rejected', timeoutMs: 20000 });
    const callsBeforeRestore = await evaluate(cdp, 'window.__locusWire.calls.length');
    const j5 = await evaluate(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.id === window.__jointJ5ConvId);
      const err = c.items.find(i => i.kind === 'error');
      return { code: err && err.code, msg: err && err.message };
    })()`);
    check('J5 the incompatible runtime rejected the task core_incompatible through the REAL entry',
      j5.code === 'core_incompatible' && String(j5.msg).includes('999'), JSON.stringify(j5));
    check('J5 zero model requests for the incompatible core',
      callsBeforeRestore === (await evaluate(cdp, 'window.__jointJ5CallsBefore')),
      JSON.stringify({ calls: callsBeforeRestore }));
    await evaluate(cdp, `(() => {
      window.__locus.runtimeHost().capabilities = window.__jointRealCaps;
      window.__locusWire.responses.push(${literal({
        choices: [{ message: { role: 'assistant', content: 'Joint J5 legal follow-up' }, finish_reason: 'stop' }],
      })});
    })(); window.__locus.actions.submit('joint J5: legal follow-up')`);
    await waitForRuntimeCondition(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.id === window.__jointJ5ConvId);
      return !!c && c.status === 'completed' && c.items.some(i => i.content === 'Joint J5 legal follow-up');
    })()`, { process: chrome, phase: 'joint-j5-followup', timeoutMs: 30000 });
    const callsAfterRestore = await evaluate(cdp, 'window.__locusWire.calls.length');
    check('J5 the slot was released and the next legal task ran', callsAfterRestore === callsBeforeRestore + 1, JSON.stringify({ before: callsBeforeRestore, after: callsAfterRestore }));

    // ---------- J7: historical images obey the frozen per-task decision ----------
    // Review round 2. A normal image task completes under the REAL
    // declaration (registry preseeded supported → the image goes out and
    // the conversation history keeps the reference). The harness
    // declaration seam then hosts a generation WITHOUT imageInputGate and
    // a TEXT follow-up in the SAME conversation must send zero image
    // blocks (the deterministic notice instead), raise no capability
    // card, and complete; with the real declaration restored, the SAME
    // history sends the image again (per-task re-check, no sticky state).
    const J7_PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9, 7, 7, 7, 7]);
    const j7PngB64 = Buffer.from(J7_PNG).toString('base64');
    await evaluate(cdp, `window.__locus.actions.newTask()`);
    await evaluate(cdp, `(async () => {
      const id = createProviderIdentity({ provider: 'openai', adapterId: 'openai-compatible', dialect: 'openai', apiBase: 'https://joint.invalid/v1', model: 'joint-model' });
      await window.__locus.capabilities.registry().setUserDecision(id, 'supported');
      const bytes = Uint8Array.from(${literal([...J7_PNG])});
      window.__locus.actions.addUploadFiles([new File([bytes], 'joint-j7.png', { type: 'image/png' })]);
    })()`);
    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: 'Joint J7 image answer' }, finish_reason: 'stop' }],
    })}); window.__locus.actions.submit('joint J7: image task')`);
    await waitForRuntimeCondition(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'joint J7: image task');
      return !!c && c.status === 'completed';
    })()`, { process: chrome, phase: 'joint-j7-image', timeoutMs: 30000 });
    const j7Seeded = await evaluate(cdp, `(() => {
      const call = window.__locusWire.calls[window.__locusWire.calls.length - 1];
      return { hasImage: JSON.stringify(call.body.messages).includes('image_url') };
    })()`);
    check('J7 task 1 sent the image through the real gate (a live history reference exists)',
      j7Seeded.hasImage === true, JSON.stringify(j7Seeded));

    // The degrade follow-up in the SAME conversation, hosted through the
    // narrow declaration seam with only imageInputGate removed (derived
    // from the REAL declaration via the new ?e2e=1 seam — never a
    // hand-written shape).
    await evaluate(cdp, `(async () => {
      const real = JSON.parse(JSON.stringify(window.__locus.harnessCapabilities()));
      real.capabilities.imageInputGate = false;
      window.__jointRealHarnessDecl = real;
      window.__LOCUS_HOOKS__.harnessCapabilities = () => Object.freeze(JSON.parse(JSON.stringify(real)));
      window.__jointJ7CallsBefore = window.__locusWire.calls.length;
    })()`);
    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: 'Joint J7 degrade answer' }, finish_reason: 'stop' }],
    })}); (function () { window.__locus.actions.submit('joint J7: historical image degrades to text'); return 'submitted'; })()`);
    await waitForRuntimeCondition(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'joint J7: image task');
      return !!c && c.status === 'completed' && c.items.some(i => i.kind === 'assistant' && String(i.content).includes('degrade answer'));
    })()`, { process: chrome, phase: 'joint-j7-degrade', timeoutMs: 30000 });
    const j7 = await evaluate(cdp, `(async () => {
      const call = window.__locusWire.calls[window.__jointJ7CallsBefore];
      const body = JSON.stringify(call.body.messages);
      const c = window.__locus.store.conversations.find(x => x.title === 'joint J7: image task');
      return {
        callsDelta: window.__locusWire.calls.length - window.__jointJ7CallsBefore,
        hasImage: body.includes('image_url') || body.includes('data:image') || body.includes(${literal(j7PngB64)}),
        hasNotice: body.includes('Image input is disabled for this task'),
        historyIntact: body.includes('Joint J7 image answer'),
        warning: c.items.some(i => i.kind === 'warning' && i.code === 'image_input_unavailable'),
        noCard: !window.__locus.store.pendingApproval,
      };
    })()`);
    check('J7 the degrade follow-up sent the notice instead of every image block, history text intact',
      j7.callsDelta === 1 && j7.hasImage === false && j7.hasNotice === true && j7.historyIntact === true,
      JSON.stringify(j7));
    check('J7 the degrade follow-up raised no capability card and warned the user explicitly',
      j7.warning === true && j7.noCard === true, JSON.stringify(j7));

    // The real declaration is back: the SAME history sends the image
    // again (per-task re-check; the registry answer needs no new card).
    await evaluate(cdp, `(() => { delete window.__LOCUS_HOOKS__.harnessCapabilities; })()`);
    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: 'Joint J7 recovery answer' }, finish_reason: 'stop' }],
    })}); window.__locus.actions.submit('joint J7: recovery')`);
    await waitForRuntimeCondition(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'joint J7: image task');
      return !!c && c.items.some(i => i.kind === 'assistant' && String(i.content).includes('recovery answer'));
    })()`, { process: chrome, phase: 'joint-j7-recovery', timeoutMs: 30000 });
    const j7Recovery = await evaluate(cdp, `(() => {
      const call = window.__locusWire.calls[window.__locusWire.calls.length - 1];
      return { hasImage: JSON.stringify(call.body.messages).includes('image_url'),
        noCard: !window.__locus.store.pendingApproval };
    })()`);
    check('J7 the recovered task re-sent the history image under the real declaration (no new card)',
      j7Recovery.hasImage === true && j7Recovery.noCard === true, JSON.stringify(j7Recovery));

    // ---------- J6: page health ----------
    const errors = await evaluate(cdp, '(window.__e2eErrors || []).slice(0, 5)');
    check('J6 the browser reported no unhandled errors or rejections', errors.length === 0, JSON.stringify(errors));

    console.log('---');
    console.log('e2e-product-joint: ' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('PRODUCT JOINT E2E FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) await closeChrome(chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
