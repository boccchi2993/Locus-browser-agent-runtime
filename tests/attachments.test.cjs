// AttachmentStore tests (node, memory persistence mode; no OPFS/IndexedDB).
// Covers docs/IMAGE-INPUT.md v1 invariants: MIME sniffing (never extension
// trust), SHA-256 identity, content-addressed dedup, exact byte round
// trip, durable reload, failure propagation and no-base64-persisted.
// Run: node tests/attachments.test.cjs

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const P = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'persistence.js'), 'utf8') +
  '\n;({ PersistenceService, PERSISTENCE_SCHEMA_VERSION, PERSISTENCE_STORES });'
);
const A = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'attachments.js'), 'utf8') +
  '\n;({ AttachmentStore, IMAGE_MIME_TYPES, MAX_IMAGE_ATTACHMENT_BYTES, imageContentPart, textContentPart, attachmentIntegrityError, isAttachmentIntegrityError });'
);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// Minimal real-format fixtures (magic bytes matter, sizes are tiny).
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4, 5, 6, 7, 8]);
const PNG_BYTES2 = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 9, 9, 9, 9]);
const JPEG_BYTES = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 1, 2, 3]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x18, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 1, 2, 3]);
const TEXT_BYTES = new Uint8Array([0x68, 0x65, 0x6C, 0x6C, 0x6F]); // "hello"

