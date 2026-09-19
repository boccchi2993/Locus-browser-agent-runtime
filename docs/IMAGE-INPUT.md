# IMAGE INPUT (Image Feedback v1)

Locus can feed real images to a model as multimodal input, governed by a
single invariant:

> **TOOLS PRODUCE ARTIFACTS. THE HARNESS DECIDES WHETHER AN IMAGE MAY CROSS
> THE CURRENT MODEL-INPUT BOUNDARY. MODEL CAPABILITY NEVER CHANGES TOOL
> AVAILABILITY.**

Image-producing tools (screenshot, PDF page rendering, future plugins) may
exist regardless of the model. Whether the produced image enters the next
model request is decided at exactly one place: the boundary where a request
is built.

## Not v1

NetworkRuntime, curl refactors, browser automation/screenshot tools, PDF
renderers, spreadsheet/DOCX plugins, MCP, audio/video, arbitrary file input,
OCR, image captioning, server-side image proxies, provider file-upload APIs,
Responses API migration, compression/transcoding — all out of scope.

## Data flow

```
upload (ephemeral File at /mnt/upload)
    ↓ submit: exact-bytes snapshot
AttachmentStore (src/attachments.js)
    ↓ durable content-addressed blob (OPFS) + metadata (IndexedDB)
semantic user turn: [{ type: 'text' }, { type: 'image', attachmentId, … }]
    ↓ about to build the next model request
ImageInputGate (src/capabilities.js) → supported | unsupported | unknown
    ↓ supported
AttachmentResolver → temporary { type:'image', mimeType, dataBase64 }
    ↓
ProviderAdapter → provider wire shape (one request only)
```

/mnt/upload stays ephemeral. Anything that survives into conversation
continuation state references the **durable snapshot**, never the File.

## AttachmentStore (src/attachments.js)

- `ingestImage({ bytes, name, declaredType })` — hashes (SHA-256 via
  WebCrypto), validates MIME, writes bytes, stores metadata, returns
  `{ id: 'att_…', sha256, mimeType, size, storageKey, name, createdAt }`.
- **MIME policy**: v1 allowlist is `image/png`, `image/jpeg`, `image/webp`,
  `image/gif`. The declared `File.type` must AGREE with the magic bytes;
  a contradiction — or non-image bytes under any declaration — is rejected
  loudly (`AttachmentRejectedError`). Extensions are never trusted; bytes
  are never relabeled.
- **Size limits**: one image ≤ 10 MiB (`MAX_IMAGE_ATTACHMENT_BYTES`). The
  per-request wire budget is enforced separately (see "Request budget").
  Oversized → explicit rejection; no silent compression or transcoding.
- **Content addressing**: `storageKey` IS the SHA-256. Byte-identical files
  dedupe to one blob regardless of filename; metadata rows are per-ingest
  so conversation frames keep stable attachment ids.
- **Durable backing**: bytes in OPFS `attachments/<h2>/<sha256>`, metadata
  in the IndexedDB `attachments` store (schema v3). Memory mode mirrors the
  semantics for tests/degraded environments. UI/components never touch
  OPFS/IndexedDB directly.
- **No base64 in persistence**: metadata records carry refs only; bytes
  live as bytes. `resolveForWire(id)` produces the temporary
  `{ mimeType, dataBase64 }` — one request, never persisted, never logged,
  never emitted, never copied into presentation state.

## Rich content (provider-neutral)

A user turn with images is ONE turn:

```json
{ "role": "user",
  "content": [
    { "type": "text", "text": "帮我看一下这个截图" },
    { "type": "image", "attachmentId": "att_…", "mimeType": "image/png",
      "sha256": "…", "size": 123456 }
  ] }
```

- Stored history (frames, normalized rows) keeps the SEMANTIC form;
  `dataBase64` never enters persistence. Legacy `{ role:'user',
  content:'hello' }` string turns remain fully valid; rich content only
  appears when multimodal.
- Same-provider replay re-materializes bytes at request time. Cross-provider
  projection (`projectNormalizedHistory`) carries semantic parts through; the
  TARGET provider's gate decides per request — a text-only target gets the
  deterministic notice, never a silent drop and never foreign wire shapes.
- If durable bytes vanish (e.g. storage cleared), the model receives an
  explicit "no longer available" text part and the UI gets a warning; the
  task continues honestly.

