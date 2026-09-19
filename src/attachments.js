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
//    - This module owns MIME sniffing, hashing, dedup, limits and
//      read-back integrity verification.
//    - PersistenceService owns the durable backends (OPFS bytes,
//      IndexedDB metadata). Components never touch them directly.
//    - ProviderAdapters never see this module: they receive already
//      resolved, one-request temporary payloads from the resolver.
//
//  Core invariant (docs/IMAGE-INPUT.md, "Read-path integrity"): a
//  content-addressed attachment MUST be verified against its metadata
//  (size, SHA-256, MIME magic) on EVERY read that can cross the
//  model-input boundary, before any base64 is materialized.
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

// Content-addressed storage is only trustworthy if the address is
// VERIFIED, not merely present. Every read that can cross the
// model-input boundary re-checks the durable bytes against their
// metadata BEFORE anything is base64-materialized:
//   read bytes → verify size → verify sha256 → verify MIME magic
//   → only then materialize (docs/IMAGE-INPUT.md, "Read-path integrity").
// A blob that was truncated / bit-flipped / replaced in OPFS fails here
// instead of silently travelling to a provider as image/png.
//
// Reasons are a closed set so UI/debug surfaces can distinguish the
// failure modes without ever seeing the payload (the error carries
// EXPECTED metadata only — never the actual bytes or their base64).
function attachmentIntegrityError(reason, record) {
  var e = new Error('attachment integrity check failed (' + reason + '): ' + (record && record.id || '(unknown)'));
  e.name = 'AttachmentIntegrityError';
  e.code = 'attachment_integrity_error';
  e.reason = reason; // 'size_mismatch' | 'hash_mismatch' | 'mime_mismatch'
  e.attachmentId = record && record.id || null;
  e.expectedSha256 = record && record.sha256 || null;
  e.expectedSize = record && record.size || null;
  return e;
}

