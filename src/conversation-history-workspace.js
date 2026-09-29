// ============================================================
//  PRODUCT: conversation history as a read-only VFS provider.
//  (M2a, repository split — moved verbatim out of src/workspace.js:
//  this is a Product persistence view shaped as a WorkspaceAdapter,
//  not a Runtime filesystem primitive.) Mounted by the product store
//  at /home/locus/history over PersistenceServiceInstance.
// ============================================================
class ConversationHistoryWorkspace extends WorkspaceAdapter {
  constructor(service) { super(); this.service = service; this.name = 'history'; }

  _parts(path) {
    const rel = normalizeWorkspacePath(path);
    return rel ? rel.split('/') : [];
  }

  async list(path) {
    const parts = this._parts(path);
    const conversations = await this.service.loadConversations();
    if (!parts.length) return conversations.map((c) => ({ name: c.id, kind: 'directory' }));
    if (parts.length === 1) return [
      { name: 'events.jsonl', kind: 'file' },
      { name: 'messages.jsonl', kind: 'file' },
      { name: 'provider-frames.jsonl', kind: 'file' },
    ];
    throw new Error('not a directory: ' + path);
  }

  async read(path) {
    const parts = this._parts(path);
    if (parts.length !== 2) throw new Error('is a directory: ' + path);
    const conversationId = parts[0];
    const name = parts[1];
    const rows = name === 'events.jsonl'
      ? await this.service._byIndex('presentationEvents', 'conversationId', conversationId)
      : name === 'messages.jsonl'
        ? await this.service.loadNormalizedMessages(conversationId)
        : name === 'provider-frames.jsonl'
          ? await (async () => {
            const session = await this.service.loadProviderSession(conversationId);
            return session ? this.service.loadProviderFrames(session.id) : [];
          })()
          : null;
    if (!rows) throw new Error('no such file: ' + path);
    return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  }

  async readBytes(path) { return new TextEncoder().encode(await this.read(path)); }
  async write(path) { throw new Error('read-only filesystem: ' + path); }
  async remove(path) { throw new Error('read-only filesystem: ' + path); }
  async mkdir(path) { throw new Error('read-only filesystem: ' + path); }
  async exists(path) {
    try { await this.stat(path); return true; } catch (e) { if (e && e.name === 'NotFoundError') return false; throw e; }
  }
  async stat(path) {
    const parts = this._parts(path);
    if (!parts.length) return { kind: 'directory', size: 0, modified: null };
    const conversations = await this.service.loadConversations();
    if (parts.length === 1 && conversations.some((c) => c.id === parts[0])) return { kind: 'directory', size: 0, modified: null };
    if (parts.length === 2 && ['events.jsonl', 'messages.jsonl', 'provider-frames.jsonl'].includes(parts[1])) {
      return { kind: 'file', size: (await this.read(path)).length, modified: null };
    }
    const e = new Error('no such file or directory: ' + path); e.name = 'NotFoundError'; throw e;
  }
}
