// ============================================================
//  LOCUS BROWSER-LOCAL PERSISTENCE
//
//  IndexedDB is the canonical metadata/history store. OPFS is the durable
//  byte store for the local machine (/home/locus and /mnt/plugins). This is
//  deliberately a classic script so the framework-independent runtime and
//  the Vue store share one substrate without reaching into browser storage
//  APIs themselves.
// ============================================================

var PERSISTENCE_SCHEMA_VERSION = 3;
var PERSISTENCE_DB_NAME = 'locus';

// One canonical home layout.  The VFS consumes the same value when it
// creates its memory provider, while OPFS consumes it after mount/clear/reset.
var LOCUS_HOME_SKELETON = [
  '.skills',
  '.config/locus/mcp',
  '.cache/locus',
];

var PERSISTENCE_STORES = [
  'conversations', 'presentationEvents', 'providerSessions',
  'providerFrames', 'normalizedMessages', 'settings', 'secrets',
  'workspaceHandles', 'meta', 'attachments', 'capabilities',
];

function persistenceUuid(prefix) {
  var c = typeof crypto !== 'undefined' && crypto.randomUUID;
  return (c ? crypto.randomUUID() : prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
}

function persistenceClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  // The supported browser path has structuredClone.  This fallback is only
  // for older test/runtime hosts; keep the same supported semantic types
  // instead of silently converting them to JSON.
  return persistenceCloneFallback(value, new Map());
}

function persistenceCloneFallback(value, seen) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') throw persistenceSerializationError('functions are not persistable');
    return value;
  }
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) {
    var array = []; seen.set(value, array);
    for (var ai = 0; ai < value.length; ai++) array[ai] = persistenceCloneFallback(value[ai], seen);
    return array;
  }
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) return new DataView(persistenceCloneFallback(value.buffer, seen), value.byteOffset, value.byteLength);
    return new value.constructor(value);
  }
  if (value instanceof Map) {
    var map = new Map(); seen.set(value, map);
    value.forEach(function (v, k) { map.set(persistenceCloneFallback(k, seen), persistenceCloneFallback(v, seen)); });
    return map;
  }
  if (value instanceof Set) {
    var set = new Set(); seen.set(value, set);
    value.forEach(function (v) { set.add(persistenceCloneFallback(v, seen)); });
    return set;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.slice(0, value.size, value.type);
  if (typeof value === 'function' || value.nodeType || value === globalThis) {
    throw persistenceSerializationError('unsupported non-cloneable value');
  }
  var out = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  seen.set(value, out);
  Object.keys(value).forEach(function (key) { out[key] = persistenceCloneFallback(value[key], seen); });
  return out;
}

function persistenceSerializationError(message, cause) {
  var e = new Error(message);
  e.name = 'PersistenceSerializationError';
  e.code = 'persistence_serialization_failed';
  if (cause) e.cause = cause;
  return e;
}

function persistenceError(message, cause) {
  var e = new Error(message);
  e.name = 'PersistenceError';
  e.code = 'persistence_write_failed';
  if (cause) e.cause = cause;
  return e;
}

function storageClearError(paths, cause) {
  var e = new Error('storage clear partially failed for: ' + paths.join(', '));
  e.name = 'StorageClearError';
  e.code = 'storage_clear_failed';
  e.failedPaths = paths.slice();
  e.partial = true;
  if (cause) e.cause = cause;
  return e;
}

function persistenceNow() { return new Date().toISOString(); }

function persistenceMemoryStores() {
  var out = {};
  for (var i = 0; i < PERSISTENCE_STORES.length; i++) out[PERSISTENCE_STORES[i]] = new Map();
  return out;
}