## Provider serialization (src/model-adapters.js)

- OpenAI-compatible: `{ type: 'image_url', image_url: { url:
  'data:image/png;base64,…' } }` content parts (Chat Completions).
- Anthropic-compatible: `{ type: 'image', source: { type: 'base64',
  media_type: 'image/png', data: '…' } }` blocks (Messages API). thinking /
  tool_use / opaque assistant blocks replay verbatim — provider-native
  replay fidelity is untouched by rich user input.
- An unresolved semantic ref (attachmentId without dataBase64) reaching
  serialization is an internal wiring bug and FAILS LOUDLY.
- ProviderAdapters never see OPFS, attachments, hashing, capability
  decisions or approvals — only resolved parts in, wire shape out.

## Capability registry (src/capabilities.js)

Two DIFFERENT concepts, never merged (docs/APPROVALS.md):

| | Approval grant | Capability record |
|---|---|---|
| question | "may the harness DO this?" | "can this provider path SEE images?" |
| storage | memory, page session | persistent registry |
| scope | action | provider identity |

- **Identity**: `provider | adapterId | dialect | endpointIdentity | model |
  protocolVersion` — never the model name alone (same model id + different
  endpoint can differ).
- **Tri-state**: `supported / unsupported / unknown`. `unknown ≠ unsupported`.
- **Precedence** (documented + tested, deterministic — never mutually
  random overwriting):
  1. provider authoritative rejection (runtime evidence, always written)
  2. persisted user decision (always written — the human correction path)
  3. probe result (never overwrites 1 or 2; it only runs when lookup was
     unknown anyway, enforced twice)
  4. builtin seed (consulted only when NO record exists; can never
     overwrite runtime evidence)
  5. unknown
