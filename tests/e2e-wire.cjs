// Browser integration for the production adapter → wire boundary. The fake
// lives at Model.transport, so callModel, adapter selection, serialization,
// headers, replay compatibility and AgentSession remain real.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const APP_URL = process.env.E2E_APP_URL || 'http://127.0.0.1:4173/?e2e=1';
const WIRE_URL = APP_URL + (APP_URL.includes('?') ? '&' : '?') + 'wire=1';

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: 110000,
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
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-wire-profile-'));
    chrome = await launchChrome(WIRE_URL, {
      chromePath: process.env.CHROME,
      label: 'adapter wire Chrome',
      profileDir,
      extraArgs: ['--window-size=1440,900'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, WIRE_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, '!!(window.__locus && document.querySelector(".app-shell") && window.__locusWire)', {
      process: chrome, phase: 'wire-app-boot', timeoutMs: 15000,
    });

    await evaluate(cdp, `(async () => {
      await window.__locus.actions.resetAllData();
      const s = window.__locus.store.settings;
      s.apiBase = 'https://gateway.example/tenant-a';
      s.dialect = 'openai'; s.model = 'audit-model'; s.apiKey = 'KEY_A'; s.remember = false;
      window.__locus.actions.applySettings();
      await window.__locus.actions.persistSettingsIfNeeded();
    })()`);
    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      choices: [{ message: {
        role: 'assistant', content: 'wire answer', reasoning_content: 'opaque reasoning',
        future_vendor_field: { keep: true },
      }, finish_reason: 'stop' }],
    })}); window.__locus.actions.submit('wire task')`);
    await waitForRuntimeCondition(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'wire task');
      return !!c && c.status === 'completed' && c.items.some(i => i.content === 'wire answer');
    })()`, { process: chrome, phase: 'wire-first-task', timeoutMs: 15000 });
    const callsAfterFirst = await evaluate(cdp, 'window.__locusWire.calls');
    check('W-E1 production callModel reached fake transport', callsAfterFirst.length === 1);
    check('W-E2 OpenAI endpoint is adapter-owned', callsAfterFirst[0]?.url === 'https://gateway.example/tenant-a/chat/completions', callsAfterFirst[0]?.url);
    check('W-E3 OpenAI adapter built Bearer header', callsAfterFirst[0]?.headers?.Authorization === 'Bearer KEY_A');
    check('W-E4 provider-neutral tools became OpenAI tools', callsAfterFirst[0]?.body?.tools?.[0]?.type === 'function');

    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: 'same-provider continuation' }, finish_reason: 'stop' }],
    })}); window.__locus.actions.submit('same provider')`);
    await waitForRuntimeCondition(cdp, `window.__locus.store.conversations.some(c => c.items.some(i => i.content === 'same-provider continuation'))`, {
      process: chrome, phase: 'wire-same-provider', timeoutMs: 15000,
    });
    const callsAfterSame = await evaluate(cdp, 'window.__locusWire.calls');
    const sameBody = callsAfterSame[1]?.body || {};
    const replayed = sameBody.messages?.find(m => m.future_vendor_field || m.reasoning_content);
    check('W-E5 same-provider wire replay keeps opaque fields', !!replayed && replayed.future_vendor_field?.keep === true && replayed.reasoning_content === 'opaque reasoning');

    await evaluate(cdp, `(async () => {
      const s = window.__locus.store.settings;
      s.apiBase = 'https://gateway.example/tenant-b'; s.dialect = 'anthropic'; s.apiKey = 'KEY_B'; s.remember = false;
      window.__locus.actions.applySettings();
      await window.__locus.actions.persistSettingsIfNeeded();
      window.__locusWire.responses.push(${literal({
        content: [{ type: 'text', text: 'cross-provider continuation' }], stop_reason: 'end_turn',
      })});
      await window.__locus.actions.submit('cross provider');
    })()`);
    await waitForRuntimeCondition(cdp, `window.__locus.store.conversations.some(c => c.items.some(i => i.content === 'cross-provider continuation'))`, {
      process: chrome, phase: 'wire-cross-provider', timeoutMs: 15000,
    });
    const callsAfterCross = await evaluate(cdp, 'window.__locusWire.calls');
    const cross = callsAfterCross[2] || {};
    check('W-E6 cross-provider wire uses Anthropic endpoint', cross.url === 'https://gateway.example/tenant-b/v1/messages', cross.url);
    check('W-E7 cross-provider wire uses only destination B credential', cross.headers?.['x-api-key'] === 'KEY_B' && !JSON.stringify(cross.headers).includes('KEY_A'));
    check('W-E8 cross-provider projection excludes foreign opaque fields', !JSON.stringify(cross.body?.messages || []).includes('future_vendor_field') && !JSON.stringify(cross.body?.messages || []).includes('reasoning_content'));

    const conversationId = await evaluate(cdp, `window.__locus.store.conversations.find(c => c.title === 'wire task').id`);
    const sessionId = await evaluate(cdp, `window.__locus.store.conversations.find(c => c.id === ${literal(conversationId)}).activeProviderSessionId`);
    await evaluate(cdp, `new Promise((resolve, reject) => {
      const req = indexedDB.open('locus');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result; const tx = db.transaction('providerSessions', 'readwrite');
        const get = tx.objectStore('providerSessions').get(${literal(sessionId)});
        get.onerror = () => reject(get.error);
        get.onsuccess = () => { const row = get.result; row.replayCheckpointSequence = 999; tx.objectStore('providerSessions').put(row); };
        tx.oncomplete = () => resolve(true); tx.onerror = () => reject(tx.error);
      };
    })`);
    const beforeCorrupt = await evaluate(cdp, 'window.__locusWire.calls.length');
    await evaluate(cdp, `window.__locus.actions.newTask(); window.__locus.actions.openConversation(${literal(conversationId)}); window.__locus.actions.submit('corrupt checkpoint')`);
    await waitForRuntimeCondition(cdp, `window.__locus.store.conversations.find(c => c.id === ${literal(conversationId)})?.replayState === 'raw_invalid'`, {
      process: chrome, phase: 'wire-corrupt-replay', timeoutMs: 15000,
    });
    const afterCorrupt = await evaluate(cdp, 'window.__locusWire.calls.length');
    check('W-E9 corrupt checkpoint sends zero provider request', afterCorrupt === beforeCorrupt, 'before=' + beforeCorrupt + ',after=' + afterCorrupt);

    // F-C01 closure probe: create a real native tool transcript through the
    // production callModel/adapter/fake transport path, then corrupt only its
    // durable metadata and remove the result suffix. Raw tool semantics must
    // still make restore fail closed before another provider request.
    await evaluate(cdp, `(async () => {
      window.__locus.actions.newTask();
      window.__e2eToolExecutor = async () => ({ output: 'seeded tool output', success: true, backend: 'browser' });
      const s = window.__locus.store.settings;
      s.apiBase = 'https://gateway.example/tenant-a'; s.dialect = 'openai'; s.model = 'audit-model'; s.apiKey = 'KEY_A'; s.remember = false;
      window.__locus.actions.applySettings();
      window.__locusWire.responses.push(${literal({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'wire-c01-openai', type: 'function', function: { name: 'bash', arguments: '{"input":"pwd"}' } }] }, finish_reason: 'tool_calls' }],
      })}, ${literal({
        choices: [{ message: { role: 'assistant', content: 'seeded openai final' }, finish_reason: 'stop' }],
      })});
      await window.__locus.actions.submit('seed openai raw tool transcript');
    })()`);
    await waitForRuntimeCondition(cdp, `window.__locus.store.conversations.some(c => c.title === 'seed openai raw tool transcript' && c.status === 'completed')`, {
      process: chrome, phase: 'wire-c01-openai-seed', timeoutMs: 15000,
    });
    const openAiSeedCalls = await evaluate(cdp, 'window.__locusWire.calls');
    const openAiToolBody = JSON.stringify(
      (openAiSeedCalls.find((c) => JSON.stringify(c?.body || {}).includes('seeded tool output')) || {}).body || {});
    check('BE-E1 OpenAI native tool result omits execution backend (R-NF05A\u2032)',
      openAiToolBody.includes('seeded tool output')
      && !openAiToolBody.includes('backend:')
      && !openAiToolBody.includes('browser-direct') && !openAiToolBody.includes('edge-relay'),
      openAiToolBody.slice(0, 200));
    const openAiAttackId = await evaluate(cdp, `window.__locus.store.conversations.find(c => c.title === 'seed openai raw tool transcript').id`);
    const openAiAttackSession = await evaluate(cdp, `window.__locus.store.conversations.find(c => c.id === ${literal(openAiAttackId)}).activeProviderSessionId`);
    await evaluate(cdp, `(async () => {
      const db = await new Promise((resolve, reject) => { const req = indexedDB.open('locus'); req.onerror = () => reject(req.error); req.onsuccess = () => resolve(req.result); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['providerFrames', 'providerSessions'], 'readwrite');
        const index = tx.objectStore('providerFrames').index('sessionId');
        const get = index.getAll(${literal(openAiAttackSession)});
        get.onerror = () => reject(get.error);
        get.onsuccess = () => {
          const rows = get.result.sort((a, b) => a.sequence - b.sequence);
          const target = rows.find(r => r.raw && r.raw.role === 'assistant' && Array.isArray(r.raw.tool_calls) && r.raw.tool_calls.length);
          if (!target) return reject(new Error('OpenAI attack assistant frame not found'));
          const frames = tx.objectStore('providerFrames');
          rows.filter(r => r.sequence > target.sequence).forEach(r => frames.delete(r.id));
          target.kind = 'message'; frames.put(target);
          const sessions = tx.objectStore('providerSessions');
          const sessionGet = sessions.get(${literal(openAiAttackSession)});
          sessionGet.onerror = () => reject(sessionGet.error);
          sessionGet.onsuccess = () => { const session = sessionGet.result; session.replayCheckpointSequence = target.sequence; session.nextFrameSequence = target.sequence; sessions.put(session); };
        };
        tx.oncomplete = () => resolve(true); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('attack transaction aborted'));
      });
    })()`);
    const beforeOpenAiCorrupt = await evaluate(cdp, 'window.__locusWire.calls.length');
    await evaluate(cdp, `window.__locus.actions.newTask(); window.__locus.actions.openConversation(${literal(openAiAttackId)}); window.__locus.actions.submit('continue corrupt openai raw')`);
    await waitForRuntimeCondition(cdp, `window.__locus.store.conversations.find(c => c.id === ${literal(openAiAttackId)})?.replayState === 'raw_invalid'`, {
      process: chrome, phase: 'wire-c01-openai-corrupt', timeoutMs: 15000,
    });
    const afterOpenAiCorrupt = await evaluate(cdp, 'window.__locusWire.calls.length');
    check('C01 wire OpenAI raw dangling tool call sends zero requests', afterOpenAiCorrupt === beforeOpenAiCorrupt, 'before=' + beforeOpenAiCorrupt + ',after=' + afterOpenAiCorrupt);

    // The same metadata corruption must be rejected for Anthropic tool_use.
    await evaluate(cdp, `(async () => { await window.__locus.actions.resetAllData(); const s = window.__locus.store.settings; s.apiBase = 'https://gateway.example/tenant-b'; s.dialect = 'anthropic'; s.model = 'audit-model'; s.apiKey = 'KEY_B'; s.remember = false; window.__locus.actions.applySettings(); window.__e2eToolExecutor = async () => ({ output: 'seeded tool output', success: true, backend: 'browser' }); })()`);
    await evaluate(cdp, `(async () => {
      window.__locusWire.responses.push(${literal({
        content: [{ type: 'tool_use', id: 'wire-c01-anthropic', name: 'bash', input: { input: 'pwd' } }], stop_reason: 'tool_use',
      })}, ${literal({
        content: [{ type: 'text', text: 'seeded anthropic final' }], stop_reason: 'end_turn',
      })});
      await window.__locus.actions.submit('seed anthropic raw tool transcript');
    })()`);
    await waitForRuntimeCondition(cdp, `window.__locus.store.conversations.some(c => c.title === 'seed anthropic raw tool transcript' && c.status === 'completed')`, {
      process: chrome, phase: 'wire-c01-anthropic-seed', timeoutMs: 15000,
    });
    const anthropicSeedCalls = await evaluate(cdp, 'window.__locusWire.calls');
    const anthropicToolBody = JSON.stringify(
      (anthropicSeedCalls.find((c) => String(c?.url || '').includes('tenant-b')
        && JSON.stringify(c?.body || {}).includes('seeded tool output')) || {}).body || {});
    check('BE-E2 Anthropic projection of the tool result omits execution backend (R-NF05A\u2032)',
      anthropicToolBody.includes('seeded tool output')
      && !anthropicToolBody.includes('backend:')
      && !anthropicToolBody.includes('browser-direct') && !anthropicToolBody.includes('edge-relay'),
      anthropicToolBody.slice(0, 200));
    const anthropicAttackId = await evaluate(cdp, `window.__locus.store.conversations.find(c => c.title === 'seed anthropic raw tool transcript').id`);
    const anthropicAttackSession = await evaluate(cdp, `window.__locus.store.conversations.find(c => c.id === ${literal(anthropicAttackId)}).activeProviderSessionId`);
    await evaluate(cdp, `(async () => {
      const db = await new Promise((resolve, reject) => { const req = indexedDB.open('locus'); req.onerror = () => reject(req.error); req.onsuccess = () => resolve(req.result); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['providerFrames', 'providerSessions'], 'readwrite');
        const get = tx.objectStore('providerFrames').index('sessionId').getAll(${literal(anthropicAttackSession)});
        get.onerror = () => reject(get.error);
        get.onsuccess = () => {
          const rows = get.result.sort((a, b) => a.sequence - b.sequence);
          const target = rows.find(r => r.raw && r.raw.role === 'assistant' && Array.isArray(r.raw.content) && r.raw.content.some(b => b && b.type === 'tool_use'));
          if (!target) return reject(new Error('Anthropic attack assistant frame not found'));
          const frames = tx.objectStore('providerFrames');
          rows.filter(r => r.sequence > target.sequence).forEach(r => frames.delete(r.id));
          target.kind = 'message'; frames.put(target);
          const sessions = tx.objectStore('providerSessions');
          const sessionGet = sessions.get(${literal(anthropicAttackSession)});
          sessionGet.onerror = () => reject(sessionGet.error);
          sessionGet.onsuccess = () => { const session = sessionGet.result; session.replayCheckpointSequence = target.sequence; session.nextFrameSequence = target.sequence; sessions.put(session); };
        };
        tx.oncomplete = () => resolve(true); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('attack transaction aborted'));
      });
    })()`);
    const beforeAnthropicCorrupt = await evaluate(cdp, 'window.__locusWire.calls.length');
    await evaluate(cdp, `window.__locus.actions.newTask(); window.__locus.actions.openConversation(${literal(anthropicAttackId)}); window.__locus.actions.submit('continue corrupt anthropic raw')`);
    await waitForRuntimeCondition(cdp, `window.__locus.store.conversations.find(c => c.id === ${literal(anthropicAttackId)})?.replayState === 'raw_invalid'`, {
      process: chrome, phase: 'wire-c01-anthropic-corrupt', timeoutMs: 15000,
    });
    const afterAnthropicCorrupt = await evaluate(cdp, 'window.__locusWire.calls.length');
    check('C01 wire Anthropic raw dangling tool call sends zero requests', afterAnthropicCorrupt === beforeAnthropicCorrupt, 'before=' + beforeAnthropicCorrupt + ',after=' + afterAnthropicCorrupt);

    await evaluate(cdp, 'window.__locus.actions.newTask()');
    const failureId = await evaluate(cdp, 'window.__locus.store.liveConversationId');
    const beforeFailure = await evaluate(cdp, 'window.__locusWire.calls.length');
    await evaluate(cdp, `(() => {
      const original = window.PersistenceServiceInstance.appendProviderFrame.bind(window.PersistenceServiceInstance);
      window.__wireToolCount = 0;
      window.__e2eToolExecutor = async () => { window.__wireToolCount++; return { output: 'tool output', success: true, backend: 'browser' }; };
      window.PersistenceServiceInstance.appendProviderFrame = async function(row) {
        if (row.kind === 'tool_result') throw new Error('simulated durable write failure');
        return original(row);
      };
    })()`);
    await evaluate(cdp, `window.__locus.store.settings.apiBase = 'https://gateway.example/tenant-a'; window.__locus.store.settings.dialect = 'openai'; window.__locus.store.settings.apiKey = 'KEY_A'; window.__locus.actions.applySettings(); window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-fail', type: 'function', function: { name: 'bash', arguments: '{"input":"pwd"}' } }] }, finish_reason: 'tool_calls' }],
    })}, ${literal({ choices: [{ message: { role: 'assistant', content: 'must not be called' }, finish_reason: 'stop' }] })}); window.__locus.actions.submit('persistence failure')`);
    await waitForRuntimeCondition(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.id === ${literal(failureId)});
      return !!c && c.status === 'persistence_error' && c.runState === 'interrupted' && c.persistenceState === 'degraded';
    })()`, { process: chrome, phase: 'wire-persistence-failure', timeoutMs: 15000 });
    const failureState = await evaluate(cdp, `(() => { const c = window.__locus.store.conversations.find(x => x.id === ${literal(failureId)}); return { status: c.status, runState: c.runState, persistenceState: c.persistenceState }; })()`);
    const afterFailure = await evaluate(cdp, '({ calls: window.__locusWire.calls.length, tools: window.__wireToolCount })');
    check('W-E10 persistence failure is terminal and degraded', failureState.status === 'persistence_error' && failureState.runState === 'interrupted' && failureState.persistenceState === 'degraded');
    check('W-E11 persistence failure stops tool retry/model resend', afterFailure.calls === beforeFailure + 1 && afterFailure.tools === 1, JSON.stringify(afterFailure));

    check('W-E12 browser reported no unhandled errors', (await evaluate(cdp, '(window.__e2eErrors || []).length')) === 0);
    console.log('---');
    console.log('e2e-wire: ' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('WIRE E2E FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) await closeChrome(chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
