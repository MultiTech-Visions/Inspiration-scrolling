'use strict';

const crypto = require('crypto');
const { pool, withTransaction } = require('./db');

// Single-row advisory lock backed by SELECT ... FOR UPDATE on run_lock(id=1).
// Scheduled + manual runs collide here and the loser refuses or retries.
//
// Concurrency model:
//   - Transaction A holds the row lock while it flips running=1; transaction B
//     blocks on its SELECT FOR UPDATE until A commits, then sees running=1 and
//     bails. This is the whole point of using FOR UPDATE rather than a plain
//     UPDATE ... WHERE running=0.
//   - Lock is released by clearRunning() (or releaseStale()), not by the
//     transaction; the lock row is durable, the transaction just protects the
//     read-modify-write.

async function acquireRunLock({ runIdHint } = {}) {
  const runId = runIdHint || crypto.randomBytes(8).toString('hex');
  return await withTransaction(async (conn) => {
    const [rows] = await conn.execute('SELECT running, run_id, started_at FROM run_lock WHERE id = 1 FOR UPDATE');
    if (rows.length === 0) {
      throw new Error('run_lock control row missing (id=1). Did schema.sql run?');
    }
    const row = rows[0];
    if (row.running === 1) {
      return { acquired: false, currentRunId: row.run_id, startedAt: row.started_at };
    }
    await conn.execute(
      'UPDATE run_lock SET running = 1, run_id = ?, started_at = NOW(), finished_at = NULL, last_error = NULL WHERE id = 1',
      [runId]
    );
    return { acquired: true, runId };
  });
}

async function releaseRunLock({ runId, error } = {}) {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('releaseRunLock requires a string runId');
  }
  const errorText = error ? String(error.stack || error.message || error) : null;
  const [result] = await pool().execute(
    'UPDATE run_lock SET running = 0, finished_at = NOW(), last_error = ? WHERE id = 1 AND run_id = ?',
    [errorText, runId]
  );
  if (result.affectedRows !== 1) {
    throw new Error(`releaseRunLock did not match run_id=${runId} (lock may have been forcibly cleared)`);
  }
}

async function getRunLockStatus() {
  const [rows] = await pool().execute('SELECT running, run_id, started_at, finished_at, last_error, last_cursor FROM run_lock WHERE id = 1');
  if (rows.length === 0) throw new Error('run_lock control row missing');
  return rows[0];
}

async function updateLastCursor(cursor) {
  await pool().execute('UPDATE run_lock SET last_cursor = ? WHERE id = 1', [cursor]);
}

// Escape hatch: clear a stuck lock from outside. The web UI exposes this only
// behind an explicit "force release" action — we never call it from the
// normal pipeline path.
async function forceReleaseRunLock() {
  await pool().execute('UPDATE run_lock SET running = 0, finished_at = NOW(), last_error = "force-released" WHERE id = 1');
}

module.exports = {
  acquireRunLock,
  releaseRunLock,
  getRunLockStatus,
  updateLastCursor,
  forceReleaseRunLock,
};
