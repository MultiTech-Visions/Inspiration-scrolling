'use strict';

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return await res.json();
}

const statusRow = document.getElementById('status-row');
const settingsGrid = document.getElementById('settings-grid');
const promptsList = document.getElementById('prompts-list');

async function refreshStatus() {
  try {
    const { lock, queued } = await api('/api/status');
    if (lock.running === 1) {
      statusRow.innerHTML = `<span class="running">Run in progress</span> · run_id=${lock.run_id} · started ${new Date(lock.started_at).toLocaleString()} · queue=${queued}`;
    } else if (lock.last_error) {
      statusRow.innerHTML = `<span class="err">Last run errored:</span> ${escapeHtml(lock.last_error.slice(0, 200))} · queue=${queued}`;
    } else {
      const finished = lock.finished_at ? new Date(lock.finished_at).toLocaleString() : 'never';
      statusRow.innerHTML = `<span class="ok">Idle</span> · last finished ${finished} · last cursor ${lock.last_cursor || '(none)'} · queue=${queued}`;
    }
  } catch (err) {
    statusRow.innerHTML = `<span class="err">Status fetch failed:</span> ${escapeHtml(err.message)}`;
  }
}

document.getElementById('run-now').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Running…';
  try {
    const result = await api('/api/run-now', { method: 'POST' });
    if (result.ok === false && result.reason === 'run-already-in-progress') {
      alert(`Run already in progress (run_id=${result.currentRunId}). Try again once it finishes.`);
    } else if (result.ok) {
      alert(`Run finished. Inserted: ${JSON.stringify(result.summary.inserted)}`);
    }
  } catch (err) {
    alert('Run failed: ' + err.message);
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Run now';
    await refreshStatus();
  }
});

document.getElementById('force-release').addEventListener('click', async () => {
  if (!confirm('Force-clear the run lock? Use only if a run is genuinely stuck.')) return;
  await api('/api/lock/force-release', { method: 'POST' });
  await refreshStatus();
});

document.getElementById('submit-request').addEventListener('click', async () => {
  const intent = document.getElementById('req-intent').value;
  const topic = document.getElementById('req-topic').value.trim();
  const focus = document.getElementById('req-focus').value.trim();
  const immediate = document.getElementById('req-immediate').checked;
  if (topic.length === 0) { alert('Topic / repo is required'); return; }

  let body;
  if (intent === 'learning_goal') {
    body = { intent, topic, immediate };
  } else if (intent === 'discovery_topic') {
    body = { intent, topic, immediate };
  } else if (intent === 'codebase_audit') {
    const [owner, name] = topic.split('/');
    if (!owner || !name) { alert('codebase_audit needs "owner/name"'); return; }
    body = { intent, repo: { owner, name }, focus: focus || undefined, immediate };
  }
  try {
    const result = await api('/api/requests', { method: 'POST', body: JSON.stringify(body) });
    alert(`Submitted (request_id=${result.request_id})${result.run ? ` · run=${JSON.stringify(result.run.summary || result.run.reason)}` : ''}`);
    document.getElementById('req-topic').value = '';
    document.getElementById('req-focus').value = '';
    document.getElementById('req-immediate').checked = false;
    await refreshStatus();
  } catch (err) {
    alert('Submit failed: ' + err.message);
  }
});

async function refreshSettings() {
  const { settings, prompts } = await api('/api/settings');
  settingsGrid.innerHTML = '';
  for (const s of settings) {
    const label = document.createElement('label');
    label.textContent = s.key;
    settingsGrid.appendChild(label);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = s.value;
    input.dataset.key = s.key;
    settingsGrid.appendChild(input);
  }

  promptsList.innerHTML = '';
  for (const p of prompts) {
    const card = document.createElement('div');
    card.className = 'prompt-card';

    const header = document.createElement('header');
    header.innerHTML = `<span class="key">${escapeHtml(p.key)}</span><span class="updated">${new Date(p.updated_at).toLocaleString()}</span>`;
    card.appendChild(header);

    const ta = document.createElement('textarea');
    ta.value = p.instruction_text;
    ta.dataset.key = p.key;
    card.appendChild(ta);

    const row = document.createElement('div');
    row.className = 'button-row';
    const save = document.createElement('button');
    save.textContent = 'Save';
    save.addEventListener('click', async () => {
      try {
        await api(`/api/prompts/${encodeURIComponent(p.key)}`, {
          method: 'PUT',
          body: JSON.stringify({ instruction_text: ta.value }),
        });
        await refreshSettings();
      } catch (err) { alert('Save failed: ' + err.message); }
    });
    const reset = document.createElement('button');
    reset.textContent = 'Reset to default';
    reset.addEventListener('click', async () => {
      if (!confirm(`Reset prompt "${p.key}" to its default?`)) return;
      try {
        await api(`/api/prompts/${encodeURIComponent(p.key)}/reset`, { method: 'POST' });
        await refreshSettings();
      } catch (err) { alert('Reset failed: ' + err.message); }
    });
    row.appendChild(save);
    row.appendChild(reset);
    card.appendChild(row);

    promptsList.appendChild(card);
  }
}

document.getElementById('save-settings').addEventListener('click', async () => {
  const updates = {};
  for (const input of settingsGrid.querySelectorAll('input')) {
    updates[input.dataset.key] = input.value;
  }
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(updates) });
    alert('Settings saved.');
  } catch (err) { alert('Save failed: ' + err.message); }
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

refreshStatus().catch(() => {});
refreshSettings().catch((err) => {
  promptsList.textContent = 'Failed to load: ' + err.message;
});
