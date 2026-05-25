'use strict';

const { callPipelineStep } = require('../llm');
const { getString, getInt } = require('../settings');
const { upsertSource } = require('../sources');
const { insertCard } = require('../cards');

// For one theme: let the LLM search the open web (excluding the user's
// blocklist) for real sources, then synthesize a discovery card whose
// source_urls are constrained to URLs the search actually returned. We never
// fabricate URLs — if the search came back empty, we drop the card.
async function synthesizeDiscoveryFromTheme(theme) {
  const blockedDomainsRaw = await getString('blocked_domains');
  const blockedDomains = blockedDomainsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const maxUses = await getInt('discovery_search_max_uses');

  const dataBlock = [
    `=== Theme ===\n${theme.label}`,
    `Why this theme: ${theme.reasoning || '(no reasoning provided)'}`,
    '',
    'Use the web_search tool to find 3-6 recent, high-quality real sources about this theme. Then write one discovery card. Every URL in source_urls must be a URL you actually retrieved via web_search — do not invent or guess URLs. If the card references a video on YouTube/Twitter/Instagram/Reddit, fill in the "video" object.',
  ].join('\n');

  const { parsed, searchResults } = await callPipelineStep({
    promptKey: 'synthesize_discovery',
    dataBlock,
    maxTokens: 4000,
    webSearch: { blockedDomains, maxUses },
  });

  if (searchResults.length === 0) {
    console.warn(`No web_search results for theme ${JSON.stringify(theme.label)} — skipping card.`);
    return null;
  }

  if (!Array.isArray(parsed.source_urls)) {
    throw new Error('discovery synthesis missing source_urls array');
  }
  const searchUrls = new Set(searchResults.map((r) => r.url));
  const cleanSourceUrls = parsed.source_urls.filter((u) => searchUrls.has(u));
  if (cleanSourceUrls.length === 0) {
    cleanSourceUrls.push(searchResults[0].url);
  }
  parsed.source_urls = cleanSourceUrls;
  parsed.generated_at = new Date().toISOString();
  if (parsed.video === undefined) parsed.video = null;

  const score = (theme.weight || 0.5) * 10;

  const sourceIds = [];
  for (const r of searchResults) {
    if (!cleanSourceUrls.includes(r.url)) continue;
    const sid = await upsertSource({ kind: 'web', external_ref: r.url, title: r.title });
    sourceIds.push(sid);
  }

  const card_id = await insertCard({
    type: 'discovery',
    payload: parsed,
    score,
    seed_recency_at: null,
    source_ids: sourceIds,
  });

  return card_id;
}

module.exports = { synthesizeDiscoveryFromTheme };
