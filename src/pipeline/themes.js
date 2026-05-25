'use strict';

const { callPipelineStep } = require('../llm');
const { formatDigestForDownstream } = require('./digest');

// activitySummary may be null (no GitHub activity / no username configured).
// digest may be null on the very first run before any signals have accrued.
async function chooseThemes({ activitySummary, requests, digest }) {
  const parts = [];

  parts.push(digest ? formatDigestForDownstream(digest) : '=== User insights digest ===\n(no digest yet — first run with this user)');

  parts.push('');
  if (activitySummary) {
    parts.push('=== Recent GitHub activity (raw, freshest signal) ===');
    parts.push(activitySummary);
  } else {
    parts.push('=== Recent GitHub activity (raw) ===');
    parts.push('(none — fall back to the digest)');
  }

  if (requests && requests.length > 0) {
    parts.push('');
    parts.push('=== Pending user requests this run ===');
    for (const r of requests) {
      parts.push(`- intent=${r.body.intent}: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
  }

  const { parsed } = await callPipelineStep({
    promptKey: 'themes',
    dataBlock: parts.join('\n'),
    maxTokens: 2048,
  });

  if (!parsed || !Array.isArray(parsed.themes) || parsed.themes.length === 0) {
    throw new Error(`themes step returned no themes: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  for (const t of parsed.themes) {
    if (typeof t.label !== 'string' || t.label.length === 0) {
      throw new Error(`themes step returned theme without label: ${JSON.stringify(t)}`);
    }
    if (typeof t.weight !== 'number' || !Number.isFinite(t.weight)) {
      throw new Error(`themes step returned theme without numeric weight: ${JSON.stringify(t)}`);
    }
  }
  return parsed.themes;
}

module.exports = { chooseThemes };
