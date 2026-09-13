// ============================================================
//  PRESENTATION PROJECTOR (pure, framework-independent)
//
//  The single mapping from AgentSession runtime events to
//  presentation timeline state:
//
//    task_start → reasoning* → tool_call → tool_result → …
//    → assistant_text → task_end   (+ warning / error at any point)
//
//  This file is a classic script (like the runtime under src/) so the
//  Node suites can eval it directly — no bundler semantics here. It
//  knows NOTHING about Vue, the DOM, providers or tool execution; it
//  only shapes events into timeline items for whatever UI consumes
//  them. Presentation state is a projection: it is NEVER serialized
//  back into provider history (docs/MODEL-PROTOCOL.md).
//
//  Fidelity rules honored here:
//  - reasoning content is stored COMPLETE; collapsing/truncating for
//    display is a component concern, never done in this layer.
//  - backend badges come only from event metadata; nothing is guessed.
//  - opaque/redacted provider state never appears in events, so it
//    can never appear here either.
// ============================================================

var LocusProjector = (function () {
  'use strict';

  var nextItemId = 1;

  // Conversation = one presentation-level task thread. `items` is the
  // timeline; `meta` derives progress-rail state from real events only
  // (no invented plan steps).
  function createConversation(id, title) {
    return {
      id: id,
      title: title || 'New task',
      createdAt: new Date().toISOString(),
      status: 'idle', // idle | running | completed | error | cancelled | session_changed | iteration_limit
      items: [],
      meta: {
        toolCount: 0,
        lastTool: null,      // most recent tool name
        lastBackend: null,   // most recent tool_result backend metadata
        lastOperation: null, // most recent tool_result operation metadata
      },
    };
  }

  function push(conv, item) {
    item.id = nextItemId++;
    conv.items.push(item);
    return item;
  }

  // Attach a tool_result to its originating tool_call item so a tool
  // step renders as one collapsible unit (call + result). Falls back to
  // a standalone result item if the call is missing (defensive only —
  // the runtime always pairs them).
  function attachToolResult(conv, event) {
    for (var i = conv.items.length - 1; i >= 0; i--) {
      var it = conv.items[i];
      if (it.kind === 'tool' && !it.result) {
        it.result = {
          backend: event.backend !== undefined ? event.backend : null,
          success: !!event.success,
          output: event.output !== undefined ? event.output : '',
          operation: event.operation !== undefined ? event.operation : null,
        };
        it.state = event.success ? 'done' : 'failed';
        return it;
      }
    }
    return push(conv, {
      kind: 'tool_result',
      tool: event.tool || null,
      result: {
        backend: event.backend !== undefined ? event.backend : null,
        success: !!event.success,
        output: event.output !== undefined ? event.output : '',
        operation: event.operation !== undefined ? event.operation : null,
      },
    });
  }

  // Project one runtime event into the conversation. Unknown event
  // types are ignored — the projector must never crash the UI on an
  // event schema it predates.
  function projectEvent(conv, event) {
    if (!conv || !event || typeof event.type !== 'string') return conv;
    switch (event.type) {
      case 'task_start':
        conv.status = 'running';
        if (typeof event.input === 'string' && event.input.trim()) {
          push(conv, { kind: 'user', content: event.input });
          if (conv.title === 'New task') {
            conv.title = event.input.trim().split(/\r?\n/)[0].slice(0, 60);
          }
        }
        break;
      case 'reasoning':
        push(conv, {
          kind: 'reasoning',
          content: event.content !== undefined ? event.content : '',
          presentation: event.presentation || 'raw',
        });
        break;
      case 'tool_call':
        conv.meta.lastTool = event.tool || null;
        push(conv, {
          kind: 'tool',
          tool: event.tool || 'tool',
          input: event.input !== undefined ? event.input : '',
          result: null,
          state: 'running',
        });
        break;
      case 'tool_result':
        conv.meta.toolCount++;
        conv.meta.lastBackend = event.backend !== undefined ? event.backend : null;
        conv.meta.lastOperation = event.operation !== undefined ? event.operation : null;
        attachToolResult(conv, event);
        break;
      case 'assistant_text':
        push(conv, { kind: 'assistant', content: event.content !== undefined ? event.content : '' });
        break;
      case 'warning':
        push(conv, { kind: 'warning', code: event.code || null, message: event.message || '' });
        break;
      case 'error':
        push(conv, { kind: 'error', code: event.code || null, message: event.message || '' });
        break;
      case 'task_end':
        conv.status = event.reason || 'completed';
        break;
    }
    return conv;
  }

  return {
    createConversation: createConversation,
    projectEvent: projectEvent,
  };
})();
