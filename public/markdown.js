// Minimal client-side markdown renderer. Safe subset only: headings, paragraphs,
// unordered/ordered lists, fenced code blocks, inline code, bold, italic, links,
// blockquotes. Everything else is HTML-escaped and rendered literally. Returns
// a STRING of HTML; the caller is responsible for setting innerHTML.
(function () {
  'use strict';

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  function renderInline(s) {
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
      return '<a href="' + escapeAttr(u) + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
    });
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\\*])\*([^\s*][^*\n]*?)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\\_])_([^\s_][^_\n]*?)_/g, '$1<em>$2</em>');
    return s;
  }

  function renderBlock(block) {
    if (/^\s*␚CODE\d+␚\s*$/.test(block)) return block.trim();
    var m = block.match(/^(#{1,6})\s+(.+)$/);
    if (m) {
      var level = Math.min(6, m[1].length + 2);
      return '<h' + level + '>' + renderInline(m[2]) + '</h' + level + '>';
    }
    var lines = block.split('\n');
    if (lines.every(function (l) { return /^[-*]\s/.test(l); })) {
      return '<ul>' + lines.map(function (l) {
        return '<li>' + renderInline(l.replace(/^[-*]\s+/, '')) + '</li>';
      }).join('') + '</ul>';
    }
    if (lines.every(function (l) { return /^\d+\.\s/.test(l); })) {
      return '<ol>' + lines.map(function (l) {
        return '<li>' + renderInline(l.replace(/^\d+\.\s+/, '')) + '</li>';
      }).join('') + '</ol>';
    }
    if (lines.every(function (l) { return /^>\s?/.test(l); })) {
      return '<blockquote>' + lines.map(function (l) {
        return renderInline(l.replace(/^>\s?/, ''));
      }).join('<br>') + '</blockquote>';
    }
    return '<p>' + renderInline(block).replace(/\n/g, '<br>') + '</p>';
  }

  function renderMarkdown(md) {
    if (typeof md !== 'string' || md.length === 0) return '';

    var blocks = [];
    md = md.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      var i = blocks.push({ lang: lang, code: code }) - 1;
      return '\n\n␚CODE' + i + '␚\n\n';
    });

    md = escapeHtml(md);

    var html = md.split(/\n{2,}/).map(function (b) { return renderBlock(b); }).join('\n');

    return html.replace(/␚CODE(\d+)␚/g, function (_, i) {
      var b = blocks[+i];
      var cls = b.lang ? ' class="lang-' + escapeAttr(b.lang) + '"' : '';
      return '<pre><code' + cls + '>' + escapeHtml(b.code) + '</code></pre>';
    });
  }

  window.renderMarkdown = renderMarkdown;
  window.escapeHtml = escapeHtml;
})();
