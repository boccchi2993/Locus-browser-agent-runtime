// Product prompt parity + telemetry sink containment (M2b, H8 + the prompt
// side of H11): the REAL harness prompt builder + the REAL product prompt
// inputs + the REAL runtime shell description compose back to the product
// prompt's key content; the product telemetry sink never breaks a tool
// result. Run: node tests/harness-prompt-parity.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- the classic runtime description source (shell.js) ----------
// The description port's text is GENERATED from the runtime command
// registry; the product page loads it as a classic script. Eval the
// runtime files (telemetry/workspace/vfs/shell — the runtime core set)
// to obtain the same shellSystemPromptSection.
const shellM = eval(
  readFileSync(join(root, 'src', 'telemetry.js'), 'utf8') + '\n' +
  readFileSync(join(root, 'src', 'workspace.js'), 'utf8') + '\n' +
  readFileSync(join(root, 'src', 'vfs.js'), 'utf8') + '\n' +
  readFileSync(join(root, 'src', 'shell.js'), 'utf8') +
  '\n;({ shellSystemPromptSection, AGENT_TOOL_DEFINITIONS_REF: (typeof AGENT_TOOL_DEFINITIONS !== "undefined" ? null : null) })'
);

// ---------- the harness prompt builder + the product tool registry ----------
const { ensureHarnessCore, buildSystemPrompt, toolRegistryDefinitions } =
  await import('../src/harness/index.js');
await ensureHarnessCore();

// The PRODUCT tool definitions come from the product tool layer (src/tools.js
// — Product adapter; eval, not import — the harness never carries them).
const toolM = eval(
  readFileSync(join(root, 'src', 'tools.js'), 'utf8') +
  '\n;({ AGENT_TOOL_DEFINITIONS, executeTool });'
);

// ---------- the product prompt inputs (pure module) ----------
const { locusEnvironmentNotes } = await import('../src/ui/product-prompt.js');

// The REAL shell text, adapted exactly like productDescriptionPort does
// over RuntimeSession.describeCommands() (which delegates to this function).
const descriptionText = shellM.shellSystemPromptSection();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const TOOLS = toolM.AGENT_TOOL_DEFINITIONS.slice();

function productPrompt(workspace) {
  return buildSystemPrompt({
    tools: TOOLS,
    descriptionText,
    environmentNotes: locusEnvironmentNotes({ workspace }),
    taskEnvironment: null,
  });
}

{
  const mounted = productPrompt({ name: 'W' });
  const unmounted = productPrompt(null);

  // Tool surface parity: names/descriptions/schemas survive composition.
  check('P1 both product tools render with verbatim descriptions',
    mounted.includes('- bash: ' + TOOLS[0].description)
    && mounted.includes('- cloud_bash: ' + TOOLS[1].description),
    '');
  check('P1b the tool schema the model receives is the product registry entry',
    JSON.stringify(TOOLS[0].inputSchema.required) === '["input"]'
    && TOOLS[0].inputSchema.additionalProperties === false);

  // Runtime capability description parity (the shell contract text).
  check('P2 the shell capability section is present verbatim (registry-derived)',
    mounted.includes('This is a Unix-like compatibility shell, NOT full POSIX bash')
    && mounted.includes("python <<'PY'")
    && mounted.includes('Supported operators:'),
    '');
  check('P2b curl guidance is part of the description',
    mounted.includes('use curl for network requests')
    && mounted.includes('curl -o <file> <url>'), '');
  check('P2c the description is NOT hand-inlined into the harness builder (single source)',
    !buildSystemPrompt({ tools: TOOLS, environmentNotes: null }).includes('Unix-like compatibility shell'));

  // Product behavior notes parity (workspace line + rules).
  check('P3 mounted workspace line',
    mounted.includes('An external folder "W" is currently mounted at /mnt/workspace (the default cwd).'), '');
  check('P3b unmounted fallback lists the still-available paths',
    unmounted.includes('/mnt/workspace is unavailable') && unmounted.includes('/mnt/upload')
    && unmounted.includes('/mnt/download') && unmounted.includes('/tmp') && unmounted.includes('/home/locus'), '');
  check('P3c the /mnt/upload rule and the python/curl network trust line survive',
    mounted.includes('provide them through Locus at /mnt/upload')
    && mounted.includes('fetch attempts from Python fail by design'), '');

  // Generic harness rules stay present.
  check('P4 trust boundaries (untrusted data + prompt injection)',
    mounted.includes('UNTRUSTED DATA') && mounted.includes('prompt-injection'), '');
  check('P4b the plain-text final answer rule + reply-in-language',
    mounted.includes('That is your final answer') && mounted.includes("Reply in the user's language."), '');

  // Nothing fabricated when the ports are absent (harness-level claim).
  const bare = buildSystemPrompt({ tools: [], descriptionText: null, environmentNotes: null });
  check('P5 no defs/description/notes → no bash/python/mnt claims at all',
    !bare.includes('bash') && !bare.includes('python') && !bare.includes('/mnt'), '');
}

// ---------- H8. the product telemetry sink is contained ----------
{
  // One record per execution; a throwing sink and a rejected-promise sink
  // never break the tool result and never surface as unhandled rejections.
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(String(e && e.message || e));
  process.on('unhandledRejection', onUnhandled);

  const sinks = [];
  const sinkThrow = { record: (r) => { sinks.push(r); throw new Error('sink boom'); } };
  const sinkReject = { record: (r) => { sinks.push(r); return Promise.reject(new Error('sink async boom')); } };
  const sinkOk = { record: (r) => { sinks.push(r); } };

  const r1 = await toolM.executeTool('nope', '', null, { telemetry: sinkThrow });
  check('H8 a throwing sink still returns the failed tool result',
    r1.success === false && r1.output.includes('unknown tool: nope'), JSON.stringify(r1));

  const r2 = await toolM.executeTool('alsonope', '', null, { telemetry: sinkReject });
  check('H8 a rejected-promise sink still returns the failed tool result',
    r2.success === false && r2.output.includes('unknown tool: alsonope'), JSON.stringify(r2));

  await toolM.executeTool('thirdnope', '', null, { telemetry: sinkOk });
  await new Promise((r) => setTimeout(r, 20));
  check('H8 exactly one record per execution (no double metering)',
    sinks.length === 3 && sinks.every((s) => s.tool && typeof s.duration_ms === 'number'),
    JSON.stringify(sinks.map((s) => s.tool)));
  check('H8 no unhandled rejections from the sink',
    unhandled.length === 0, JSON.stringify(unhandled));
  check('H8 record fields preserved (shape per the split contract)',
    sinks[0].success === false && sinks[0].backend === 'browser'
    && typeof sinks[0].input_bytes === 'number' && typeof sinks[0].output_bytes === 'number'
    && sinks[0].error !== null);

  // No sink → no delivery at all (no-op), still a valid result.
  const r3 = await toolM.executeTool('nopenope', '', null, {});
  check('H8 missing sink is a no-op and the tool result stands',
    r3.success === false, JSON.stringify(r3));
  process.off('unhandledRejection', onUnhandled);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
