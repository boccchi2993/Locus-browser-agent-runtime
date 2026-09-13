// ============================================================
//  TOOL ROUTER
//  The model sees exactly two tools:
//    bash       — local browser runtime (workspace + Python)
//    cloud_bash — expensive remote fallback, NOT configured in V0
//  Every execution is recorded in Telemetry.
// ============================================================

const TOOL_NOT_FOUND = (name) => 'unknown tool: ' + name + '. Available tools: bash, cloud_bash';

async function executeTool(name, input, workspace) {
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
      const res = await runShellCommand(input, workspace);
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
