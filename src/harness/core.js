// ============================================================
//  HARNESS CORE — SELF-ASSEMBLY MODULE (M2b)
//
//  The SAME classic sources the product page loads as classic scripts,
//  imported here as ES modules for hosts that carry no classic copies.
//  This module is fetched ONLY by the public entry's self-assembly path
//  (src/harness/index.js resolves the declared __LOCUS_HARNESS_CORE__
//  table first and delegates to it) — a mixed page therefore never loads
//  a second copy of any harness definition.
//
//  Load order mirrors the classic page exactly (model-adapters → model →
//  capabilities → extension-composition → approval → agent). The
//  cross-file edges (model.js → getProviderAdapter; the table assembly
//  in agent.js) are satisfied by the explicit globalThis publishes each
//  file appends for exactly this mode.
//
//  NOT included (and never): src/tools.js — the product tool registry
//  and execution router are PRODUCT adapter code (contract §3.2); the
//  Harness receives its tool surface through the injected ToolPort.
// ============================================================

import '../model-adapters.js';
import '../model.js';
import '../capabilities.js';
import '../extension-composition.js';
import '../approval.js';
import '../agent.js';
