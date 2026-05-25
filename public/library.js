'use strict';

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return await res.json();
}

const content = document.getElementById('library-content');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const NEXT_STATUS = {
  active: ['paused', 'mastered', 'cancelled'],
  paused: ['active', 'mastered', 'cancelled'],
  mastered: ['active'],
  cancelled: ['active'],
};

async function render() {
  let data;
  try {
    data = await api('/api/library');
  } catch (err) {
    content.textContent = 'Failed to load: ' + err.message;
    return;
  }
  content.innerHTML = '';
  if (data.goals.length === 0) {
    content.innerHTML = '<p>No goals yet. Submit a <code>learning_goal</code> request from settings.</p>';
    return;
  }

  const grouped = { active: [], paused: [], mastered: [], cancelled: [] };
  for (const g of data.goals) grouped[g.status].push(g);

  for (const status of ['active', 'paused', 'mastered', 'cancelled']) {
    if (grouped[status].length === 0) continue;
    const h2 = document.createElement('h2');
    h2.textContent = status;
    content.appendChild(h2);
    for (const g of grouped[status]) {
      content.appendChild(renderGoal(g, data.cards_by_goal[String(g.id)] || []));
    }
  }
}

function renderGoal(goal, cards) {
  const card = document.createElement('div');
  card.className = 'goal-card';

  const header = document.createElement('header');
  const title = document.createElement('div');
  title.innerHTML = `<strong>${escapeHtml(goal.topic)}</strong> <span style="color: var(--text-dim); font-size: 0.85rem;">·  reviewed ${goal.total_reviewed} (${goal.total_correct} correct) · streak ${goal.correct_streak}/${goal.mastery_threshold}</span>`;
  header.appendChild(title);

  const statusTag = document.createElement('span');
  statusTag.className = `goal-status ${goal.status}`;
  statusTag.textContent = goal.status;
  header.appendChild(statusTag);
  card.appendChild(header);

  const row = document.createElement('div');
  row.className = 'button-row';
  for (const next of NEXT_STATUS[goal.status] || []) {
    const b = document.createElement('button');
    b.textContent = `→ ${next}`;
    b.addEventListener('click', async () => {
      if (!confirm(`Change goal "${goal.topic}" to ${next}?`)) return;
      try {
        await api(`/api/goals/${goal.id}/status`, { method: 'POST', body: JSON.stringify({ status: next }) });
        await render();
      } catch (err) { alert('Failed: ' + err.message); }
    });
    row.appendChild(b);
  }
  card.appendChild(row);

  if (cards.length > 0) {
    const list = document.createElement('ul');
    list.className = 'goal-card-list';
    for (const c of cards) {
      const li = document.createElement('li');
      const titleText = c.payload && c.payload.title ? c.payload.title : '(card)';
      const subtype = c.payload && c.payload.subtype ? c.payload.subtype : '';
      li.innerHTML = `<span style="color:var(--text-dim)">${c.status} · ${subtype}</span> · ${escapeHtml(titleText)}`;
      list.appendChild(li);
    }
    card.appendChild(list);
  }

  return card;
}

render();
