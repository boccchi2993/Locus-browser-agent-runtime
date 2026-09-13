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
//
//  Envelope (docs/MODEL-PROTOCOL.md):
//    { content, reasoning, reasoningType, toolCalls, rawMessage,
//      stopReason, usage, providerMetadata, truncated }
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

// ---------- OpenAI-compatible adapter ----------
const OpenAIAdapter = {
  dialect: 'openai',

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

  // History entries are already provider-native (rawMessage objects
  // produced by parseResponse, user/tool-feedback strings). Replay them
  // unchanged — reasoning_content and any provider-specific continuation
  // fields ride along.
  prepareHistory(messages) {
    return messages;
  },

  serializeRequest(input) {
    const messages = this.prepareHistory(input.messages || []).slice();
    if (input.system) messages.unshift({ role: 'system', content: input.system });
    return { model: input.model, messages: messages, max_tokens: input.max_tokens || 2000 };
  },

  parseResponse(data) {
    if (data.choices && data.choices[0]) {
      const choice = data.choices[0];
      const msg = choice.message || choice.delta || {};
      const content = typeof msg.content === 'string' ? msg.content : '';
      const reasoning = typeof msg.reasoning_content === 'string' && msg.reasoning_content
        ? msg.reasoning_content : null;
      const envelope = {
        content: content,
        reasoning: reasoning,
        reasoningType: reasoning ? 'raw' : null,
        // Native tool calls are NOT consumed by the agent loop yet (the
        // strict fenced-JSON protocol stays authoritative); the seam exists
        // and any provider-native call state survives inside rawMessage.
        toolCalls: null,
        stopReason: choice.finish_reason || null,
        usage: data.usage || null,
        providerMetadata: pickMetadata({
          id: data.id,
          model: data.model,
          system_fingerprint: data.system_fingerprint,
          service_tier: data.service_tier,
        }),
        // Replay the provider-native message object unchanged (keeps
        // reasoning_content and any unknown provider-specific fields).
        rawMessage: msg,
        truncated: choice.finish_reason === 'length',
      };
      if (content) return envelope;
      if (choice.finish_reason === 'length') {
        throw makeParseError('模型在生成可见回答前达到 token 上限（finish_reason: length）');
      }
      throw makeParseError('响应中没有可见文本内容（finish_reason: ' + (choice.finish_reason || 'unknown') + '）');
    }
    if (data.error) throw makeParseError(data.error.message || JSON.stringify(data.error));
    throw makeParseError('响应格式不符合预期');
  },
};

// ---------- Anthropic-compatible adapter ----------
const AnthropicAdapter = {
  dialect: 'anthropic',

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
  // redacted_thinking, opaque/unknown blocks) — replay it verbatim, in
  // order. Unknown does not mean irrelevant.
  prepareHistory(messages) {
    return messages;
  },

  serializeRequest(input) {
    return {
      model: input.model,
      system: input.system,
      messages: this.prepareHistory(input.messages || []),
      max_tokens: input.max_tokens,
    };
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
    // provider-returned thinking becomes visible `reasoning`; redacted /
    // opaque / unknown blocks are preserved in rawMessage for replay but
    // never rendered as fake prose.
    const text = data.content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    const reasoning = data.content
      .filter((part) => part && part.type === 'thinking' && typeof part.thinking === 'string')
      .map((part) => part.thinking)
      .join('\n') || null;

    const envelope = {
      content: text,
      reasoning: reasoning,
      reasoningType: reasoning ? 'raw' : null,
      toolCalls: null,
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
    if (!text) {
      if (data.stop_reason === 'max_tokens') {
        throw makeParseError('模型在生成可见回答前达到 token 上限（stop_reason: max_tokens）');
      }
      throw makeParseError('响应中没有可见文本内容（stop_reason: ' + (data.stop_reason || 'unknown') + '）');
    }
    return envelope;
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
