// AttachmentStore tests (node, memory persistence mode; no OPFS/IndexedDB).
// Covers docs/IMAGE-INPUT.md v1 invariants: MIME sniffing (never extension
// trust), SHA-256 identity, content-addressed dedup, exact byte round
// trip, durable reload, failure propagation and no-base64-persisted.
// Run: node tests/attachments.test.cjs

const fs = require('fs');
const path = require('path');

const P = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'persistence.js'), 'utf8') +
  '\n;({ PersistenceService, PERSISTENCE_SCHEMA_VERSION, PERSISTENCE_STORES });'
);
const A = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'attachments.js'), 'utf8') +
  '\n;({ AttachmentStore, IMAGE_MIME_TYPES, MAX_IMAGE_ATTACHMENT_BYTES, imageContentPart, textContentPart });'
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

  console.log('---');
  console.log('attachments.test.cjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
