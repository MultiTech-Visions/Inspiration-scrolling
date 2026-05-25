'use strict';

const { acquireRunLock, releaseRunLock } = require('./runLock');
const { ensureDefaultPrompts } = require('./prompts');
const { getInt } = require('./settings');
const { query, queryOne } = require('./db');
const { parseRequest } = require('./payload');
const { countQueued, expireOldDiscoveries } = require('./cards');

const { gatherActivity, persistCursor } = require('./pipeline/activity');
const { gatherPreferences, chooseThemes } = require('./pipeline/themes');
const { synthesizeDiscoveryFromTheme } = require('./pipeline/discovery');
const { synthesizeCodebaseForRequest } = require('./pipeline/codebase');
const { listActiveGoals, synthesizeLearningForGoal, createLearningGoal } = require('./pipeline/learning');

// The whole run. One entry point, used by:
//   - scheduled cloud-scheduler trigger
//   - manual "Run now" button
//   - low-queue refill from the live feed path
//   - immediate request submission
//
// The run-lock guarantees no two of these execute concurrently.
async function runOnce({ trigger }) {
  await ensureDefaultPrompts();
  const targetQueue = await getInt('queue_target_size');
  const stalenessDays = await getInt('staleness_days');

  const lock = await acquireRunLock();
  if (!lock.acquired) {
    return {
      ok: false,
      reason: 'run-already-in-progress',
      currentRunId: lock.currentRunId,
      startedAt: lock.startedAt,
    };
  }

  const log = [`[run ${lock.runId}] trigger=${trigger}`];
  const summary = {
    runId: lock.runId,
    trigger,
    inserted: { discovery: 0, codebase: 0, learning: 0 },
    requests_processed: 0,
    requests_errored: 0,
    themes: 0,
  };

  try {
    // Step 1: housekeeping — expire stale discovery cards.
    await expireOldDiscoveries(stalenessDays);

    // Step 2: read inputs.
    const activity = await gatherActivity();
    const preferences = await gatherPreferences();
    const pendingRequests = await loadPendingRequests();

    // Step 3: process the deferred request queue. Each request opens its own
    // sub-path; we do not let one bad request break the whole run.
    for (const req of pendingRequests) {
      try {
        if (req.body.intent === 'learning_goal') {
          const goalId = await createLearningGoal({
            topic: req.body.topic,
            mastery_threshold: req.body.mastery_threshold,
          });
          const goal = await queryOne('SELECT id, topic, mastery_threshold, correct_streak, total_reviewed, total_correct FROM goals WHERE id = ?', [goalId]);
          await synthesizeLearningForGoal(goal);
          summary.inserted.learning++;
        } else if (req.body.intent === 'codebase_audit') {
          await synthesizeCodebaseForRequest(req);
          summary.inserted.codebase++;
        } else if (req.body.intent === 'discovery_topic') {
          // Treated as a topic the user explicitly wants seen tonight; push
          // through the discovery pipeline with weight=1.
          await synthesizeDiscoveryFromTheme({ label: req.body.topic, weight: 1.0, reasoning: 'user requested' });
          summary.inserted.discovery++;
        }
        await query("UPDATE requests SET status = 'processed', processed_at = NOW(), error = NULL WHERE id = ?", [req.id]);
        summary.requests_processed++;
      } catch (err) {
        const msg = String(err.stack || err.message || err);
        log.push(`request ${req.id} failed: ${msg.split('\n')[0]}`);
        await query("UPDATE requests SET status = 'errored', processed_at = NOW(), error = ? WHERE id = ?", [msg, req.id]);
        summary.requests_errored++;
      }
    }

    // Step 4: refill discovery queue up to target.
    let queuedNow = await countQueued();
    if (queuedNow < targetQueue) {
      const themes = await chooseThemes({
        activitySummary: activity.summary,
        requests: pendingRequests,
        preferences,
      });
      summary.themes = themes.length;

      const discoveryQuotaPerRun = await getInt('discovery_per_run');
      const sortedThemes = [...themes].sort((a, b) => b.weight - a.weight);
      let made = 0;
      for (const theme of sortedThemes) {
        if (made >= discoveryQuotaPerRun) break;
        if (queuedNow >= targetQueue) break;
        try {
          const cardId = await synthesizeDiscoveryFromTheme(theme);
          if (cardId) {
            made++;
            queuedNow++;
            summary.inserted.discovery++;
          }
        } catch (err) {
          log.push(`discovery theme "${theme.label}" failed: ${(err.message || '').split('\n')[0]}`);
        }
      }
    }

    // Step 5: refresh learning cards for active goals whose cards have all
    // consumed or expired. The queue-gate JOIN handles the pause/unpause
    // story; we just top up so active goals never stall the queue.
    const learningQuotaPerRun = await getInt('learning_per_run');
    const activeGoals = await listActiveGoals();
    let learningMade = 0;
    for (const goal of activeGoals) {
      if (learningMade >= learningQuotaPerRun) break;
      const existing = await queryOne("SELECT COUNT(*) AS n FROM cards WHERE goal_id = ? AND status = 'queued'", [goal.id]);
      if (existing.n >= 2) continue; // already has fresh cards waiting
      try {
        await synthesizeLearningForGoal(goal);
        learningMade++;
        summary.inserted.learning++;
      } catch (err) {
        log.push(`learning goal ${goal.id} (${goal.topic}) failed: ${(err.message || '').split('\n')[0]}`);
      }
    }

    // Step 6: persist activity cursor only after a successful run.
    if (activity.latestCursor) {
      await persistCursor(activity.latestCursor);
    }

    log.push(`done: ${JSON.stringify(summary)}`);
    await releaseRunLock({ runId: lock.runId });
    return { ok: true, summary, log };
  } catch (err) {
    log.push(`fatal: ${String(err.stack || err.message || err)}`);
    await releaseRunLock({ runId: lock.runId, error: err });
    throw err;
  }
}

const MAX_REQUESTS_PER_RUN = 16;
async function loadPendingRequests() {
  const rows = await query(`SELECT id, body, immediate, created_at FROM requests WHERE status = 'pending' ORDER BY immediate DESC, created_at ASC LIMIT ${MAX_REQUESTS_PER_RUN}`);
  return rows.map((r) => {
    let body;
    try {
      body = parseRequest(r.body);
    } catch (err) {
      throw new Error(`request ${r.id} body invalid: ${err.message}`);
    }
    return { id: r.id, body, immediate: r.immediate === 1, created_at: r.created_at };
  });
}

module.exports = { runOnce };