- **Persistence**: IndexedDB `capabilities` store (schema v3), Harness
  control-plane. The model cannot write it — model text ("I support
  images") and tool output have no effect. Agents get no filesystem
  projection in v1; a read-only mount is a possible future addition.
- **Recheck**: Settings → "Forget & recheck image capability" deletes the
  override for the CURRENT identity only (fall back to seed/unknown), so a
  mistaken Yes/No is never a dead end. `resetAllData` clears the registry
  (full wipe); `clear conversations` keeps it.
- **Builtin seed** (verified against current vendor docs; deliberately
  narrow — known provider family + OFFICIAL endpoint family + known model
  patterns, never `/vision/`-style substrings):
  - DeepSeek official endpoint: `deepseek-flash` → supported (official
    vision docs); `deepseek-chat` / `deepseek-reasoner` (V3-series) →
    unsupported (text-only).
  - api.openai.com: GPT-4o family, GPT-4.1 family, o1/o3/o4-mini, GPT-4
    turbo/vision → supported; GPT-3.5 → unsupported.
  - api.anthropic.com: Claude 3+ generations → supported.
  - Everything else → unknown (lazy flow). A known model on a non-official
    endpoint stays unknown — the endpoint family matters.

## ImageInputGate + the ask flow

`createImageInputGate({ registry, approvals, runProbe, identityOf })` —
`ensure({ signal, taskGeneration, askCache })` runs EXACTLY where an image
is about to enter a model request (AgentSession loop). Pure-text tasks and
tool registration/execution/upload never touch it.

- **supported** → continue; resolve attachments at serialization time.
- **unknown** → Approval Framework, `kind: 'capability'` (schema:
  confirm/decline/unsure — reserved since Approval v1, now consumed):
  - **Yes (confirm)** → registry `supported / user`; per the Approval
    consumer contract (docs/APPROVALS.md): await decision → safe
    preparation (durable registry write) → FINAL AbortSignal liveness check
    → provider request begins. The SAME task resumes (one task_start /
    task_end, no second submit, no duplicate user bubble).
  - **No (decline)** → registry `unsupported / user`. The image does not
    cross the boundary; the model receives the deterministic textual
    notice ("…marked as not supporting image input…"). A failed-to-attach
    image is NOT a tool failure and never reported as one. The user's file
    stays in /mnt/upload.
  - **I don't know (unsure)** → the harness runs the visual probe (below).
  - **Cancelled (Escape / Cancel task / session boundary)** → a cancelled
    DECISION, not a "No": nothing is written to the registry; the task
    continues without the image plus a warning event, and does not re-ask
    within the same run (askCache). Escape deliberately does not inherit
    the permission-kind "Escape = deny" behavior — closing a knowledge
    question is not answering it.
- **unsupported** → skip the image, attach the notice, task continues.
- Session grants are NEVER used for capability (capability kind has no
  session scope); the registry is the only persistence.

## Visual probe

A "I don't know" triggers ONE isolated synthetic request through the
PRODUCTION provider path — same `callModel`, adapter, endpoint, model and
protocol as ordinary traffic. It detects whether the CURRENT provider path
accepts images, not whether some model family is philosophically multimodal.

- Image: 400×400 truecolor PNG, four solid-color quadrants (red / blue /
  yellow / black in a random permutation), generated by a dependency-free
  pure-JS PNG encoder. The pixel layout is the ONLY carrier of the answer —
  never the prompt, filename or metadata (blind guessing succeeds 1/24).
- Prompt: "The image contains four solid-color quadrants. Return their
  colors in order: top-left, top-right, bottom-left, bottom-right. Return
  only four lowercase color names separated by commas."
- Classification:
  - exact color order returned → `supported / probe` (persisted)
  - explicit 400/422 request-validation rejection naming image content →
    `unsupported / provider-rejection` (persisted). Auth (401/403), quota
    (429), 5xx, timeouts, network failures, malformed responses and WRONG
    or absent answers are all inconclusive → registry stays `unknown`
    (a wrong answer means poor vision, not no vision).
- The probe never enters conversation history, provider frames, normalized
  messages, presentation events or replay checkpoints; it is Harness
  control-plane. Probe transport accepts the task AbortSignal (cancel
  mid-probe → inconclusive, no supported write).
- No infinite loops: at most one ask/probe per provider identity per run
  (run-local askCache); a new run may ask again.

## Provider rejection correction

If the registry says supported but a real image request receives an
explicit pre-inference image validation rejection, the registry is corrected
to `unsupported / provider-rejection`. Classification is conservative —
auth/quota/5xx/size-limit errors never downgrade capability. There is NO
automatic image-less resend after an ambiguous failure (double-billing /
duplicate-inference rules of docs/MODEL-PROTOCOL.md apply unchanged).

## Request budget

`HISTORY_BUDGET_BYTES` counts what actually hits the wire. Semantic image
parts are accounted at their RESOLVED size — `ceil(size/3) × 4` base64
expansion + framing — not their metadata JSON. A submit whose turn would
exceed the budget fails BEFORE any task starts with an explicit error;
`enforceHistoryBudget` remains the run-time backstop.

## Upload / submit lifecycle

The composer keeps working as before ("→ Upload files", attachment chips
with a lightweight "Image" marker — display metadata only, never a
capability decision). On submit, image attachments are ingested into the
AttachmentStore (durable snapshot) BEFORE the user frame is persisted, and
text + images bind into ONE user turn / ONE provider turn / ONE user bubble
(the bubble shows an "N images" chip). Individual rejected images surface a
conversation warning and the text still goes out.

## Security boundaries

- The capability registry is Harness-only; the agent has no write path.
- Base64 payloads never persist: verified for providerFrames,
  normalizedMessages, presentationEvents, conversation projections, logs,
  telemetry and UI text (sentinel-bytes tests at unit and browser level).
- Approval questions/answers and probe prompts/answers never enter
  provider-visible history.

## Cancellation / liveness (Approval consumer contract)

Every gate consumer follows docs/APPROVALS.md — decision → safe preparation
→ final AbortSignal check → provider side effect. Verified:
unknown→Yes→cancel before the request → ZERO provider side effects;
cancel during a probe → inconclusive, no registry write; cancel while the
card is pending → task cancelled, card closed, registry untouched.

## Known v1 limitations

- No agent-readable filesystem projection of the registry (future
  system-read-only mount at `/home/locus/.config/locus/model-capabilities.json`).
- Builtin seed covers only the families above; anything else asks once.
- Images in tool results (the `attachments: [{ type:'image', … }]` seam) are
  defined and reserved but have no producer yet.
- Inconclusive capability (unknown) is retried by asking again on a later
  run — there is no probe back-off budget in v1 (bounded per run).
- Cross-provider image-rich continuation relies on the same gate; it is not
  silently dropped, but there is no per-conversation "block images across
  providers" override.
