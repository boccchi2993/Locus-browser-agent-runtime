// ============================================================
//  HARNESS REPLAY VALIDATION (M2b review round F3)
//
//  The durable-prefix validation ALGORITHMS, extracted verbatim from the
//  Product persistence module into the side that owns the semantics:
//  checkpoint/contiguous-sequence structure, provider-session identity
//  matching, the adapter classifier hand-off, and tool-call/result
//  pairing. Error codes, check order and result shapes are UNCHANGED
//  (tests/persistence-audit.test.cjs keeps auditing them; the harness
//  entry export is covered end-to-end by tests/harness-replay.test.mjs).
//
//  Pure logic: no DOM, no storage, no Vue, no Runtime, no Product
//  module. createProviderSessions consumes these as the DEFAULT for its
//  injected validator ports (an explicit injection still wins), and the
//  public entry re-exports them. The Product persistence module keeps
//  ONE-WAY compatibility delegates that resolve the single implementation
//  through the table published below — never a second copy.
// ============================================================

function replayValidationError(code, message) {
  var e = new Error(message);
  e.name = 'ReplayValidationError';
  e.code = code;
  e.replayInvalid = true;
  return e;
}

// Generic durable-prefix validation.  Provider-specific wire details remain
// adapter-owned, but identity, sequence and the basic tool-call/result
// pairing are checked before any raw state can reach serializeRequest().
function validateReplayPrefix(session, frames, adapter) {
  if (!session || typeof session !== 'object') throw replayValidationError('session_missing', 'provider session is missing');
  var checkpoint = session.replayCheckpointSequence;
  if (!Number.isInteger(checkpoint) || checkpoint < 0) throw replayValidationError('checkpoint_invalid', 'replay checkpoint must be a non-negative integer');
  var rows = Array.isArray(frames) ? frames.slice().sort(function (a, b) { return (a && a.sequence || 0) - (b && b.sequence || 0); }) : [];
  if (checkpoint === 0 && rows.length) throw replayValidationError('checkpoint_mismatch', 'checkpoint 0 requires an empty raw prefix');
  if (rows.length !== checkpoint) throw replayValidationError('checkpoint_beyond_tail', 'replay checkpoint ' + checkpoint + ' does not match the loaded frame tail');
  for (var i = 0; i < rows.length; i++) {
    var frame = rows[i];
    if (!frame || !Number.isInteger(frame.sequence) || frame.sequence !== i + 1) {
      throw replayValidationError('sequence_invalid', 'raw transcript must be a contiguous prefix 1..' + checkpoint);
    }
    if (frame.sessionId !== session.id) throw replayValidationError('session_identity_mismatch', 'raw frame has the wrong provider session id');
    if (frame.conversationId !== session.conversationId) throw replayValidationError('conversation_identity_mismatch', 'raw frame has the wrong conversation id');
  }
  // The adapter classifies raw provider state before any persisted metadata is
  // consulted.  A corrupt kind/role cannot therefore hide an assistant tool
  // call or a provider-neutral tool result from the pairing validator.
  if (!adapter || typeof adapter.inspectRawReplayFrame !== 'function') {
    throw replayValidationError('raw_classifier_missing', 'raw replay requires a provider raw-frame classifier');
  }
  var semanticRows = [];
  for (var j = 0; j < rows.length; j++) {
    var current = rows[j];
    var semantic;
    try {
      semantic = adapter.inspectRawReplayFrame(current);
    } catch (e) {
      throw replayValidationError('raw_semantics_invalid', 'provider raw replay frame is malformed: ' + (e && e.message ? e.message : String(e)));
    }
    if (!semantic || !semantic.semanticKind || !semantic.role || !Array.isArray(semantic.toolCallIds)) {
      throw replayValidationError('raw_semantics_invalid', 'provider raw replay classifier returned an invalid result');
    }
    if (!Object.prototype.hasOwnProperty.call(current, 'kind')
      || typeof current.kind !== 'string'
      || !Object.prototype.hasOwnProperty.call(current, 'role')
      || typeof current.role !== 'string') {
      throw replayValidationError('metadata_missing', 'raw replay frame is missing durable kind/role metadata');
    }
    if (current.role !== semantic.role) {
      throw replayValidationError('metadata_role_mismatch', 'raw replay role does not match persisted frame role');
    }
    if (semantic.semanticKind === 'assistant' && current.kind !== 'assistant') {
      throw replayValidationError('metadata_kind_mismatch', 'raw assistant frame must persist kind assistant');
    }
    if (semantic.semanticKind === 'tool_result' && current.kind !== 'tool_result') {
      throw replayValidationError('metadata_kind_mismatch', 'raw tool result frame must persist kind tool_result');
    }
    if (semantic.semanticKind === 'user' && current.kind !== 'user' && current.kind !== 'tool_feedback') {
      throw replayValidationError('metadata_kind_mismatch', 'raw user frame must persist kind user or tool_feedback');
    }
    if (semantic.semanticKind !== 'assistant' && semantic.semanticKind !== 'tool_result' && semantic.semanticKind !== 'user') {
      throw replayValidationError('raw_semantics_invalid', 'raw replay semantic kind is unknown');
    }
    if (semantic.semanticKind === 'tool_result') {
      if (!Object.prototype.hasOwnProperty.call(current, 'toolCallId')
        || typeof current.toolCallId !== 'string' || !current.toolCallId) {
        throw replayValidationError('tool_result_id_missing', 'raw tool result is missing persisted toolCallId metadata');
      }
      if (current.toolCallId !== semantic.toolResultId) {
        throw replayValidationError('tool_result_id_mismatch', 'raw tool result id does not match persisted toolCallId metadata');
      }
    } else if (current.toolCallId !== undefined && current.toolCallId !== null) {
      throw replayValidationError('tool_result_id_unexpected', 'non-tool-result raw frame has toolCallId metadata');
    }
    semanticRows.push({ frame: current, semantic: semantic });
  }

  var pending = null;
  for (var k = 0; k < semanticRows.length; k++) {
    var classified = semanticRows[k];
    var kind = classified.semantic.semanticKind;
    if (kind === 'assistant') {
      var ids = classified.semantic.toolCallIds;
      if (ids.some(function (id) { return typeof id !== 'string' || !id; })) {
        throw replayValidationError('tool_call_invalid', 'provider tool-call ids must be non-empty strings');
      }
      if (new Set(ids).size !== ids.length) throw replayValidationError('tool_call_duplicate', 'provider tool-call ids must be unique within an assistant frame');
      if (pending) throw replayValidationError('tool_batch_dangling', 'a new assistant frame starts before the previous tool batch completed');
      if (ids.length) pending = { ids: new Set(ids), seen: new Set() };
    } else if (kind === 'tool_result') {
      if (!pending) throw replayValidationError('tool_result_unpaired', 'tool result has no preceding provider tool call');
      var id = classified.semantic.toolResultId;
      if (!pending.ids.has(id)) throw replayValidationError('tool_result_unpaired', 'tool result id does not belong to the pending tool batch');
      if (pending.seen.has(id)) throw replayValidationError('tool_result_duplicate', 'duplicate tool result id in provider tool batch');
      pending.seen.add(id);
      if (pending.seen.size === pending.ids.size) pending = null;
    } else if (pending) {
      throw replayValidationError('tool_batch_interrupted', 'raw user frame interrupts a pending provider tool batch');
    }
  }
  if (pending) throw replayValidationError('tool_batch_dangling', 'replay checkpoint ends inside a provider tool batch');
  return { valid: true, checkpoint: checkpoint, frames: rows };
}

