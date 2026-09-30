// ============================================================
//  TOOL ROUTER + MODEL-VISIBLE TOOL REGISTRY
//  The model sees exactly two tools:
//    bash       — local browser runtime (workspace + Python)
//    cloud_bash — expensive remote fallback, NOT configured in V0
//  Every execution is recorded in Telemetry.
//
//  AGENT_TOOL_DEFINITIONS is the SINGLE provider-neutral source of
//  truth for the model-visible tool surface (name / description /
//  inputSchema). ProviderAdapters map it onto provider wire shapes
//  (OpenAI function tools, Anthropic input_schema); the system prompt
//  derives its tool list from it. Never write a provider-specific
//  schema here.
// ============================================================

const AGENT_TOOL_DEFINITIONS = [
  {
    name: 'bash',
    description: 'Execute a command in the local browser Linux-like compatibility runtime. ' +
      'Use it for filesystem work, Python execution, text/data processing, and supported network operations.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The shell command to execute.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
  },
  {
    name: 'cloud_bash',
    // Legacy/debug compatibility path (docs/NETWORK-RUNTIME.md): NOT a
    // network path — ordinary network work uses the local bash tool and
    // NetworkRuntime never needs it.
    description: 'Legacy remote execution fallback (debug/compatibility tool, not a network path). ' +
      'It is currently NOT configured, so calls fail. Ordinary shell and network work uses the local bash tool.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The shell command to execute remotely.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
  },
];

const AGENT_TOOL_NAMES = AGENT_TOOL_DEFINITIONS.map((t) => t.name);

const TOOL_NOT_FOUND = (name) => 'unknown tool: ' + name + '. Available tools: ' + AGENT_TOOL_NAMES.join(', ');

async function executeTool(name, input, workspace, opts) {
  const started = performance.now();
  const toolName = String(name || '').trim();
  let output = '';
  let success = true;
  let error = null;
  let backend = toolName === 'cloud_bash' ? 'cloud' : 'browser';
  let operation = null;
  let ioIn = utf8ByteLength(input || '');
  let ioOut = 0;

  try {
    if (toolName === 'bash') {
      // M2a (repository split): the product execution chain goes through
      // the public RuntimeSession entry — the session injects the
      // interpreter instance and the grep worker asset itself, so a call
      // can never execute on a foreign interpreter or fetch worker source
      // from a page. Running bash WITHOUT a session is an assembly bug
      // and fails loudly (runtime suites test runShellCommand directly).
      const runtimeSession = opts && opts.runtimeSession;
      if (!runtimeSession) throw new Error('bash: no runtime session injected');
      const res = await runtimeSession.execute({
        kind: 'shell',
        input: input,
        context: {
          filesystem: workspace,
          signal: opts && opts.signal,
          mutationPolicy: opts && opts.mutationPolicy,
          authorization: opts && opts.authorization,
          cwd: opts && opts.cwd,
        },
      });
      output = res.output;
      success = res.ok;
      if (!res.ok) error = firstLine(res.output);
      ioIn = res.io.in;
      ioOut = res.io.out;
      // A shell command may run on a more specific backend than the tool
      // default (e.g. curl → browser-direct / edge-relay network fetch).
      if (res.backend) backend = res.backend;
      if (res.operation) operation = res.operation;
    } else if (toolName === 'cloud_bash') {
      // Unconfigured cloud execution is a FAILURE, not a successful stub:
      // the agent and telemetry must both see success=false.
      output = 'Cloud execution is not configured.';
      success = false;
      error = output;
    } else {
      output = TOOL_NOT_FOUND(toolName || '(empty)');
      success = false;
      error = output;
    }
  } catch (e) {
    output = 'tool execution failed: ' + (e && e.message ? e.message : String(e));
    success = false;
    error = output;
  }

  const record = {
    tool: toolName,
    backend,
    duration_ms: Math.round(performance.now() - started),
    success,
    input_bytes: ioIn,
    output_bytes: ioOut || utf8ByteLength(output),
    error,
  };
  if (operation) record.operation = operation;
  // M2b (repository split): the execution measurement goes through an
  // explicit sink (opts.telemetry, wired by the store's ToolPort; the
  // page Telemetry is the product default). Delivery is CONTAINED: a
  // throwing sink — or one that returns a rejected promise — never
  // breaks the tool result and never surfaces as an unhandled
  // rejection. Exactly one record per execution (the Harness records
  // nothing per tool execution, so there is no double metering).
  emitTelemetry((opts && opts.telemetry)
    || (typeof Telemetry !== 'undefined' ? Telemetry : null), record);

  return { output, success, backend, operation };
}

function firstLine(s) {
  return String(s || '').split('\n')[0];
}

// One contained delivery to a telemetry sink. A sync throw or a rejected
// returned promise is swallowed by design — observability must never
// break the execution it measured.
function emitTelemetry(sink, record) {
  if (!sink || typeof sink.record !== 'function') return;
  try {
    const r = sink.record(record);
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (e) { /* a failing sink never breaks execution */ }
}
