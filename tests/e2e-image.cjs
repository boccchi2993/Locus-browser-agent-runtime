// Image Feedback v1 browser integration (wire mode): the fake lives at
// Model.transport, so adapter selection, rich-content serialization,
// headers, the AttachmentStore (real OPFS/IndexedDB), the capability
// registry, the visual probe and the real ApprovalCard capability UI all
// run for real (docs/IMAGE-INPUT.md CASES A–G + viewport matrix).
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const APP_URL = process.env.E2E_APP_URL || 'http://127.0.0.1:4173/?e2e=1';
const WIRE_URL = APP_URL + (APP_URL.includes('?') ? '&' : '?') + 'wire=1';
const BASE = 'https://gateway.example/v1';

// 1×1 red PNG — the byte-level sentinel: its exact base64 must appear in
// the provider request and NOWHERE else (history, events, IndexedDB, UI).
const SENTINEL_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGO4Z2gIAAMxAUHTY+YjAAAAAElFTkSuQmCC';

// Injected after every page (re)load. Wraps the wire transport with probe
// awareness: the four-quadrant probe is answered by DECODING ITS PIXELS
// (the only honest way a transport fake can "see"), everything else flows
// through the normal FIFO queue.
const PAGE_HELPERS = `
(() => {
  const L = window.__locus;
  if (window.__img) return 'ready';
  window.__img = {
    pngB64: ${JSON.stringify(SENTINEL_PNG_B64)},
    calls: [],
    probePrompts: [],
  };
  const COLORS = { red: [222,49,49], blue: [49,80,222], yellow: [240,200,40], black: [20,20,20] };
  const colorName = (rgb) => Object.keys(COLORS).find(n => { const v = COLORS[n]; return v[0]===rgb[0]&&v[1]===rgb[1]&&v[2]===rgb[2]; });
  function decodeProbe(dataBase64) {
    const bytes = Uint8Array.from(atob(dataBase64), c => c.charCodeAt(0));
    const dv = (a, i) => ((a[i]<<24)|(a[i+1]<<16)|(a[i+2]<<8)|a[i+3]) >>> 0;
    let at = 8, width = 0, height = 0, idat = [];
    while (at < bytes.length) {
      const len = dv(bytes, at);
      const type = String.fromCharCode(bytes[at+4], bytes[at+5], bytes[at+6], bytes[at+7]);
      const data = bytes.slice(at+8, at+8+len);
      if (type === 'IHDR') { width = dv(data,0); height = dv(data,4); }
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      at += 12 + len;
    }
    const p = new Uint8Array(0); void p;
    const z = idat.reduce((acc, cur) => { const out = new Uint8Array(acc.length + cur.length); out.set(acc); out.set(cur, acc.length); return out; }, new Uint8Array(0));
    let q = 2; const raw = [];
    for (;;) {
      const final = z[q] & 1; const len = z[q+1] | (z[q+2] << 8);
      raw.push(z.slice(q+5, q+5+len)); q += 5 + len;
      if (final) break;
    }
    const merged = raw.reduce((acc, cur) => { const out = new Uint8Array(acc.length + cur.length); out.set(acc); out.set(cur, acc.length); return out; }, new Uint8Array(0));
    const stride = 1 + width * 3;
    const pixel = (x, y) => { const off = y * stride + 1 + x * 3; return [merged[off], merged[off+1], merged[off+2]]; };
    const half = width / 2;
    return [pixel(50,50), pixel(width-50,50), pixel(50,height-50), pixel(width-50,height-50)].map(colorName).join(',');
  }
  window.__img.decodeProbe = decodeProbe;

  const isProbe = (body) => !!body && Array.isArray(body.messages) && body.messages.length === 1
    && !body.tools && body.max_tokens === 64
    && Array.isArray(body.messages[0].content)
    && body.messages[0].content.some(p => p.type === 'image' || p.type === 'image_url');

  if (!window.__imgWrapped) {
    window.__imgWrapped = true;
    const base = Model.transport;
    Model.transport = async (url, init) => {
      const body = JSON.parse(init.body || '{}');
      window.__img.calls.push({ url, body });
      if (isProbe(body)) {
        window.__img.probePrompts.push(body.messages[0].content[0].text);
        // The transport sees the ADAPTER-SERIALIZED body: the image rides
        // as an image_url data URL (OpenAI wire), not a semantic part.
        const part = body.messages[0].content.find(p => p.type === 'image' || p.type === 'image_url');
        // Both wire shapes carry the pixels: OpenAI = data URL, Anthropic =
        // base64 source block (semantic dataBase64 never survives the wire).
        const b64 = part.type === 'image_url'
          ? String(part.image_url && part.image_url.url || '').split('base64,')[1]
          : (part.source && part.source.data) || part.dataBase64;
        const answer = window.__img.probeAnswer === 'wrong'
          ? 'red,red,red,red'
          : decodeProbe(b64);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const next = window.__locusWire.responses.length ? window.__locusWire.responses.shift()
        : { choices: [{ message: { role: 'assistant', content: 'wire default answer' }, finish_reason: 'stop' }] };
      if (next && next.__status) {
        return new Response(JSON.stringify(next.json), { status: next.__status, headers: { 'content-type': 'application/json' } });
      }
      void base;
      return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  }

  window.__img.configure = async (model, dialect) => {
    const s = L.store.settings;
    s.apiBase = ${JSON.stringify(BASE)};
    s.dialect = dialect || 'openai'; s.model = model; s.apiKey = 'KEY_IMG'; s.remember = false;
    L.actions.applySettings();
    await L.actions.persistSettingsIfNeeded();
  };
  window.__img.upload = (name) => {
    const bytes = Uint8Array.from(atob(window.__img.pngB64), c => c.charCodeAt(0));
    L.actions.addUploadFiles([new File([bytes], name, { type: 'image/png' })]);
  };
  window.__img.clickApproval = (label) => {
    const btn = Array.from(document.querySelectorAll('.approval-btn')).find(b => b.textContent.trim() === label);
    if (!btn) return false;
    btn.click();
    return true;
  };
  window.__img.cardText = () => {
    const card = document.querySelector('.approval-card');
    return card ? card.textContent : null;
  };
  window.__img.escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  window.__img.idbAll = (storeName) => new Promise((resolve, reject) => {
    const req = indexedDB.open('locus');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(storeName, 'readonly');
        const r = tx.objectStore(storeName).getAll();
        r.onsuccess = () => resolve(JSON.stringify(r.result));
        r.onerror = () => reject(r.error);
      } catch (e) { resolve('[]'); }
    };
  });
  window.__img.reset = async () => {
    await L.actions.resetAllData();
    window.__img.calls.length = 0;
    window.__img.probePrompts.length = 0;
    window.__locusWire.responses.length = 0;
  };
  return 'installed';
})()
`;

