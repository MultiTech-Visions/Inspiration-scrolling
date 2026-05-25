'use strict';

const { query, queryOne } = require('./db');

// Upsert a source by (kind, external_ref). Returns the source row id.
async function upsertSource({ kind, external_ref, title }) {
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new Error('upsertSource requires kind');
  }
  if (typeof external_ref !== 'string' || external_ref.length === 0) {
    throw new Error('upsertSource requires external_ref');
  }
  const existing = await queryOne(
    'SELECT id FROM sources WHERE kind = ? AND external_ref = ?',
    [kind, external_ref]
  );
  if (existing) {
    if (title) {
      await query('UPDATE sources SET title = COALESCE(title, ?) WHERE id = ?', [title, existing.id]);
    }
    return existing.id;
  }
  const result = await query(
    'INSERT INTO sources (kind, external_ref, title, weight, followed) VALUES (?, ?, ?, 1.0, 0)',
    [kind, external_ref, title || null]
  );
  return result.insertId;
}

async function attachSourcesToCard(card_id, source_ids) {
  if (!Array.isArray(source_ids) || source_ids.length === 0) return;
  const values = source_ids.map(() => '(?, ?)').join(', ');
  const params = source_ids.flatMap((sid) => [card_id, sid]);
  await query(`INSERT IGNORE INTO card_sources (card_id, source_id) VALUES ${values}`, params);
}

async function followSource(source_id, followed) {
  if (typeof followed !== 'boolean') {
    throw new Error('followSource requires boolean');
  }
  const bump = followed ? 'weight + 1.0' : 'GREATEST(weight - 1.0, 0.1)';
  await query(
    `UPDATE sources SET followed = ?, weight = ${bump} WHERE id = ?`,
    [followed ? 1 : 0, source_id]
  );
}

async function listFollowedSources() {
  return await query('SELECT id, kind, external_ref, title, weight FROM sources WHERE followed = 1 ORDER BY weight DESC');
}

module.exports = {
  upsertSource,
  attachSourcesToCard,
  followSource,
  listFollowedSources,
};
