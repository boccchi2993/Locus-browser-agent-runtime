// ============================================================
//  PROVIDER ADAPTERS
//  Provider-specific request/response/replay semantics, isolated
//  from the generic model transport in src/model.js:
//
//    AgentSession → ModelClient (model.js) → ProviderAdapter (here)
//
//  Core distinction: provider identity ≠ API dialect. Any HTTPS
//  endpoint may speak either dialect (official APIs, third-party
//  compatible gateways, enterprise proxies, self-hosted relays).
//  There is intentionally NO provider hostname allowlist.
//
//  A ProviderAdapter is pure logic — no DOM, no fetch, no UI
//  globals — so it can be tested directly in Node:
//
//    adapter.buildEndpoints(apiBase)   → ordered endpoint URLs to try
//    adapter.buildHeaders({ apiKey, apiBase }) → auth/protocol headers
//    adapter.serializeRequest(input)   → provider request JSON
//    adapter.prepareHistory(messages)  → replay policy for stored history
//    adapter.parseResponse(data)       → normalized response envelope
//    adapter.isToolingUnsupportedError(err) → explicit request-validation
//                                       rejection of the tools payload only
//
//  Envelope (docs/MODEL-PROTOCOL.md):
//    { content, reasoning, reasoningType, toolCalls, rawMessage,
//      stopReason, usage, providerMetadata, truncated }
//
//  toolCalls is the normalized provider-native tool request list:
//    [{ id, name, input, argumentsError? }]
//  input is the parsed arguments OBJECT (never a raw string, never
//  eval'd); argumentsError marks an unparseable/invalid arguments
//  payload — the harness turns it into a failed tool result, it is
//  NEVER executed.
//
//  History may contain provider-neutral tool results produced by
//  AgentSession:
//    { role: 'tool_result', toolCallId, toolName, content, success }
//  prepareHistory maps them onto the provider wire shape (OpenAI
//  role:'tool' / Anthropic user tool_result blocks). AgentSession never
//  sees those wire shapes.
//
//  Replay policy lives HERE, not in AgentSession: rawMessage is the
//  provider-native assistant state, and prepareHistory/serializeRequest
//  decide how it re-enters the next request. Unknown provider-native
//  fields/blocks are preserved, never destructively normalized.
//
//  Error constructors (makeParseError etc.) are defined in model.js;
//  adapters reference them at call time only.
// ============================================================

// Auto dialect detection from the endpoint form (only used when the
// configured dialect is 'auto'; an explicit dialect always wins):
// - api.anthropic.com            → anthropic
// - any base ending in /anthropic → anthropic (e.g. api.deepseek.com/anthropic)
// - everything else               → openai
function detectDialect(apiBase) {
  const base = String(apiBase || '').replace(/\/+$/, '');
  if (/api\.anthropic\.com/i.test(base) || /\/anthropic$/i.test(base)) {
    return 'anthropic';
  }
  return 'openai';
}

// Endpoint identity is deliberately narrower than an origin and deliberately
// wider than a hostname: gateway paths often select a different tenant or
// protocol. The relay/proxy is transport only and is not part of this
// identity.
function normalizeCredentialEndpoint(apiBase) {
  const raw = String(apiBase || '').trim();
  let url;
  try { url = new URL(raw); } catch (e) { throw new Error('invalid custom endpoint: ' + raw); }
  const scheme = String(url.protocol || '').toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') throw new Error('invalid custom endpoint scheme: ' + raw);
  if (url.username || url.password) throw new Error('custom endpoint must not contain URL credentials');
  const path = (url.pathname || '').replace(/\/+$/, '');
  const port = url.port ? ':' + url.port : '';
  const query = url.search ? '?' + Array.from(url.searchParams.entries()).sort(function (a, b) {
    return a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]);
  }).map(function (pair) { return encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1]); }).join('&') : '';
  return scheme + '//' + String(url.hostname || '').toLowerCase() + port + path + query;
}

