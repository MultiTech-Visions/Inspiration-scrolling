'use strict';

const { fetchUserEvents } = require('../github');
const { getString } = require('../settings');
const { getRunLockStatus, updateLastCursor } = require('../runLock');

// Pull recent GitHub events for the configured user, compact into a small
// summary the LLM can theme. Returns { summary, events, latestCursor }.
async function gatherActivity() {
  const username = (await getString('github_username')).trim();
  if (username.length === 0) {
    return { summary: null, events: [], latestCursor: null, username: null };
  }

  const lock = await getRunLockStatus();
  const sinceCursor = lock.last_cursor || null;
  const { events, latestCursor } = await fetchUserEvents(username, sinceCursor);

  if (events.length === 0) {
    return { summary: null, events: [], latestCursor: latestCursor || sinceCursor, username };
  }

  // Compact each event to a single line. Big bodies belong in the LLM data
  // block, not in our memory.
  const lines = [];
  const repos = new Map();
  for (const ev of events) {
    const repo = ev.repo && ev.repo.name ? ev.repo.name : '(unknown)';
    repos.set(repo, (repos.get(repo) || 0) + 1);
    const line = describeEvent(ev);
    if (line) lines.push(`- ${line}`);
    if (lines.length >= 80) break; // cap to keep the prompt bounded
  }

  const repoSummary = [...repos.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([repo, n]) => `${repo} (${n})`)
    .join(', ');

  const summary = [
    `GitHub user: ${username}`,
    `Window: events since ${sinceCursor || '(no prior cursor — initial snapshot)'}`,
    `Repos touched: ${repoSummary}`,
    '',
    'Recent events:',
    ...lines,
  ].join('\n');

  return { summary, events, latestCursor, username };
}

function describeEvent(ev) {
  const repo = ev.repo && ev.repo.name ? ev.repo.name : null;
  const at = ev.created_at;
  switch (ev.type) {
    case 'PushEvent': {
      const commits = (ev.payload && ev.payload.commits) || [];
      const msgs = commits.slice(0, 3).map((c) => c.message.split('\n')[0]).join(' | ');
      return `${at} push ${repo}: ${msgs}`;
    }
    case 'PullRequestEvent': {
      const action = ev.payload && ev.payload.action;
      const pr = ev.payload && ev.payload.pull_request;
      return `${at} pr ${action} ${repo}#${pr && pr.number}: ${pr && pr.title}`;
    }
    case 'IssuesEvent': {
      const action = ev.payload && ev.payload.action;
      const issue = ev.payload && ev.payload.issue;
      return `${at} issue ${action} ${repo}#${issue && issue.number}: ${issue && issue.title}`;
    }
    case 'IssueCommentEvent': {
      const issue = ev.payload && ev.payload.issue;
      return `${at} comment ${repo}#${issue && issue.number}: ${issue && issue.title}`;
    }
    case 'WatchEvent':
      return `${at} starred ${repo}`;
    case 'ForkEvent':
      return `${at} forked ${repo}`;
    case 'CreateEvent':
      return `${at} created ${ev.payload && ev.payload.ref_type} on ${repo}`;
    case 'ReleaseEvent': {
      const rel = ev.payload && ev.payload.release;
      return `${at} release ${repo} ${rel && rel.tag_name}`;
    }
    default:
      return null;
  }
}

async function persistCursor(cursor) {
  if (!cursor) return;
  await updateLastCursor(cursor);
}

module.exports = { gatherActivity, persistCursor };
