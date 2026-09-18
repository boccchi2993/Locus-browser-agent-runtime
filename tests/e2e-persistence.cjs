// Persistence browser E2E. It deliberately uses the shared Chrome helper
// for dynamic CDP ports, readiness and bounded cleanup. The second browser
// launch reuses the first launch's profile directory.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const APP_URL = process.env.E2E_APP_URL || 'http://127.0.0.1:4173/?e2e=1';

async function evaluate(cdp, expression, awaitPromise = true) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, timeout: 110000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result?.result?.value;
}

async function waitForPresentationTaskStarts(cdp, conversationId, input, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  const conversationLiteral = JSON.stringify(conversationId);
  const inputLiteral = JSON.stringify(input);
  while (Date.now() < deadline) {
    const count = await evaluate(cdp, `(async () => new Promise((resolve, reject) => {
      const req = indexedDB.open('locus');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('presentationEvents', 'readonly');
        const get = tx.objectStore('presentationEvents').index('conversationId').getAll(${conversationLiteral});
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result.filter(row =>
          row.event && row.event.type === 'task_start' && row.event.input === ${inputLiteral}).length);
      };
    }))()`);
    if (count === 1) return count;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error('timed out waiting for one persisted task_start for ' + input);
}

async function open(profileDir, preserveProfile) {
  const chrome = await launchChrome(APP_URL, {
    chromePath: process.env.CHROME,
    label: preserveProfile ? 'persistence Chrome A' : 'persistence Chrome B',
    profileDir,
    preserveProfile,
    extraArgs: ['--window-size=1440,900'],
  });
  await waitForCdp(chrome, { timeoutMs: 15000 });
  const target = await waitForPageTarget(chrome, APP_URL, { timeoutMs: 15000 });
  const cdp = await connectToTarget(target);
  await waitForRuntimeCondition(cdp, '!!(window.__locus && document.querySelector(".app-shell"))', {
    process: chrome, phase: 'persistence-app-boot', timeoutMs: 15000,
  });
  await waitForRuntimeCondition(cdp, '!!(window.__locus && window.__locus.store.storageStatus)', {
    process: chrome, phase: 'persistence-service-boot', timeoutMs: 15000,
  });
  await waitForRuntimeCondition(cdp, '!!(window.__locus && window.__locus.vfs.resolveMount("/home/locus").provider.root)', {
    process: chrome, phase: 'persistence-opfs-boot', timeoutMs: 15000,
  });
  return { chrome, cdp };
}

async function main() {
  let profileDir;
  let first;
  let second;
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
  };

  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-persistence-profile-'));
    first = await open(profileDir, true);

    await evaluate(first.cdp, `window.__locus.actions.resetAllData()`);
    await evaluate(first.cdp, `window.__e2eReplies.push({
      content: 'persisted answer', reasoning: 'provider returned reasoning',
      rawMessage: { role: 'assistant', future_vendor_field: { nested: [1, 2, 3] }, content: [
        { type: 'thinking', thinking: 'provider returned reasoning' },
        { type: 'text', text: 'persisted answer' },
        { type: 'future_opaque_block', payload: { nested: [1, 2, 3] } }
      ] }
    }); window.__locus.actions.submit('persist this conversation')`);
    await waitForRuntimeCondition(first.cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'persist this conversation');
      return !!c && c.status === 'completed' && c.items.some(i => i.content === 'persisted answer');
    })()`, { process: first.chrome, phase: 'persistence-first-run', timeoutMs: 15000 });
    const firstConversationId = await evaluate(first.cdp, `window.__locus.store.conversations.find(c => c.title === 'persist this conversation')?.id`);
    const firstUserCount = await evaluate(first.cdp, `window.__locus.store.conversations
      .find(c => c.id === ${JSON.stringify(firstConversationId)})?.items
      .filter(i => i.kind === 'user' && i.content === 'persist this conversation').length`);
    check('P-E0 first submit projects exactly one user item', firstUserCount === 1, String(firstUserCount));
    check('P-E0b first submit persists exactly one presentation task_start',
      await waitForPresentationTaskStarts(first.cdp, firstConversationId, 'persist this conversation') === 1);

    await evaluate(first.cdp, `window.__locus.store.settings.apiKey = 'TEST_SECRET_123'; window.__locus.store.settings.remember = true; window.__locus.actions.persistSettingsIfNeeded()`);
    await evaluate(first.cdp, `window.__locus.vfs.write('/home/locus/durable.txt', 'durable'); window.__locus.vfs.write('/tmp/ephemeral.txt', 'ephemeral'); window.PersistenceServiceInstance.writePlugin('test-plugin/plugin.json', '{"name":"test"}')`);
    await waitForRuntimeCondition(first.cdp, `window.__locus.vfs.read('/home/locus/durable.txt').then(v => v === 'durable')`, { process: first.chrome, phase: 'persistence-first-files', timeoutMs: 10000 });

    const firstDb = await evaluate(first.cdp, `(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('locus');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const names = Array.from(db.objectStoreNames).filter(n => n !== 'secrets');
        const tx = db.transaction(names, 'readonly');
        const out = {}; let left = names.length;
        for (const name of names) { const r = tx.objectStore(name).getAll(); r.onsuccess = () => { out[name] = r.result; if (!--left) resolve(JSON.stringify(out)); }; }
        if (!left) resolve(JSON.stringify(out));
      };
    }))()`);
    check('P-E1 non-secret durable stores contain no remembered key', !String(firstDb).includes('TEST_SECRET_123'));
    check('P-E2 OPFS plugin bytes are readable by privileged setup', await evaluate(first.cdp, `window.__locus.vfs.read('/mnt/plugins/test-plugin/plugin.json')`) === '{"name":"test"}');
    check('P-E3 ordinary agent-facing plugin mount is read-only', await evaluate(first.cdp, `window.__locus.vfs.write('/mnt/plugins/test-plugin/nope', 'x').then(() => false).catch(e => e.name === 'ReadOnlyError')`));

    first.cdp.close();
    const cleanupA = await closeChrome(first.chrome, { gracefulTimeoutMs: 1200 });
    check('P-E4 first browser closes cleanly', cleanupA.exited);
    first = null;

    second = await open(profileDir, false);
    await waitForRuntimeCondition(second.cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'persist this conversation');
      return !!c && c.items.some(i => i.content === 'persisted answer');
    })()`, { process: second.chrome, phase: 'persistence-reload', timeoutMs: 15000 });
    check('P-E5 browser restart restores conversation timeline', true);
    check('P-E6 browser restart restores OPFS home', await evaluate(second.cdp, `window.__locus.vfs.read('/home/locus/durable.txt')`) === 'durable');
    check('P-E7 browser restart restores OPFS plugins', await evaluate(second.cdp, `window.__locus.vfs.read('/mnt/plugins/test-plugin/plugin.json')`) === '{"name":"test"}');
    check('P-E8 browser restart clears /tmp', await evaluate(second.cdp, `window.__locus.vfs.exists('/tmp/ephemeral.txt')`) === false);
    check('P-E9 settings and remembered key restore', await evaluate(second.cdp, `window.__locus.store.settings.apiKey === 'TEST_SECRET_123' && window.__locus.store.settings.remember === true`));
    const restoredDebug = await evaluate(second.cdp, `JSON.stringify({ conversations: window.__locus.store.conversations.map(c => ({ id: c.id, title: c.title, items: c.items.length })), history: window.__locus.session.history })`);
    console.log('persistence restored:', restoredDebug);
    const persistedId = await evaluate(second.cdp, `window.__locus.store.conversations.find(c => c.title === 'persist this conversation')?.id`);
    check('P-E10 history projection is readable and secret-free', await evaluate(second.cdp, `window.__locus.vfs.read('/home/locus/history/' + ${JSON.stringify(persistedId)} + '/events.jsonl').then(v => !v.includes('TEST_SECRET_123') && v.includes('persisted answer'))`), persistedId);

    const history = await evaluate(second.cdp, `window.__locus.session.history`);
    check('P-E11 same-provider replay retains unknown provider fields', JSON.stringify(history).includes('future_vendor_field'), JSON.stringify(history));
    check('P-E12 same-provider replay retains returned reasoning state', JSON.stringify(history).includes('provider returned reasoning'), JSON.stringify(history));
    await evaluate(second.cdp, `window.__e2eReplies.push({ content: 'continued' }); window.__locus.actions.submit('continue old conversation')`);
    await waitForRuntimeCondition(second.cdp, `window.__locus.store.conversations.find(c => c.title === 'persist this conversation').items.some(i => i.content === 'continued')`, { process: second.chrome, phase: 'persistence-continuation', timeoutMs: 15000 });
    check('P-E13 restored conversation continues', true);

    await evaluate(second.cdp, `window.__e2eReplies.push((body, opts) => new Promise((resolve) => {
      const answer = { content: 'cancelled answer', reasoning: null, reasoningType: 'raw',
        toolCalls: null, rawMessage: { role: 'assistant', content: 'cancelled answer' },
        stopReason: 'end_turn', usage: null, providerMetadata: null, truncated: false };
      if (opts?.signal?.aborted) resolve(answer);
      else opts.signal.addEventListener('abort', () => resolve(answer), { once: true });
    })); void window.__locus.actions.submit('gate cancellation'); true`);
    await waitForRuntimeCondition(second.cdp, '!!(window.__locus.store.busy && window.__locus.session.task)', {
      process: second.chrome, phase: 'persistence-gate-active-task', timeoutMs: 10000,
    });
    await evaluate(second.cdp, 'window.__locus.actions.clearConversations()');
    check('P-E14 storage gate waits for task settlement before clear', await evaluate(second.cdp, '!window.__locus.store.busy && window.__locus.session.task === null'));
    check('P-E15 clear conversations leaves no durable conversation rows', await evaluate(second.cdp, `new Promise((resolve, reject) => {
      const req = indexedDB.open('locus'); req.onerror = () => reject(req.error);
      req.onsuccess = () => { const tx = req.result.transaction('conversations', 'readonly'); const get = tx.objectStore('conversations').getAll(); get.onsuccess = () => resolve(get.result.length === 1); };
    })`));

    await evaluate(second.cdp, 'window.__locus.actions.resetAllData()');
    check('P-E16 reset unmounts external workspace and clears handle state', await evaluate(second.cdp, '!window.__locus.vfs.resolveMount("/mnt/workspace") && window.__locus.store.workspaceHandleAvailable === false'));
    check('P-E17 reset recreates canonical home skeleton', await evaluate(second.cdp, 'window.__locus.vfs.exists("/home/locus/.skills") && window.__locus.vfs.exists("/home/locus/.config/locus/mcp") && window.__locus.vfs.exists("/home/locus/.cache/locus")'));

    // F-C02: OPFS clear still removes durable files and preserves the same
    // canonical skeleton before the memory-only fallback cases below.
    await evaluate(second.cdp, `window.__locus.vfs.write('/home/locus/opfs-clear-survivor.txt', 'durable')`);
    await evaluate(second.cdp, 'window.__locus.actions.clearHome()');
    const opfsClearState = await evaluate(second.cdp, `(async () => ({ exists: await window.__locus.vfs.exists('/home/locus/opfs-clear-survivor.txt'), provider: window.__locus.vfs.resolveMount('/home/locus').provider.constructor.name, opfs: !!window.PersistenceServiceInstance.opfsRoot }))()`);
    check('C02-5 OPFS Clear still works', !opfsClearState.exists, JSON.stringify(opfsClearState));
    check('C02-5b OPFS Clear rebuilds skeleton', await evaluate(second.cdp, 'window.__locus.vfs.exists("/home/locus/.skills") && window.__locus.vfs.exists("/home/locus/.config/locus/mcp") && window.__locus.vfs.exists("/home/locus/.cache/locus")'));

    const clearFailure = await evaluate(second.cdp, `(async () => {
      const service = window.PersistenceServiceInstance;
      const before = window.__locus.vfs.resolveMount('/home/locus').provider;
      await window.__locus.vfs.write('/home/locus/durable-clear-failure.txt', 'must remain');
      const original = service.clearHome;
      service.clearHome = async () => { const e = new Error('simulated OPFS removeEntry failure'); e.name = 'StorageClearError'; throw e; };
      try {
        await window.__locus.actions.clearHome();
        return { rejected: false };
      } catch (e) {
        return {
          rejected: true,
          name: e.name,
          providerPreserved: window.__locus.vfs.resolveMount('/home/locus').provider === before,
          filePreserved: await window.__locus.vfs.read('/home/locus/durable-clear-failure.txt') === 'must remain',
        };
      } finally { service.clearHome = original; }
    })()`);
    check('C02-6 OPFS clear failure is not masked', clearFailure.rejected && clearFailure.name === 'StorageClearError' && clearFailure.providerPreserved && clearFailure.filePreserved, JSON.stringify(clearFailure));

    // Force the app into the same memory-only mounted-provider state produced
    // when OPFS was unavailable at boot. Clear and Reset must replace that
    // provider even though PersistenceService correctly returns false.
    await evaluate(second.cdp, `(async () => {
      const service = window.PersistenceServiceInstance;
      service.opfsRoot = null; service.opfsAvailable = false;
      window.__locus.vfs.resetHome();
      await window.__locus.vfs.write('/home/locus/memory-clear-survivor.txt', 'memory');
      await window.__locus.actions.clearHome();
    })()`);
    const memoryClearState = await evaluate(second.cdp, `(async () => ({ exists: await window.__locus.vfs.exists('/home/locus/memory-clear-survivor.txt'), provider: window.__locus.vfs.resolveMount('/home/locus').provider.constructor.name, opfs: !!window.PersistenceServiceInstance.opfsRoot }))()`);
    check('C02-1 memory home Clear removes files', !memoryClearState.exists, JSON.stringify(memoryClearState));
    check('C02-2 memory home Clear rebuilds skeleton', await evaluate(second.cdp, 'window.__locus.vfs.exists("/home/locus/.skills") && window.__locus.vfs.exists("/home/locus/.config/locus/mcp") && window.__locus.vfs.exists("/home/locus/.cache/locus")'));
    await evaluate(second.cdp, `(async () => {
      await window.__locus.vfs.write('/home/locus/memory-reset-survivor.txt', 'memory');
      await window.__locus.actions.resetAllData();
    })()`);
    const memoryResetState = await evaluate(second.cdp, `(async () => ({ exists: await window.__locus.vfs.exists('/home/locus/memory-reset-survivor.txt'), provider: window.__locus.vfs.resolveMount('/home/locus').provider.constructor.name, opfs: !!window.PersistenceServiceInstance.opfsRoot }))()`);
    check('C02-3 memory home Reset removes files', !memoryResetState.exists, JSON.stringify(memoryResetState));
    check('C02-4 memory home Reset rebuilds skeleton', await evaluate(second.cdp, 'window.__locus.vfs.exists("/home/locus/.skills") && window.__locus.vfs.exists("/home/locus/.config/locus/mcp") && window.__locus.vfs.exists("/home/locus/.cache/locus")'));

    console.log('---');
    console.log('e2e-persistence: ' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('PERSISTENCE E2E FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { if (first?.cdp) first.cdp.close(); } catch (e) {}
    try { if (second?.cdp) second.cdp.close(); } catch (e) {}
    if (first?.chrome) await closeChrome(first.chrome);
    if (second?.chrome) await closeChrome(second.chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
