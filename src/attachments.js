// ============================================================
//  ATTACHMENT STORE (Image Feedback v1)
//
//  A durable, content-addressed store for image attachments that are
//  about to cross the model-input boundary (docs/IMAGE-INPUT.md):
//
//    upload (ephemeral /mnt/upload File) → ingestImage()
//      → exact bytes snapshot → SHA-256 → durable blob
//      → semantic attachment record { id, sha256, mimeType, size, … }
//
//  Ownership boundaries:
//    - This module owns MIME sniffing, hashing, dedup and limits.
//    - PersistenceService owns the durable backends (OPFS bytes,
//      IndexedDB metadata). Components never touch them directly.
//    - ProviderAdapters never see this module: they receive already
//      resolved, one-request temporary payloads from the resolver.
//
//  Non-goals (docs/IMAGE-INPUT.md, "Not v1"): compression, transcoding,
//  OCR, captioning, arbitrary file types, provider upload APIs.
// ============================================================

// v1 allowlist. Detection NEVER trusts the declared type alone: the
// magic bytes must confirm it (docs/IMAGE-INPUT.md, "MIME policy").
var IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// Durable snapshot limit per image. This bounds storage only — the
// per-request wire budget is enforced separately against
// HISTORY_BUDGET_BYTES (agent.js) using exact base64 arithmetic.
var MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

var IMAGE_MAGIC = [
  { mime: 'image/png', test: function (b) {
    return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47
      && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A;
  } },
  { mime: 'image/jpeg', test: function (b) {
    return b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
  } },
  { mime: 'image/gif', test: function (b) {
    return b.length >= 6
      && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38
      && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61; // GIF87a / GIF89a
  } },
  { mime: 'image/webp', test: function (b) {
    return b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50; // RIFF….WEBP
  } },
];

// Returns the allowlisted MIME the bytes actually are, or null when the
// bytes are not a recognizable v1 image.
function sniffImageMime(bytes) {
  for (var i = 0; i < IMAGE_MAGIC.length; i++) {
    if (IMAGE_MAGIC[i].test(bytes)) return IMAGE_MAGIC[i].mime;
  }
  return null;
}

// Declared type (File.type) + magic bytes must AGREE. A lie in either
// direction fails loudly — bytes are never silently relabeled and an
// arbitrary blob is never sent to the provider as image/png.
function resolveImageMime(declaredType, bytes) {
  var declared = String(declaredType || '').toLowerCase().trim();
  var actual = sniffImageMime(bytes);
  if (!actual) {
    return { ok: false, reason: declared && IMAGE_MIME_TYPES.indexOf(declared) !== -1
      ? 'file content is not a valid ' + declared + ' image'
      : 'unsupported attachment type' };
  }
  if (declared && IMAGE_MIME_TYPES.indexOf(declared) !== -1 && declared !== actual) {
    return { ok: false, reason: 'declared type ' + declared + ' does not match file content (' + actual + ')' };
  }
  return { ok: true, mime: actual };
}

// Exact base64 wire size for `size` bytes (no re-encoding of the payload
// needed for budget math): ceil(size/3) * 4.
function base64WireBytes(size) {
  return Math.ceil(size / 3) * 4;
}

function attachmentUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'att-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

// ---------- base64 helpers (chunked, browser + Node) ----------

