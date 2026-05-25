'use strict';

const { callPipelineStep } = require('../llm');
const { query, queryOne } = require('../db');

// Lookback window for the "what is the user signaling lately" portion of the
// digest input. Hardcoded for now — the right value is "long enough to see
// momentum, short enough to feel current" and 30 days is a defensible default.
const SIGNAL_WINDOW_DAYS = 30;
const REVIEW_WINDOW_DAYS = 14;

async function gatherRawSignals() {
  // Topic preferences that have actually moved (skip the default 1.0 weight).
  const topics = await query(
    `SELECT topic, weight FROM topic_preferences
     WHERE weight <> 1.0
     ORDER BY weight DESC LIMIT 64`
  );
  const appetite = await query('SELECT type, weight FROM type_appetite');

  const recentSaved = await query(
    `SELECT id, type, payload, saved_at
       FROM cards
      WHERE status IN ('saved', 'done')
        AND COALESCE(done_at, saved_at) > NOW() - INTERVAL ${SIGNAL_WINDOW_DAYS} DAY
      ORDER BY COALESCE(done_at, saved_at) DESC
      LIMIT 40`
  );

  const recentConsumed = await query(
    `SELECT id, type, payload, consumed_at
       FROM cards
      WHERE status = 'consumed'
        AND consumed_at > NOW() - INTERVAL ${SIGNAL_WINDOW_DAYS} DAY
      ORDER BY consumed_at DESC
      LIMIT 60`
  );

  const recentExpired = await query(
    `SELECT id, type, payload, created_at
       FROM cards
      WHERE status = 'expired'
        AND created_at > NOW() - INTERVAL ${SIGNAL_WINDOW_DAYS} DAY
      ORDER BY created_at DESC
      LIMIT 40`
  );

  const followedSources = await query(
    `SELECT id, kind, external_ref, title, weight FROM sources
      WHERE followed = 1 ORDER BY weight DESC LIMIT 30`
  );

  const goals = await query(
    `SELECT id, topic, status, correct_streak, total_reviewed, total_correct, mastery_threshold, updated_at
       FROM goals ORDER BY updated_at DESC LIMIT 20`
  );

  const recentReviews = await query(
    `SELECT lr.goal_id, g.topic, lr.result, lr.reviewed_at
       FROM learning_reviews lr
       JOIN goals g ON lr.goal_id = g.id
      WHERE lr.reviewed_at > NOW() - INTERVAL ${REVIEW_WINDOW_DAYS} DAY
      ORDER BY lr.reviewed_at DESC
      LIMIT 80`
  );

  return { topics, appetite, recentSaved, recentConsumed, recentExpired, followedSources, goals, recentReviews };
}