function adapterForIdentity(config) {
  const c = config || {};
  const name = c.adapterId || c.dialect;
  if (name === 'anthropic-compatible' || c.provider === 'anthropic' || c.dialect === 'anthropic') return AnthropicAdapter;
  if (name === 'openai-compatible' || c.provider === 'openai' || c.dialect === 'openai') return OpenAIAdapter;
  return null;
}

function createCredentialIdentity(config) {
  const c = config || {};
  const adapter = adapterForIdentity(c) || (typeof getProviderAdapter === 'function' ? getProviderAdapter(c) : null);
  const requestedDialect = String(c.dialect || '');
  const dialect = requestedDialect && requestedDialect !== 'auto'
    ? requestedDialect : String(adapter && adapter.dialect || requestedDialect);
  const provider = String(c.provider || adapter && adapter.providerFamily || dialect);
  const adapterId = String(c.adapterId || adapter && adapter.adapterId || dialect);
  const endpointIdentity = normalizeCredentialEndpoint(String(c.endpointIdentity || c.apiBase || ''));
  if (!endpointIdentity) throw new Error('credential endpoint identity is required');
  return { provider: provider, adapterId: adapterId, dialect: dialect, endpointIdentity: endpointIdentity };
}

function createProviderIdentity(config) {
  const c = config || {};
  const credential = createCredentialIdentity(c);
  const adapter = adapterForIdentity(c) || (typeof getProviderAdapter === 'function' ? getProviderAdapter(c) : null);
  return {
    provider: credential.provider,
    adapterId: credential.adapterId,
    dialect: credential.dialect,
    endpointIdentity: credential.endpointIdentity,
    model: String(c.model || ''),
    protocolVersion: String(c.protocolVersion || adapter && adapter.protocolVersion || ''),
  };
}

function rawReplayIdentityCompatible(adapter, sessionMeta, currentConfig) {
  if (!sessionMeta || sessionMeta.rawReplayInvalid || sessionMeta.persistenceState && sessionMeta.persistenceState !== 'healthy') return false;
  const c = currentConfig || {};
  let current;
  try {
    current = createProviderIdentity(Object.assign({}, c, {
      adapterId: adapter.adapterId, provider: adapter.providerFamily, dialect: adapter.dialect,
    }));
  } catch (e) { return false; }
  if (sessionMeta.provider !== current.provider
      || sessionMeta.adapterId !== current.adapterId
      || sessionMeta.dialect !== current.dialect
      || sessionMeta.endpointIdentity !== current.endpointIdentity) return false;
  if (sessionMeta.protocolVersion !== current.protocolVersion) return false;
  // Raw protocol state is model-specific by default. Adapters must opt in
  // explicitly before a model switch may reuse opaque reasoning/signatures.
  return sessionMeta.model === current.model || adapter.rawHistoryModelPortable === true;
}

// Light response metadata worth keeping for debugging/future adapters —
// never a second copy of the full response body (rawMessage already holds
// the replay-relevant assistant state).
function pickMetadata(fields) {
  let out = null;
  for (const k in fields) {
    if (fields[k] !== undefined && fields[k] !== null) {
      if (!out) out = {};
      out[k] = fields[k];
    }
  }
  return out;
}

// A provider-neutral tool result from AgentSession history.
function isNeutralToolResult(m) {
  return !!m && m.role === 'tool_result' && typeof m.toolCallId === 'string';
}

function neutralResultText(m) {
  return typeof m.content === 'string' ? m.content : String(m.content == null ? '' : m.content);
}

// Conservative shared test: the provider EXPLICITLY rejected the request
// at validation time (400/422) because of the tools payload. Anything
// ambiguous (auth, quota, 5xx, timeouts, parse failures) is NOT a tooling
// rejection — see the double-billing rules in model.js.
function errorMentionsTooling(msg) {
  const s = String(msg || '').toLowerCase();
  return /\b(tools|tool_choice|functions?|function_call)\b/.test(s) &&
    /(unknown|unrecognized|unexpect|unsupported|not supported|not allowed|invalid|extra)/.test(s);
}

