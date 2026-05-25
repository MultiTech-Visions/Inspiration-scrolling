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
  listPullRequests,
  getPullRequest,
  getPullRequestFiles,
  getPullRequestComments,
  getPullRequestCommits,
  listCommits,
  getCommit,
  listIssues,
  getIssue,
};

// ---------------------------------------------------------------------------
// Agentic read-only surface for the codebase-card pipeline. Each function maps
// to a single GitHub endpoint and returns a compact, model-friendly shape.
// Patches and long bodies are truncated to keep tool-result payloads bounded.
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

function truncate(s, n) {
  if (typeof s !== 'string') return s == null ? null : s;
  return s.length > n ? `${s.slice(0, n)}\n…[truncated, ${s.length - n} chars cut]` : s;
}

function clampInt(n, min, max, fallback) {
  const x = Number.isInteger(n) ? n : parseInt(n, 10);
  if (!Number.isInteger(x)) return fallback;
  return Math.min(Math.max(x, min), max);
}

async function listPullRequests(owner, name, { state = 'all', per_page = 20 } = {}) {
  const p = clampInt(per_page, 1, 50, 20);
  const s = ['open', 'closed', 'all'].includes(state) ? state : 'all';
  const res = await ghFetch(`https://api.github.com/repos/${enc(owner)}/${enc(name)}/pulls?state=${s}&per_page=${p}&sort=updated&direction=desc`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('listPullRequests: expected array response');
  return json.map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: !!pr.draft,
    merged_at: pr.merged_at,
    user: pr.user && pr.user.login,
    head: pr.head && pr.head.ref,
    base: pr.base && pr.base.ref,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    body: truncate(pr.body || '', 600),
    labels: (pr.labels || []).map((l) => l.name),
  }));
}

async function getPullRequest(owner, name, number) {
  const res = await ghFetch(`https://api.github.com/repos/${enc(owner)}/${enc(name)}/pulls/${number}`);
  const pr = await res.json();
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: !!pr.draft,
    merged: !!pr.merged,
    merged_at: pr.merged_at,
    closed_at: pr.closed_at,
    user: pr.user && pr.user.login,
    head: { ref: pr.head && pr.head.ref, sha: pr.head && pr.head.sha },
    base: { ref: pr.base && pr.base.ref, sha: pr.base && pr.base.sha },
    body: truncate(pr.body || '', 6000),
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    labels: (pr.labels || []).map((l) => l.name),
    created_at: pr.created_at,
    updated_at: pr.updated_at,
  };
}

async function getPullRequestFiles(owner, name, number) {
  const res = await ghFetch(`https://api.github.com/repos/${enc(owner)}/${enc(name)}/pulls/${number}/files?per_page=100`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('getPullRequestFiles: expected array response');
  return json.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: truncate(f.patch || '', 4000),
  }));
}

async function getPullRequestComments(owner, name, number) {
  const [issueRes, reviewRes] = await Promise.all([
    ghFetch(`https://api.github.com/repos/${enc(owner)}/${enc(name)}/issues/${number}/comments?per_page=100`),
    ghFetch(`https://api.github.com/repos/${enc(owner)}/${enc(name)}/pulls/${number}/comments?per_page=100`),
  ]);
  const issueComments = (await issueRes.json()).map((c) => ({
    kind: 'discussion',
    user: c.user && c.user.login,
    created_at: c.created_at,
    body: truncate(c.body || '', 1500),
  }));
  const reviewComments = (await reviewRes.json()).map((c) => ({
    kind: 'review',
    user: c.user && c.user.login,
    created_at: c.created_at,
    path: c.path,
    line: c.line == null ? c.original_line : c.line,
    body: truncate(c.body || '', 1500),
    diff_hunk: truncate(c.diff_hunk || '', 1000),
  }));
  return [...issueComments, ...reviewComments].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

async function getPullRequestCommits(owner, name, number) {
  const res = await ghFetch(`https://api.github.com/repos/${enc(owner)}/${enc(name)}/pulls/${number}/commits?per_page=100`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('getPullRequestCommits: expected array response');
  return json.map((c) => ({
    sha: c.sha,
    message: truncate((c.commit && c.commit.message) || '', 800),
    author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || null,
    date: c.commit && c.commit.author && c.commit.author.date,
  }));
}

async function listCommits(owner, name, { per_page = 20, sha } = {}) {
  const p = clampInt(per_page, 1, 30, 20);
  const params = new URLSearchParams({ per_page: String(p) });
  if (typeof sha === 'string' && sha.length > 0) params.set('sha', sha);
  const res = await ghFetch(`https://api.github.com/repos/${enc(owner)}/${enc(name)}/commits?${params.toString()}`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('listCommits: expected array response');
  return json.map((c) => ({
    sha: c.sha,
    message: truncate((c.commit && c.commit.message) || '', 600),
    author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || null,
    date: c.commit && c.commit.author && c.commit.author.date,
  }));
}

async function getCommit(owner, name, sha) {
  const res = await ghFetch(`https://api.github.com/repos/${enc(owner)}/${enc(name)}/commits/${sha}`);
  const c = await res.json();
  return {
    sha: c.sha,
    message: (c.commit && c.commit.message) || '',
    author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || null,
    date: c.commit && c.commit.author && c.commit.author.date,
    stats: c.stats,
    files: (c.files || []).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: truncate(f.patch || '', 3000),
    })),
  };
}

async function listIssues(owner, name, { state = 'all', per_page = 20 } = {}) {
  const p = clampInt(per_page, 1, 50, 20);
  const s = ['open', 'closed', 'all'].includes(state) ? state : 'all';
  const res = await ghFetch(`https://api.github.com/repos/${enc(owner)}/${enc(name)}/issues?state=${s}&per_page=${p}&sort=updated&direction=desc`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('listIssues: expected array response');
  return json
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      user: i.user && i.user.login,
      labels: (i.labels || []).map((l) => l.name),
      created_at: i.created_at,
      updated_at: i.updated_at,
      closed_at: i.closed_at,
      body: truncate(i.body || '', 600),
      comments: i.comments,
    }));
}

async function getIssue(owner, name, number) {
  const [issueRes, commentsRes] = await Promise.all([
    ghFetch(`https://api.github.com/repos/${enc(owner)}/${enc(name)}/issues/${number}`),
    ghFetch(`https://api.github.com/repos/${enc(owner)}/${enc(name)}/issues/${number}/comments?per_page=100`),
  ]);
  const issue = await issueRes.json();
  const comments = (await commentsRes.json()).map((c) => ({
    user: c.user && c.user.login,
    created_at: c.created_at,
    body: truncate(c.body || '', 1500),
  }));
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    user: issue.user && issue.user.login,
    labels: (issue.labels || []).map((l) => l.name),
    body: truncate(issue.body || '', 6000),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    comments,
  };
}
