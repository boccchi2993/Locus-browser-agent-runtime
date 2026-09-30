// Harness independence gates (M2b, H1–H6/H9 + assembly errors):
// the PUBLIC harness entry runs complete tasks with a fake model and a
// fake ToolPort — no window, no document, no Runtime, no Vue, no Product
// storage. Run: node tests/harness-standalone.test.mjs

import {
  ensureHarnessCore, createAgentSession, createModelClient, getProviderAdapter,
  historyBudgetBytes,
} from '../src/harness/index.js';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const evTypes = (events) => events.map((e) => e.type).join(',');

function fakeEnvelope(text, extra) {
  return Object.assign({
    content: text,
    reasoning: null,
    stopReason: 'end_turn',
    usage: null,
    rawMessage: { role: 'assistant', content: text },
    truncated: false,
  }, extra || {});
}

function lookupPort(name, log) {
  return {
    definitions: () => [{
      name: name,
      description: 'Look things up (' + name + ').',
      inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
    }],
    async execute(call) {
      if (log) log.push([call.name, call.input, !!call.context]);
      return { output: 'OUT(' + call.input + ')', success: true, backend: 'fake' };
    },
  };
}

function finalOnly() {
  return async () => fakeEnvelope('done');
}

// ============================================================
async function main() {
  // ---------- H1. loads and executes with NO window/document/Runtime ----------
  check('H1 no window global in this process', typeof globalThis.window === 'undefined');
  check('H1 no document global in this process', typeof globalThis.document === 'undefined');
  check('H1 no runtime registry booted by the import', globalThis.__LOCUS_RUNTIME_CORE__ === undefined);
  const table = await ensureHarnessCore();
  check('H1 the declared table resolves with contractVersion 1', table && table.contractVersion === 1,
    JSON.stringify(table && table.contractVersion));
  {
    const events = [];
    const execs = [];
    const session = createAgentSession({
      modelClient: finalOnly(),
      toolPort: lookupPort('lookup', execs),
      emit: (e) => events.push(e),
    });
    await session.run('hello harness', {});
    check('H1 full task runs on the entry (event chain)',
      evTypes(events) === 'task_start,assistant_text,task_end', evTypes(events));
    check('H1 task_end completed', events[events.length - 1].reason === 'completed');
  }

  // ---------- H2. a single lookup tool: prompt/tools/validator agree ----------
  {
    const events = [];
    const execs = [];
    const bodies = [];
    const session = createAgentSession({
      modelClient: async (body) => {
        bodies.push(body);
        return fakeEnvelope('plain answer');
      },
      toolPort: lookupPort('lookup', execs),
      emit: (e) => events.push(e),
    });
    await session.run('q', {});
    const system = bodies[0].system;
    check('H2 prompt names the tool', system.includes('- lookup: Look things up (lookup).'), system.slice(0, 200));
    check('H2 prompt claims NO bash', !system.includes('bash'));
    check('H2 prompt claims NO cloud_bash', !system.includes('cloud_bash'));
    check('H2 prompt claims NO python', !/python/i.test(system));
    check('H2 prompt claims NO curl', !/curl/i.test(system));
    check('H2 prompt claims NO /mnt paths', !system.includes('/mnt'));
    check('H2 prompt claims NO shell capability text', !system.includes('Unix-like compatibility shell'));
    check('H2 model tools = exactly the snapshot definition',
      Array.isArray(bodies[0].tools) && bodies[0].tools.length === 1
      && bodies[0].tools[0].name === 'lookup' && bodies[0].tools[0].inputSchema.type === 'object',
      JSON.stringify(bodies[0].tools));
    check('H2 the text-fallback example names the snapshot tool, not bash',
      system.includes('{"tool": "lookup"'), '');

    // Validator: an unknown tool (native) is a failed result with ZERO execution.
    execs.length = 0;
    events.length = 0;
    bodies.length = 0;
    const session2 = createAgentSession({
      modelClient: async () => fakeEnvelope('```json\n{"tool":"bash","input":"ls"}\n```'),
      toolPort: lookupPort('lookup', execs),
      emit: (e) => events.push(e),
    });
    await session2.run('try bash', {});
    check('H2 unknown tool via text fallback: zero execution',
      execs.length === 0, JSON.stringify(execs));
    const tr = events.find((e) => e.type === 'tool_result');
    check('H2 unknown tool → failed result naming the available list',
      !!tr && tr.success === false && tr.output.includes('unknown tool: bash')
      && tr.output.includes('lookup'), JSON.stringify(tr));

    // Validator: an unknown tool (native batch) — same contract.
    execs.length = 0;
    events.length = 0;
    let nativeCalls = 0;
    const session3 = createAgentSession({
      modelClient: async () => {
        nativeCalls++;
        if (nativeCalls === 1) {
          return fakeEnvelope('', {
            toolCalls: [{ id: 'c1', name: 'cloud_bash', input: { input: 'x' } }],
          });
        }
        return fakeEnvelope('corrected');
      },
      toolPort: lookupPort('lookup', execs),
      emit: (e) => events.push(e),
    });
    await session3.run('native unknown', {});
    check('H2 unknown native tool: zero execution + failed result',
      execs.length === 0 && events.some((e) => e.type === 'tool_result' && e.success === false
        && e.output.includes('unknown tool: cloud_bash') && e.output.includes('Available tools: lookup')),
      JSON.stringify(events.filter((e) => e.type === 'tool_result')));
    check('H2 the task continues after the failed result (model can correct)',
      events.some((e) => e.type === 'task_end' && e.reason === 'completed')
      && events.some((e) => e.type === 'assistant_text' && e.content === 'corrected'),
      evTypes(events));
  }

  // ---------- H3. native tool → result → final answer; text fallback rules ----------
  {
    const events = [];
    const execs = [];
    const bodies = [];
    let calls = 0;
    const session = createAgentSession({
      modelClient: async (body) => {
        bodies.push(body);
        calls++;
        if (calls === 1) {
          return fakeEnvelope('', { toolCalls: [{ id: 't1', name: 'lookup', input: { input: 'q1' } }] });
        }
        return fakeEnvelope('final answer ' + calls);
      },
      toolPort: lookupPort('lookup', execs),
      emit: (e) => events.push(e),
    });
    await session.run('native roundtrip', {});
    check('H3 native call executed once with the task filesystem context',
      execs.length === 1 && execs[0][0] === 'lookup' && execs[0][1] === 'q1' && execs[0][2] === true,
      JSON.stringify(execs));
    check('H3 full loop event chain',
      evTypes(events) === 'task_start,tool_call,tool_result,assistant_text,task_end', evTypes(events));
    check('H3 the tool result re-entered the next request (untrusted framing)',
      bodies[1].messages.some((m) => typeof m.content === 'string' && m.content.includes('OUT(q1)')
        && m.content.includes('untrusted data')), JSON.stringify(bodies[1].messages.map((m) => m.role)));
    check('H3 history keeps raw replay + paired tool result',
      session.history.length === 4
      && session.history[1].role === 'assistant'
      && session.history[2].role === 'tool_result' && session.history[2].toolCallId === 't1',
      JSON.stringify(session.history.map((h) => h.role)));

    // Strict text fallback: prose-wrapped fence is plain text, never executed.
    execs.length = 0;
    events.length = 0;
    const session2 = createAgentSession({
      modelClient: async () => fakeEnvelope('看：\n```json\n{"tool":"lookup","input":"x"}\n```\n以上。'),
      toolPort: lookupPort('lookup', execs),
      emit: (e) => events.push(e),
    });
    await session2.run('prose fence', {});
    check('H3 prose-wrapped fence is a plain final answer (strict protocol)',
      execs.length === 0 && events.some((e) => e.type === 'assistant_text'
        && e.content.includes('```json')), evTypes(events));

    // Pure fence executes through the port.
    execs.length = 0;
    events.length = 0;
    let fenceCalls = 0;
    const session3 = createAgentSession({
      modelClient: async () => {
        fenceCalls++;
        return fenceCalls === 1
          ? fakeEnvelope('```json\n{"tool":"lookup","input":"fenced"}\n```')
          : fakeEnvelope('after fence');
      },
      toolPort: lookupPort('lookup', execs),
      emit: (e) => events.push(e),
    });
    await session3.run('pure fence', {});
    check('H3 pure fenced block executes exactly once',
      execs.length === 1 && execs[0][1] === 'fenced', JSON.stringify(execs));

    // A reply carrying BOTH native calls and a fence executes the native calls only.
    execs.length = 0;
    let bothCalls = 0;
    const session4 = createAgentSession({
      modelClient: async () => {
        bothCalls++;
        return bothCalls === 1
          ? fakeEnvelope('```json\n{"tool":"lookup","input":"fence"}\n```', {
              toolCalls: [{ id: 'n1', name: 'lookup', input: { input: 'native' } }],
            })
          : fakeEnvelope('after native');
      },
      toolPort: lookupPort('lookup', execs),
      emit: () => {},
    });
    await session4.run('both', {});
    check('H3 native calls take precedence over the fenced block',
      execs.length === 1 && execs[0][1] === 'native', JSON.stringify(execs));
  }

  // ---------- H4. two sessions: no cross-pollution ----------
  {
    const evA = [], evB = [];
    const framesA = [], framesB = [];
    const bodiesA = [], bodiesB = [];
    const mkSession = (tag, events, bodies) => {
      const s = createAgentSession({
        modelClient: async (body) => {
          bodies.push(body);
          if (tag === 'A') {
            // Park until explicitly released (the test cancels A here).
            return new Promise((resolve) => {
              setTimeout(() => resolve(fakeEnvelope('A answered late')), 5000);
            });
          }
          return fakeEnvelope(tag + ' done');
        },
        toolPort: lookupPort('lookup' + tag.toLowerCase()),
        emit: (e) => events.push(e),
      });
      s.setPersistenceContext({
        onProviderFrame: async (p) => { (tag === 'A' ? framesA : framesB).push(p); return { sequence: 1 }; },
        onNormalizedMessage: async () => ({}),
        onCheckpoint: async () => {},
      });
      return s;
    };
    const A = mkSession('A', evA, bodiesA);
    const B = mkSession('B', evB, bodiesB);
    const pA = A.run('task A', {});
    await new Promise((r) => setTimeout(r, 10));
    await B.run('task B', {});
    A.cancel();
    await pA;
    check('H4 A cancelled, B completed — outcomes independent',
      evA.some((e) => e.type === 'task_end' && e.reason === 'cancelled')
      && evB.some((e) => e.type === 'task_end' && e.reason === 'completed'),
      JSON.stringify({ a: evA.map((e) => e.type), b: evB.map((e) => e.type) }));
    check('H4 histories isolated', A.history.length !== B.history.length
      && B.history[B.history.length - 1].content === 'B done',
      JSON.stringify({ a: A.history.length, b: B.history.length }));
    check('H4 persistence frames never crossed (A parked pre-frame; B recorded its own)',
      framesB.length === 1 && String(framesB[0].raw && framesB[0].raw.content).includes('B done')
      && framesA.every((f) => !String(f.raw && f.raw.content).includes('B done')),
      JSON.stringify({ a: framesA.length, b: framesB.length }));

    // Distinct tool registries: A cannot execute B's tool and vice versa.
    const execsA = [], execsB = [];
    const A2 = createAgentSession({
      modelClient: async () => fakeEnvelope('```json\n{"tool":"lookupb","input":"x"}\n```'),
      toolPort: lookupPort('lookupa', execsA),
      emit: () => {},
    });
    await A2.run('wrong tool', {});
    check('H4 A rejects B\u2019s tool name (registry isolation)',
      execsA.length === 0, JSON.stringify(execsA));
  }

  // ---------- H5. mid-task definitions() mutation cannot rebind the task ----------
  {
    const defs = [{
      name: 'lookup',
      description: 'The ORIGINAL description.',
      inputSchema: { type: 'object' },
    }];
    const bodies = [];
    const session = createAgentSession({
      modelClient: async (body) => {
        bodies.push(body);
        if (bodies.length === 1) {
          // The task's snapshot was taken at run() start; mutate the
          // definitions SOURCE now (mid-task, before the response).
          defs.push({ name: 'extra', description: 'Added mid-task.', inputSchema: { type: 'object' } });
          defs[0].description = 'The MUTATED description.';
          return fakeEnvelope('done');
        }
        return fakeEnvelope('second task done');
      },
      toolPort: { definitions: () => defs, execute: async () => ({ output: 'x', success: true }) },
      emit: () => {},
    });
    await session.run('task one', {});
    check('H5 the running task kept its frozen snapshot (prompt)',
      bodies[0].system.includes('The ORIGINAL description.')
      && !bodies[0].system.includes('MUTATED') && !bodies[0].system.includes('extra'),
      bodies[0].system.slice(0, 120));
    check('H5 the running task kept its frozen snapshot (request.tools)',
      bodies[0].tools.length === 1 && bodies[0].tools[0].name === 'lookup',
      JSON.stringify(bodies[0].tools));
    await session.run('task two', {});
    check('H5 the next task reads fresh definitions',
      bodies[1].tools.length === 2 && bodies[1].system.includes('The MUTATED description.'),
      JSON.stringify(bodies[1].tools && bodies[1].tools.map((t) => t.name)));
  }

  // ---------- H6. description ports: nothing fabricated, never shared ----------
  {
    const longText = '  CAPABILITY DESC A — shell contract for environment A (long).'.repeat(3);
    const shortText = '  CAPABILITY DESC B.';
    const mk = (descriptionText) => createAgentSession({
      modelClient: async () => fakeEnvelope('done'),
      toolPort: lookupPort('lookup'),
      descriptionPort: descriptionText ? { describeCommands: async () => descriptionText } : null,
      emit: () => {},
    });
    const none = mk(null);
    const a = mk(longText);
    const b = mk(shortText);
    await none.run('n', {});
    await a.run('a', {});
    await b.run('b', {});
    const sysNone = (await none.historyRequestBytes(null, null));
    const sysA = await a.historyRequestBytes(null, null);
    const sysB = await b.historyRequestBytes(null, null);
    const promptOf = async (s) => {
      const bodies = [];
      const probe = createAgentSession({
        modelClient: async (body) => { bodies.push(body); return fakeEnvelope('done'); },
        toolPort: lookupPort('lookup'),
        descriptionPort: s === 'none' ? null : { describeCommands: async () => (s === 'a' ? longText : shortText) },
        emit: () => {},
      });
      await probe.run('p', {});
      return bodies[0].system;
    };
    const pNone = await promptOf('none');
    const pA = await promptOf('a');
    const pB = await promptOf('b');
    check('H6 no description port → no runtime capability claims',
      !pNone.includes('CAPABILITY DESC') && !pNone.includes('shell') && !pNone.includes('python'),
      pNone.slice(0, 150));
    check('H6 each session\u2019s prompt carries ONLY its own description',
      pA.includes('CAPABILITY DESC A') && !pA.includes('DESC B')
      && pB.includes('CAPABILITY DESC B') && !pB.includes('DESC A'),
      '');
    check('H6 budget estimates use the session\u2019s own description (no cross-use)',
      sysA > sysB && sysB >= sysNone,
      JSON.stringify({ a: sysA, b: sysB, none: sysNone }));
    check('H6 the budget constant is reachable through the entry',
      historyBudgetBytes() === 768 * 1024);
  }

  // ---------- assembly errors fail before any model request ----------
  {
    const events = [];
    let modelCalls = 0;
    const session = createAgentSession({
      modelClient: async () => { modelCalls++; return fakeEnvelope('should not run'); },
      toolPort: {
        definitions: () => [
          { name: 'dup', description: 'a', inputSchema: {} },
          { name: 'dup', description: 'b', inputSchema: {} },
        ],
        execute: async () => ({ output: 'x', success: true }),
      },
      emit: (e) => events.push(e),
    });
    await session.run('dup registry', {});
    check('ASSEMBLY duplicate names → tool_registry_invalid error, zero model calls',
      modelCalls === 0 && events.some((e) => e.type === 'error' && e.code === 'tool_registry_invalid')
      && events.some((e) => e.type === 'task_end' && e.reason === 'error'),
      JSON.stringify(events.map((e) => e.type + ':' + (e.code || e.reason || ''))));
  }
  {
    const events = [];
    let modelCalls = 0;
    const session = createAgentSession({
      modelClient: async () => { modelCalls++; return fakeEnvelope('nope'); },
      toolPort: {
        definitions: () => [{ description: 'no name here', inputSchema: {} }],
        execute: async () => ({ output: 'x', success: true }),
      },
      emit: (e) => events.push(e),
    });
    await session.run('missing name', {});
    check('ASSEMBLY missing name → assembly error before any model request',
      modelCalls === 0 && events.some((e) => e.type === 'error' && e.code === 'tool_registry_invalid'),
      JSON.stringify(events.map((e) => e.type)));
  }
  {
    const events = [];
    let modelCalls = 0;
    const session = createAgentSession({
      modelClient: async () => { modelCalls++; return fakeEnvelope('nope'); },
      toolPort: {
        definitions: () => 'not an array',
        execute: async () => ({ output: 'x', success: true }),
      },
      emit: (e) => events.push(e),
    });
    await session.run('bad registry', {});
    check('ASSEMBLY non-array definitions → assembly error',
      modelCalls === 0 && events.some((e) => e.type === 'error' && e.code === 'tool_registry_invalid'),
      JSON.stringify(events.map((e) => e.type)));
  }

  // ---------- H9. real ProviderAdapter + fake transport ----------
  {
    const calls = [];
    const transport = async (url, init) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok-openai' }, finish_reason: 'stop' }],
        }),
      };
    };
    const client = createModelClient({
      config: { apiKey: '  sk-key-1  ', apiBase: 'https://gw.example.com', model: 'm1', dialect: 'openai' },
      transport,
    });
    const envelope = await client.call({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'lookup', description: 'd', inputSchema: { type: 'object' } }],
    });
    check('H9 OpenAI endpoint path (base + /chat/completions)',
      calls[0].url === 'https://gw.example.com/chat/completions', calls[0].url);
    check('H9 OpenAI auth header (sanitized key, Bearer)',
      calls[0].headers['Authorization'] === 'Bearer sk-key-1', calls[0].headers.Authorization);
    check('H9 OpenAI tools serialize to function tools',
      calls[0].body.tools[0].function.name === 'lookup'
      && calls[0].body.tools[0].function.parameters.type === 'object',
      JSON.stringify(calls[0].body.tools));
    check('H9 envelope parses (content)', envelope.content === 'ok-openai');

    // Anthropic dialect: x-api-key + anthropic-version, /v1/messages.
    calls.length = 0;
    const anthropic = createModelClient({
      config: { apiKey: 'sk-ant', apiBase: 'https://api.anthropic.example', model: 'm2', dialect: 'anthropic' },
      transport: async (url, init) => {
        calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
        return {
          ok: true, status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ content: [{ type: 'text', text: 'ok-anthropic' }], stop_reason: 'end_turn' }),
        };
      },
    });
    await anthropic.call({ system: 's', messages: [{ role: 'user', content: 'hi' }], max_tokens: 99 });
    check('H9 Anthropic endpoint + headers',
      calls[0].url === 'https://api.anthropic.example/v1/messages'
      && calls[0].headers['x-api-key'] === 'sk-ant'
      && calls[0].headers['anthropic-version'] === '2023-06-01',
      JSON.stringify(calls[0].headers));
    check('H9 Anthropic body keeps max_tokens',
      calls[0].body.max_tokens === 99, JSON.stringify(calls[0].body.max_tokens));

    // Replay round trip through the REAL adapter.
    const adapter = getProviderAdapter({ dialect: 'anthropic', apiBase: 'https://x' });
    const parsed = adapter.parseResponse({
      content: [
        { type: 'text', text: 'working' },
        { type: 'tool_use', id: 'tu1', name: 'lookup', input: { input: 'x' } },
      ],
      stop_reason: 'tool_use',
    });
    const history = [parsed.rawMessage, {
      role: 'tool_result', toolCallId: 'tu1', toolName: 'lookup', content: 'result', success: true,
    }];
    const wire = adapter.prepareHistory(history);
    check('H9 replay: raw blocks preserved + neutral result → tool_result block',
      Array.isArray(wire[0].content) && wire[0].content[1].type === 'tool_use'
      && wire[1].role === 'user' && wire[1].content[0].type === 'tool_result'
      && wire[1].content[0].tool_use_id === 'tu1',
      JSON.stringify(wire[1]));

    // Explicit tools rejection → exactly ONE downgrade re-request.
    calls.length = 0;
    const downgrade = createModelClient({
      config: { apiKey: 'k', apiBase: 'https://gw2.example.com', model: 'm', dialect: 'openai' },
      transport: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        if (calls.length === 1) {
          return {
            ok: false, status: 400,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ error: { message: 'tools are not supported by this model', type: 'invalid_request_error', param: 'tools' } }),
          };
        }
        return {
          ok: true, status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'no-tools ok' }, finish_reason: 'stop' }] }),
        };
      },
    });
    const dEnv = await downgrade.call({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'lookup', description: 'd', inputSchema: {} }],
    });
    check('H9 explicit tools rejection downgrades ONCE (second request without tools)',
      calls.length === 2 && !calls[1].body.tools && dEnv.content === 'no-tools ok',
      JSON.stringify(calls.map((c) => c.url + ':' + String(!!c.body.tools))));

    // Ambiguous failure (500) NEVER re-sends.
    calls.length = 0;
    const strict = createModelClient({
      config: { apiKey: 'k', apiBase: 'https://gw3.example.com', model: 'm', dialect: 'openai' },
      transport: async (url) => {
        calls.push(String(url));
        return {
          ok: false, status: 500,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ error: { message: 'boom' } }),
        };
      },
    });
    let threw = null;
    try {
      await strict.call({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'lookup', description: 'd', inputSchema: {} }] });
    } catch (e) { threw = e; }
    check('H9 5xx never re-sends (one call, HttpError thrown)',
      calls.length === 1 && threw && threw.name === 'HttpError' && threw.status === 500,
      JSON.stringify({ calls: calls.length, err: threw && threw.name }));

    // 401 authoritative: stop immediately, no endpoint fallback.
    calls.length = 0;
    const auth = createModelClient({
      config: { apiKey: 'k', apiBase: 'https://gw4.example.com', model: 'm', dialect: 'openai' },
      transport: async (url) => {
        calls.push(String(url));
        return {
          ok: false, status: 401,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ error: { message: 'bad key' } }),
        };
      },
    });
    threw = null;
    try { await auth.call({ messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { threw = e; }
    check('H9 401 is authoritative (one call, HttpError)',
      calls.length === 1 && threw && threw.status === 401, JSON.stringify({ calls: calls.length }));

    // 404 falls back to the second OpenAI endpoint layout, once.
    calls.length = 0;
    const fbf = createModelClient({
      config: { apiKey: 'k', apiBase: 'https://gw5.example.com', model: 'm', dialect: 'openai' },
      transport: async (url) => {
        calls.push(String(url));
        if (calls.length === 1) {
          return {
            ok: false, status: 404,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ error: { message: 'not found' } }),
          };
        }
        return {
          ok: true, status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'v1 ok' }, finish_reason: 'stop' }] }),
        };
      },
    });
    const fEnv = await fbf.call({ messages: [{ role: 'user', content: 'hi' }] });
    check('H9 404 falls back to /v1/chat/completions once',
      calls.length === 2 && calls[1] === 'https://gw5.example.com/v1/chat/completions'
      && fEnv.content === 'v1 ok', JSON.stringify(calls));

    // Config isolation: two clients, one shared mutable config object.
    const sharedConfig = { apiKey: 'key-A', apiBase: 'https://a.example.com', model: 'ma', dialect: 'openai' };
    const urlsA = [], urlsB = [];
    const ca = createModelClient({
      config: sharedConfig,
      transport: async (u) => { urlsA.push(String(u)); return { ok: false, status: 500, headers: { get: () => null }, text: async () => '{}' }; },
    });
    const cb = createModelClient({
      config: sharedConfig,
      transport: async (u) => { urlsB.push(String(u)); return { ok: false, status: 500, headers: { get: () => null }, text: async () => '{}' }; },
    });
    sharedConfig.apiBase = 'https://MUTATED.example.com';
    sharedConfig.apiKey = 'key-MUTATED';
    await Promise.all([ca.call({ messages: [{ role: 'user', content: 'x' }] }).catch(() => {}), cb.call({ messages: [{ role: 'user', content: 'x' }] }).catch(() => {})]);
    check('H9 captured configs survive source mutation; clients never share state',
      urlsA[0] === 'https://a.example.com/chat/completions'
      && urlsB[0] === 'https://a.example.com/chat/completions'
      && urlsA.length === 1 && urlsB.length === 1,
      JSON.stringify({ a: urlsA, b: urlsB }));
  }

  // ---------- F1 (review round): the snapshot is a DEEP, independent copy ----------
  {
    const schemaSource = {
      type: 'object',
      properties: { input: { type: 'string', description: 'the query' } },
      required: ['input'],
    };
    const defs = [{
      name: 'lookup',
      description: 'Look things up (lookup).',
      inputSchema: schemaSource,
    }];
    const bodies = [];
    let release = null;
    const gate = new Promise((r) => { release = r; });
    let parkedOnce = false;
    const session = createAgentSession({
      modelClient: async (body) => {
        bodies.push(body);
        if (!parkedOnce) {
          // Barrier: the snapshot AND the first request were built, the
          // model has not answered. Mutate the SHARED nested schema now.
          parkedOnce = true;
          await gate;
          schemaSource.properties.input.type = 'number';
          schemaSource.required.length = 0;
          schemaSource.properties.added = { type: 'string' };
          return fakeEnvelope('', { toolCalls: [{ id: 't1', name: 'lookup', input: { input: 'q1' } }] });
        }
        return fakeEnvelope('done');
      },
      toolPort: {
        definitions: () => defs,
        execute: async () => ({ output: 'OUT(q1)', success: true, backend: 'fake' }),
      },
      emit: () => {},
    });
    const runPromise = session.run('deep snapshot', {});
    await new Promise((r) => {
      const t = setInterval(() => { if (bodies.length === 1) { clearInterval(t); r(); } }, 2);
    });
    release();
    await runPromise;
    const sent = bodies[0].tools[0].inputSchema;
    check('F1 nested schema mutation mid-task cannot reach the sent request',
      sent.properties.input.type === 'string' && sent.required.length === 1 && !sent.properties.added,
      JSON.stringify(sent));
    check('F1 the snapshot structure is deeply frozen',
      Object.isFrozen(sent) && Object.isFrozen(sent.properties) && Object.isFrozen(sent.required)
      && Object.isFrozen(sent.properties.input),
      JSON.stringify([Object.isFrozen(sent), Object.isFrozen(sent.properties), Object.isFrozen(sent.required)]));
    check('F1 a write into the snapshot copy is rejected (strict mode)',
      (() => { try { sent.properties.extra = 1; return false; } catch (e) { return true; } })(),
      'strict-mode write allowed on the snapshot copy');
    check('F1 the CALLER still owns its objects (mutation visible in the source)',
      schemaSource.properties.input.type === 'number' && schemaSource.required.length === 0
      && !!schemaSource.properties.added,
      JSON.stringify(schemaSource));
    check('F1 the tool-result round trip request is unaffected too',
      bodies.length === 2 && !JSON.stringify(bodies[1].tools[0].inputSchema).includes('"added"'),
      JSON.stringify(bodies[1].tools));

    // The next task reads the UPDATED (restored) legal definitions.
    bodies.length = 0;
    schemaSource.properties.input.type = 'string';
    schemaSource.required.push('input');
    delete schemaSource.properties.added;
    defs[0].description = 'UPDATED description.';
    await session.run('task two', {});
    check('F1 the next task reads the updated definitions',
      bodies.length === 1 && bodies[0].system.includes('UPDATED description.')
      && bodies[0].tools[0].inputSchema.properties.input.type === 'string',
      JSON.stringify({ system: bodies[0].system.slice(0, 140), tools: bodies[0].tools }));

    // Two instances never share one schema snapshot.
    const shared = [{ name: 'lookup', description: 'shared.', inputSchema: { type: 'object', properties: { input: { type: 'string' } } } }];
    const portShared = { definitions: () => shared, execute: async () => ({ output: 'x', success: true, backend: 'fake' }) };
    const bodiesA = [], bodiesB = [];
    const sa = createAgentSession({ modelClient: async (b) => { bodiesA.push(b); return fakeEnvelope('a'); }, toolPort: portShared, emit: () => {} });
    const sb = createAgentSession({ modelClient: async (b) => { bodiesB.push(b); return fakeEnvelope('b'); }, toolPort: portShared, emit: () => {} });
    await sa.run('a', {});
    shared[0].inputSchema.properties.input.type = 'integer';
    await sb.run('b', {});
    check('F1 two sessions never share one schema snapshot',
      bodiesA[0].tools[0].inputSchema.properties.input.type === 'string'
      && bodiesB[0].tools[0].inputSchema.properties.input.type === 'integer',
      JSON.stringify([bodiesA[0].tools, bodiesB[0].tools]));

    // Non-transportable definitions fail BEFORE any model request with
    // tool_registry_invalid — zero model calls, zero tool executions.
    const modelCalls = { n: 0 };
    const execs = [];
    const runIllegal = async (illegalDefs) => {
      modelCalls.n = 0;
      execs.length = 0;
      const events = [];
      const s = createAgentSession({
        modelClient: async () => { modelCalls.n++; return fakeEnvelope('should not run'); },
        toolPort: {
          definitions: () => illegalDefs,
          execute: async () => { execs.push(1); return { output: 'x', success: true, backend: 'fake' }; },
        },
        emit: (e) => events.push(e),
      });
      await s.run('illegal registry', {});
      return events;
    };
    const assertIllegal = (events, label) => check('F1 ' + label + ' fails before any model request (zero executions)',
      modelCalls.n === 0 && execs.length === 0
      && events.some((e) => e.type === 'error' && e.code === 'tool_registry_invalid')
      && events.some((e) => e.type === 'task_end' && e.reason === 'error'),
      JSON.stringify({ calls: modelCalls.n, execs: execs.length, events: events.map((e) => e.type + ':' + (e.code || e.reason || '')) }));

    assertIllegal(await runIllegal([
      { name: 'lookup', description: 'd', inputSchema: { type: 'object', properties: { input: { type: 'string', transform: () => 'x' } } } },
    ]), 'a function inside inputSchema');

    const circular = { name: 'lookup', description: 'd', inputSchema: { type: 'object' } };
    circular.inputSchema.self = circular;
    assertIllegal(await runIllegal([circular]), 'a circular reference');

    assertIllegal(await runIllegal([
      { name: 'lookup', description: 'd', inputSchema: { type: 'object', createdAt: new Date(0) } },
    ]), 'a non-plain object (Date) inside inputSchema');

    assertIllegal(await runIllegal([
      { name: 'lookup', description: 'd', inputSchema: { type: 'object', note: undefined } },
    ]), 'an undefined field (would be silently dropped by JSON)');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('TEST RUNNER FAIL', e && e.stack || e); process.exit(1); });
