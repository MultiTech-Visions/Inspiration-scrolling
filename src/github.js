'use strict';

const USER_AGENT = 'inspiration-scrolling/0.1 (+https://github.com/multitech-visions/inspiration-scrolling)';

function authHeader() {
  const token = process.env.GITHUB_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function ghFetch(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...authHeader(),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${url}: ${body.slice(0, 200)}`);
  }
  return res;
}

// Fetch up to ~300 most-recent public events for the user. Caller supplies a
// since-cursor (etag-like ISO timestamp from the last successful run); we
// filter newer events client-side. Returns { events, latestCursor }.
async function fetchUserEvents(username, sinceIso) {
  if (typeof username !== 'string' || username.length === 0) {
    throw new Error('fetchUserEvents requires a non-empty username');
  }
  const since = sinceIso ? new Date(sinceIso).getTime() : 0;
  if (sinceIso && Number.isNaN(since)) {
    throw new Error(`Invalid sinceIso: ${sinceIso}`);
  }

  const events = [];
  let latestMs = since;

  for (let page = 1; page <= 3; page++) {
    const res = await ghFetch(`https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=100&page=${page}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    let stopped = false;
    for (const ev of batch) {
      const t = Date.parse(ev.created_at);
      if (!Number.isFinite(t)) continue;
      if (t > latestMs) latestMs = t;
      if (t <= since) {
        stopped = true;
        continue;
      }
      events.push(ev);
    }
    if (stopped) break;
    if (batch.length < 100) break;
  }

  return {
    events,
    latestCursor: latestMs > 0 ? new Date(latestMs).toISOString() : null,
  };
}

async function fetchRepoMetadata(owner, name) {
  const res = await ghFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  return await res.json();
}

async function fetchRepoLanguages(owner, name) {
  const res = await ghFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/languages`);
  return await res.json();
}

async function fetchRepoReadme(owner, name) {
  const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/readme`, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github.raw',
      'X-GitHub-Api-Version': '2022-11-28',
      ...authHeader(),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub README fetch ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.text();
}

async function fetchPackageManifest(owner, name) {
  const candidates = ['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile'];
  for (const path of candidates) {
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path}`, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github.raw',
        ...authHeader(),
      },
    });
    if (res.status === 404) continue;
    if (!res.ok) continue;
    const body = await res.text();
    return { path, body };
  }
  return null;
}

module.exports = {
  fetchUserEvents,
  fetchRepoMetadata,
  fetchRepoLanguages,
  fetchRepoReadme,
  fetchPackageManifest,
};
