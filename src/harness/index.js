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

import { TASK_OUTCOME_REASONS } from './task-runner.js';
export { createTaskRunner, isPersistenceFailure, TASK_OUTCOME_REASONS } from './task-runner.js';
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

// ---------- M2c: the PUBLIC capability declaration (contract §5) ----------
// A read-only statement about THIS harness: the port versions it implements
// and the semantic capabilities its behavior suites pin. Every declared item
// maps to a live implementation + behavior tests (M2C-DESIGN §5); table-
// derived fields are declared from the RESOLVED table's actual content and
// shape-checked — a hostile or partial table can never make this function
// claim something its content does not support, and a missing or malformed
// field is OMITTED, never fabricated and never guessed from versions,
// sources or arity.
//
// TWO VERSION CONCEPTS, never merged (contract §5):
//   contractVersion  — the PUBLIC harness protocol version (semantics of
//                      the ports/capabilities below; breaking changes bump it)
//   registryVersion  — the DECLARED __LOCUS_HARNESS_CORE__ table's INTERNAL
//                      registry version, surfaced under its own name only so
//                      consumers can detect a different harness generation.
//                      Same initial number, different meaning.
// Declaring is not checking: the Product owns compatibility decisions
// (src/product/core-compatibility.js); this function never judges a consumer.
function finiteInt(v) {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v ? v : null;
}

function legalKindsList(v) {
  return Array.isArray(v) && v.length > 0 && v.every((k) => typeof k === 'string' && k)
    ? Object.freeze(v.slice()) : null;
}

export function harnessCapabilities() {
  const table = readCoreTable();
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error('harnessCapabilities: no harness core resolved — call'
      + ' ensureHarnessCore() first (standalone hosts) or load the harness'
      + ' classic set (model-adapters/model/capabilities/extension-composition/'
      + 'approval/agent)');
  }
  const declaration = {
    contractVersion: 1,
    ports: {},
    capabilities: {},
  };
  const registryVersion = finiteInt(table.contractVersion);
  if (registryVersion !== null) declaration.registryVersion = registryVersion;

  // taskLifecycle — the runner's own constants (real enum + real caps).
  const lifecycle = { version: 1, outcomeReasons: TASK_OUTCOME_REASONS };
  const maxIter = finiteInt(table.MAX_TOOL_ITERATIONS);
  if (maxIter !== null) lifecycle.maxToolIterations = maxIter;
  const budget = finiteInt(table.HISTORY_BUDGET_BYTES);
  if (budget !== null) lifecycle.historyBudgetBytes = budget;
  declaration.ports.taskLifecycle = Object.freeze(lifecycle);

  // toolPort — the per-task frozen transportable-JSON definition snapshot
  // (agent.js; pinned by the harness-standalone F1/F1b blocks).
  declaration.ports.toolPort = Object.freeze({
    version: 1,
    snapshot: 'per-task-frozen-transportable-json',
  });

  // descriptionPort — OPTIONAL consumer: a session without one simply
  // prompts with no capability claims (harness-standalone H6).
  declaration.ports.descriptionPort = Object.freeze({ version: 1, optional: true });

  // modelClient — captured config/transport/relay per request
  // (createModelClient; pinned by F2 + H9).
  declaration.ports.modelClient = Object.freeze({ version: 1, configCaptured: true });

  // approval — kinds declared from the table's actual content; a hostile
  // (non-string-array) value is OMITTED, never reported as supported.
  const kinds = legalKindsList(table.APPROVAL_KINDS);
  const approval = { version: 1, sessionGrants: true };
  if (kinds) approval.kinds = kinds;
  declaration.ports.approval = Object.freeze(approval);

  // persistencePort — replay validation is Harness-owned (F3) and a
  // required-write failure ends the task persistence_error (§4 taxonomy).
  declaration.ports.persistencePort = Object.freeze({
    version: 1,
    replayValidators: 'harness-owned',
    requiredWriteOutcome: 'persistence_error',
  });

  // Semantic capabilities — implementation facts, each pinned by suites.
  declaration.capabilities.nativeToolCalls = true;      // H3 (native tool round trip)
  declaration.capabilities.textFallbackStrict = true;   // H2/H3 (fence rules)
  declaration.capabilities.taskEventIdentity = true;    // task-runner F2 stamping
  declaration.capabilities.providerReplay = true;       // harness-replay (real validators)
  declaration.capabilities.imageInputGate = Boolean(
    typeof table.createImageInputGate === 'function'
    && typeof table.ModelCapabilityRegistry === 'function'
    && typeof table.runImageInputProbe === 'function'
    && typeof table.classifyImageProviderError === 'function');
  declaration.capabilities.capabilityComposition = Boolean(
    typeof table.CapabilityManager === 'function'
    && typeof table.validatePluginPayload === 'function'
    && typeof table.pythonExtensionKeyOf === 'function');

  return deepFreezeDeclaration(declaration);
}

function deepFreezeDeclaration(value) {
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) deepFreezeDeclaration(value[k]);
    Object.freeze(value);
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
