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
    description: 'Expensive remote execution fallback. It is currently NOT configured, so calls fail. ' +
      'Do not use it unless the user explicitly asks for cloud execution.',
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
      const res = await runShellCommand(input, workspace, opts);
      output = res.output;
      success = !res.isError;
      if (res.isError) error = firstLine(res.output);
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
  Telemetry.record(record);

  return { output, success, backend, operation };
}

function firstLine(s) {
  return String(s || '').split('\n')[0];
}