function isAttachmentIntegrityError(e) {
  return !!e && (e.name === 'AttachmentIntegrityError' || e.code === 'attachment_integrity_error');
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
//  getBytes(attachmentId) → Uint8Array (integrity-verified or throw)
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
    // Per-SHA ingest serialization (F-I01C): Map<sha256, Promise>. Only
    // byte-identical ingests serialize; different SHAs stay concurrent.
    this._ingestLocks = new Map();
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

  // Durable snapshot of one image.
  //
  // Attachments are CONTENT-ADDRESSED and metadata is CANONICALIZED by
  // SHA-256 (docs/IMAGE-INPUT.md): re-ingesting byte-identical content
  // — concurrently or not — yields ONE blob and ONE canonical metadata
  // record/identity, with no second blob. (If user-visible per-upload
  // instances are ever needed, that is a separate upload-reference
  // layer, not extra metadata rows here.)
  //
  // Concurrency (F-I01C): same-SHA ingests serialize on a per-key lock
  // with an inside-lock re-check, so real OPFS/IDB backends cannot
  // produce duplicate metadata rows from racing await windows.
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
    // Fast path outside the lock: already canonicalized by an earlier
    // ingest. The authoritative re-check runs inside the lock.
    var existing = await this.persistence.findAttachmentMetaBySha256(sha256);
    if (existing) return existing;
    return this._ingestExclusive(sha256, bytes, mime.mime, s);
  }

  // Serialize same-SHA ingests; different SHAs never block each other.
  async _ingestExclusive(sha256, bytes, mimeType, spec) {
    var locks = this._ingestLocks;
    var prev = locks.get(sha256) || Promise.resolve();
    var store = this;
    // `prev` is always a caught tail (never rejects), so chaining with
    // .then() is safe: this job always runs, after prior same-SHA work.
    var job = prev.then(function () {
      return store._ingestLocked(sha256, bytes, mimeType, spec);
    });
    var tail = job.catch(function () {}); // keep the chain rejection-free
    locks.set(sha256, tail);
    tail.then(function () {
      if (locks.get(sha256) === tail) locks.delete(sha256);
    });
    return job;
  }

  async _ingestLocked(sha256, bytes, mimeType, spec) {
    // Inside-lock double check (the race-closing step): another same-SHA
    // ingest may have canonicalized while this call waited on the lock.
    var existing = await this.persistence.findAttachmentMetaBySha256(sha256);
    if (existing) return existing;
    var createdBlob = false;
    if (!(await this.persistence.hasAttachmentBytes(sha256))) {
      // Blob write first: metadata must never reference bytes that are
      // not durable yet (the same fail-closed order the persistence
      // layer uses for provider frames).
      await this.persistence.writeAttachmentBytes(sha256, bytes);
      createdBlob = true;
    }
    var record = {
      id: 'att_' + attachmentUuid(),
      sha256: sha256,
      mimeType: mimeType,
      size: bytes.byteLength,
      storageKey: sha256,
      name: String(spec.name || '').slice(0, 255) || null,
      createdAt: new Date().toISOString(),
    };
    try {
      return await this.persistence.saveAttachmentMeta(record);
    } catch (e) {
      // Orphan rollback (F-I02): only the blob THIS ingest created may be
      // removed. A pre-existing blob is content-addressed shared state —
      // other metadata rows may reference it and is never touched.
      if (createdBlob) {
        try {
          await this.persistence.deleteAttachmentBytes(sha256);
        } catch (cleanupError) {
          // Best-effort only: the ORIGINAL metadata failure is the cause
          // that matters; never replace it, never fake success. The
          // cleanup failure rides along for debug surfaces.
          e.attachmentCleanupFailure = cleanupError && cleanupError.message
            ? String(cleanupError.message) : String(cleanupError);
        }
      }
      throw e;
    }
  }

  async getRecord(attachmentId) {
    return this.persistence.getAttachmentMeta(attachmentId);
  }

  // Read durable bytes and VERIFY them against the metadata before
  // handing them on: size, then SHA-256 (against both the record and the
  // content-addressed storage key — the address itself is not the
  // check), then MIME magic. Order is deliberate: size is the cheap
  // first gate, so a truncated blob never pays for hashing. No verified
  // result is ever cached across calls: OPFS bytes can change at any
  // time outside this store's control (F-I04, docs/IMAGE-INPUT.md).
  async _readVerified(record) {
    var bytes = await this.persistence.readAttachmentBytes(record.storageKey);
    if (bytes.byteLength !== record.size) {
      throw attachmentIntegrityError('size_mismatch', record);
    }
    var sha256 = await this._sha256Hex(bytes);
    if (sha256 !== record.sha256 || sha256 !== record.storageKey) {
      throw attachmentIntegrityError('hash_mismatch', record);
    }
    // Too-short/unrecognizable bytes cannot be confirmed as the recorded
    // type — an integrity failure, never a silent pass-through.
    if (sniffImageMime(bytes) !== record.mimeType) {
      throw attachmentIntegrityError('mime_mismatch', record);
    }
    return bytes;
  }

  async getBytes(attachmentId) {
    var record = await this.persistence.getAttachmentMeta(attachmentId);
    if (!record || !record.storageKey) {
      var missing = new Error('attachment not found: ' + attachmentId);
      missing.name = 'NotFoundError';
      throw missing;
    }
    return this._readVerified(record);
  }

  // One-request temporary payload for provider serialization. The result
  // MUST NOT be persisted, logged or emitted (docs/IMAGE-INPUT.md,
  // "Resolution boundary"). Missing metadata still resolves to null (the
  // caller's honest "attachment unavailable" path); PRESENT metadata
  // with corrupt/missing backing bytes fails loudly — a corrupted blob
  // must never cross the model-input boundary as base64.
  async resolveForWire(attachmentId) {
    var record = await this.persistence.getAttachmentMeta(attachmentId);
    if (!record || !record.storageKey) return null;
    var bytes = await this._readVerified(record);
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
