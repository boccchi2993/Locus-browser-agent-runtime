// ============================================================
//  TELEMETRY
//  In-memory execution telemetry. Every tool execution is recorded
//  here; inspect via the "log" panel, the `telemetry` command, or
//  window.__telemetry in the console.
// ============================================================

// Real UTF-8 byte length of a string (NOT String.length, which counts
// UTF-16 code units — e.g. "你好" is 6 bytes, not 2).
function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text)).byteLength;
}

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
    // Trim in place: window.__telemetry holds a reference to this exact
    // array and must never be detached by reassignment.
    if (this.records.length > 500) this.records.splice(0, this.records.length - 500);
    if (typeof renderDebugPanel === 'function') renderDebugPanel();
    return rec;
  },
};

window.__telemetry = Telemetry.records;
