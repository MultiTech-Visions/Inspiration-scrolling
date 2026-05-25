'use strict';

const { runAgenticStep } = require('../llm');
const { getString, getInt } = require('../settings');
const { upsertSource } = require('../sources');
const { insertCard } = require('../cards');
const { formatDigestForDownstream } = require('./digest');

// Discovery is one batched agentic call per run. The model gets:
//   - the themes for tonight,
//   - the precomputed insights digest,
//   - web_search (server tool, large budget) to browse the open web,
//   - bookmark_idea(url, title, hook) (client tool) as a working-memory
//     scratchpad to collect promising URLs while it searches.
// Then it emits {cards:[...]} — multiple cards in one response. Each card's
// source_urls are filtered against the URLs web_search actually returned
// across the whole loop so we never publish a hallucinated link.

const BOOKMARK_TOOL_DEF = {
  name: 'bookmark_idea',
  description: 'Record a promising URL found via web_search so you can come back to it when writing cards. Use this aggressively while you browse — bookmarks are your working memory across searches. You can bookmark more than you ultimately write about; pick the best ones at the end.',
  input_schema: {
    type: 'object',
    required: ['url', 'title', 'hook'],
    properties: {
      url: { type: 'string', description: 'The URL of the page (must come from a web_search result).' },
      title: { type: 'string', description: 'Page title, or your concise label for it (<=120 chars).' },
      hook: { type: 'string', description: '1-2 sentences on why this is worth turning into a card. What is the IDEA?' },
    },
  },
};

function makeDiscoveryDispatch() {
  const bookmarks = [];
  const dispatch = async (toolName, input) => {
    if (toolName !== 'bookmark_idea') {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const hook = typeof input.hook === 'string' ? input.hook.trim() : '';
    if (url.length === 0) throw new Error('bookmark_idea: url is required');
    if (title.length === 0) throw new Error('bookmark_idea: title is required');
    if (hook.length === 0) throw new Error('bookmark_idea: hook is required');
    bookmarks.push({ url, title, hook, at: new Date().toISOString() });
    return { ok: true, bookmarks_so_far: bookmarks.length };
  };
  return { dispatch, bookmarks };
}

function validateCard(card, idx) {
  if (typeof card !== 'object' || card === null) {
    throw new Error(`discovery card[${idx}] is not an object`);
  }
  for (const k of ['title', 'summary', 'body', 'discussion_context']) {
    if (typeof card[k] !== 'string' || card[k].length === 0) {
      throw new Error(`discovery card[${idx}] missing or empty "${k}"`);
    }
  }
  if (!Array.isArray(card.topics) || card.topics.length === 0) {
    throw new Error(`discovery card[${idx}] missing topics[]`);
  }
  if (!Array.isArray(card.source_urls)) {
    throw new Error(`discovery card[${idx}] missing source_urls[]`);
  }
}

// `themes` may be empty or short — the user-requests path can call this with
// just one or two forced themes. `digest` is the parsed digest object from
// pipeline/digest.js (or null on the very first run before any signals).
async function synthesizeDiscoveryBatch({ themes, digest, targetCount }) {
  if (!Array.isArray(themes) || themes.length === 0) {
    throw new Error('synthesizeDiscoveryBatch requires at least one theme');
  }
  if (!Number.isInteger(targetCount) || targetCount <= 0) {
    throw new Error('synthesizeDiscoveryBatch requires positive integer targetCount');
  }

  const blockedDomainsRaw = await getString('blocked_domains');
  const blockedDomains = blockedDomainsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const searchMaxUses = await getInt('discovery_search_max_uses');
  const maxSteps = await getInt('discovery_agent_max_steps');

  const themesBlock = themes
    .map((t, i) => `${i + 1}. "${t.label}" (weight ${Number(t.weight).toFixed(2)}) — ${t.reasoning || '(no reasoning provided)'}`)
    .join('\n');

  const digestBlock = digest
    ? formatDigestForDownstream(digest)
    : '=== User insights digest ===\n(no digest yet — this is an early run; lean on the themes and prefer concrete primary sources)';

  const initialMessage = [
    '=== Tonight\'s themes ===',
    themesBlock,
    '',
    digestBlock,
    '',
    `Target card count: ${targetCount}. Fewer strong cards beats padding. Make sure cards are distinct (different sources, different angles).`,
    `Your web_search budget is ${searchMaxUses} searches. Spend them across themes, not all on one. Bookmark generously, write selectively.`,
  ].join('\n');

  const { dispatch, bookmarks } = makeDiscoveryDispatch();

  const { parsed, toolTrace, searchResults } = await runAgenticStep({
    promptKey: 'synthesize_discovery',
    initialMessage,
    tools: [BOOKMARK_TOOL_DEF],
    dispatch,
    webSearch: { maxUses: searchMaxUses, blockedDomains },
    maxTokens: 8000,
    maxSteps,
  });

  if (!parsed || !Array.isArray(parsed.cards)) {
    throw new Error('discovery batch: model output missing cards[] array');
  }
  if (parsed.cards.length === 0) {
    console.warn(`discovery batch returned 0 cards (searches=${searchResults.length}, bookmarks=${bookmarks.length})`);
    return { cardIds: [], bookmarks, searchResults, toolTrace };
  }

  const searchUrls = new Set(searchResults.map((r) => r.url));
  const titleByUrl = new Map(searchResults.filter((r) => r.title).map((r) => [r.url, r.title]));

  const cardIds = [];
  for (let i = 0; i < parsed.cards.length; i++) {
    const card = parsed.cards[i];
    validateCard(card, i);

    const cleanSourceUrls = card.source_urls.filter((u) => typeof u === 'string' && searchUrls.has(u));
    if (cleanSourceUrls.length === 0) {
      console.warn(`discovery card[${i}] "${card.title}" had no valid source_urls after filtering — skipping.`);
      continue;
    }
    card.source_urls = cleanSourceUrls;
    card.generated_at = new Date().toISOString();
    if (card.video === undefined) card.video = null;

    const score = 8.0;
    const sourceIds = [];
    for (const url of cleanSourceUrls) {
      const sid = await upsertSource({
        kind: 'web',
        external_ref: url,
        title: titleByUrl.get(url) || null,
      });
      sourceIds.push(sid);
    }

    const cardId = await insertCard({
      type: 'discovery',
      payload: card,
      score,
      seed_recency_at: null,
      source_ids: sourceIds,
    });
    cardIds.push(cardId);
  }

  console.log(`discovery batch: ${cardIds.length} cards / ${parsed.cards.length} drafted, ${searchResults.length} search results, ${bookmarks.length} bookmarks, ${toolTrace.length} bookmark calls`);
  return { cardIds, bookmarks, searchResults, toolTrace };
}

module.exports = { synthesizeDiscoveryBatch };
