'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const { getInstruction } = require('./prompts');
const { getString, getInt, getNumber } = require('./settings');
const { query, queryOne } = require('./db');
const { getCard } = require('./cards');

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Missing ANTHROPIC_API_KEY — refusing to make LLM calls without an API key');
  }
  _client = new Anthropic();
  return _client;
}

// Build the (static-per-card) context string that follows the editable
// instruction in the system slot. This is data appended after the instruction
// in code — not interpolated into it.
function buildCardContext(card) {
  const p = card.payload;
  const lines = [
    '=== CARD CONTEXT (static; do not repeat verbatim) ===',
    `Type: ${card.type}`,
    `Title: ${p.title}`,
    `Summary: ${p.summary}`,
    '',
    'Body (what the user already saw):',
    p.body,
    '',
    'Prepared discussion context (HIDDEN from the user unless they ask to see it):',
    p.discussion_context,
  ];
  if (card.type === 'discovery') {
    if (Array.isArray(p.topics) && p.topics.length > 0) {
      lines.push('', 'Topics: ' + p.topics.join(', '));
    }
    if (Array.isArray(p.source_urls) && p.source_urls.length > 0) {
      lines.push('', 'Sources cited in the card:');
      p.source_urls.forEach((u) => lines.push(`- ${u}`));
    }
    if (p.video) {
      lines.push('', `Video reference: ${p.video.provider} ${p.video.embeddable ? '(embeddable)' : '(link-out)'} ${p.video.source_url}`);
    }
  } else if (card.type === 'codebase') {
    if (p.repo) lines.push('', `Repository: ${p.repo.owner}/${p.repo.name} (ref: ${p.repo.ref})`, `Finding kind: ${p.finding_kind}`);
    if (Array.isArray(p.references) && p.references.length > 0) {
      lines.push('References:');
      p.references.forEach((r) => lines.push(`- ${r.path}${r.line ? ':' + r.line : ''}`));
    }
  } else if (card.type === 'learning') {
    lines.push('', `Subtype: ${p.subtype}`);
    if (card.goal_topic) lines.push(`Parent learning goal: ${card.goal_topic}`);
    if (p.answer_text) lines.push(`Answer (for reference): ${p.answer_text}`);
  }
  return lines.join('\n');
}

async function listMessages(card_id, { limit } = {}) {
  const n = limit && Number.isInteger(limit) && limit > 0 ? limit : 0;
  if (n > 0) {
    // Most recent N, then re-sort ascending so the LLM sees chronological order.
    const rows = await query(
      `SELECT id, role, content, created_at FROM card_messages WHERE card_id = ? ORDER BY id DESC LIMIT ${n}`,
      [card_id]
    );
    return rows.reverse();
  }
  return await query(
    'SELECT id, role, content, created_at FROM card_messages WHERE card_id = ? ORDER BY id ASC',
    [card_id]
  );
}

async function postMessage({ card_id, role, content }) {
  if (role !== 'user' && role !== 'assistant') {
    throw new Error(`postMessage: role must be 'user' or 'assistant', got ${JSON.stringify(role)}`);
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('postMessage: content must be a non-empty string');
  }
  const result = await query(
    'INSERT INTO card_messages (card_id, role, content) VALUES (?, ?, ?)',
    [card_id, role, content]
  );
  return result.insertId;
}

// Apply the engagement boost exactly once per card, when the user's message
// count crosses the configured threshold. Boosts the card's topics (for
// discovery) and type_appetite for the card's type.
async function maybeApplyEngagementBoost(card) {
  if (card.engagement_boosted === 1) return { applied: false, reason: 'already_boosted' };
  const threshold = await getInt('engagement_boost_threshold');
  const amount = await getNumber('engagement_boost_amount');

  const count = await queryOne(
    "SELECT COUNT(*) AS n FROM card_messages WHERE card_id = ? AND role = 'user'",
    [card.id]
  );
  if (count.n < threshold) return { applied: false, reason: 'below_threshold', user_messages: count.n };

  // Atomically claim the boost — if another concurrent request beat us to it,
  // the UPDATE affects 0 rows and we bail.
  const claim = await query(
    'UPDATE cards SET engagement_boosted = 1 WHERE id = ? AND engagement_boosted = 0',
    [card.id]
  );
  if (claim.affectedRows !== 1) return { applied: false, reason: 'already_boosted_concurrently' };

  if (card.type === 'discovery' && Array.isArray(card.payload.topics)) {
    for (const t of card.payload.topics.slice(0, 8)) {
      await query(
        'INSERT INTO topic_preferences (topic, weight) VALUES (?, GREATEST(0.1, 1.0 + ?)) ON DUPLICATE KEY UPDATE weight = GREATEST(0.1, weight + ?)',
        [t, amount, amount]
      );
    }
  }
  await query(
    'UPDATE type_appetite SET weight = GREATEST(0.1, weight + ?) WHERE type = ?',
    [amount * 0.5, card.type]
  );

  return { applied: true, user_messages: count.n, topic_delta: amount, type_delta: amount * 0.5 };
}

// One round-trip: append user message, call the LLM with the card context as
// cached system prompt + alternating thread history, append assistant reply.
// Returns { reply, message_id, engagement }.
async function discuss({ card_id, user_text }) {
  if (!Number.isInteger(card_id) || card_id <= 0) {
    throw new Error('discuss requires a positive integer card_id');
  }
  if (typeof user_text !== 'string' || user_text.trim().length === 0) {
    throw new Error('discuss requires non-empty user_text');
  }

  const card = await getCard(card_id);
  if (card === null) throw new Error(`discuss: card ${card_id} not found`);

  // Append the user message first so it shows up if anything below throws.
  const userMessageId = await postMessage({ card_id, role: 'user', content: user_text });

  const instruction = await getInstruction('discuss_card');
  const model = await getString('llm_model');
  const effort = await getString('llm_effort');
  const maxHistory = await getInt('discussion_max_history');

  const history = await listMessages(card_id, { limit: maxHistory });
  // Strip the just-inserted user message from history — we send it as the
  // final messages[] entry, not duplicated.
  const beforeNew = history.filter((m) => m.id !== userMessageId);

  const cardContext = buildCardContext(card);
  const response = await client().messages.create({
    model,
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    system: [
      {
        type: 'text',
        text: instruction + '\n\n' + cardContext,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      ...beforeNew.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: user_text },
    ],
  });

  let reply = null;
  for (const block of response.content) {
    if (block.type === 'text') { reply = block.text; break; }
  }
  if (reply === null || reply.trim().length === 0) {
    throw new Error(`discuss: LLM returned no text content (stop_reason=${response.stop_reason})`);
  }

  const replyId = await postMessage({ card_id, role: 'assistant', content: reply });
  const engagement = await maybeApplyEngagementBoost(card);

  return { reply, user_message_id: userMessageId, reply_id: replyId, engagement };
}

module.exports = { discuss, listMessages, buildCardContext };
