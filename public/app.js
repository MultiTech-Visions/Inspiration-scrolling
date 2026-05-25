'use strict';

const stack = document.getElementById('card-stack');
const emptyState = document.getElementById('empty-state');
const queueMeta = document.getElementById('queue-meta');
const runFromEmpty = document.getElementById('run-now-from-empty');

const state = {
  cards: [],
  queued: 0,
  refillThreshold: 8,
  refillInFlight: false,
};

runFromEmpty.addEventListener('click', async () => {
  runFromEmpty.disabled = true;
  runFromEmpty.textContent = 'Generating…';
  try {
    await fetch('/api/run-now', { method: 'POST' });
    await refreshFeed();
  } catch (err) {
    alert('Run failed: ' + err.message);
  } finally {
    runFromEmpty.disabled = false;
    runFromEmpty.textContent = 'Generate cards';
  }
});

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  const res = await fetch(path, { headers, ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return await res.json();
}

async function refreshFeed() {
  const data = await api('/api/feed?limit=20');
  state.cards = data.cards;
  state.queued = data.queued;
  state.refillThreshold = data.refill_threshold;
  render();
  if (state.queued < state.refillThreshold && !state.refillInFlight) {
    triggerRefill();
  }
}

async function triggerRefill() {
  state.refillInFlight = true;
  queueMeta.textContent = `Queue low (${state.queued}). Refilling in the background…`;
  try {
    await fetch('/api/run-now', { method: 'POST' });
    await refreshFeed();
  } catch (err) {
    queueMeta.textContent = 'Refill failed: ' + err.message;
  } finally {
    state.refillInFlight = false;
  }
}

function render() {
  stack.innerHTML = '';
  if (state.cards.length === 0) {
    emptyState.hidden = false;
    queueMeta.textContent = '';
    return;
  }
  emptyState.hidden = true;
  for (const card of state.cards) {
    stack.appendChild(renderCard(card));
  }
  queueMeta.textContent = `${state.queued} card${state.queued === 1 ? '' : 's'} in the queue.`;
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) c.forEach((x) => x && node.appendChild(typeof x === 'string' ? document.createTextNode(x) : x));
    else node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function renderCard(card) {
  const root = el('article', { class: `card ${card.type}`, 'data-card-id': card.id });
  const p = card.payload;

  const tagRow = el('div', { class: 'tag-row' },
    el('span', { class: `type-tag ${card.type}` }, card.type),
    card.goal_topic ? el('span', null, `goal: ${card.goal_topic}`) : null,
  );
  root.appendChild(tagRow);

  root.appendChild(el('h2', null, p.title || '(untitled)'));
  if (p.summary) root.appendChild(el('p', { class: 'summary' }, p.summary));

  if (card.type === 'discovery') {
    renderDiscoveryBody(root, p, card);
  } else if (card.type === 'codebase') {
    renderCodebaseBody(root, p, card);
  } else if (card.type === 'learning') {
    renderLearningBody(root, p, card);
  }

  const actions = el('div', { class: 'actions' });
  if (card.type === 'learning') {
    // outcome buttons rendered inside learning body; reaction buttons skipped.
  } else {
    actions.appendChild(button('👍', 'thumb-up',   () => giveFeedback(card.id, { kind: 'thumbs', value: 'up' }, root)));
    actions.appendChild(button('👎', 'thumb-down', () => giveFeedback(card.id, { kind: 'thumbs', value: 'down' }, root, { drop: true })));
    actions.appendChild(button('♡', 'heart',       () => giveFeedback(card.id, { kind: 'heart' }, root)));
    actions.appendChild(button('📌 save', 'save',  () => giveFeedback(card.id, { kind: 'save' }, root, { drop: true })));
  }
  actions.appendChild(button('💬 discuss', 'discuss', (e) => toggleDiscussion(card, root, e.target)));
  actions.appendChild(button('done', 'done', () => giveFeedback(card.id, { kind: 'consume' }, root, { drop: true })));
  root.appendChild(actions);

  // Discussion drawer is created lazily on first toggle; placeholder slot here.
  const drawerSlot = el('div', { class: 'discussion-slot' });
  root.appendChild(drawerSlot);

  return root;
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderDiscoveryBody(root, p, card) {
  if (p.video && p.video.embeddable && p.video.provider === 'youtube') {
    const idMatch = (p.video.source_url || '').match(/[?&]v=([^&]+)|youtu\.be\/([^?&]+)/);
    const ytId = idMatch ? (idMatch[1] || idMatch[2]) : null;
    if (ytId) {
      const embed = el('div', { class: 'embed' });
      embed.innerHTML = `<iframe src="https://www.youtube.com/embed/${ytId}" allow="encrypted-media" allowfullscreen></iframe>`;
      root.appendChild(embed);
    }
  } else if (p.video && !p.video.embeddable) {
    root.appendChild(el('p', { class: 'summary' },
      el('a', { href: p.video.source_url, target: '_blank', rel: 'noopener noreferrer' },
        `Watch on ${p.video.provider} →`)));
  }

  const bodyEl = document.createElement('div');
  bodyEl.className = 'body markdown';
  bodyEl.innerHTML = window.renderMarkdown(p.body || '');
  root.appendChild(bodyEl);

  if (Array.isArray(p.source_urls) && p.source_urls.length > 0) {
    const sources = el('ul', { class: 'sources' });
    for (const u of p.source_urls) {
      sources.appendChild(el('li', null,
        el('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, u)));
    }
    root.appendChild(el('div', null,
      el('strong', null, 'Sources'),
      sources,
    ));
  }
}

function renderCodebaseBody(root, p, card) {
  if (p.repo) {
    root.appendChild(el('p', { class: 'summary' },
      `${p.repo.owner}/${p.repo.name} (${p.repo.ref}) · ${p.finding_kind || ''}`));
  }
  const bodyEl = document.createElement('div');
  bodyEl.className = 'body markdown';
  bodyEl.innerHTML = window.renderMarkdown(p.body || '');
  root.appendChild(bodyEl);
  if (Array.isArray(p.references) && p.references.length > 0) {
    const refs = el('ul', { class: 'refs' });
    for (const r of p.references) {
      refs.appendChild(el('li', null, r.line ? `${r.path}:${r.line}` : r.path));
    }
    root.appendChild(refs);
  }
}

function renderLearningBody(root, p, card) {
  const promptEl = document.createElement('div');
  promptEl.className = 'body markdown';
  promptEl.innerHTML = window.renderMarkdown(p.prompt_text || '');
  root.appendChild(promptEl);

  if (p.subtype === 'tidbit') {
    if (p.answer_text) {
      const tidbit = document.createElement('div');
      tidbit.className = 'reveal shown markdown';
      tidbit.innerHTML = window.renderMarkdown(p.answer_text);
      root.appendChild(tidbit);
    }
    appendOutcomeButtons(root, card);
    return;
  }

  if (p.subtype === 'quiz') {
    const opts = el('div', { class: 'quiz-options' });
    const buttons = [];
    p.options.forEach((opt, i) => {
      const b = button(opt, '', () => {
        buttons.forEach((bb) => { bb.disabled = true; });
        const correct = i === p.correct_index;
        b.classList.add(correct ? 'correct' : 'incorrect');
        if (!correct) {
          buttons[p.correct_index].classList.add('correct');
        }
        recordLearning(card.id, correct ? 'correct' : 'incorrect', root);
      });
      buttons.push(b);
      opts.appendChild(b);
    });
    root.appendChild(opts);
    if (p.answer_text) {
      const rev = document.createElement('div');
      rev.className = 'reveal markdown';
      rev.innerHTML = window.renderMarkdown(p.answer_text);
      root.appendChild(rev);
    }
    return;
  }

  // flashcard/question
  const reveal = document.createElement('div');
  reveal.className = 'reveal markdown';
  reveal.innerHTML = window.renderMarkdown(p.answer_text || '');
  const showBtn = button('reveal', '', () => {
    reveal.classList.add('shown');
    showBtn.style.display = 'none';
    appendOutcomeButtons(root, card);
  });
  root.appendChild(showBtn);
  root.appendChild(reveal);
}

function appendOutcomeButtons(root, card) {
  const outcomes = el('div', { class: 'actions' },
    button('✓ correct',   '', () => recordLearning(card.id, 'correct', root)),
    button('✗ incorrect', '', () => recordLearning(card.id, 'incorrect', root)),
  );
  root.appendChild(outcomes);
}

async function recordLearning(card_id, result, rootEl) {
  try {
    await api('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'learning_outcome', card_id, result }),
    });
    if (result === 'correct') {
      rootEl.style.opacity = '0.4';
      setTimeout(() => rootEl.remove(), 400);
    }
  } catch (err) {
    alert('Failed to record: ' + err.message);
  }
}

async function giveFeedback(card_id, body, rootEl, opts = {}) {
  try {
    await api('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ card_id, ...body }),
    });
    if (opts.drop) {
      rootEl.style.opacity = '0.4';
      setTimeout(() => rootEl.remove(), 400);
    } else {
      rootEl.querySelectorAll(`.${body.kind === 'thumbs' ? `thumb-${body.value}` : body.kind}`)
        .forEach((b) => b.classList.add('active'));
    }
  } catch (err) {
    alert('Feedback failed: ' + err.message);
  }
}

// -----------------------------------------------------------------------------
// Discussion drawer. Created lazily under each card; one open/close toggle.
// -----------------------------------------------------------------------------
async function toggleDiscussion(card, cardRoot, triggerBtn) {
  const slot = cardRoot.querySelector('.discussion-slot');
  if (slot.firstChild) {
    // Already opened — collapse / re-expand.
    slot.classList.toggle('collapsed');
    triggerBtn.classList.toggle('active');
    return;
  }
  triggerBtn.classList.add('active');
  slot.appendChild(buildDiscussionDrawer(card));
  await loadDiscussionHistory(card.id, slot);
}

function buildDiscussionDrawer(card) {
  const drawer = el('div', { class: 'discussion' });

  const toggleCtxBtn = button('👁 show prepared context', 'ctx-toggle', () => {
    const ctx = drawer.querySelector('.prepared-context');
    const open = ctx.classList.toggle('shown');
    toggleCtxBtn.textContent = open ? '🙈 hide prepared context' : '👁 show prepared context';
  });

  const ctxBlock = document.createElement('div');
  ctxBlock.className = 'prepared-context markdown';
  ctxBlock.innerHTML = window.renderMarkdown(card.payload.discussion_context || '');

  const thread = el('div', { class: 'thread', 'data-card-id': card.id });
  const loading = el('div', { class: 'thread-loading' }, 'loading conversation…');
  thread.appendChild(loading);

  const inputArea = el('div', { class: 'discussion-input' });
  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Ask about this card…';
  textarea.rows = 2;
  const sendBtn = button('send', 'send', async () => {
    const text = textarea.value.trim();
    if (text.length === 0) return;
    sendBtn.disabled = true;
    textarea.disabled = true;
    appendThreadMessage(thread, 'user', text);
    appendThreadMessage(thread, 'assistant', '…thinking…', { pending: true });
    try {
      const result = await api(`/api/cards/${card.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: text }),
      });
      thread.querySelector('.thread-message.pending')?.remove();
      appendThreadMessage(thread, 'assistant', result.reply);
      if (result.engagement && result.engagement.applied) {
        const banner = el('div', { class: 'engagement-banner' },
          `✨ topic-weight boost applied (you've engaged with this card ${result.engagement.user_messages} times)`);
        thread.appendChild(banner);
      }
      textarea.value = '';
    } catch (err) {
      thread.querySelector('.thread-message.pending')?.remove();
      appendThreadMessage(thread, 'assistant', '_(failed: ' + err.message + ')_');
    } finally {
      sendBtn.disabled = false;
      textarea.disabled = false;
      textarea.focus();
    }
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendBtn.click();
    }
  });
  inputArea.appendChild(textarea);
  inputArea.appendChild(sendBtn);

  drawer.appendChild(toggleCtxBtn);
  drawer.appendChild(ctxBlock);
  drawer.appendChild(thread);
  drawer.appendChild(inputArea);
  return drawer;
}

function appendThreadMessage(thread, role, content, opts = {}) {
  // Clear "loading" placeholder if present.
  thread.querySelector('.thread-loading')?.remove();
  const wrap = document.createElement('div');
  wrap.className = `thread-message ${role}${opts.pending ? ' pending' : ''}`;
  const label = document.createElement('div');
  label.className = 'role';
  label.textContent = role === 'user' ? 'you' : 'claude';
  const body = document.createElement('div');
  body.className = 'message-body markdown';
  body.innerHTML = window.renderMarkdown(content);
  wrap.appendChild(label);
  wrap.appendChild(body);
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
}

async function loadDiscussionHistory(card_id, slot) {
  const thread = slot.querySelector('.thread');
  try {
    const data = await api(`/api/cards/${card_id}/messages`);
    thread.querySelector('.thread-loading')?.remove();
    if (data.messages.length === 0) {
      thread.appendChild(el('div', { class: 'thread-empty' },
        'No messages yet. Ask anything about this card — Claude has its body and a hidden prepared-context block on hand.'));
      return;
    }
    for (const m of data.messages) {
      appendThreadMessage(thread, m.role, m.content);
    }
  } catch (err) {
    thread.innerHTML = '';
    thread.appendChild(el('div', { class: 'thread-empty err' }, 'Failed to load: ' + err.message));
  }
}

refreshFeed().catch((err) => {
  queueMeta.textContent = 'Failed to load feed: ' + err.message;
});