// ---------- OpenAI-compatible adapter ----------
const OpenAIAdapter = {
  dialect: 'openai',
  adapterId: 'openai-compatible',
  providerFamily: 'openai',
  rawHistoryModelPortable: false,
  protocolVersion: 'chat-completions-v1',

  isRawReplayCompatible(sessionMeta, currentConfig) {
    return rawReplayIdentityCompatible(this, sessionMeta, currentConfig);
  },

  // Raw provider state is the protocol source of truth. Persisted frame
  // metadata is checked by validateReplayPrefix after this classification;
  // it must never decide whether an assistant tool call is inspected.
  inspectRawReplayFrame(frame) {
    const raw = frame && frame.raw;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('OpenAI raw replay frame is malformed');
    if (raw.role === 'assistant') {
      if (raw.tool_calls !== undefined && !Array.isArray(raw.tool_calls)) throw new Error('OpenAI raw replay tool_calls is malformed');
      const toolCallIds = [];
      for (const call of raw.tool_calls || []) {
        if (!call || typeof call !== 'object' || Array.isArray(call)
          || typeof call.id !== 'string' || !call.id
          || !call.function || typeof call.function !== 'object'
          || Array.isArray(call.function) || typeof call.function.name !== 'string'
          || !call.function.name) {
          throw new Error('OpenAI raw replay tool call is malformed');
        }
        toolCallIds.push(call.id);
      }
      if (new Set(toolCallIds).size !== toolCallIds.length) throw new Error('OpenAI raw replay tool-call ids are duplicated');
      return { semanticKind: 'assistant', role: 'assistant', toolCallIds: toolCallIds, toolResultId: null };
    }
    if (raw.role === 'tool_result') {
      if (typeof raw.toolCallId !== 'string' || !raw.toolCallId) throw new Error('OpenAI raw replay tool result id is malformed');
      return { semanticKind: 'tool_result', role: 'tool_result', toolCallIds: [], toolResultId: raw.toolCallId };
    }
    if (raw.role === 'user') return { semanticKind: 'user', role: 'user', toolCallIds: [], toolResultId: null };
    throw new Error('OpenAI raw replay role is unknown');
  },

  validateRawReplay(frames) {
    for (const frame of frames || []) this.inspectRawReplayFrame(frame);
    return true;
  },

  // Tolerate both endpoint layouts: bare base + /chat/completions first,
  // then the /v1 variant (fallback policy in model.js decides when the
  // second attempt is allowed — never on authoritative/parse/timeout errors).
  // The user's base path is appended verbatim: with an explicit dialect
  // selected, a path segment like /anthropic is just part of the endpoint
  // identity (e.g. an enterprise gateway route), never a protocol hint
  // to strip. Only redundant trailing slashes are removed.
  buildEndpoints(apiBase) {
    const root = String(apiBase || '').replace(/\/+$/, '');
    return [root + '/chat/completions', root + '/v1/chat/completions'];
  },

  buildHeaders(config) {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + config.apiKey,
    };
  },

  // History entries are provider-native (rawMessage objects produced by
  // parseResponse, user/tool-feedback strings) EXCEPT neutral tool
  // results, which map onto role:'tool' messages with the exact matching
  // tool_call_id. Reasoning_content and any provider-specific
  // continuation fields ride along unchanged.
  prepareHistory(messages) {
    return (messages || []).map((m) => isNeutralToolResult(m)
      ? { role: 'tool', tool_call_id: m.toolCallId, content: neutralResultText(m) }
      : m);
  },

  serializeRequest(input) {
    const messages = this.prepareHistory(input.messages || []).slice();
    if (input.system) messages.unshift({ role: 'system', content: input.system });
    const body = { model: input.model, messages: messages, max_tokens: input.max_tokens || 2000 };
    // Provider-neutral tool definitions → OpenAI function tools. The
    // model decides whether a tool is needed (no forced tool_choice).
    if (Array.isArray(input.tools) && input.tools.length) {
      body.tools = input.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }
    return body;
  },

  parseResponse(data) {
    if (data.choices && data.choices[0]) {
      const choice = data.choices[0];
      const msg = choice.message || choice.delta || {};
      const content = typeof msg.content === 'string' ? msg.content : '';
      const reasoning = typeof msg.reasoning_content === 'string' && msg.reasoning_content
        ? msg.reasoning_content : null;
      // Native tool calls → normalized { id, name, input }. arguments is
      // a JSON STRING on the wire; parse it safely (never eval). An
      // unparseable payload is preserved as argumentsError so the harness
      // can fail the call honestly instead of executing garbage.
      const toolCalls = [];
      if (Array.isArray(msg.tool_calls)) {
        for (const c of msg.tool_calls) {
          if (!c || typeof c !== 'object') continue;
          const fn = c.function || {};
          let input = null;
          let argumentsError = null;
          const rawArgs = fn.arguments;
          if (typeof rawArgs === 'string') {
            try { input = JSON.parse(rawArgs); } catch (e) { argumentsError = 'tool arguments are not valid JSON'; }
          } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
            input = rawArgs; // some compatible providers send an object directly
          } else {
            argumentsError = 'tool arguments missing or not a JSON string';
          }
          toolCalls.push({
            id: typeof c.id === 'string' ? c.id : '',
            name: typeof fn.name === 'string' ? fn.name : '',
            input: input,
            argumentsError: argumentsError,
          });
        }
      }
      const envelope = {
        content: content,
        reasoning: reasoning,
        reasoningType: reasoning ? 'raw' : null,
        toolCalls: toolCalls.length ? toolCalls : null,
        stopReason: choice.finish_reason || null,
        usage: data.usage || null,
        providerMetadata: pickMetadata({
          id: data.id,
          model: data.model,
          system_fingerprint: data.system_fingerprint,
          service_tier: data.service_tier,
        }),
        // Replay the provider-native message object unchanged (keeps
        // reasoning_content, tool_calls and any unknown provider fields).
        rawMessage: msg,
        truncated: choice.finish_reason === 'length',
      };
      // A tool-only response (zero visible text) is a VALID response.
      if (content || toolCalls.length) return envelope;
      if (choice.finish_reason === 'length') {
        throw makeParseError('模型在生成可见回答前达到 token 上限（finish_reason: length）');
      }
      throw makeParseError('响应中没有可见文本内容（finish_reason: ' + (choice.finish_reason || 'unknown') + '）');
    }
    if (data.error) throw makeParseError(data.error.message || JSON.stringify(data.error));
    throw makeParseError('响应格式不符合预期');
  },

  // Only an explicit request-validation rejection of the tools payload
  // justifies the one-time downgrade to a tool-less request (model.js).
  isToolingUnsupportedError(e) {
    if (!e || (e.status !== 400 && e.status !== 422)) return false;
    const pe = e.providerError || {};
    const param = String(pe.param || '').toLowerCase();
    if (param === 'tools' || param === 'tool_choice' || param === 'functions' || param === 'function_call') return true;
    return errorMentionsTooling(e.message);
  },
};

