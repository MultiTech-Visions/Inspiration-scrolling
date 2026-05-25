'use strict';

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return await res.json();
}

const root = document.getElementById('todos-content');

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// Hand-off format for pasting into Claude Code. Markdown but plain enough that
// Claude Code will read it as task spec, not a transcript.
function handoffText(card) {
  const p = card.payload;
  const lines = [
    `# ${p.title}`,
    '',
    p.summary,
    '',
    '## Details',
    '',
    p.body,
  ];
  if (card.type === 'discovery' && Array.isArray(p.source_urls) && p.source_urls.length > 0) {
    lines.push('', '## Sources', '');
    for (const u of p.source_urls) lines.push(`- ${u}`);
  }
  if (card.type === 'codebase' && p.repo) {
    lines.push('', '## Repository', '', `${p.repo.owner}/${p.repo.name} (${p.repo.ref}) — finding kind: ${p.finding_kind}`);
    if (Array.isArray(p.references) && p.references.length > 0) {
      lines.push('', '### References', '');
      for (const r of p.references) lines.push(`- ${r.path}${r.line ? ':' + r.line : ''}`);
    }
  }
  if (p.discussion_context) {
    lines.push('', '## Additional context (prepared alongside the card)', '', p.discussion_context);
  }
  lines.push('', `_(card #${card.id} — saved ${card.saved_at})_`);
  return lines.join('\n');
}

async function render() {
  let data;
  try {
    data = await api('/api/todos');
  } catch (err) {
    root.textContent = 'Failed to load: ' + err.message;
    return;
  }
  root.innerHTML = '';

  const grouped = { saved: [], done: [] };
  for (const c of data.cards) grouped[c.status]?.push(c);

  if (grouped.saved.length === 0 && grouped.done.length === 0) {
    root.appendChild(el('p', { class: 'summary' }, 'Nothing saved yet. Tap 📌 on a card in the feed to add it here.'));
    return;
  }

  for (const status of ['saved', 'done']) {
    if (grouped[status].length === 0) continue;
    const h2 = el('h2', null, status === 'saved' ? 'pending' : 'done');
    root.appendChild(h2);
    for (const card of grouped[status]) {
      root.appendChild(renderTodoCard(card));
    }
  }
}

function renderTodoCard(card) {
  const p = card.payload;
  const wrap = el('article', { class: `card todo ${card.type} ${card.status}` });

  const tags = el('div', { class: 'tag-row' },
    el('span', { class: `type-tag ${card.type}` }, card.type),
    card.goal_topic ? el('span', null, `goal: ${card.goal_topic}`) : null,
  );
  wrap.appendChild(tags);

  wrap.appendChild(el('h2', null, p.title || '(untitled)'));
  if (p.summary) wrap.appendChild(el('p', { class: 'summary' }, p.summary));

  const body = document.createElement('div');
  body.className = 'body markdown';
  body.innerHTML = window.renderMarkdown(p.body || '');
  wrap.appendChild(body);

  if (Array.isArray(p.source_urls) && p.source_urls.length > 0) {
    const sources = el('ul', { class: 'sources' });
    for (const u of p.source_urls) {
      sources.appendChild(el('li', null,
        el('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, u)));
    }
    wrap.appendChild(el('div', null, el('strong', null, 'Sources'), sources));
  }

  const actions = el('div', { class: 'actions' });

  const copyBtn = button('📋 copy for Claude', 'copy', async () => {
    try {
      await navigator.clipboard.writeText(handoffText(card));
      copyBtn.textContent = '✓ copied';
      setTimeout(() => { copyBtn.textContent = '📋 copy for Claude'; }, 1500);
    } catch (err) {
      alert('Copy failed: ' + err.message + '\n\n(You may need to grant clipboard permission, or run on https.)');
    }
  });
  actions.appendChild(copyBtn);

  if (card.status === 'saved') {
    actions.appendChild(button('✓ mark done', 'done', async () => {
      try {
        await api(`/api/todos/${card.id}/done`, { method: 'POST' });
        await render();
      } catch (err) { alert('Failed: ' + err.message); }
    }));
  } else {
    actions.appendChild(button('↺ undo done', '', async () => {
      try {
        await api(`/api/todos/${card.id}/undone`, { method: 'POST' });
        await render();
      } catch (err) { alert('Failed: ' + err.message); }
    }));
  }

  actions.appendChild(button('🗑 delete', '', async () => {
    if (!confirm('Remove this card from the to-do list? (It is not deleted from history, just removed from this view.)')) return;
    try {
      await api(`/api/todos/${card.id}/delete`, { method: 'POST' });
      await render();
    } catch (err) { alert('Failed: ' + err.message); }
  }));

  wrap.appendChild(actions);
  return wrap;
}

render();