async function main() {
  check('S0 schema v3 carries attachments store', P.PERSISTENCE_SCHEMA_VERSION === 3
    && P.PERSISTENCE_STORES.includes('attachments') && P.PERSISTENCE_STORES.includes('capabilities'),
    P.PERSISTENCE_STORES.join(','));

  const service = new P.PersistenceService();
  await service.ready;
  check('S0b memory mode is a valid AttachmentStore backend', service.mode === 'memory');
  const store = new A.AttachmentStore({ persistence: service });

  // --- ingest + MIME policy ---
  const rec = await store.ingestImage({ bytes: PNG_BYTES, name: 'photo.png', declaredType: 'image/png' });
  check('S1 PNG ingest returns a semantic record', !!rec && typeof rec.id === 'string' && rec.id.startsWith('att_')
    && rec.mimeType === 'image/png' && rec.size === PNG_BYTES.byteLength && rec.storageKey === rec.sha256
    && /^[0-9a-f]{64}$/.test(rec.sha256), JSON.stringify(rec));
  const recJson = JSON.stringify(rec).replace(/"sha256":"[0-9a-f]{64}"/g, '""').replace(/"storageKey":"[0-9a-f]{64}"/g, '""');
  check('S1b record carries no pixel payload (no base64 in metadata)',
    !/[A-Za-z0-9+/]{40,}/.test(recJson) && rec.dataBase64 === undefined);

  const jpeg = await store.ingestImage({ bytes: JPEG_BYTES, name: 'x.jpg', declaredType: 'image/jpeg' });
  const gif = await store.ingestImage({ bytes: GIF_BYTES, name: 'x.gif', declaredType: 'image/gif' });
  const webp = await store.ingestImage({ bytes: WEBP_BYTES, name: 'x.webp', declaredType: 'image/webp' });
  check('S2 v1 allowlist ingests JPEG/GIF/WebP', jpeg.mimeType === 'image/jpeg'
    && gif.mimeType === 'image/gif' && webp.mimeType === 'image/webp');

  let threw = null;
  try { await store.ingestImage({ bytes: TEXT_BYTES, name: 'notes.txt', declaredType: 'image/png' }); }
  catch (e) { threw = e; }
  check('S3 declared image/png with non-image bytes is rejected loudly',
    !!threw && threw.name === 'AttachmentRejectedError' && threw.code === 'attachment_type_unsupported',
    threw && threw.message);

  threw = null;
  try { await store.ingestImage({ bytes: TEXT_BYTES, name: 'notes.txt', declaredType: 'text/plain' }); }
  catch (e) { threw = e; }
  check('S3b non-image content is rejected even with honest declaration',
    !!threw && threw.code === 'attachment_type_unsupported', threw && threw.message);

  threw = null;
  try { await store.ingestImage({ bytes: JPEG_BYTES, name: 'faked.png', declaredType: 'image/png' }); }
  catch (e) { threw = e; }
  check('S3c declaration contradicting magic bytes is rejected (never silently relabeled)',
    !!threw && threw.code === 'attachment_type_unsupported', threw && threw.message);

  threw = null;
  try { await store.ingestImage({ bytes: new Uint8Array(0), name: 'empty.png', declaredType: 'image/png' }); }
  catch (e) { threw = e; }
  check('S3d empty attachment is rejected', !!threw && threw.code === 'attachment_empty');

  threw = null;
  try {
    await store.ingestImage({
      bytes: new Uint8Array(A.MAX_IMAGE_ATTACHMENT_BYTES + 1), name: 'huge.png', declaredType: 'image/png',
    });
  } catch (e) { threw = e; }
  check('S4 oversized image is rejected with a bounded limit (10 MiB)',
    !!threw && threw.code === 'attachment_too_large' && A.MAX_IMAGE_ATTACHMENT_BYTES === 10 * 1024 * 1024);

  // --- SHA-256 identity + dedup ---
  const dup = await store.ingestImage({ bytes: PNG_BYTES, name: 'renamed.png', declaredType: 'image/png' });
  check('S5 same bytes under a different filename dedupe to the same record',
    dup.id === rec.id && dup.sha256 === rec.sha256, JSON.stringify({ a: rec.id, b: dup.id }));
  const other = await store.ingestImage({ bytes: PNG_BYTES2, name: 'other.png', declaredType: 'image/png' });
  check('S5b different bytes produce different identities', other.sha256 !== rec.sha256);

  const metas = await service.allAttachmentMetas();
  check('S5c blob dedup: 6 ingests, 5 metadata rows, no duplicate blobs',
    metas.length === 5 && new Set(metas.map((m) => m.sha256)).size === 5, String(metas.length));

  // --- exact byte round trip + reload ---
  const round = await store.getBytes(rec.id);
  check('S6 byte-exact round trip', round.length === PNG_BYTES.length
    && round.every((b, i) => b === PNG_BYTES[i]));

  const store2 = new A.AttachmentStore({ persistence: service });
  const reload = await store2.getBytes(rec.id);
  const reRec = await store2.getRecord(rec.id);
  check('S7 reload over the same backend re-materializes exact bytes + metadata',
    !!reRec && reload.every((b, i) => b === PNG_BYTES[i]));

  const resolved = await store.resolveForWire(rec.id);
  const b64 = Buffer.from(PNG_BYTES).toString('base64');
  check('S7b resolveForWire returns the one-request temporary payload',
    resolved.mimeType === 'image/png' && resolved.dataBase64 === b64);

  // --- failure propagation ---
  const broken = new P.PersistenceService();
  await broken.ready;
  broken.writeAttachmentBytes = async () => { throw new Error('simulated OPFS quota failure'); };
  const brokenStore = new A.AttachmentStore({ persistence: broken });
  threw = null;
  try { await brokenStore.ingestImage({ bytes: PNG_BYTES, name: 'x.png', declaredType: 'image/png' }); }
  catch (e) { threw = e; }
  check('S8 blob write failure propagates (no metadata phantom)',
    !!threw && (threw.name === 'PersistenceError' || /simulated OPFS quota failure/.test(threw.message)),
    threw && threw.message);
  const brokenMeta = await broken.allAttachmentMetas();
  check('S8b failed ingest leaves no metadata row behind', brokenMeta.length === 0, String(brokenMeta.length));

  // --- semantic content parts ---
  const part = A.imageContentPart(rec);
  const textPart = A.textContentPart('帮我看一下这个截图');
  check('S9 semantic image part carries refs, never bytes',
    part.type === 'image' && part.attachmentId === rec.id && part.sha256 === rec.sha256
      && part.mimeType === 'image/png' && part.size === rec.size && part.dataBase64 === undefined);
  check('S9b semantic user turn shape: text + image parts',
    textPart.type === 'text' && textPart.text === '帮我看一下这个截图');

  // --- clear semantics ---
  await service.clearAttachments();
  const afterClear = await service.allAttachmentMetas();
  let gone = null;
  try { await store.getBytes(rec.id); } catch (e) { gone = e; }
  check('S10 clearAttachments drops metadata AND bytes (no dead refs)',
    afterClear.length === 0 && !!gone, String(afterClear.length));

  // ============================================================
  //  F-I04 — read-path integrity (verify before model-input boundary)
  // ============================================================
  // Fresh service so corruption tests start from a known state.
  const isvc = new P.PersistenceService();
  await isvc.ready;
  const istore = new A.AttachmentStore({ persistence: isvc });
  const IREC = await istore.ingestImage({ bytes: PNG_BYTES, name: 'integrity.png', declaredType: 'image/png' });
  // Mutate the durable blob the way an external bug/hostile write would.
  // The mutator may return replacement bytes (e.g. a truncated copy).
  const mutateBlob = async (mutator) => {
    const bytes = await isvc.readAttachmentBytes(IREC.sha256);
    const next = mutator(bytes) || bytes;
    await isvc.writeAttachmentBytes(IREC.sha256, next);
  };
  // `expectedRecord` is the metadata AS STORED — the integrity error must
  // carry exactly those expected values (with tampered metadata, the
  // tampered values are what the store believed).
  async function integrityCheck(fn, reason, label, expectedRecord) {
    const want = expectedRecord || IREC;
    let err = null;
    try { await fn(); } catch (e) { err = e; }
    check(label,
      !!err && A.isAttachmentIntegrityError(err) && err.code === 'attachment_integrity_error'
        && err.reason === reason && err.attachmentId === want.id
        && err.expectedSha256 === want.sha256 && err.expectedSize === want.size,
      err && (err.reason || err.message));
    return err;
  }

  const okResolved = await istore.resolveForWire(IREC.id);
  check('I1 happy path: verified read materializes the exact payload',
    okResolved && okResolved.mimeType === 'image/png'
      && okResolved.dataBase64 === Buffer.from(PNG_BYTES).toString('base64'));

  await mutateBlob((b) => { b[5] ^= 0xFF; }); // flip one byte
  await integrityCheck(() => istore.getBytes(IREC.id), 'hash_mismatch',
    'I2 (T1) flipped blob byte → hash_mismatch, fail closed');
  await integrityCheck(() => istore.resolveForWire(IREC.id), 'hash_mismatch',
    'I2b resolveForWire refuses a bit-flipped blob');
  const hashErr = await integrityCheck(async () => {
    const s2 = new A.AttachmentStore({ persistence: isvc }); // "reload"
    return s2.getBytes(IREC.id);
  }, 'hash_mismatch', 'I2c (G) reload after corruption still fails closed');

  await mutateBlob((b) => b.slice(0, b.length - 3)); // truncate
  await integrityCheck(() => istore.getBytes(IREC.id), 'size_mismatch',
    'I3 (T2) truncated blob → size_mismatch (cheap first gate, no hash needed)');

  // Restore original bytes, then tamper METADATA only.
  await isvc.writeAttachmentBytes(IREC.sha256, PNG_BYTES);
  const mimeTampered = Object.assign({}, IREC, { mimeType: 'image/jpeg' });
  await isvc.saveAttachmentMeta(mimeTampered);
  await integrityCheck(() => istore.getBytes(IREC.id), 'mime_mismatch',
    'I4 (T3) metadata MIME contradicts magic bytes → mime_mismatch');
  await isvc.saveAttachmentMeta(IREC); // restore

  const shaTampered = Object.assign({}, IREC, { sha256: 'f'.repeat(64) });
  await isvc.saveAttachmentMeta(shaTampered);
  await integrityCheck(() => istore.getBytes(IREC.id), 'hash_mismatch',
    'I5 (E) tampered metadata sha256 → fail closed', shaTampered);
  await isvc.saveAttachmentMeta(IREC); // restore

  const sizeTampered = Object.assign({}, IREC, { size: IREC.size + 1 });
  await isvc.saveAttachmentMeta(sizeTampered);
  await integrityCheck(() => istore.getBytes(IREC.id), 'size_mismatch',
    'I6 (F) tampered metadata size → fail closed', sizeTampered);
  await isvc.saveAttachmentMeta(IREC); // restore

  const payloadB64 = Buffer.from(PNG_BYTES).toString('base64');
  check('I7 the integrity error carries expected metadata only — never payload bytes',
    !!hashErr && !JSON.stringify(hashErr).includes(payloadB64)
      && hashErr.message.indexOf('iVBOR') === -1,
    hashErr && hashErr.message);

  const missingWire = await istore.resolveForWire('att_does_not_exist');
  check('I8 missing record still resolves to null (honest unavailable path)',
    missingWire === null);

  // ============================================================
  //  F-I01C — concurrent same-SHA ingest canonicalizes
  // ============================================================
  const csvc = new P.PersistenceService();
  await csvc.ready;
  const cstore = new A.AttachmentStore({ persistence: csvc });
  const CONC_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 7, 7, 7, 7, 7, 7, 7, 7]);
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    cstore.ingestImage({ bytes: CONC_BYTES, name: 'conc-' + i + '.png', declaredType: 'image/png' })));
  const concMetas = await csvc.allAttachmentMetas();
  const concIds = new Set(results.map((r) => r.id));
  check('C1 (T13) 50 parallel same-bytes ingests → ONE canonical attachment identity',
    concIds.size === 1 && concMetas.length === 1 && results.every((r) => r.id === results[0].id)
      && results.every((r) => r.sha256 === results[0].sha256),
    JSON.stringify({ ids: concIds.size, metas: concMetas.length }));
  check('C1b one blob, exact bytes', (await csvc.readAttachmentBytes(results[0].sha256))
    .every((b, i) => b === CONC_BYTES[i]));

  const diffSpecs = Array.from({ length: 8 }, (_, i) => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, i, i, i, i]);
    return cstore.ingestImage({ bytes, name: 'diff-' + i + '.png', declaredType: 'image/png' });
  });
  const diffResults = await Promise.all(diffSpecs);
  const diffMetas = await csvc.allAttachmentMetas();
  check('C2 (T14) different-SHA parallel ingests stay independent (no cross-blocking, no dedupe)',
    new Set(diffResults.map((r) => r.sha256)).size === 8
      && diffMetas.length === 9 && new Set(diffMetas.map((m) => m.sha256)).size === 9,
    JSON.stringify({ metas: diffMetas.length }));

  const renamed = await cstore.ingestImage({ bytes: CONC_BYTES, name: 'renamed-after.png', declaredType: 'image/png' });
  check('C3 same filename / different bytes → different identity; same bytes / new name → canonical identity',
    renamed.id === results[0].id
      && (await cstore.ingestImage({
        bytes: new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 7, 7, 7, 7, 7, 7, 7, 8]),
        name: 'conc-0.png', declaredType: 'image/png',
      })).sha256 !== results[0].sha256);

  // ============================================================
  //  F-I02 — orphan rollback on metadata failure
  // ============================================================
  const rsvc = new P.PersistenceService();
  await rsvc.ready;
  const rstore = new A.AttachmentStore({ persistence: rsvc });
  const RREC = await rstore.ingestImage({ bytes: PNG_BYTES2, name: 'rollback.png', declaredType: 'image/png' });

  // RB1/A: blob-exists-but-no-metadata + metadata failure → NEW blob is rolled back.
  await rsvc.delete('attachments', RREC.id); // remove meta, keep blob (shared-blob setup)
  const failSvc = rsvc;
  const realSave = failSvc.saveAttachmentMeta.bind(failSvc);
  let failFirst = true;
  failSvc.saveAttachmentMeta = async (record) => {
    if (failFirst) { failFirst = false; throw new Error('simulated metadata write failure'); }
    return realSave(record);
  };
  let rbErr = null;
  try { await rstore.ingestImage({ bytes: PNG_BYTES, name: 'orphan.png', declaredType: 'image/png' }); }
  catch (e) { rbErr = e; }
  check('RB1 (T15) metadata failure after a NEW blob write → ingest fails, no false success',
    !!rbErr && /simulated metadata write failure/.test(rbErr.message), rbErr && rbErr.message);
  const orphanSha = crypto.createHash('sha256').update(PNG_BYTES).digest('hex');
  const orphanGone = !(await failSvc.hasAttachmentBytes(orphanSha));
  check('RB1b the just-created orphan blob was rolled back',
    orphanGone && failSvc.memoryAttachmentBytes.size === 1, String(failSvc.memoryAttachmentBytes.size));

  // RB2/B: pre-existing shared blob + metadata failure → blob PRESERVED.
  const sharedBefore = failSvc.memoryAttachmentBytes.get(RREC.sha256);
  failFirst = true;
  rbErr = null;
  try { await rstore.ingestImage({ bytes: PNG_BYTES2, name: 'shared.png', declaredType: 'image/png' }); }
  catch (e) { rbErr = e; }
  check('RB2 (T16) metadata failure with a PRE-EXISTING blob → blob never deleted',
    !!rbErr && sharedBefore && !!failSvc.memoryAttachmentBytes.get(RREC.sha256)
      && failSvc.memoryAttachmentBytes.get(RREC.sha256).every((b, i) => b === sharedBefore[i]),
    rbErr && rbErr.message);

  // RB3/C: cleanup failure must not mask the original error (no false success).
  const realDelete = failSvc.deleteAttachmentBytes.bind(failSvc);
  failSvc.deleteAttachmentBytes = async () => { throw new Error('simulated cleanup failure'); };
  failSvc.saveAttachmentMeta = async () => { throw new Error('simulated metadata write failure 2'); };
  rbErr = null;
  try { await rstore.ingestImage({ bytes: JPEG_BYTES, name: 'cleanup-fail.png', declaredType: 'image/jpeg' }); }
  catch (e) { rbErr = e; }
  check('RB3 cleanup failure never replaces/masks the original metadata error',
    !!rbErr && /simulated metadata write failure 2/.test(rbErr.message)
      && /simulated cleanup failure/.test(String(rbErr.attachmentCleanupFailure)),
    rbErr && rbErr.message + ' | cleanup=' + rbErr.attachmentCleanupFailure);

  // RB4/D: retry after failure ingests normally.
  failSvc.saveAttachmentMeta = realSave;
  failSvc.deleteAttachmentBytes = realDelete;
  const retried = await rstore.ingestImage({ bytes: JPEG_BYTES, name: 'retry.png', declaredType: 'image/jpeg' });
  check('RB4 retry after a failed ingest succeeds normally',
    !!retried && retried.mimeType === 'image/jpeg'
      && !!(await rsvc.findAttachmentMetaBySha256(retried.sha256))
      && !!(await rsvc.hasAttachmentBytes(retried.sha256)));

  console.log('---');
  console.log('attachments.test.cjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
