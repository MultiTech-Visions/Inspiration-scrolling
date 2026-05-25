'use strict';

const { query, queryOne, withTransaction } = require('./db');
const { serializeAndValidate, parsePayload } = require('./payload');
const { attachSourcesToCard } = require('./sources');

// Single insert path for all card types. Payload goes through the choke
// point; sources are attached atomically with the card row.
async function insertCard({ type, payload, score, seed_recency_at, expires_at, goal_id, source_ids }) {
  const serialized = serializeAndValidate(type, payload);
  return await withTransaction(async (conn) => {
    const [result] = await conn.execute(
      `INSERT INTO cards (type, status, goal_id, payload, score, seed_recency_at, expires_at)
       VALUES (?, 'queued', ?, ?, ?, ?, ?)`,
      [type, goal_id || null, serialized, score ?? 0, seed_recency_at || null, expires_at || null]
    );
    const card_id = result.insertId;
    if (Array.isArray(source_ids) && source_ids.length > 0) {
      const values = source_ids.map(() => '(?, ?)').join(', ');
      const params = source_ids.flatMap((sid) => [card_id, sid]);
      await conn.execute(`INSERT IGNORE INTO card_sources (card_id, source_id) VALUES ${values}`, params);
    }
    return card_id;
  });
}

// The feed read. One indexed query — joined to goals so a learning card only
// appears when its parent goal is active. No per-card writes for pause: the
// gate is the JOIN.
async function readFeed({ limit }) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('readFeed requires a positive integer limit');
  }
  // limit is validated as a positive integer above; inline it so we don't
  // depend on the MySQL-version-specific behaviour of `LIMIT ?` in prepared
  // statements.
  const rows = await query(
    `SELECT c.id, c.type, c.goal_id, c.payload, c.score, c.created_at, c.seed_recency_at, c.expires_at,
            g.topic AS goal_topic, g.status AS goal_status
     FROM cards c
     LEFT JOIN goals g ON c.goal_id = g.id
     WHERE c.status = 'queued'
       AND (c.expires_at IS NULL OR c.expires_at > NOW())
       AND (c.goal_id IS NULL OR g.status = 'active')
     ORDER BY c.score DESC, c.created_at DESC
     LIMIT ${limit}`
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    goal_id: r.goal_id,
    goal_topic: r.goal_topic,
    score: r.score,
    created_at: r.created_at,
    seed_recency_at: r.seed_recency_at,
    expires_at: r.expires_at,
    payload: parsePayload(r.type, r.payload),
  }));
}

async function countQueued() {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM cards c
     LEFT JOIN goals g ON c.goal_id = g.id
     WHERE c.status = 'queued'
       AND (c.expires_at IS NULL OR c.expires_at > NOW())
       AND (c.goal_id IS NULL OR g.status = 'active')`
  );
  return row.n;
}

async function getCard(card_id) {
  const row = await queryOne(
    `SELECT id, type, status, goal_id, payload, score, created_at FROM cards WHERE id = ?`,
    [card_id]
  );
  if (row === null) return null;
  row.payload = parsePayload(row.type, row.payload);
  return row;
}

async function getCardSources(card_id) {
  return await query(
    `SELECT s.id, s.kind, s.external_ref, s.title, s.weight, s.followed
       FROM card_sources cs
       JOIN sources s ON cs.source_id = s.id
      WHERE cs.card_id = ?
      ORDER BY s.weight DESC`,
    [card_id]
  );
}

async function markConsumed(card_id) {
  await query(
    "UPDATE cards SET status = 'consumed', consumed_at = NOW() WHERE id = ? AND status = 'queued'",
    [card_id]
  );
}

async function expireOldDiscoveries(staleness_days) {
  if (!Number.isFinite(staleness_days) || staleness_days <= 0) {
    throw new Error('expireOldDiscoveries requires positive staleness_days');
  }
  await query(
    `UPDATE cards
       SET status = 'expired'
     WHERE status = 'queued'
       AND type = 'discovery'
       AND created_at < NOW() - INTERVAL ? DAY`,
    [staleness_days]
  );
}

module.exports = {
  insertCard,
  readFeed,
  countQueued,
  getCard,
  getCardSources,
  markConsumed,
  expireOldDiscoveries,
};
