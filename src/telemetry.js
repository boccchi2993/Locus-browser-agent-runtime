// ============================================================
//  TELEMETRY
//  In-memory execution telemetry. Every tool execution is recorded
//  here; inspect via the "log" panel, the `telemetry` command, or
//  window.__telemetry in the console.
// ============================================================
const Telemetry = {
  records: [],

  record(entry) {
    const rec = Object.assign({
      ts: new Date().toISOString(),
      tool: '',
      backend: 'browser',
      duration_ms: 0,
      success: false,
      input_bytes: 0,
      output_bytes: 0,
      error: null,
    }, entry);
    this.records.push(rec);
    if (this.records.length > 500) this.records = this.records.slice(-500);
    if (typeof renderDebugPanel === 'function') renderDebugPanel();
    return rec;
  },
};

window.__telemetry = Telemetry.records;
