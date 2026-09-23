# Locus security and authority model

Locus is a browser-local agent harness, not a hostile-code sandbox certification. Claims are deliberately narrow and testable.

## 1. Authority vs approval

**Authority** is technical reachability. **Approval** is a human decision about a specific action already within hard authority.

Approval can reduce autonomy; it cannot manufacture authority.

## 2. Trust zones

- Workspace/upload/network/tool content is data, not policy.
- Model-generated shell/Python is an untrusted proposed action.
- Runtime code, fixed manifests, and trusted descriptor/source catalogs are harness inputs.
- Model APIs, relays, and future MCP services are separate remote boundaries.

## 3. Filesystem authority

User-granted workspace authority is explicit. Uploads are read-only. Paths are normalized and structural roots protected. Task VFS forks prevent mid-task workspace rebinding.

## 4. Python authority

Model-generated Python is local compute + filesystem, not a network client.

A strict-CSP creator iframe produces the worker so user-phase network primitives cannot issue requests. F04a JS lockdown is defense-in-depth.

The trusted page acquires the fixed Pyodide bootstrap set, verifies exact size + SHA-256, then delivers verified bytes to the worker.

Trusted Plugin Runtime v1A extends this contract with verified plugin wheels: the harness validates the payload (shape, bounds, metadata/bytes agreement) and takes an own copy; the worker re-verifies byte identity (size + SHA-256) before installing, installs OFFLINE from a `/tmp` scratch path (micropip `emfs:`, `deps=False` — no dependency closure, no package index), smoke-imports every declared import, deletes the scratch file, retires the bootstrap installer (`micropip.install` becomes a denial), and only then reports READY. Plugin wheels never enter the F04c bootstrap manifest: they travel as payload data, and a broken payload fails the boot closed. After READY, user-phase package loading stays Harness-controlled: `micropip.install` (remote, index, or local `emfs:`) is a denial, `pyodide.loadPackage`/`loadPackagesFromImports` are denied, and the browser CSP makes every remaining network act impossible with zero requests.

This is a concrete no-network authority contract, not proof against every imaginable hostile-code escape.

## 5. Network authority

NetworkRuntime accepts bounded HTTP/HTTPS only. Ambient credentials are omitted, unsafe headers filtered, sizes/deadlines bounded, and private relay targets refused.

GET/HEAD retry only on genuine initial transport failure. Side-effecting methods are approval-gated and sent exactly once.

## 6. Behavior authority: Skills

Changing a SkillInstance changes future behavior.

Read is free; create/write/delete requires `confirmation` every time, with a harness-built diff, no session grant, bounded review size, TOCTOU recheck, and task-cancellation checks.

Prompt injection may propose a change. It cannot silently persist one.

## 7. Capability / Plugin / MCP

Capability enablement does not auto-connect MCP. Plugin v1 authority is exactly `none`.

The future trusted package loader may acquire verified code through the trusted harness, but Plugin code still must not inherit network, DOM, credentials, or MCP authority. (The v1A offline wheel bootstrap primitive implements exactly this: verified wheel bytes in, pre-READY offline install, no new authority for the plugin or for user Python.)

## 8. Capability package import (planned authoring boundary)

The Capability Package/Authoring design introduces an explicit trust transition: **writing/building extension code is not the same as installing it**.

A future import path must require an explicit user action before model-authored or third-party code becomes registered extension code. Structural validation and SHA-256 prove coherence/identity, not benevolence.

After import, Plugin authority is still `none`: package code receives only the local computation/filesystem authority of the runtime it joins and no extra network, DOM, browser credential, API-key, arbitrary parent-RPC, or MCP authority.

The model must not have a hidden shell/RPC path that auto-trusts its own generated package.

## 9. Perception

Image support is a compatibility decision, not an authority grant. Provider/model capability evidence is scoped to full provider identity; third-party endpoints do not inherit official builtin claims by copying model names.

## 10. Secrets

API keys are not persisted by default. Opt-in storage is destination-aware and separate from conversation/provider history.

## 11. Explicit non-claims

Locus does not claim full POSIX isolation, hostile-code sandbox certification, a browser TCP/IP stack, automatic rollback of committed side effects, authenticated browser automation, a production Plugin marketplace, or a production MCP transport/auth layer on current main.