async function evaluate(cdp, expression) {
  if (process.env.IMG_DEBUG) console.log('>> ' + expression.slice(0, 90).replace(/\s+/g, ' '));
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
  const boot = async (url) => {
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, url, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitCond('!!(window.__locus && document.querySelector(".app-shell") && window.__locusWire)', 'image-app-boot', 15000);
    await evaluate(cdp, PAGE_HELPERS);
  };
  // waitCond: waits for a runtime condition; on timeout dumps page state so
  // the failing phase is diagnosable from the log alone.
  const waitCond = async (expression, phase, timeoutMs) => {
    try {
      await waitForRuntimeCondition(cdp, expression, { process: chrome, phase, timeoutMs });
    } catch (e) {
      let dump = 'unavailable';
      try {
        dump = await evaluate(cdp, `JSON.stringify({
          busy: window.__locus.store.busy,
          task: !!window.__locus.session.task,
          approval: !!window.__locus.store.pendingApproval,
          convs: window.__locus.store.conversations.map(c => ({ t: c.title, s: c.status, items: c.items.map(i => i.kind + ':' + String(i.content || '').slice(0, 30)) })),
          calls: window.__img ? window.__img.calls.length : null,
          lastBody: window.__img && window.__img.calls.length ? JSON.stringify(window.__img.calls[window.__img.calls.length - 1].body).slice(0, 160) : null,
          errs: window.__e2eErrors,
          notice: window.__locus.store.storageNotice,
        })`);
      } catch (ignored) {}
      throw new Error('condition timeout at ' + phase + ' | state=' + dump + ' | ' + e.message);
    }
  };

  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-image-profile-'));
    chrome = await launchChrome(WIRE_URL, {
      chromePath: process.env.CHROME,
      label: 'image wire Chrome',
      profileDir,
      preserveProfile: true, // CASE F restarts from this profile
      extraArgs: ['--window-size=1440,900'],
    });
    await boot(WIRE_URL);

    // ============ CASE A: known supported (preseeded user decision) ============
    await evaluate(cdp, `window.__img.reset()`);
    await evaluate(cdp, `(async () => {
      await window.__img.configure('vision-model-a');
      const id = createProviderIdentity({ provider: 'openai', adapterId: 'openai-compatible', dialect: 'openai', apiBase: ${JSON.stringify(BASE)}, model: 'vision-model-a' });
      await window.__locus.capabilities.registry().setUserDecision(id, 'supported');
      await window.__locus.capabilities.status();
    })()`);
    await evaluate(cdp, `window.__img.upload('photo.png')`);
    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: 'I can see the red dot.' }, finish_reason: 'stop' }],
    })}); window.__img.calls.length = 0; window.__locus.actions.submit('look at this photo')`);
    await waitCond(`(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'look at this photo');
      return !!c && c.status === 'completed';
    })()`, 'case-a-complete', 15000);
    const callsA = await evaluate(cdp, `window.__img.calls`);
    check('I-E1 supported: exactly one provider request', callsA.length === 1, String(callsA.length));
    check('I-E2 request reaches the OpenAI-compatible endpoint with Bearer auth',
      callsA[0].url === BASE + '/chat/completions', callsA[0].url);
    const userMsg = callsA[0].body.messages.find((m) => m.role === 'user');
    check('I-E3 ONE user turn: text + image_url data URL with the EXACT sentinel bytes',
      callsA[0].body.messages.filter((m) => m.role === 'user').length === 1
        && Array.isArray(userMsg.content) && userMsg.content[0].type === 'text'
        && userMsg.content[1].type === 'image_url'
        && userMsg.content[1].image_url.url === 'data:image/png;base64,' + SENTINEL_PNG_B64,
      JSON.stringify(userMsg).slice(0, 200));
    check('I-E4 tool availability is unchanged by image capability',
      Array.isArray(callsA[0].body.tools) && callsA[0].body.tools.length > 0);
    check('I-E5 no approval card for a known-capable model',
      (await evaluate(cdp, `!document.querySelector('.approval-card')`)) === true);
    const convA = await evaluate(cdp, `(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'look at this photo');
      return { users: c.items.filter(i => i.kind === 'user'), chip: c.items.find(i => i.kind === 'user')?.imageCount, assistant: c.items.some(i => i.kind === 'assistant') };
    })()`);
    check('I-E6 exactly one user presentation item with an image chip, model answer shown',
      convA.users.length === 1 && convA.chip === 1 && convA.assistant === true, JSON.stringify(convA));
    const leakA = await evaluate(cdp, `(async () => {
      const frames = await window.__img.idbAll('providerFrames');
      const normalized = await window.__img.idbAll('normalizedMessages');
      const events = await window.__img.idbAll('presentationEvents');
      const conv = JSON.stringify(window.__locus.store.conversations);
      return [frames, normalized, events, conv].some(s => s.includes(${JSON.stringify(SENTINEL_PNG_B64)}));
    })()`);
    check('I-E7 the sentinel base64 never leaks into frames/normalized/events/timeline', leakA === false);
    const durableA = await evaluate(cdp, `(async () => {
      const store = window.__locus.attachments.store();
      const metas = await window.PersistenceServiceInstance.allAttachmentMetas();
      if (metas.length !== 1) return 'metas=' + metas.length;
      const bytes = await store.getBytes(metas[0].id);
      const expected = Uint8Array.from(atob(window.__img.pngB64), c => c.charCodeAt(0));
      return bytes.length === expected.length && bytes.every((b, i) => b === expected[i]) ? 'exact' : 'bytes-mismatch';
    })()`);
    check('I-E8 the durable snapshot holds the exact uploaded bytes', durableA === 'exact', String(durableA));
    check('I-E9 no unhandled page errors so far',
      (await evaluate(cdp, '(window.__e2eErrors || []).length')) === 0);

    // ============ CASE C: unknown → Yes (real ApprovalCard) ============
    await evaluate(cdp, `window.__img.reset()`);
    await evaluate(cdp, `window.__img.configure('mystery-model-c')`);
    await evaluate(cdp, `window.__img.upload('shot-c.png')`);
    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: 'yes flow done' }, finish_reason: 'stop' }],
    })}); window.__locus.actions.submit('case c'); 'submitted'`);
    await waitCond(`!!document.querySelector('.approval-card')`, 'case-c-card', 15000);
    const cardC = await evaluate(cdp, `window.__img.cardText()`);
    check('I-E10 unknown model suspends the task on the Image capability card',
      /Image capability/.test(cardC) && /image-capable model/.test(cardC)
        && !/Allow once/.test(cardC) && !/Allow for this session/.test(cardC), String(cardC).slice(0, 200));
    await evaluate(cdp, `window.__img.clickApproval('Yes')`);
    await waitCond(`(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'case c');
      return !!c && c.status === 'completed';
    })()`, 'case-c-complete', 15000);
    const callsC = await evaluate(cdp, `window.__img.calls`);
    check('I-E11 Yes → exactly one image provider request, same task resumed once',
      callsC.length === 1 && JSON.stringify(callsC[0].body).includes(SENTINEL_PNG_B64)
        && callsC[0].body.messages.filter((m) => m.role === 'user').length === 1);
    const statusC = await evaluate(cdp, `window.__locus.capabilities.status()`);
    check('I-E12 the Yes decision persisted (supported, source user)',
      statusC && statusC.state === 'supported' && statusC.source === 'user', JSON.stringify(statusC));
    // Same conversation, next image turn: no re-ask.
    await evaluate(cdp, `window.__img.upload('shot-c2.png')`);
    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: 'second image turn' }, finish_reason: 'stop' }],
    })}); window.__img.calls.length = 0; window.__locus.actions.submit('case c follow-up')`);
    await waitCond(`window.__locus.store.conversations.some(c => c.items.some(i => i.kind === 'assistant' && i.content === 'second image turn'))`, 'case-c-followup', 15000);
    const callsC2 = await evaluate(cdp, `({ n: window.__img.calls.length, card: !!document.querySelector('.approval-card') })`);
    check('I-E13 the next image turn no longer asks', callsC2.n === 1 && callsC2.card === false, JSON.stringify(callsC2));

    // ============ CASE D: unknown → No ============
    await evaluate(cdp, `window.__img.reset()`);
    await evaluate(cdp, `window.__img.configure('mystery-model-d')`);
    await evaluate(cdp, `window.__img.upload('shot-d.png')`);
    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: 'no flow done' }, finish_reason: 'stop' }],
    })}); window.__locus.actions.submit('case d'); 'submitted'`);
    await waitCond(`!!document.querySelector('.approval-card')`, 'case-d-card', 15000);
    await evaluate(cdp, `window.__img.clickApproval('No')`);
    await waitCond(`(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'case d');
      return !!c && c.status === 'completed';
    })()`, 'case-d-complete', 15000);
    const callsD = await evaluate(cdp, `window.__img.calls`);
    const userD = callsD[0].body.messages.find((m) => m.role === 'user');
    check('I-E14 No → text reaches the model, image does not, deterministic notice present',
      callsD.length === 1 && !JSON.stringify(callsD[0].body).includes(SENTINEL_PNG_B64)
        && Array.isArray(userD.content)
        && userD.content.some((p) => p.type === 'text' && p.text.includes('case d'))
        && JSON.stringify(userD.content).includes('not supporting image input'),
      JSON.stringify(userD).slice(0, 260));
    const statusD = await evaluate(cdp, `window.__locus.capabilities.status()`);
    check('I-E15 the No decision persisted (unsupported, source user)',
      statusD && statusD.state === 'unsupported' && statusD.source === 'user', JSON.stringify(statusD));
    check('I-E16 the upload itself is NOT deleted (pixels just never cross the boundary)',
      (await evaluate(cdp, `window.__locus.vfs.exists('/mnt/upload/shot-d.png')`)) === true);
    await evaluate(cdp, `window.__img.upload('shot-d2.png')`);
    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: 'done d2' }, finish_reason: 'stop' }],
    })}); window.__img.calls.length = 0; window.__locus.actions.submit('case d follow-up')`);
    await waitCond(`window.__locus.store.conversations.some(c => c.items.some(i => i.kind === 'assistant' && i.content === 'done d2'))`, 'case-d-followup', 15000);
    const followupD = await evaluate(cdp, `({ n: window.__img.calls.length, card: !!document.querySelector('.approval-card') })`);
    check('I-E17 the next image turn no longer asks (unsupported persisted)',
      followupD.n === 1 && followupD.card === false, JSON.stringify(followupD));

    // ============ CASE E: unknown → I don't know → probe reads pixels ============
    await evaluate(cdp, `window.__img.reset()`);
    await evaluate(cdp, `window.__img.configure('mystery-model-e')`);
    await evaluate(cdp, `window.__img.upload('shot-e.png')`);
    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: 'probe flow done' }, finish_reason: 'stop' }],
    })}); window.__locus.actions.submit('case e'); 'submitted'`);
    await waitCond(`!!document.querySelector('.approval-card')`, 'case-e-card', 15000);
    await evaluate(cdp, `window.__img.clickApproval("I don't know")`);
    await waitCond(`(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'case e');
      return !!c && c.status === 'completed';
    })()`, 'case-e-complete', 20000);
    const callsE = await evaluate(cdp, `window.__img.calls`);
    check('I-E18 unsure → exactly one probe request, then exactly one image request',
      callsE.length === 2 && callsE[0].body.max_tokens === 64 && !callsE[0].body.tools
        && JSON.stringify(callsE[0].body).includes('image')
        && callsE[1].body.max_tokens === 2000
        && JSON.stringify(callsE[1].body).includes(SENTINEL_PNG_B64),
      'calls=' + callsE.length + ' shapes=' + JSON.stringify(callsE.map((c) => ({
        mt: c.body.max_tokens, tools: !!c.body.tools,
        hasSentinel: JSON.stringify(c.body).includes(SENTINEL_PNG_B64),
        users: (c.body.messages || []).filter((m) => m.role === 'user').length,
      }))))
    const statusE = await evaluate(cdp, `window.__locus.capabilities.status()`);
    check('I-E19 the probe result persisted (supported, source probe)',
      statusE && statusE.state === 'supported' && statusE.source === 'probe', JSON.stringify(statusE));
    const framesE = await evaluate(cdp, `(async () => {
      const frames = JSON.stringify(await window.__img.idbAll('providerFrames'));
      const normalized = JSON.stringify(await window.__img.idbAll('normalizedMessages'));
      const events = JSON.stringify(await window.__img.idbAll('presentationEvents'));
      const probeText = 'four solid-color quadrants';
      return [frames, normalized, events].some(s => s.includes(probeText));
    })()`);
    check('I-E20 the probe prompt/answer never enters conversation state', framesE === false, String(framesE));
    check('I-E21 the probe answer lives only in pixels (prompt carries no colors)',
      (await evaluate(cdp, `window.__img.probePrompts.every(p => !/red|blue|yellow|black/i.test(p))`)) === true);

    // ============ CASE E2: probe inconclusive (wrong answer) ============
    await evaluate(cdp, `window.__img.reset()`);
    await evaluate(cdp, `window.__img.configure('mystery-model-e2')`);
    await evaluate(cdp, `window.__img.probeAnswer = 'wrong'`);
    await evaluate(cdp, `window.__img.upload('shot-e2.png')`);
    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      choices: [{ message: { role: 'assistant', content: 'recovered without image' }, finish_reason: 'stop' }],
    })}); window.__locus.actions.submit('case e2'); 'submitted'`);
    await waitCond(`!!document.querySelector('.approval-card')`, 'case-e2-card', 15000);
    await evaluate(cdp, `window.__img.clickApproval("I don't know")`);
    await waitCond(`(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'case e2');
      return !!c && c.status === 'completed';
    })()`, 'case-e2-complete', 20000);
    const callsE2 = await evaluate(cdp, `window.__img.calls`);
    const realE2 = callsE2[callsE2.length - 1];
    check('I-E22 inconclusive probe: image not sent, task recovers, no loop (one probe only)',
      callsE2.length === 2 && callsE2.filter((c) => c.body.max_tokens === 64).length === 1
        && !JSON.stringify(realE2.body).includes(SENTINEL_PNG_B64)
        && JSON.stringify(realE2.body).includes('could not be verified'),
      'calls=' + callsE2.length);
    const statusE2 = await evaluate(cdp, `window.__locus.capabilities.status()`);
    check('I-E23 the registry stays unknown with the failure reason recorded',
      statusE2 && statusE2.state === 'unknown' && !!statusE2.lastProbeAt, JSON.stringify(statusE2));

    // ============ provider rejection correction (spec 66) ============
    await evaluate(cdp, `window.__img.reset()`);
    await evaluate(cdp, `(async () => {
      await window.__img.configure('vision-model-f');
      const id = createProviderIdentity({ provider: 'openai', adapterId: 'openai-compatible', dialect: 'openai', apiBase: ${JSON.stringify(BASE)}, model: 'vision-model-f' });
      await window.__locus.capabilities.registry().setUserDecision(id, 'supported');
    })()`);
    await evaluate(cdp, `window.__img.upload('shot-f.png')`);
    await evaluate(cdp, `window.__locusWire.responses.push(${literal({
      __status: 400,
      json: { error: { message: 'image content is not supported by this model', param: 'content' } },
    })}); window.__img.calls.length = 0; window.__locus.actions.submit('case f'); 'submitted'`);
    await waitCond(`(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'case f');
      return !!c && c.status === 'error';
    })()`, 'case-f-complete', 15000);
    const callsF = await evaluate(cdp, `window.__img.calls`);
    const statusF = await evaluate(cdp, `window.__locus.capabilities.status()`);
    check('I-E24 authoritative image rejection corrects the registry to unsupported',
      callsF.length === 1 && statusF.state === 'unsupported' && statusF.source === 'provider-rejection',
      JSON.stringify({ calls: callsF.length, status: statusF }));
    check('I-E25 NO dangerous image-less resend after the rejection',
      callsF.length === 1 && callsF[0].body.messages.some((m) => m.role === 'user' && JSON.stringify(m).includes(SENTINEL_PNG_B64)));

    // ============ CASE F: real browser restart (same profile) ============
    const convFId = await evaluate(cdp, `window.__locus.store.conversations.find(x => x.title === 'case f').id`);
    await evaluate(cdp, `(async () => {
      await window.__img.reset();
      await window.__img.configure('vision-model-f');
      // resetAllData wiped the registry (control-plane exception: full wipe);
      // reseed the supported decision for this identity.
      const id = createProviderIdentity({ provider: 'openai', adapterId: 'openai-compatible', dialect: 'openai', apiBase: ${JSON.stringify(BASE)}, model: 'vision-model-f' });
      await window.__locus.capabilities.registry().setUserDecision(id, 'supported');
      window.__img.upload('shot-f2.png');
      window.__locusWire.responses.push(${literal({ choices: [{ message: { role: 'assistant', content: 'before restart' }, finish_reason: 'stop' }] })});
      window.__img.calls.length = 0;
      window.__locus.actions.submit('image reload case');
    })()`);
    await waitCond(`(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'image reload case');
      return !!c && c.status === 'completed';
    })()`, 'case-g-seed', 15000);
    const attachmentBefore = await evaluate(cdp, `(async () => {
      const metas = await window.PersistenceServiceInstance.allAttachmentMetas();
      return metas.length;
    })()`);
    const uploadExisted = await evaluate(cdp, `window.__locus.vfs.exists('/mnt/upload/shot-f2.png')`);
    cdp.close();
    const cleanup = await closeChrome(chrome, { gracefulTimeoutMs: 1200 });
    check('I-E26 browser closes cleanly before restart', cleanup.exited === true);
    chrome = null;
    // True restart: same profile, fresh process. /mnt/upload (memory) dies;
    // OPFS/IndexedDB attachments + the capability registry survive.
    chrome = await launchChrome(WIRE_URL, {
      chromePath: process.env.CHROME,
      label: 'image wire Chrome (restarted)',
      profileDir,
      extraArgs: ['--window-size=1440,900'],
    });
    await boot(WIRE_URL);
    await waitCond(`(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'image reload case');
      return !!c && c.items.some(i => i.kind === 'assistant' && i.content === 'before restart');
    })()`, 'case-g-restored', 20000);
    check('I-E27 the conversation timeline is restored after restart', true);
    check('I-E28 /mnt/upload is gone (ephemeral) but durable attachments remain',
      uploadExisted === true
        && (await evaluate(cdp, `window.__locus.vfs.exists('/mnt/upload/shot-f2.png')`)) === false
        && (await evaluate(cdp, `window.PersistenceServiceInstance.allAttachmentMetas().then(m => m.length)`)) === attachmentBefore,
      'before=' + attachmentBefore);
    check('I-E29 the capability decision survives the restart (no re-ask)',
      (await evaluate(cdp, `window.__locus.capabilities.status().then(s => s.state + ':' + s.source)`)) === 'supported:user');
    // Continue the SAME conversation: the restored history contains the old
    // image part — materialization must come from durable bytes, /mnt/upload
    // being long gone.
    await evaluate(cdp, `(async () => {
      const c = window.__locus.store.conversations.find(x => x.title === 'image reload case');
      window.__locus.actions.openConversation(c.id);
      window.__img.calls.length = 0;
      window.__locusWire.responses.push(${literal({ choices: [{ message: { role: 'assistant', content: 'continuation after restart' }, finish_reason: 'stop' }] })});
      await window.__locus.actions.submit('continue after restart'); 'submitted';
    })()`);
    await waitCond(`(() => {
      const c = window.__locus.store.conversations.find(x => x.title === 'image reload case');
      return !!c && c.items.some(i => i.kind === 'assistant' && i.content === 'continuation after restart');
    })()`, 'case-g-continue', 20000);
    const callsG = await evaluate(cdp, `window.__img.calls`);
    check('I-E30 restored image-rich history continues same-provider with the image re-materialized',
      callsG.length === 1 && callsG[0].body.messages.some((m) => m.role === 'user' && JSON.stringify(m).includes(SENTINEL_PNG_B64)),
      JSON.stringify(callsG.map((c) => c.url)));

    // ============ viewport matrix + Escape/Cancel semantics ============
    const VIEWPORTS = [
      { name: '360x800', width: 360, height: 800, mobile: true },
      { name: '390x844', width: 390, height: 844, mobile: true },
      { name: '412x915', width: 412, height: 915, mobile: true },
      { name: '768x1024', width: 768, height: 1024, mobile: false },
      { name: '1440x900', width: 1440, height: 900, mobile: false },
    ];
    await cdp.send('Page.enable');
    for (const vp of VIEWPORTS) {
      console.log('=== image viewport ' + vp.name + ' ===');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile,
      });
      await cdp.send('Page.navigate', { url: WIRE_URL });
      await waitForPageTarget(chrome, WIRE_URL, { timeoutMs: 15000 });
      await waitCond('!!(window.__locus && document.querySelector(".app-shell") && window.__locusWire)', 'image-vp-boot:' + vp.name, 15000);
      await evaluate(cdp, PAGE_HELPERS);
      await evaluate(cdp, `window.__img.reset()`);
      await evaluate(cdp, `window.__img.configure('vp-model-${vp.width}x${vp.height}')`);
      await evaluate(cdp, `window.__img.upload('vp.png')`);
      await evaluate(cdp, `window.__locusWire.responses.push(${literal({
        choices: [{ message: { role: 'assistant', content: 'vp fallback' }, finish_reason: 'stop' }],
      })}); window.__locus.actions.submit('vp probe'); 'submitted'`);
      await waitCond(`!!document.querySelector('.approval-card')`, 'image-vp-card:' + vp.name, 15000);
      const vpCard = await evaluate(cdp, `(() => {
        const card = document.querySelector('.approval-card');
        const cancel = document.querySelector('.composer .cancel-btn');
        const cr = card.getBoundingClientRect();
        const buttons = Array.from(document.querySelectorAll('.approval-btn')).map((b) => {
          const r = b.getBoundingClientRect();
          return { label: b.textContent.trim(), visible: r.width > 0 && r.height > 0 };
        });
        return { title: /Image capability/.test(card.textContent), buttons,
          bounded: cr.height <= window.innerHeight * 1.2,
          cancelVisible: !!cancel && cancel.getBoundingClientRect().width > 0 };
      })()`);
      check('I-VP[' + vp.name + '] capability card renders bounded with all three choices',
        vpCard.title && vpCard.bounded && vpCard.cancelVisible
          && vpCard.buttons.map((b) => b.label).join('|') === 'No|Yes|I don\'t know'
          && vpCard.buttons.every((b) => b.visible), JSON.stringify(vpCard));
      // Escape = decision cancelled, NOT a permanent "No".
      await evaluate(cdp, `window.__img.escape()`);
      await waitCond(`(() => {
        const c = window.__locus.store.conversations.find(x => x.title === 'vp probe');
        return !!c && c.status === 'completed';
      })()`, 'image-vp-escape:' + vp.name, 15000);
      const vpEscapeStatus = await evaluate(cdp, `window.__locus.capabilities.status()`);
      const vpEscape = await evaluate(cdp, `({ card: !!document.querySelector('.approval-card'),
        imageSent: JSON.stringify(window.__img.calls[window.__img.calls.length - 1].body).includes(${JSON.stringify(SENTINEL_PNG_B64)}) })`);
      vpEscape.status = vpEscapeStatus;
      check('I-VP[' + vp.name + '] Escape cancels the decision (registry untouched, image unsent, task continues)',
        vpEscape.card === false && vpEscape.status.state === 'unknown'
          && vpEscape.imageSent === false, JSON.stringify(vpEscape));

      // Cancel task via the composer while a capability card is pending.
      await evaluate(cdp, `window.__img.upload('vp2.png')`);
      await evaluate(cdp, `window.__locus.actions.submit('vp cancel'); 'submitted'`);
      await waitCond(`!!document.querySelector('.approval-card')`, 'image-vp-cancel-card:' + vp.name, 15000);
      await evaluate(cdp, `(() => {
        const cancel = Array.from(document.querySelectorAll('button')).find(b => b.classList.contains('cancel-btn'));
        if (cancel) cancel.click();
        return !!cancel;
      })()`);
      await waitCond(`window.__locus.store.conversations.some(c => c.status === 'cancelled')`, 'image-vp-cancel:' + vp.name, 15000);
      const callsBeforeCancel = await evaluate(cdp, `window.__img.calls.length`);
      const vpCancelStatus = await evaluate(cdp, `window.__locus.capabilities.status()`);
      const vpCancel = await evaluate(cdp, `({ card: !!document.querySelector('.approval-card'), calls: window.__img.calls.length })`);
      vpCancel.status = vpCancelStatus;
      check('I-VP[' + vp.name + '] Cancel task closes the card, sends nothing, writes no capability',
        vpCancel.card === false && vpCancel.status.state === 'unknown' && vpCancel.calls === callsBeforeCancel,
        JSON.stringify(vpCancel));
    }

    check('I-E31 browser reported no unhandled errors', (await evaluate(cdp, '(window.__e2eErrors || []).length')) === 0);
    console.log('---');
    console.log('e2e-image: ' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('IMAGE E2E FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) await closeChrome(chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
