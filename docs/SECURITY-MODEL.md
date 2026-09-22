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

The future trusted package loader may acquire verified code through the trusted harness, but Plugin code still must not inherit network, DOM, credentials, or MCP authority.

## 8. Perception

Image support is a compatibility decision, not an authority grant. Provider/model capability evidence is scoped to full provider identity; third-party endpoints do not inherit official builtin claims by copying model names.

## 9. Secrets

API keys are not persisted by default. Opt-in storage is destination-aware and separate from conversation/provider history.

## 10. Explicit non-claims

Locus does not claim full POSIX isolation, hostile-code sandbox certification, a browser TCP/IP stack, automatic rollback of committed side effects, authenticated browser automation, a production Plugin marketplace, or a production MCP transport/auth layer on current main.
