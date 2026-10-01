// ============================================================
//  PRODUCT TOOLPORT FACTORY (M2c, repository split)
//
//  The ONE production composition of the Harness ToolPort contract
//  (docs/REPOSITORY-SPLIT-CONTRACTS.md §3.2), extracted verbatim from the
//  store's productToolPort so the Product store AND the joint integration
//  suites call the SAME implementation:
//
//    definitions()             → the product tool registry slice
//    execute({ name, input, context }) → the product execution path:
//        context = { filesystem, signal } (the port's narrow per-call
//        binding); the runtime session resolves through the async
//        one-time entry resolution; the product mutation policy and the
//        execution authorization port are injected per call.
//
//  Dependency style only — behavior is byte-identical to the pre-M2c
//  store closure. `executeTool` (src/tools.js) remains the ONLY tool
//  adaptation path: the `execute` dep IS that path (the store wraps it
//  with the ?e2e=1 hooks seam; joint tests pass the real executeTool).
//  No UI state, no store, no storage implementation lives here.
// ============================================================

export function createLocusToolPort(deps) {
  if (!deps || typeof deps.execute !== 'function') {
    throw new Error('createLocusToolPort: execute (the product tool executor) is required');
  }
  if (typeof deps.resolveRuntimeSession !== 'function') {
    throw new Error('createLocusToolPort: resolveRuntimeSession is required');
  }
  const definitions = typeof deps.definitions === 'function' ? deps.definitions : null;
  const mutationPolicy = typeof deps.mutationPolicy === 'function' ? deps.mutationPolicy : null;
  const authorization = typeof deps.authorization === 'function' ? deps.authorization : null;

  return {
    definitions() {
      if (!definitions) return [];
      const list = definitions();
      return Array.isArray(list) ? list.slice() : [];
    },
    async execute(call) {
      const c = call && typeof call === 'object' ? call : {};
      // The task context is the port's narrow per-call binding:
      // { filesystem, signal } (contract §3.2).
      const context = c.context && typeof c.context === 'object' ? c.context : {};
      const workspace = context.filesystem || null;
      const o = {
        signal: context.signal,
        // The runtime entry assembles asynchronously, so the task path
        // awaits the one-time resolution (M2a semantics).
        runtimeSession: await deps.resolveRuntimeSession(),
        // The product mutation policy — mv/rm refusals (skill identity
        // among them) come from IT, never from hardcoded runtime rules.
        mutationPolicy: mutationPolicy ? mutationPolicy() : undefined,
        // The execution authorization port (the product adapter supplies
        // the chat identity on its side; the runtime request carries none).
        authorization: authorization ? authorization() : undefined,
      };
      return deps.execute(c.name, c.input, workspace, o);
    },
  };
}
