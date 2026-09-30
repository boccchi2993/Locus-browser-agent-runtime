// Runtime SELF-ASSEMBLY gates (M2a review round).
//
// The review corrects A1c: a missing LEGAL configuration must error, but
// MERELY not having preloaded the classic core scripts must NOT. This
// suite proves the module entry works with ZERO classic scripts and zero
// page files: the entry assembles its own core (src/runtime/core.js → the
// SAME five sources, published for the module load path), and the VFS
// helpers make a host self-sufficient. It runs BEFORE any eval'd classic
// copy exists in this process — exactly the standalone-host condition.
// Run: node tests/runtime-self-assembly.test.mjs

let passed = 0, failed = 0;
function check(name, cond, detail) {
  const line = (cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 300) : '');
  console.log(line);
  if (cond) passed++; else failed++;
}
const errText = (e) => String(e && e.message ? e.message : e);
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e && e.stack || e); process.exit(3); });

// ---------- SA1: cold import — no core, no window, no document, no page ----------
// Nothing in this process defines window/document or the classic globals:
// any import-time DOM or page dependency would throw right here.
let entry = null;
let coreWasAbsent = false;
try {
  coreWasAbsent = !globalThis.__LOCUS_RUNTIME_CORE__;
  entry = await import('../src/runtime/index.js');
} catch (e) { console.error('entry import threw:', e); }
check('SA0 the process starts with NO core registry (the standalone condition)',
  coreWasAbsent && typeof globalThis.window === 'undefined' && typeof globalThis.document === 'undefined',
  JSON.stringify({ registry: !!globalThis.__LOCUS_RUNTIME_CORE__, window: typeof globalThis.window }));
check('SA1 the entry imports standalone (no core, no DOM, no page)',
  !!entry && typeof entry.createRuntime === 'function'
  && typeof entry.createWorkspace === 'function'
  && typeof entry.createMemoryWorkspace === 'function'
  && typeof entry.shellCommandNames === 'function',
  JSON.stringify(entry && Object.keys(entry)));

// ---------- SA2: createRuntime with zero classic scripts self-assembles ----------
let host = null;
let assembleError = null;
try {
  host = await entry.createRuntime({ workerAssets: { pyWorkerSource: 'x', grepWorkerSource: 'y' } });
} catch (e) { assembleError = e; }
check('SA2 createRuntime with NO classic scripts assembles its own core (not an error)',
  !!host && host.contractVersion === 1 && assembleError === null, errText(assembleError));

// ---------- SA3: the VFS exports make a host self-sufficient ----------
{
  const shellNames = entry.shellCommandNames();
  check('SA3 shellCommandNames exposes the runtime command surface after assembly',
    Array.isArray(shellNames) && shellNames.includes('echo') && shellNames.includes('grep'),
    JSON.stringify(shellNames && shellNames.slice(0, 5)));
  const vfs = entry.createWorkspace();
  check('SA3b createWorkspace builds a task filesystem with the runtime command surface',
    !!vfs && vfs.isLocusVFS === true, JSON.stringify({ isLocusVFS: !!(vfs && vfs.isLocusVFS) }));
  const mem = entry.createMemoryWorkspace({ name: 'scratch' });
  check('SA3c createMemoryWorkspace builds a workspace without any classic global',
    !!mem, JSON.stringify({ name: mem && mem.name }));

  const session = host.createSession();
  const wr = await session.execute({
    kind: 'shell',
    input: 'echo self-assembled > /tmp/sa.txt && cat /tmp/sa.txt && ls',
    context: { filesystem: vfs },
  });
  check('SA3d a composite shell (write + read + ls) runs on the self-assembled core',
    wr.ok === true && wr.output.includes('self-assembled'), JSON.stringify(wr).slice(0, 200));
  session.dispose('SA done');
}

// ---------- SA4: a missing LEGAL configuration still errors ----------
{
  let refused = null;
  try { await entry.createRuntime({ workerAssets: { grepWorkerSource: 'y' } }); }
  catch (e) { refused = e; }
  check('SA4 createRuntime without a legal py worker source errors (config, not assembly)',
    !!refused && /workerAssets\.pyWorkerSource/.test(errText(refused)), errText(refused));

  const saved = globalThis.__LOCUS_RUNTIME_CORE__;
  globalThis.__LOCUS_RUNTIME_CORE__ = { createPythonRuntime() {} }; // partial table
  let broken = null;
  try { await entry.createRuntime({ workerAssets: { pyWorkerSource: 'x', grepWorkerSource: 'y' } }); }
  catch (e) { broken = e; }
  globalThis.__LOCUS_RUNTIME_CORE__ = saved;
  check('SA4b a present-but-partial registry errors clearly (never a half runtime)',
    !!broken && /incomplete/.test(errText(broken)), errText(broken));
}

// ---------- SA5: two hosts on the self-assembled core never cross ----------
{
  const hostA = await entry.createRuntime({ workerAssets: { pyWorkerSource: 'x', grepWorkerSource: 'y' } });
  const hostB = await entry.createRuntime({ workerAssets: { pyWorkerSource: 'x', grepWorkerSource: 'y' } });
  const sa = hostA.createSession();
  const sb = hostB.createSession();
  const vfsA = entry.createWorkspace();
  const vfsB = entry.createWorkspace();
  await sa.execute({ kind: 'shell', input: 'echo A > /tmp/which.txt', context: { filesystem: vfsA } });
  await sb.execute({ kind: 'shell', input: 'echo B > /tmp/which.txt', context: { filesystem: vfsB } });
  const ra = await sa.execute({ kind: 'shell', input: 'cat /tmp/which.txt', context: { filesystem: vfsA } });
  const rb = await sb.execute({ kind: 'shell', input: 'cat /tmp/which.txt', context: { filesystem: vfsB } });
  check('SA5 self-assembled sessions are execution- and filesystem-scoped',
    ra.output === 'A\n' && rb.output === 'B\n', JSON.stringify({ a: ra.output, b: rb.output }));
  hostA.dispose('SA5 done');
  hostB.dispose('SA5 done');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