function uint8ToBase64(bytes) {
  if (typeof Buffer !== 'undefined' && Buffer.from) {
    return Buffer.from(bytes).toString('base64');
  }
  var CHUNK = 0x8000;
  var out = [];
  for (var i = 0; i < bytes.length; i += CHUNK) {
    out.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return btoa(out.join(''));
}

// ------------------------------------------------------------
//  AttachmentStore
//
//  new AttachmentStore({ persistence, maxImageBytes })
//    persistence — a PersistenceService (defaults to the canonical
//                  instance). Memory mode is fully supported so the
//                  store is testable without OPFS/IndexedDB.
//
//  ingestImage({ bytes, name, declaredType }) → attachment record
//    { id: 'att_…', sha256, mimeType, size, storageKey, name,
//      createdAt }
//  getBytes(attachmentId) → Uint8Array (exact bytes or throw)
//  resolveForWire(attachmentId) → { mimeType, dataBase64 }
//    TEMPORARY, one-request representation — callers must never
//    persist, log or telemetry the returned object.
//  getRecord(attachmentId) / describe() — metadata only.
// ------------------------------------------------------------
class AttachmentStore {
  constructor(opts) {
    var o = opts || {};
    this.persistence = o.persistence
      || (typeof PersistenceServiceInstance !== 'undefined' ? PersistenceServiceInstance : null);
    if (!this.persistence) throw new Error('AttachmentStore: no persistence backend available');
    this.maxImageBytes = o.maxImageBytes !== undefined && o.maxImageBytes !== null
      ? o.maxImageBytes : MAX_IMAGE_ATTACHMENT_BYTES;
  }

  async _sha256Hex(bytes) {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      throw new Error('AttachmentStore: WebCrypto subtle is unavailable');
    }
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Copy into a fresh ArrayBuffer so subclassed/pooled views (and Node
    // Buffers with byteOffset) hash the exact attachment bytes.
    var copy = new Uint8Array(view.byteLength);
    copy.set(view);
    var digest = await crypto.subtle.digest('SHA-256', copy.buffer);
    var hex = '';
    var arr = new Uint8Array(digest);
    for (var i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
    return hex;
  }

  // Durable snapshot of one image. Dedup happens on the BLOB (storageKey
  // = sha256): re-ingesting byte-identical content reuses the stored
  // bytes and creates no second blob. Metadata records are per-ingest
  // identities, so conversation frames keep stable attachmentIds.
  async ingestImage(spec) {
    var s = spec || {};
    var bytes = s.bytes instanceof Uint8Array ? s.bytes : new Uint8Array(s.bytes);
    if (!bytes.byteLength) {
      var empty = new Error('attachment is empty: ' + String(s.name || '(unnamed)'));
      empty.name = 'AttachmentRejectedError';
      empty.code = 'attachment_empty';
      throw empty;
    }
    if (bytes.byteLength > this.maxImageBytes) {
      var tooBig = new Error('image size ' + bytes.byteLength + ' exceeds the ' + this.maxImageBytes + ' byte attachment limit: ' + String(s.name || '(unnamed)'));
      tooBig.name = 'AttachmentRejectedError';
      tooBig.code = 'attachment_too_large';
      throw tooBig;
    }
    var mime = resolveImageMime(s.declaredType, bytes);
    if (!mime.ok) {
      var bad = new Error(mime.reason + ': ' + String(s.name || '(unnamed)'));
      bad.name = 'AttachmentRejectedError';
      bad.code = 'attachment_type_unsupported';
      throw bad;
    }
    var sha256 = await this._sha256Hex(bytes);
    var existing = await this.persistence.findAttachmentMetaBySha256(sha256);
    if (existing) return existing;
    if (!(await this.persistence.hasAttachmentBytes(sha256))) {
      // Blob write first: metadata must never reference bytes that are
      // not durable yet (the same fail-closed order the persistence
      // layer uses for provider frames).
      await this.persistence.writeAttachmentBytes(sha256, bytes);
    }
    var record = {
      id: 'att_' + attachmentUuid(),
      sha256: sha256,
      mimeType: mime.mime,
      size: bytes.byteLength,
      storageKey: sha256,
      name: String(s.name || '').slice(0, 255) || null,
      createdAt: new Date().toISOString(),
    };
    return this.persistence.saveAttachmentMeta(record);
  }

  async getRecord(attachmentId) {
    return this.persistence.getAttachmentMeta(attachmentId);
  }

  async getBytes(attachmentId) {
    var record = await this.persistence.getAttachmentMeta(attachmentId);
    if (!record || !record.storageKey) {
      var missing = new Error('attachment not found: ' + attachmentId);
      missing.name = 'NotFoundError';
      throw missing;
    }
    return this.persistence.readAttachmentBytes(record.storageKey);
  }

  // One-request temporary payload for provider serialization. The result
  // MUST NOT be persisted, logged or emitted (docs/IMAGE-INPUT.md,
  // "Resolution boundary").
  async resolveForWire(attachmentId) {
    var record = await this.persistence.getAttachmentMeta(attachmentId);
    if (!record || !record.storageKey) return null;
    var bytes = await this.persistence.readAttachmentBytes(record.storageKey);
    return { mimeType: record.mimeType, dataBase64: uint8ToBase64(bytes) };
  }

  // Names only — safe for UI/debug surfaces.
  describe() {
    return {
      maxImageBytes: this.maxImageBytes,
      mimes: IMAGE_MIME_TYPES.slice(),
    };
  }
}

// A semantic user content part carrying an image attachment reference
// (docs/IMAGE-INPUT.md, "Rich content"). attachmentId points into the
// durable store; dataBase64 is deliberately absent from this shape.
function imageContentPart(record) {
  return {
    type: 'image',
    attachmentId: record.id,
    mimeType: record.mimeType,
    sha256: record.sha256,
    size: record.size,
  };
}

function textContentPart(text) {
  return { type: 'text', text: String(text == null ? '' : text) };
}
