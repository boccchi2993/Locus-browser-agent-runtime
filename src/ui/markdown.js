// ============================================================
//  MARKDOWN-LITE (presentation only)
//
//  Minimal, XSS-safe renderer for assistant/user-visible text:
//  HTML is escaped FIRST, then a small inline/block grammar is applied
//  (bold, emphasis, inline code, unordered lists, ATX headers). No
//  links, images or raw HTML — model output can never inject markup.
//  Classic script like the rest of the non-bundled layer, so the Node
//  suites can eval it directly.
// ============================================================

var LocusMarkdown = (function () {
  'use strict';

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function inline(escaped) {
    return escaped
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  // Renders to an HTML string safe for v-html (input fully escaped).
  function render(text) {
    var lines = String(text || '').split(/\r?\n/);
    var html = [];
    var list = null;
    var para = null;

    function flushPara() {
      if (para) { html.push('<p>' + para.join('<br>') + '</p>'); para = null; }
    }
    function flushList() {
      if (list) { html.push('<ul>' + list.map(function (i) { return '<li>' + i + '</li>'; }).join('') + '</ul>'); list = null; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var esc = escapeHtml(line);
      var trimmed = line.trim();
      if (!trimmed) {
        flushPara(); flushList();
        continue;
      }
      var head = trimmed.match(/^(#{1,4})\s+(.*)$/);
      if (head) {
        flushPara(); flushList();
        var level = Math.min(head[1].length + 2, 6); // ## → h4 …, keeps headers small
        html.push('<h' + level + '>' + inline(escapeHtml(head[2])) + '</h' + level + '>');
        continue;
      }
      var li = trimmed.match(/^[-*]\s+(.*)$/);
      if (li) {
        flushPara();
        if (!list) list = [];
        list.push(inline(escapeHtml(li[1])));
        continue;
      }
      flushList();
      if (!para) para = [];
      para.push(inline(esc));
    }
    flushPara(); flushList();
    return html.join('');
  }

  return { render: render };
})();
