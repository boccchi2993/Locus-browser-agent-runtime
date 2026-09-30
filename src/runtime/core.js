// ============================================================
//  RUNTIME CORE — SELF-ASSEMBLY MODULE (M2a review round)
//
//  The SAME five classic sources the product page loads as classic
//  scripts, imported here as ES modules for hosts that carry no classic
//  copies. This module is fetched ONLY by the public entry's
//  self-assembly path (src/runtime/index.js resolves the declared
//  __LOCUS_RUNTIME_CORE__ registry first and delegates to it) — a mixed
//  page therefore never loads a second copy of any core definition.
//
//  Load order matters and mirrors the classic page exactly:
//  telemetry → workspace → vfs → network → shell. The one load-time
//  cross-file edge (vfs.js `extends WorkspaceAdapter`) is satisfied by
//  the explicit publishes each file appends for exactly this mode.
// ============================================================

import '../telemetry.js';
import '../workspace.js';
import '../vfs.js';
import '../network.js';
import '../shell.js';