function validateNormalizedPrefix(conversationId, rows) {
  var list = Array.isArray(rows) ? rows.slice().sort(function (a, b) { return (a && a.sequence || 0) - (b && b.sequence || 0); }) : [];
  for (var i = 0; i < list.length; i++) {
    if (!list[i] || list[i].conversationId !== conversationId || list[i].sequence !== i + 1) {
      throw replayValidationError('normalized_sequence_invalid', 'normalized history is not a contiguous conversation prefix');
    }
  }
  var pending = null;
  for (var j = 0; j < list.length; j++) {
    var row = list[j];
    var calls = Array.isArray(row.toolCalls) ? row.toolCalls.map(function (c) { return c && c.id; }).filter(function (id) { return typeof id === 'string' && id; }) : [];
    if (row.kind === 'tool_call' && calls.length) {
      if (pending) throw replayValidationError('normalized_tool_batch_dangling', 'normalized history starts a tool batch before the previous one completed');
      pending = { ids: new Set(calls), seen: new Set() };
    } else if (row.kind === 'tool_result' || row.role === 'tool_result') {
      if (!pending || !pending.ids.has(row.toolCallId) || pending.seen.has(row.toolCallId)) {
        throw replayValidationError('normalized_tool_result_invalid', 'normalized tool result is not paired with its tool call');
      }
      pending.seen.add(row.toolCallId);
      if (pending.seen.size === pending.ids.size) pending = null;
    }
  }
  if (pending) throw replayValidationError('normalized_tool_batch_dangling', 'normalized history ends inside a tool batch');
  return { valid: true, rows: list };
}

// Explicit publish (the M2a/M2b ESM self-assembly pattern): classic
// scripts cannot import ES modules, so the Product persistence module's
// ONE-WAY compatibility delegates resolve the single implementation
// through this table. In the product page the entry module graph
// evaluates this file before any delegate can run.
globalThis.__LOCUS_HARNESS_REPLAY_VALIDATION__ = Object.freeze({
  validateReplayPrefix: validateReplayPrefix,
  validateNormalizedPrefix: validateNormalizedPrefix,
});

export { replayValidationError, validateReplayPrefix, validateNormalizedPrefix };