function persistenceUpgrade(db, oldVersion, newVersion, tx) {
  // The explicit migration path is intentionally boring. Future schema
  // versions must add a branch here rather than infer old shapes at read time.
  if (oldVersion < 1) {
    db.createObjectStore('conversations', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
    var events = db.createObjectStore('presentationEvents', { keyPath: 'id' });
    events.createIndex('conversationSequence', ['conversationId', 'sequence'], { unique: true });
    events.createIndex('conversationId', 'conversationId');
    var sessions = db.createObjectStore('providerSessions', { keyPath: 'id' });
    sessions.createIndex('conversationId', 'conversationId');
    var frames = db.createObjectStore('providerFrames', { keyPath: 'id' });
    frames.createIndex('sessionSequence', ['sessionId', 'sequence'], { unique: true });
    frames.createIndex('sessionId', 'sessionId');
    frames.createIndex('conversationId', 'conversationId');
    var normalized = db.createObjectStore('normalizedMessages', { keyPath: 'id' });
    normalized.createIndex('conversationSequence', ['conversationId', 'sequence'], { unique: true });
    normalized.createIndex('conversationId', 'conversationId');
    db.createObjectStore('settings', { keyPath: 'key' });
    db.createObjectStore('secrets', { keyPath: 'key' });
    db.createObjectStore('workspaceHandles', { keyPath: 'key' });
    db.createObjectStore('meta', { keyPath: 'key' });
  }
  if (oldVersion < 2) {
    var providerFrames = tx.objectStore('providerFrames');
    if (!providerFrames.indexNames.contains('conversationId')) {
      providerFrames.createIndex('conversationId', 'conversationId');
    }
    // v1's global apiKey has no destination identity.  Never guess where it
    // belongs; migration deliberately removes it and asks the user again.
    var secrets = tx.objectStore('secrets');
    secrets.delete('apiKey');
  }
  if (oldVersion < 3) {
    // Image Feedback v1: durable attachment metadata + the Harness-owned
    // model capability registry. Attachment BYTES live in OPFS, never here.
    db.createObjectStore('attachments', { keyPath: 'id' }).createIndex('sha256', 'sha256', { unique: false });
    db.createObjectStore('capabilities', { keyPath: 'key' });
  }
}

function persistenceRequest(request) {
  return new Promise(function (resolve, reject) {
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error || new Error('IndexedDB request failed')); };
  });
}

function persistenceTx(tx) {
  return new Promise(function (resolve, reject) {
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error || new Error('IndexedDB transaction failed')); };
    tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
  });
}

function persistenceSafeString(value) {
  return typeof value === 'string' ? value : String(value == null ? '' : value);
}

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

class PersistenceService {
  constructor(opts) {
    this.name = (opts && opts.name) || PERSISTENCE_DB_NAME;
    this.version = PERSISTENCE_SCHEMA_VERSION;
    this.db = null;
    this.mode = 'memory';
    this.memory = persistenceMemoryStores();
    this.opfsRoot = null;
    this.opfsAvailable = false;
    this.initializationError = null;
    this.secrets = new Set();
    // Memory-mode backing for content-addressed attachment bytes (the OPFS
    // path is unavailable). Keyed by storageKey (sha256 hex).
    this.memoryAttachmentBytes = new Map();
    this.persistenceHealth = 'healthy'; // healthy | degraded | unavailable
    this.lastPersistenceError = null;
    this.ready = this.init();
  }

  _recordPersistenceError(error, operation) {
    var e = error instanceof Error ? error : new Error(String(error));
    this.persistenceHealth = this.mode === 'memory' && this.initializationError
      ? 'unavailable' : 'degraded';
    this.lastPersistenceError = {
      operation: operation || 'persistence',
      name: e.name || 'Error',
      message: e.message || String(e),
      code: e.code || null,
      at: persistenceNow(),
    };
    return e;
  }

  notePersistenceError(error, operation) { return this._recordPersistenceError(error, operation); }

  _throwPersistenceError(error, operation) {
    var recorded = this._recordPersistenceError(error, operation);
    if (recorded.name === 'PersistenceError' || recorded.name === 'PersistenceSerializationError' || recorded.name === 'StorageClearError') throw recorded;
    throw persistenceError((operation || 'persistence') + ' failed: ' + recorded.message, recorded);
  }