function safeParsePayload(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function summarizeCard(row) {
  const p = safeParsePayload(row.payload) || {};
  const title = typeof p.title === 'string' ? p.title : '(untitled)';
  const topics = Array.isArray(p.topics) ? p.topics.slice(0, 5).join(', ') : '';
  return topics ? `[${row.type}] "${title}" topics=${topics}` : `[${row.type}] "${title}"`;
}

function formatSignalBlock(raw) {
  const lines = [];

  lines.push('=== Topic preferences (only topics whose weight has moved off the 1.0 default) ===');
  if (raw.topics.length === 0) {
    lines.push('(no movement yet — user has not rated topics)');
  } else {
    for (const t of raw.topics) lines.push(`- ${t.topic} (weight ${Number(t.weight).toFixed(2)})`);
  }

  lines.push('', '=== Card-type appetite ===');
  for (const a of raw.appetite) lines.push(`- ${a.type}: ${Number(a.weight).toFixed(2)}`);

  lines.push('', `=== Cards saved or marked done in last ${SIGNAL_WINDOW_DAYS} days (strong positive signal) ===`);
  if (raw.recentSaved.length === 0) lines.push('(none)');
  else for (const c of raw.recentSaved) lines.push(`- ${summarizeCard(c)}`);

  lines.push('', `=== Cards consumed (read/dismissed/thumbs-down) in last ${SIGNAL_WINDOW_DAYS} days ===`);
  if (raw.recentConsumed.length === 0) lines.push('(none)');
  else for (const c of raw.recentConsumed.slice(0, 40)) lines.push(`- ${summarizeCard(c)}`);

  lines.push('', `=== Discovery cards that aged out (expired without engagement) in last ${SIGNAL_WINDOW_DAYS} days ===`);
  if (raw.recentExpired.length === 0) lines.push('(none)');
  else for (const c of raw.recentExpired.slice(0, 20)) lines.push(`- ${summarizeCard(c)}`);

  lines.push('', '=== Followed sources ===');
  if (raw.followedSources.length === 0) lines.push('(none)');
  else for (const s of raw.followedSources) lines.push(`- ${s.kind}: ${s.title || s.external_ref} (weight ${Number(s.weight).toFixed(2)})`);

  lines.push('', '=== Learning goals ===');
  if (raw.goals.length === 0) lines.push('(none)');
  else for (const g of raw.goals) {
    const ratio = g.total_reviewed > 0 ? `${g.total_correct}/${g.total_reviewed}` : '0/0';
    lines.push(`- "${g.topic}" status=${g.status} streak=${g.correct_streak} overall=${ratio} threshold=${g.mastery_threshold}`);
  }

  lines.push('', `=== Recent learning reviews (last ${REVIEW_WINDOW_DAYS} days) ===`);
  if (raw.recentReviews.length === 0) lines.push('(none)');
  else for (const r of raw.recentReviews) lines.push(`- ${r.reviewed_at.toISOString ? r.reviewed_at.toISOString() : r.reviewed_at} "${r.topic}" → ${r.result}`);

  return lines.join('\n');
}

function validateDigest(d) {
  if (typeof d !== 'object' || d === null) throw new Error('digest must be an object');
  if (typeof d.narrative !== 'string' || d.narrative.length === 0) throw new Error('digest.narrative required');
  for (const k of ['leaning_into', 'cooling_on', 'streaks', 'gaps_to_explore']) {
    if (!Array.isArray(d[k])) throw new Error(`digest.${k} must be an array`);
    for (const item of d[k]) {
      if (typeof item !== 'string' || item.length === 0) throw new Error(`digest.${k} entries must be non-empty strings`);
    }
  }
}

// Produce the digest, persist it (history kept), return the parsed object so
// downstream steps can use it directly without re-reading.
async function generateDigest({ runId, activitySummary }) {
  const raw = await gatherRawSignals();
  const signalBlock = formatSignalBlock(raw);
  const activityPart = activitySummary
    ? `\n\n=== Recent GitHub activity ===\n${activitySummary}`
    : '\n\n=== Recent GitHub activity ===\n(none for this window)';

  const dataBlock = signalBlock + activityPart;

  const { parsed } = await callPipelineStep({
    promptKey: 'digest',
    dataBlock,
    maxTokens: 1500,
  });

  validateDigest(parsed);

  await query(
    'INSERT INTO digests (run_id, payload) VALUES (?, ?)',
    [runId || null, JSON.stringify(parsed)]
  );

  return parsed;
}

// Render the digest as a short, model-friendly block for inclusion in
// downstream prompts.
function formatDigestForDownstream(digest) {
  const lines = [];
  lines.push('=== User insights digest ===');
  lines.push(`Narrative: ${digest.narrative}`);
  if (digest.leaning_into.length > 0) lines.push(`Leaning into: ${digest.leaning_into.join(', ')}`);
  if (digest.cooling_on.length > 0) lines.push(`Cooling on: ${digest.cooling_on.join(', ')}`);
  if (digest.streaks.length > 0) lines.push(`Streaks: ${digest.streaks.join(' | ')}`);
  if (digest.gaps_to_explore.length > 0) lines.push(`Gaps worth exploring: ${digest.gaps_to_explore.join(', ')}`);
  return lines.join('\n');
}

async function getLatestDigest() {
  const row = await queryOne('SELECT id, payload, created_at FROM digests ORDER BY id DESC LIMIT 1');
  if (row === null) return null;
  try {
    return { id: row.id, created_at: row.created_at, ...JSON.parse(row.payload) };
  } catch {
    return null;
  }
}

module.exports = {
  generateDigest,
  formatDigestForDownstream,
  getLatestDigest,
};
