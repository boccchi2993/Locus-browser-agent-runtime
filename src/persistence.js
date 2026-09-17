// ============================================================
//  LOCUS BROWSER-LOCAL PERSISTENCE
//
//  IndexedDB is the canonical metadata/history store. OPFS is the durable
//  byte store for the local machine (/home/locus and /mnt/plugins). This is
//  deliberately a classic script so the framework-independent runtime and
//  the Vue store share one substrate without reaching into browser storage
//  APIs themselves.
// ============================================================

var PERSISTENCE_SCHEMA_VERSION = 1;
var PERSISTENCE_DB_NAME = 'locus';

var PERSISTENCE_STORES = [
  'conversations', 'presentationEvents', 'providerSessions',
  'providerFrames', 'normalizedMessages', 'settings', 'secrets',
  'workspaceHandles', 'meta',
];

function persistenceUuid(prefix) {
  var c = typeof crypto !== 'undefined' && crypto.randomUUID;
  return (c ? crypto.randomUUID() : prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
}

function persistenceClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
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
    var normalized = db.createObjectStore('normalizedMessages', { keyPath: 'id' });
    normalized.createIndex('conversationSequence', ['conversationId', 'sequence'], { unique: true });
    normalized.createIndex('conversationId', 'conversationId');
    db.createObjectStore('settings', { keyPath: 'key' });
    db.createObjectStore('secrets', { keyPath: 'key' });
    db.createObjectStore('workspaceHandles', { keyPath: 'key' });
    db.createObjectStore('meta', { keyPath: 'key' });
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
    this.ready = this.init();
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
    if (this.db) return persistenceRequest(this.db.transaction(storeName, 'readonly').objectStore(storeName).get(key));
    return this.memory[storeName].get(key) || null;
  }

  async all(storeName) {
    await this.ready;
    if (this.db) return persistenceRequest(this.db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
    return Array.from(this.memory[storeName].values()).map(persistenceClone);
  }

  async put(storeName, value) {
    await this.ready;
    var copy = persistenceClone(value);
    if (this.db) {
      var tx = this.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(copy);
      await persistenceTx(tx);
    } else {
      this.memory[storeName].set(copy.id !== undefined ? copy.id : copy.key, copy);
    }
    return copy;
  }

  async delete(storeName, key) {
    await this.ready;
    if (this.db) {
      var tx = this.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      await persistenceTx(tx);
    } else this.memory[storeName].delete(key);
  }

  async clear(storeName) {
    await this.ready;
    if (this.db) {
      var tx = this.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      await persistenceTx(tx);
    } else this.memory[storeName].clear();
  }

  async _byIndex(storeName, indexName, query) {
    await this.ready;
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
    return persistenceRequest(index.getAll(range));
  }

  _redact(value) {
    var self = this;
    if (typeof value === 'string') {
      var out = value;
      self.secrets.forEach(function (secret) { if (secret) out = out.split(secret).join('[REDACTED]'); });
      return out;
    }
    if (Array.isArray(value)) return value.map(function (v) { return self._redact(v); });
    if (value && typeof value === 'object') {
      var obj = {};
      Object.keys(value).forEach(function (k) { obj[k] = self._redact(value[k]); });
      return obj;
    }
    return value;
  }

  async _loadSecrets() {
    try {
      var rows = this.db
        ? await persistenceRequest(this.db.transaction('secrets', 'readonly').objectStore('secrets').getAll())
        : Array.from(this.memory.secrets.values());
      this.secrets = new Set(rows.map(function (r) { return r.value; }).filter(function (v) { return typeof v === 'string' && v; }));
    } catch (e) {}
  }

  async saveSettings(settings) {
    var keys = ['apiBase', 'model', 'proxy', 'dialect'];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      await this.put('settings', { key: key, value: persistenceSafeString(settings[key] || '') });
    }
  }

  async loadSettings() {
    var rows = await this.all('settings');
    var out = {};
    rows.forEach(function (r) { out[r.key] = r.value; });
    var remembered = await this.get('secrets', 'apiKey');
    if (remembered && remembered.value) out.apiKey = remembered.value;
    out.remember = !!(remembered && remembered.value);
    return out;
  }

  async setRememberedApiKey(value, remember) {
    var secret = persistenceSafeString(value || '').trim();
    if (!remember || !secret) {
      await this.delete('secrets', 'apiKey');
      this.secrets.delete(secret);
      return;
    }
    await this.put('secrets', { key: 'apiKey', value: secret, createdAt: persistenceNow() });
    this.secrets.add(secret);
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
    var conv = await this.get('conversations', conversationId);
    var sessions = await this._byIndex('providerSessions', 'conversationId', conversationId);
    var events = await this._byIndex('presentationEvents', 'conversationId', conversationId);
    var normalized = await this._byIndex('normalizedMessages', 'conversationId', conversationId);
    for (var i = 0; i < events.length; i++) await this.delete('presentationEvents', events[i].id);
    for (var j = 0; j < normalized.length; j++) await this.delete('normalizedMessages', normalized[j].id);
    for (var k = 0; k < sessions.length; k++) {
      var frames = await this._byIndex('providerFrames', 'sessionId', sessions[k].id);
      for (var n = 0; n < frames.length; n++) await this.delete('providerFrames', frames[n].id);
      await this.delete('providerSessions', sessions[k].id);
    }
    await this.delete('conversations', conversationId);
    return !!conv;
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
    try { await this.put('workspaceHandles', { key: 'externalWorkspace', handle: handle, updatedAt: persistenceNow() }); } catch (e) {}
  }

  async loadWorkspaceHandle() {
    var row = await this.get('workspaceHandles', 'externalWorkspace');
    return row && row.handle ? row.handle : null;
  }

  async forgetWorkspaceHandle() { await this.delete('workspaceHandles', 'externalWorkspace'); }

  async opfsDirectory(parts, create) {
    await this.ready;
    if (!this.opfsRoot) throw new Error('OPFS unavailable');
    var dir = this.opfsRoot;
    for (var i = 0; i < (parts || []).length; i++) dir = await dir.getDirectoryHandle(parts[i], { create: create !== false });
    return dir;
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
    };
  }

  async requestPersistentStorage() {
    if (!navigator.storage || !navigator.storage.persist) return false;
    return !!(await navigator.storage.persist());
  }

  async clearConversations() {
    var conversations = await this.loadConversations();
    for (var i = 0; i < conversations.length; i++) await this.deleteConversation(conversations[i].id);
  }

  async _clearOpfsDir(parts) {
    var dir;
    try { dir = await this.opfsDirectory(parts, false); } catch (e) { return; }
    var entries = [];
    for await (var pair of dir.entries()) entries.push(pair);
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i][0];
      var handle = entries[i][1];
      if (handle.kind === 'directory') await this._clearOpfsEntry(handle);
      try { await dir.removeEntry(name, { recursive: handle.kind === 'directory' }); } catch (e) {}
    }
  }

  async _clearOpfsEntry(dir) {
    var entries = [];
    for await (var pair of dir.entries()) entries.push(pair);
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i][0];
      var handle = entries[i][1];
      if (handle.kind === 'directory') await this._clearOpfsEntry(handle);
      try { await dir.removeEntry(name, { recursive: handle.kind === 'directory' }); } catch (e) {}
    }
  }

  async clearHome() { await this._clearOpfsDir(['home', 'locus']); }
  async clearPlugins() { await this._clearOpfsDir(['mnt', 'plugins']); }

  // Privileged plugin installation seam. The normal agent-facing VFS mounts
  // /mnt/plugins with system-read-only authority; only an explicit host
  // integration may call this method.
  async writePlugin(path, data) {
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
  }

  async readPlugin(path) {
    var rel = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    var parts = rel.split('/');
    var file = parts.pop();
    var dir = await this.opfsDirectory(['mnt', 'plugins'].concat(parts), false);
    var f = await (await dir.getFileHandle(file, { create: false })).getFile();
    return new Uint8Array(await f.arrayBuffer());
  }

  async reset() {
    await this.clearConversations();
    await this.clear('settings');
    await this.clear('secrets');
    await this.clear('workspaceHandles');
    await this.clear('meta');
    this.secrets.clear();
    await this.clearHome();
    await this.clearPlugins();
  }
}

var locusPersistence = new PersistenceService();
var PersistenceServiceInstance = locusPersistence;