// ---------- Anthropic-compatible adapter ----------
const AnthropicAdapter = {
  dialect: 'anthropic',
  adapterId: 'anthropic-compatible',
  providerFamily: 'anthropic',
  rawHistoryModelPortable: false,
  protocolVersion: 'messages-v1',

  isRawReplayCompatible(sessionMeta, currentConfig) {
    return rawReplayIdentityCompatible(this, sessionMeta, currentConfig);
  },

  inspectRawReplayFrame(frame) {
    const raw = frame && frame.raw;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Anthropic raw replay frame is malformed');
    if (raw.role === 'assistant') {
      if (!Array.isArray(raw.content)) throw new Error('Anthropic raw replay assistant content is malformed');
      const toolCallIds = [];
      for (const block of raw.content) {
        if (block && block.type === 'tool_use') {
          if (typeof block.id !== 'string' || !block.id) throw new Error('Anthropic raw replay tool-use id is malformed');
          toolCallIds.push(block.id);
        }
      }
      if (new Set(toolCallIds).size !== toolCallIds.length) throw new Error('Anthropic raw replay tool-use ids are duplicated');
      return { semanticKind: 'assistant', role: 'assistant', toolCallIds: toolCallIds, toolResultId: null };
    }
    if (raw.role === 'tool_result') {
      if (typeof raw.toolCallId !== 'string' || !raw.toolCallId) throw new Error('Anthropic raw replay tool result id is malformed');
      return { semanticKind: 'tool_result', role: 'tool_result', toolCallIds: [], toolResultId: raw.toolCallId };
    }
    if (raw.role === 'user') return { semanticKind: 'user', role: 'user', toolCallIds: [], toolResultId: null };
    throw new Error('Anthropic raw replay role is unknown');
  },

  validateRawReplay(frames) {
    for (const frame of frames || []) this.inspectRawReplayFrame(frame);
    return true;
  },

  buildEndpoints(apiBase) {
    return [String(apiBase || '').replace(/\/+$/, '') + '/v1/messages'];
  },

  buildHeaders(config) {
    // x-api-key + anthropic-version.
    // anthropic-dangerous-direct-browser-access is only for the official
    // API's direct browser access; third-party compatible endpoints are
    // not required to recognize it.
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (/api\.anthropic\.com/i.test(String(config.apiBase || ''))) {
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    return headers;
  },

  // rawMessage.content is the EXACT provider block array (text, thinking,
  // redacted_thinking, tool_use, opaque/unknown blocks) — replayed
  // verbatim, in order. Unknown does not mean irrelevant. Neutral tool
  // results become ONE user message per consecutive run, holding
  // tool_result blocks with the exact matching tool_use_id.
  prepareHistory(messages) {
    const out = [];
    let pendingResults = null;
    for (const m of messages || []) {
      if (isNeutralToolResult(m)) {
        if (!pendingResults) {
          pendingResults = { role: 'user', content: [] };
          out.push(pendingResults);
        }
        pendingResults.content.push({
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: neutralResultText(m),
          is_error: m.success === false,
        });
      } else {
        pendingResults = null;
        out.push(m);
      }
    }
    return out;
  },

  serializeRequest(input) {
    const body = {
      model: input.model,
      system: input.system,
      messages: this.prepareHistory(input.messages || []),
      max_tokens: input.max_tokens,
    };
    // Provider-neutral tool definitions → Anthropic tools. No forced
    // tool_choice: the model decides whether a tool is needed.
    if (Array.isArray(input.tools) && input.tools.length) {
      body.tools = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }
    return body;
  },

  parseResponse(data) {
    if (!Array.isArray(data.content)) {
      if (typeof data.content === 'string' && data.content) {
        return {
          content: data.content,
          reasoning: null,
          reasoningType: null,
          toolCalls: null,
          stopReason: data.stop_reason || null,
          usage: data.usage || null,
          providerMetadata: pickMetadata({
            id: data.id, model: data.model, stop_sequence: data.stop_sequence,
          }),
          rawMessage: { role: 'assistant', content: data.content },
          truncated: data.stop_reason === 'max_tokens',
        };
      }
      if (data.error) {
        throw makeParseError(data.error.message || data.error.type || JSON.stringify(data.error));
      }
      throw makeParseError('响应中没有可见文本内容');
    }

    // content is a block array. Visible text blocks become `content`;
    // provider-returned thinking becomes visible `reasoning`; tool_use
    // blocks become normalized tool calls; redacted / opaque / unknown
    // blocks are preserved in rawMessage for replay but never rendered
    // as fake prose.
    const text = data.content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    const reasoning = data.content
      .filter((part) => part && part.type === 'thinking' && typeof part.thinking === 'string')
      .map((part) => part.thinking)
      .join('\n') || null;
    const toolCalls = data.content
      .filter((part) => part && part.type === 'tool_use')
      .map((part) => {
        const validInput = part.input && typeof part.input === 'object' && !Array.isArray(part.input);
        return {
          id: typeof part.id === 'string' ? part.id : '',
          name: typeof part.name === 'string' ? part.name : '',
          input: validInput ? part.input : null,
          argumentsError: validInput ? null : 'tool_use input is not an object',
        };
      });

    const envelope = {
      content: text,
      reasoning: reasoning,
      reasoningType: reasoning ? 'raw' : null,
      toolCalls: toolCalls.length ? toolCalls : null,
      stopReason: data.stop_reason || null,
      usage: data.usage || null,
      providerMetadata: pickMetadata({
        id: data.id, model: data.model, stop_sequence: data.stop_sequence,
      }),
      // The complete block array, in provider order — authoritative
      // continuation state for the next request.
      rawMessage: { role: 'assistant', content: data.content },
      truncated: data.stop_reason === 'max_tokens',
    };
    // A tool-only response (zero visible text) is a VALID response.
    if (text || toolCalls.length) return envelope;
    if (data.stop_reason === 'max_tokens') {
      throw makeParseError('模型在生成可见回答前达到 token 上限（stop_reason: max_tokens）');
    }
    throw makeParseError('响应中没有可见文本内容（stop_reason: ' + (data.stop_reason || 'unknown') + '）');
  },

  // Only an explicit request-validation rejection of the tools payload
  // justifies the one-time downgrade to a tool-less request (model.js).
  isToolingUnsupportedError(e) {
    if (!e || (e.status !== 400 && e.status !== 422)) return false;
    return errorMentionsTooling(e.message);
  },
};

// ---------- adapter selection ----------
// Explicit dialect always wins; 'auto' falls back to endpoint-shape
// detection. An explicit dialect makes ANY hostname usable — enterprise
// gateways and self-hosted relays included.
const PROVIDER_ADAPTERS = {
  openai: OpenAIAdapter,
  anthropic: AnthropicAdapter,
};

function getProviderAdapter(config) {
  const c = config || {};
  const requested = c.dialect || 'auto';
  const name = requested === 'auto' ? detectDialect(c.apiBase) : requested;
  const adapter = PROVIDER_ADAPTERS[name];
  if (!adapter) {
    throw new Error('unknown API dialect "' + requested + '" (expected: auto, openai, anthropic)');
  }
  return adapter;
}

// Cross-provider continuation is intentionally semantic. It never forwards
// a foreign raw protocol object (thinking signatures, vendor extensions,
// tool-call wire wrappers, etc.) to a different adapter.
function projectNormalizedHistory(messages, dialect) {
  var out = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.kind === 'tool_result' || m.role === 'tool_result') {
      out.push({ role: 'tool_result', toolCallId: m.toolCallId || '', toolName: m.toolName || '', content: String(m.toolResult == null ? (m.content || '') : m.toolResult), success: m.success !== false });
      continue;
    }
    if (m.kind === 'tool_call' && Array.isArray(m.toolCalls)) {
      if (dialect === 'anthropic') {
        var blocks = [];
        if (m.text) blocks.push({ type: 'text', text: m.text });
        m.toolCalls.forEach(function (c) { blocks.push({ type: 'tool_use', id: c.id || '', name: c.name || '', input: c.input || {} }); });
        out.push({ role: 'assistant', content: blocks });
      } else {
        out.push({ role: 'assistant', content: m.text || '', tool_calls: m.toolCalls.map(function (c) {
          return { id: c.id || '', type: 'function', function: { name: c.name || '', arguments: JSON.stringify(c.input || {}) } };
        }) });
      }
      continue;
    }
    out.push({ role: m.role || 'user', content: typeof m.text === 'string' ? m.text : (typeof m.content === 'string' ? m.content : '') });
  }
  return out;
}
