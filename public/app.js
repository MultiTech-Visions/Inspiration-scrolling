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
    // outcome buttons rendered inside learning body
  } else {
    actions.appendChild(button('👍', 'thumb-up', () => giveFeedback(card.id, { kind: 'thumbs', value: 'up' }, root)));
    actions.appendChild(button('👎', 'thumb-down', () => giveFeedback(card.id, { kind: 'thumbs', value: 'down' }, root, { drop: true })));
    actions.appendChild(button('♡', 'heart',     () => giveFeedback(card.id, { kind: 'heart' }, root)));
  }
  actions.appendChild(button('done', 'done', () => giveFeedback(card.id, { kind: 'consume' }, root, { drop: true })));
  root.appendChild(actions);

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

  root.appendChild(el('div', { class: 'body' }, p.body || ''));

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
  root.appendChild(el('div', { class: 'body' }, p.body || ''));
  if (Array.isArray(p.references) && p.references.length > 0) {
    const refs = el('ul', { class: 'refs' });
    for (const r of p.references) {
      refs.appendChild(el('li', null, r.line ? `${r.path}:${r.line}` : r.path));
    }
    root.appendChild(refs);
  }
}

function renderLearningBody(root, p, card) {
  root.appendChild(el('p', null, p.prompt_text || ''));

  if (p.subtype === 'tidbit') {
    if (p.answer_text) {
      root.appendChild(el('div', { class: 'reveal shown' }, p.answer_text));
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
      root.appendChild(el('div', { class: 'reveal' }, p.answer_text));
    }
    return;
  }

  // flashcard/question
  const reveal = el('div', { class: 'reveal' }, p.answer_text || '');
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

refreshFeed().catch((err) => {
  queueMeta.textContent = 'Failed to load feed: ' + err.message;
});
