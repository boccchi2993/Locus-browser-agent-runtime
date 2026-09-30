// ============================================================
//  LOCUS HARNESS — PUBLIC ENTRY (M2b, repository split)
//
//  The importable boundary the split contracts prescribe: agent loop
//  (AgentSession), task lifecycle (task-runner), provider-session
//  preparation, the model client factory, provider adapters, approval
//  semantics, image-capability gating and the capability-composition
//  core — ONE module a standalone host imports with explicit
//  dependencies. No Runtime, no Vue, no Locus page, no IDB/OPFS.
//
//  ASSEMBLY — two modes over ONE implementation set (the M2a pattern):
//    1. CLASSIC TABLE: the host page loaded the harness classic scripts
//       (model-adapters/model/capabilities/extension-composition/approval/
//       agent); agent.js published the frozen __LOCUS_HARNESS_CORE__
//       table. The entry DELEGATES to it — a mixed page keeps exactly
//       one copy of every definition (the product page path).
//    2. SELF-ASSEMBLY: no table — ensureHarnessCore() dynamically
//       imports ./core.js (ONE memoized import): the SAME sources as ES
//       modules; each file publishes its cross-file names explicitly.
//       Merely lacking classic scripts is NOT an error.
//  Importing this module performs NO fetch, NO DOM access, NO storage
//  open and starts NO runtime; the dynamic import fires only inside
//  ensureHarnessCore() and never on a table page.
//
//  FACTORY SHAPE: the entry exports thin factories (createAgentSession,
//  createApprovalController, createModelClient, …) instead of binding
//  classes at import time — the core resolves through the table, which
//  on a table page is synchronous. A standalone host awaits
//  ensureHarnessCore() once, then constructs. Missing names fail with a
//  targeted error naming the missing implementation (a broken or
//  partial table is an assembly bug, never a silent fallback).
//
//  No HarnessHost/HarnessSession wrappers are invented: the entry
//  exposes the EXISTING AgentSession / TaskRunner / provider-sessions
//  surfaces and nothing more.
// ============================================================

export { createTaskRunner, isPersistenceFailure } from './task-runner.js';
export { createProviderSessions } from './provider-session.js';
// Review round F3: the durable-prefix validation ALGORITHMS are Harness
// semantics — re-exported here so a standalone host restores provider
// sessions with the REAL validators, never injected fakes.
export {
  replayValidationError, validateReplayPrefix, validateNormalizedPrefix,
} from './replay-validation.js';

// ---------- core resolution ----------
function readCoreTable() {
  return globalThis.__LOCUS_HARNESS_CORE__ || null;
}

let coreAssembly = null;

// Idempotent: resolves the harness core through the declared table when
// present, otherwise ONE memoized self-assembly of the same sources.
// Standalone hosts call this once before the factories; a table page
// resolves synchronously.
export async function ensureHarnessCore() {
  if (readCoreTable()) return readCoreTable();
  if (!coreAssembly) {
    coreAssembly = import('./core.js').then(() => {
      const table = readCoreTable();
      if (!table) {
        throw new Error('harness core self-assembly produced no __LOCUS_HARNESS_CORE__ table');
      }
      return table;
    });
  }
  return coreAssembly;
}

// Targeted resolution: a missing name is an assembly error naming the
// missing implementation — never a silent fallback.
function harness(name) {
  const table = readCoreTable();
  const value = table && table[name];
  if (value === undefined) {
    throw new Error('Locus harness core is missing "' + name + '": call'
      + ' ensureHarnessCore() first (standalone hosts) or load the harness'
      + ' classic set (model-adapters/model/capabilities/extension-composition/'
      + 'approval/agent)');
  }
  return value;
}

// ---------- agent loop ----------
export function createAgentSession(deps) {
  return new (harness('AgentSession'))(deps);
}

export function buildSystemPrompt(opts) {
  return harness('buildSystemPrompt')(opts);
}

// Constants resolve lazily (the core may self-assemble after import), so
// they surface as functions — the store reads them at submit time.
export function historyBudgetBytes() {
  return harness('HISTORY_BUDGET_BYTES');
}

export function maxToolIterations() {
  return harness('MAX_TOOL_ITERATIONS');
}

// ---------- task lifecycle (real ESM since M1a) ----------
// (re-exported above)

// ---------- model layer ----------
export function createModelClient(opts) {
  return harness('createModelClient')(opts);
}

export function getProviderAdapter(config) {
  return harness('getProviderAdapter')(config);
}

export function createProviderIdentity(config) {
  return harness('createProviderIdentity')(config);
}

export function createCredentialIdentity(config) {
  return harness('createCredentialIdentity')(config);
}

export function projectNormalizedHistory(messages, dialect) {
  return harness('projectNormalizedHistory')(messages, dialect);
}

// ---------- approval semantics ----------
export function createApprovalController(opts) {
  return new (harness('ApprovalController'))(opts);
}

export function approvalKinds() {
  return harness('APPROVAL_KINDS');
}

// ---------- perception (image capability gating) ----------
export function createModelCapabilityRegistry(opts) {
  return new (harness('ModelCapabilityRegistry'))(opts);
}

export function createImageInputGate(opts) {
  return harness('createImageInputGate')(opts);
}

export function runImageInputProbe(opts) {
  return harness('runImageInputProbe')(opts);
}

export function classifyImageProviderError(e) {
  return harness('classifyImageProviderError')(e);
}

export function imageInputUnavailableNotice(result) {
  return harness('imageInputUnavailableNotice')(result);
}

// ---------- capability composition core ----------
export function createCapabilityManager(opts) {
  return new (harness('CapabilityManager'))(opts);
}

export function createSkillSourceStore(opts) {
  return new (harness('SkillSourceStore'))(opts);
}

export function pythonExtensionKeyOf(plugins) {
  return harness('pythonExtensionKeyOf')(plugins);
}

export function validatePluginPayload(plugin, payload) {
  return harness('validatePluginPayload')(plugin, payload);
}

export function registerPluginRuntimeProvider(runtime, provider) {
  return harness('registerPluginRuntimeProvider')(runtime, provider);
}