  async init() {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
      this.db = await new Promise(function (resolve, reject) {
        var req = indexedDB.open(PERSISTENCE_DB_NAME, PERSISTENCE_SCHEMA_VERSION);
        req.onupgradeneeded = function (event) {
          persistenceUpgrade(req.result, event.oldVersion, event.newVersion, req.transaction);
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
        req.onblocked = function () { reject(new Error('IndexedDB open blocked')); };
      });
      this.db.onversionchange = function () { try { this.close(); } catch (e) {} };
      this.mode = 'indexeddb';
      await this._loadSecrets();
    } catch (e) {
      this.initializationError = e;
      this.mode = 'memory';
      this.db = null;
      this.persistenceHealth = 'unavailable';
      this.lastPersistenceError = {
        operation: 'init', name: e.name || 'Error', message: e.message || String(e),
        code: 'persistence_unavailable', at: persistenceNow(),
      };
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
        this.opfsRoot = await navigator.storage.getDirectory();
        this.opfsAvailable = !!this.opfsRoot;
      }
    } catch (e) {
      this.opfsRoot = null;
      this.opfsAvailable = false;
    }
    return this;
  }

  _store(name) {
    if (!PERSISTENCE_STORES.includes(name)) throw new Error('Unknown persistence store: ' + name);
    return this.db.transaction(name, 'readwrite').objectStore(name);
  }

  async get(storeName, key) {
    await this.ready;
    try {
      if (this.db) return await persistenceRequest(this.db.transaction(storeName, 'readonly').objectStore(storeName).get(key));
      var value = this.memory[storeName].get(key);
      return value === undefined ? null : persistenceClone(value);
    } catch (e) { this._throwPersistenceError(e, 'get ' + storeName); }
  }

  async all(storeName) {
    await this.ready;
    try {
      if (this.db) return await persistenceRequest(this.db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
      return Array.from(this.memory[storeName].values()).map(persistenceClone);
    } catch (e) { this._throwPersistenceError(e, 'all ' + storeName); }
  }

  async put(storeName, value) {
    await this.ready;
    try {
      var copy = persistenceClone(value);
      var key = copy && copy.id !== undefined ? copy.id : copy && copy.key;
      if (key === undefined) throw persistenceSerializationError('persisted record has no id/key for ' + storeName);
      if (this.db) {
        var tx = this.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(copy);
        await persistenceTx(tx);
      } else {
        this.memory[storeName].set(key, copy);
      }
      return copy;
    } catch (e) { this._throwPersistenceError(e, 'put ' + storeName); }
  }

  async delete(storeName, key) {
    await this.ready;
    try {
      if (this.db) {
        var tx = this.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        await persistenceTx(tx);
      } else this.memory[storeName].delete(key);
    } catch (e) { this._throwPersistenceError(e, 'delete ' + storeName); }
  }

  async clear(storeName) {
    await this.ready;
    try {
      if (this.db) {
        var tx = this.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        await persistenceTx(tx);
      } else this.memory[storeName].clear();
    } catch (e) { this._throwPersistenceError(e, 'clear ' + storeName); }
  }

  async _byIndex(storeName, indexName, query) {
    await this.ready;
    try {
      if (!this.db) {
        var values = Array.from(this.memory[storeName].values());
        return values.filter(function (v) {
          if (indexName === 'conversationId') return v.conversationId === query;
          if (indexName === 'sessionId') return v.sessionId === query;
          if (indexName === 'conversationSequence') return v.conversationId === query[0];
          if (indexName === 'sessionSequence') return v.sessionId === query[0];
          return false;
        }).sort(function (a, b) { return (a.sequence || 0) - (b.sequence || 0); }).map(persistenceClone);
      }
      var tx = this.db.transaction(storeName, 'readonly');
      var index = tx.objectStore(storeName).index(indexName);
      var range = Array.isArray(query) ? IDBKeyRange.bound(query, query) : IDBKeyRange.only(query);
      return await persistenceRequest(index.getAll(range));
    } catch (e) { this._throwPersistenceError(e, 'index ' + storeName + '/' + indexName); }
  }

  _redact(value) {
    var self = this;
    var seen = typeof WeakMap !== 'undefined' ? new WeakMap() : new Map();
    function redact(v) {
      if (typeof v === 'function') throw persistenceSerializationError('functions are not persistable');
      if (typeof v === 'string') {
        var out = v;
        self.secrets.forEach(function (secret) { if (secret) out = out.split(secret).join('[REDACTED]'); });
        return out;
      }
      if (v === null || typeof v !== 'object') return v;
      if (seen.has(v)) return seen.get(v);

      // These are the structured-clone semantic types that the old
      // object-rebuild implementation silently destroyed.
      if (Array.isArray(v)) {
        var array = []; seen.set(v, array);
        for (var ai = 0; ai < v.length; ai++) array[ai] = redact(v[ai]);
        return array;
      }
      if (v instanceof Date) return new Date(v.getTime());
      if (v instanceof ArrayBuffer) return v.slice(0);
      if (ArrayBuffer.isView(v)) {
        if (v instanceof DataView) return new DataView(v.buffer.slice(0), v.byteOffset, v.byteLength);
        return new v.constructor(v);
      }
      if (v instanceof Map) {
        var map = new Map(); seen.set(v, map);
        v.forEach(function (mv, mk) { map.set(redact(mk), redact(mv)); });
        return map;
      }
      if (v instanceof Set) {
        var set = new Set(); seen.set(v, set);
        v.forEach(function (sv) { set.add(redact(sv)); });
        return set;
      }
      if (typeof Blob !== 'undefined' && v instanceof Blob) return v.slice(0, v.size, v.type);
      if (v.nodeType || v === globalThis) throw persistenceSerializationError('unsupported non-cloneable object');

      var proto = Object.getPrototypeOf(v);
      // Custom class instances are not reliably structured-cloned across
      // browsers. Preserve their enumerable data, then let the final clone
      // reject anything the platform cannot store; never JSON-coerce it.
      var obj = Object.create(proto === null ? null : Object.prototype);
      seen.set(v, obj);
      Object.keys(v).forEach(function (k) { obj[k] = redact(v[k]); });
      return obj;
    }
    return redact(value);
  }

  async _loadSecrets() {
    var rows = this.db
      ? await persistenceRequest(this.db.transaction('secrets', 'readonly').objectStore('secrets').getAll())
      : Array.from(this.memory.secrets.values());
    this.secrets = new Set(rows.map(function (r) { return r.value; }).filter(function (v) { return typeof v === 'string' && v; }));
  }

  async saveSettings(settings) {
    var keys = ['apiBase', 'model', 'proxy', 'dialect'];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      await this.put('settings', { key: key, value: persistenceSafeString(settings[key] || '') });
    }
  }

  async loadSettings(config) {
    var rows = await this.all('settings');
    var out = {};
    rows.forEach(function (r) { out[r.key] = r.value; });
    if (config) {
      var remembered = await this.loadRememberedApiKey(config);
      if (remembered) out.apiKey = remembered;
      out.remember = !!remembered;
    } else {
      out.remember = false;
    }
    return out;
  }

  _credentialIdentity(config) {
    if (!config) throw persistenceSerializationError('credential destination identity is required');
    if (typeof createCredentialIdentity === 'function') return createCredentialIdentity(config);
    var endpoint = String(config.endpointIdentity || config.apiBase || '').trim();
    if (!endpoint) throw persistenceSerializationError('credential endpoint identity is required');
    return {
      provider: String(config.provider || ''), adapterId: String(config.adapterId || ''),
      dialect: String(config.dialect || ''), endpointIdentity: endpoint,
    };
  }

  _credentialKey(identity) {
    return 'credential:' + encodeURIComponent([
      identity.provider, identity.adapterId, identity.dialect, identity.endpointIdentity,
    ].join('|'));
  }

  async loadRememberedApiKey(config) {
    var identity;
    try { identity = this._credentialIdentity(config); } catch (e) { return null; }
    var row = await this.get('secrets', this._credentialKey(identity));
    return row && typeof row.value === 'string' && row.value ? row.value : null;
  }

  async setRememberedApiKey(value, remember, config) {
    var identity = this._credentialIdentity(config);
    var key = this._credentialKey(identity);
    var secret = persistenceSafeString(value || '').trim();
    if (!remember || !secret) {
      await this.delete('secrets', key);
      await this._loadSecrets();
      return;
    }
    var old = await this.get('secrets', key);
    await this.put('secrets', {
      key: key, id: key, value: secret,
      provider: identity.provider, adapterId: identity.adapterId,
      dialect: identity.dialect, endpointIdentity: identity.endpointIdentity,
      createdAt: old && old.createdAt || persistenceNow(), updatedAt: persistenceNow(),
    });
    await this._loadSecrets();
  }

  async forgetApiKeys() {
    await this.clear('secrets');
    this.secrets.clear();
  }

  async saveConversation(record) {
    return this.put('conversations', this._redact(record));
  }

  async loadConversations() {
    var rows = await this.all('conversations');
    return rows.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
  }

  async deleteConversation(conversationId) {
    await this.ready;
    try {
      if (!this.db) {
        var had = this.memory.conversations.has(conversationId);
        var names = ['presentationEvents', 'providerSessions', 'providerFrames', 'normalizedMessages'];
        for (var mi = 0; mi < names.length; mi++) {
          var mem = this.memory[names[mi]];
          for (var mk of Array.from(mem.values())) {
            if (mk.conversationId === conversationId) mem.delete(mk.id !== undefined ? mk.id : mk.key);
          }
        }
        this.memory.conversations.delete(conversationId);
        return had;
      }

      // All five stores share one atomic transaction.  In particular,
      // providerFrames are selected by conversationId, so an orphan frame
      // cannot survive merely because its providerSession row is missing.
      var tx = this.db.transaction([
        'conversations', 'presentationEvents', 'providerSessions',
        'providerFrames', 'normalizedMessages',
      ], 'readwrite');
      var stores = ['presentationEvents', 'providerSessions', 'providerFrames', 'normalizedMessages'];
      for (var i = 0; i < stores.length; i++) {
        var objectStore = tx.objectStore(stores[i]);
        var request = objectStore.index('conversationId').getAll(IDBKeyRange.only(conversationId));
        request.onsuccess = (function (targetStore, event) {
          var rows = event.target.result || [];
          for (var j = 0; j < rows.length; j++) targetStore.delete(rows[j].id);
        }).bind(null, objectStore);
      }
      var found = null;
      var convRequest = tx.objectStore('conversations').get(conversationId);
      convRequest.onsuccess = function () {
        found = convRequest.result || null;
        tx.objectStore('conversations').delete(conversationId);
      };
      await persistenceTx(tx);
      return !!found;
    } catch (e) { this._throwPersistenceError(e, 'delete conversation ' + conversationId); }
  }

  async appendPresentationEvent(conversationId, sequence, event) {
    var row = {
      id: persistenceUuid('event'), conversationId: conversationId, sequence: sequence,
      event: this._redact(event), createdAt: persistenceNow(), schemaVersion: this.version,
    };
    return this.put('presentationEvents', row);
  }

  async saveProviderSession(row) { return this.put('providerSessions', this._redact(row)); }

  async loadProviderSession(conversationId) {
    var rows = await this._byIndex('providerSessions', 'conversationId', conversationId);
    return rows.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); })[0] || null;
  }

  async appendProviderFrame(row) {
    var frame = Object.assign({ id: persistenceUuid('frame'), createdAt: persistenceNow(), schemaVersion: this.version }, row);
    return this.put('providerFrames', this._redact(frame));
  }

  async loadProviderFrames(sessionId, maxSequence) {
    var rows = await this._byIndex('providerFrames', 'sessionId', sessionId);
    return rows.filter(function (r) { return maxSequence == null || r.sequence <= maxSequence; })
      .sort(function (a, b) { return a.sequence - b.sequence; });
  }

  async saveNormalizedMessage(row) {
    var message = Object.assign({ id: persistenceUuid('message'), createdAt: persistenceNow(), schemaVersion: this.version }, row);
    return this.put('normalizedMessages', this._redact(message));
  }

  async loadNormalizedMessages(conversationId) {
    return (await this._byIndex('normalizedMessages', 'conversationId', conversationId))
      .sort(function (a, b) { return a.sequence - b.sequence; });
  }

  async saveWorkspaceHandle(handle) {
    if (!handle) return;
    await this.put('workspaceHandles', { key: 'externalWorkspace', handle: handle, updatedAt: persistenceNow() });
  }

  async loadWorkspaceHandle() {
    var row = await this.get('workspaceHandles', 'externalWorkspace');
    return row && row.handle ? row.handle : null;
  }

  async forgetWorkspaceHandle() { await this.delete('workspaceHandles', 'externalWorkspace'); }

  async opfsDirectory(parts, create) {
    await this.ready;
    try {
      if (!this.opfsRoot) throw new Error('OPFS unavailable');
      var dir = this.opfsRoot;
      for (var i = 0; i < (parts || []).length; i++) dir = await dir.getDirectoryHandle(parts[i], { create: create !== false });
      return dir;
    } catch (e) { this._throwPersistenceError(e, 'OPFS directory ' + (parts || []).join('/')); }
  }

  async storageStatus() {
    var estimate = null;
    var persistent = null;
    try { if (navigator.storage && navigator.storage.estimate) estimate = await navigator.storage.estimate(); } catch (e) {}
    try { if (navigator.storage && navigator.storage.persisted) persistent = await navigator.storage.persisted(); } catch (e) {}
    return {
      mode: this.mode, dbName: this.name, schemaVersion: this.version,
      opfs: this.opfsAvailable, persistent: persistent,
      usage: estimate && typeof estimate.usage === 'number' ? estimate.usage : null,
      quota: estimate && typeof estimate.quota === 'number' ? estimate.quota : null,
      error: this.initializationError ? String(this.initializationError.message || this.initializationError) : null,
      persistenceHealth: this.persistenceHealth,
      lastPersistenceError: this.lastPersistenceError,
    };
  }

  async requestPersistentStorage() {
    if (!navigator.storage || !navigator.storage.persist) return false;
    return !!(await navigator.storage.persist());
  }

  async clearConversations() {
    await this.ready;
    try {
      var names = ['conversations', 'presentationEvents', 'providerSessions', 'providerFrames', 'normalizedMessages'];
      if (this.db) {
        var tx = this.db.transaction(names, 'readwrite');
        for (var i = 0; i < names.length; i++) tx.objectStore(names[i]).clear();
        await persistenceTx(tx);
      } else {
        for (var j = 0; j < names.length; j++) this.memory[names[j]].clear();
      }
      // Durable attachment snapshots exist only to serve conversations —
      // clearing conversations clears their bytes too. The capability
      // registry is Harness control-plane state and is deliberately kept.
      await this.clearAttachments();
    } catch (e) { this._throwPersistenceError(e, 'clear conversations'); }
  }

  async _clearOpfsDir(parts) {
    var dir;
    try { dir = await this.opfsDirectory(parts, false); }
    catch (e) {
      if (e && (e.name === 'NotFoundError' || e.cause && e.cause.name === 'NotFoundError')) return;
      this._throwPersistenceError(e, 'open OPFS ' + parts.join('/'));
    }
    var entries = [];
    try {
      for await (var pair of dir.entries()) entries.push(pair);
    } catch (e) {
      throw storageClearError([parts.join('/')], e);
    }
    var failures = [];
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i][0];
      var handle = entries[i][1];
      var target = parts.join('/') + '/' + name;
      try {
        if (handle.kind === 'directory') await this._clearOpfsEntry(handle, target, failures);
        await dir.removeEntry(name, { recursive: handle.kind === 'directory' });
      } catch (e) { failures.push({ path: target, error: e }); }
    }
    if (failures.length) throw storageClearError(failures.map(function (f) { return f.path; }), failures[0].error);
  }

  async _clearOpfsEntry(dir, path, failures) {
    var entries = [];
    try {
      for await (var pair of dir.entries()) entries.push(pair);
    } catch (e) {
      failures.push({ path: path, error: e });
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i][0];
      var handle = entries[i][1];
      var target = path + '/' + name;
      try {
        if (handle.kind === 'directory') await this._clearOpfsEntry(handle, target, failures);
        await dir.removeEntry(name, { recursive: handle.kind === 'directory' });
      } catch (e) { failures.push({ path: target, error: e }); }
    }
  }

  async ensureHomeSkeleton() {
    if (!this.opfsRoot) return false; // memory-only mode has the VFS skeleton
    for (var i = 0; i < LOCUS_HOME_SKELETON.length; i++) {
      var parts = ['home', 'locus'].concat(LOCUS_HOME_SKELETON[i].split('/'));
      await this.opfsDirectory(parts, true);
    }
  }

  async clearHome() {
    if (!this.opfsRoot) return false;
    try {
      await this._clearOpfsDir(['home', 'locus']);
      await this.ensureHomeSkeleton();
    } catch (e) {
      if (e && e.name === 'StorageClearError') this._recordPersistenceError(e, 'clear home');
      else this._recordPersistenceError(e, 'clear home');
      throw e;
    }
  }
  async clearPlugins() {
    if (!this.opfsRoot) return false;
    try { await this._clearOpfsDir(['mnt', 'plugins']); }
    catch (e) { this._recordPersistenceError(e, 'clear plugins'); throw e; }
  }

  // Privileged plugin installation seam. The normal agent-facing VFS mounts
  // /mnt/plugins with system-read-only authority; only an explicit host
  // integration may call this method.
  async writePlugin(path, data) {
    try {
      var rel = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel || rel.split('/').some(function (part) { return !part || part === '..' || part.includes(':'); })) throw new Error('invalid plugin path');
      var parts = rel.split('/');
      var file = parts.pop();
      var dir = await this.opfsDirectory(['mnt', 'plugins'].concat(parts), true);
      var writable = await (await dir.getFileHandle(file, { create: true })).createWritable();
      if (typeof data === 'string') await writable.write(data);
      else {
        var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        await writable.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      }
      await writable.close();
    } catch (e) { this._throwPersistenceError(e, 'write plugin'); }
  }

  async readPlugin(path) {
    var rel = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    var parts = rel.split('/');
    var file = parts.pop();
    var dir = await this.opfsDirectory(['mnt', 'plugins'].concat(parts), false);
    var f = await (await dir.getFileHandle(file, { create: false })).getFile();
    return new Uint8Array(await f.arrayBuffer());
  }

  // ---------- attachments (Image Feedback v1) ----------
  // Metadata lives in the 'attachments' IDB store; exact bytes live in
  // content-addressed OPFS files attachments/<h2>/<rest-of-sha256>. Records
  // are small plain objects (id/sha256/mimeType/size/storageKey/…) — never
  // base64 payloads. Memory mode keeps bytes in a Map with identical
  // semantics so the abstraction is testable without OPFS.

  async saveAttachmentMeta(record) {
    return this.put('attachments', record);
  }

  async getAttachmentMeta(id) {
    return this.get('attachments', id);
  }

  async findAttachmentMetaBySha256(sha256) {
    await this.ready;
    try {
      if (this.db) {
        var tx = this.db.transaction('attachments', 'readonly');
        var req = tx.objectStore('attachments').index('sha256').get(sha256);
        return await persistenceRequest(req);
      }
      for (var value of this.memory.attachments.values()) {
        if (value && value.sha256 === sha256) return persistenceClone(value);
      }
      return null;
    } catch (e) { this._throwPersistenceError(e, 'find attachment by sha256'); }
  }

  async allAttachmentMetas() {
    return this.all('attachments');
  }

  async writeAttachmentBytes(storageKey, bytes) {
    await this.ready;
    var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try {
      if (!this.opfsRoot) {
        this.memoryAttachmentBytes.set(storageKey, data.slice());
        return;
      }
      var dir = await this.opfsDirectory(['attachments', String(storageKey).slice(0, 2)], true);
      var writable = await (await dir.getFileHandle(String(storageKey), { create: true })).createWritable();
      await writable.write(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      await writable.close();
    } catch (e) { this._throwPersistenceError(e, 'write attachment bytes'); }
  }

  async readAttachmentBytes(storageKey) {
    await this.ready;
    try {
      if (!this.opfsRoot) {
        var cached = this.memoryAttachmentBytes.get(storageKey);
        if (!cached) throw new Error('attachment bytes not found: ' + storageKey);
        return cached.slice();
      }
      var dir = await this.opfsDirectory(['attachments', String(storageKey).slice(0, 2)], false);
      var f = await (await dir.getFileHandle(String(storageKey), { create: false })).getFile();
      return new Uint8Array(await f.arrayBuffer());
    } catch (e) { this._throwPersistenceError(e, 'read attachment bytes'); }
  }

  async hasAttachmentBytes(storageKey) {
    await this.ready;
    try {
      if (!this.opfsRoot) return this.memoryAttachmentBytes.has(storageKey);
      var dir = await this.opfsDirectory(['attachments', String(storageKey).slice(0, 2)], false);
      await dir.getFileHandle(String(storageKey), { create: false });
      return true;
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || e.cause && e.cause.name === 'NotFoundError')) return false;
      this._throwPersistenceError(e, 'has attachment bytes');
    }
  }

  // Used ONLY by AttachmentStore orphan rollback (F-I02): remove a blob
  // that THIS ingest just created after its metadata write failed.
  // Callers must never point this at a pre-existing (shared) blob. A
  // NotFoundError means the bytes are already gone — deletion succeeded
  // in every sense that matters.
  async deleteAttachmentBytes(storageKey) {
    await this.ready;
    this.memoryAttachmentBytes.delete(storageKey);
    if (!this.opfsRoot) return;
    try {
      var dir = await this.opfsDirectory(['attachments', String(storageKey).slice(0, 2)], false);
      await dir.removeEntry(String(storageKey));
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || e.cause && e.cause.name === 'NotFoundError')) return;
      this._throwPersistenceError(e, 'delete attachment bytes');
    }
  }

  async clearAttachments() {
    await this.ready;
    try {
      await this.clear('attachments');
      if (this.opfsRoot) await this._clearOpfsDir(['attachments']);
      this.memoryAttachmentBytes.clear();
    } catch (e) { this._throwPersistenceError(e, 'clear attachments'); }
  }

  async reset() {
    await this.clearConversations();
    await this.clear('settings');
    await this.clear('secrets');
    await this.clear('workspaceHandles');
    await this.clear('meta');
    // Full wipe includes the durable attachment snapshots (they only exist
    // to serve conversations) and the Harness capability registry.
    await this.clearAttachments();
    await this.clear('capabilities');
    this.secrets.clear();
    await this.clearHome();
    await this.clearPlugins();
  }
}

var locusPersistence = new PersistenceService();
var PersistenceServiceInstance = locusPersistence;
