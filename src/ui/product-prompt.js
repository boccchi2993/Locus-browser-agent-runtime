// ============================================================
//  LOCUS PRODUCT PROMPT INPUTS (M2b, repository split)
//
//  The Harness system-prompt builder is product-agnostic: the generic
//  loop/protocol/trust rules live in src/agent.js, while EVERY Locus
//  capability claim and behavior rule arrives from here, per task:
//
//    locusEnvironmentNotes({ workspace })      — the Product behavior
//        notes: prefer-local-bash, do-not-assume-commands, the
//        /mnt/upload rule, the curl/Python network trust line, and the
//        per-task workspace-mounted line (extracted verbatim from the
//        pre-split prompt; the product prompt keeps its behavior).
//
//    productDescriptionPort(resolveSession)    — adapts the Runtime's
//        PUBLIC describeCommands() into the Harness descriptionPort.
//        Consumers never read shellSystemPromptSection as a global.
//        When no runtime session exists the port yields null — the
//        prompt then claims no shell capability at all.
//
//  Pure module: no Vue, no DOM, no storage. Unit-tested for content
//  parity with the pre-split product prompt (tests/harness-prompt-parity
//  checks), never hand-inlined into the Harness.
// ============================================================

// Product behavior notes for one task. `workspace` is the task's bound
// filesystem (VirtualWorkspace — workspaceName getter — or a legacy
// adapter with a name property), or null.
export function locusEnvironmentNotes(opts) {
  const workspace = opts && opts.workspace;
  // Tolerate both a VirtualWorkspace (workspaceName getter) and a legacy
  // workspace adapter (name property).
  const wsName = workspace ? (workspace.workspaceName || workspace.name) : null;
  return [
    '- Prefer the local bash tool for everything. If a task can be done with python or the commands above, do it locally.',
    '- Do not assume commands exist beyond the list above. If a command is not available, accomplish the same thing with python.',
    '- Do not ask the user to upload local files to an external service. If local input files are needed, the user can provide them through Locus at /mnt/upload. Uploaded files stay local unless the task explicitly requires a network transfer.',
    '- Do not transmit workspace contents or derived sensitive data to external network destinations unless the user',
    '  explicitly requests or clearly requires that transfer. Network access runs through the curl command, where',
    '  transport, approval and bounds are enforced. Python has no network access and no package downloads;',
    '  use curl for any HTTP/HTTPS need — fetch attempts from Python fail by design.',
    wsName
      ? 'An external folder "' + wsName + '" is currently mounted at /mnt/workspace (the default cwd).'
      : 'No external folder is currently mounted, so /mnt/workspace is unavailable; the default cwd is /home/locus. Use /mnt/upload for user-provided inputs (read-only), /mnt/download for files the user should receive, and /tmp for scratch space.',
  ].join('\n');
}

// The Harness descriptionPort over the runtime session's public
// describeCommands(). `resolveSession` is the store's whenRuntimeSession()
// (async one-time resolution). A missing/incomplete runtime yields null —
// the prompt builds with NO capability description instead of a fabricated
// one.
export function productDescriptionPort(resolveSession) {
  if (typeof resolveSession !== 'function') {
    throw new Error('productDescriptionPort: resolveSession() is required');
  }
  return {
    async describeCommands() {
      const s = await resolveSession();
      if (!s || typeof s.describeCommands !== 'function') return null;
      const text = s.describeCommands();
      return text == null ? null : String(text);
    },
  };
}
