'use strict';

const { callPipelineStep } = require('../llm');
const { searchStories } = require('../hackernews');
const { upsertSource } = require('../sources');
const { insertCard } = require('../cards');

// For one theme: retrieve real seed sources from Hacker News, synthesize a
// discovery card carrying those sources as provenance. Returns null if no
// usable seeds were found (we never fabricate URLs).
async function synthesizeDiscoveryFromTheme(theme) {
  const hits = await searchStories(theme.label, { maxResults: 6, minPoints: 10 }).catch((err) => {
    console.warn(`HN search failed for theme ${JSON.stringify(theme.label)}: ${err.message}`);
    return [];
  });
  if (hits.length === 0) return null;

  const dataBlock = [
    `=== Theme ===\n${theme.label}`,
    `Why this theme: ${theme.reasoning || '(no reasoning provided)'}`,
    '',
    '=== Seed sources (real, fetched from Hacker News) ===',
    ...hits.map((h, i) => `[${i}] ${h.title} — ${h.url} (${h.points} points, ${h.comments} comments)`),
    '',
    'Write one discovery card. Cite at least one of these URLs verbatim in source_urls. If the card references a video on YouTube/Twitter/Instagram/Reddit, fill in the "video" object.',
  ].join('\n');

  const { parsed } = await callPipelineStep({
    promptKey: 'synthesize_discovery',
    dataBlock,
    maxTokens: 3000,
  });

  // Filter out any URLs the model invented that weren't in the seed list.
  const seedUrls = new Set(hits.map((h) => h.url));
  if (!Array.isArray(parsed.source_urls)) {
    throw new Error('discovery synthesis missing source_urls array');
  }
  const cleanSourceUrls = parsed.source_urls.filter((u) => seedUrls.has(u));
  if (cleanSourceUrls.length === 0) {
    // Model didn't cite anything real — force at least one seed in.
    cleanSourceUrls.push(hits[0].url);
  }
  parsed.source_urls = cleanSourceUrls;
  parsed.generated_at = new Date().toISOString();
  if (parsed.video === undefined) parsed.video = null;

  // Score by theme weight + best HN points (logarithmic). Newer seeds rank higher.
  const bestPoints = Math.max(...hits.map((h) => h.points || 0));
  const recencyMs = Math.max(...hits.map((h) => h.created_at ? Date.parse(h.created_at) : 0));
  const score = (theme.weight || 0.5) * 10 + Math.log10(bestPoints + 1) * 3;

  const sourceIds = [];
  for (const h of hits) {
    if (!cleanSourceUrls.includes(h.url)) continue;
    const sid = await upsertSource({ kind: 'hackernews', external_ref: h.url, title: h.title });
    sourceIds.push(sid);
  }

  const card_id = await insertCard({
    type: 'discovery',
    payload: parsed,
    score,
    seed_recency_at: recencyMs > 0 ? new Date(recencyMs) : null,
    source_ids: sourceIds,
  });

  return card_id;
}

module.exports = { synthesizeDiscoveryFromTheme };
