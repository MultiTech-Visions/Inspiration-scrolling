'use strict';

const { acquireRunLock, releaseRunLock } = require('./runLock');
const { ensureDefaultPrompts } = require('./prompts');
const { getInt } = require('./settings');
const { query, queryOne } = require('./db');
const { parseRequest } = require('./payload');
const { countQueued, expireOldDiscoveries } = require('./cards');

const { gatherActivity, persistCursor } = require('./pipeline/activity');
const { chooseThemes } = require('./pipeline/themes');
const { generateDigest } = require('./pipeline/digest');
const { synthesizeDiscoveryBatch } = require('./pipeline/discovery');
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
    digest_id: null,
  };

  try {
    // Step 1: housekeeping — expire stale discovery cards.
    await expireOldDiscoveries(stalenessDays);

    // Step 2: read raw inputs.
    const activity = await gatherActivity();
    const pendingRequests = await loadPendingRequests();

    // Step 3: distill user signals into a digest. One cheap LLM call; the
    // result feeds the more expensive downstream calls so they don't each
    // re-read the raw preference + reaction tables.
    let digest = null;
    try {
      digest = await generateDigest({ runId: lock.runId, activitySummary: activity.summary });
      const last = await queryOne('SELECT id FROM digests ORDER BY id DESC LIMIT 1');
      summary.digest_id = last ? last.id : null;
    } catch (err) {
      log.push(`digest step failed (continuing without): ${(err.message || '').split('\n')[0]}`);
    }

    // Step 4: process the deferred request queue. Non-discovery requests
    // (learning_goal, codebase_audit) run their own dedicated paths.
    // discovery_topic requests are accumulated and folded into the batched
    // discovery call below — that way they participate in the same shared
    // web_search budget as the auto-themed cards.
    const forcedDiscoveryThemes = [];
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
          await markRequestProcessed(req.id);
          summary.requests_processed++;
        } else if (req.body.intent === 'codebase_audit') {
          await synthesizeCodebaseForRequest(req);
          summary.inserted.codebase++;
          await markRequestProcessed(req.id);
          summary.requests_processed++;
        } else if (req.body.intent === 'discovery_topic') {
          forcedDiscoveryThemes.push({
            label: req.body.topic,
            weight: 1.0,
            reasoning: 'user requested',
            _requestId: req.id,
          });
          // We mark this as processed once the discovery batch completes —
          // see Step 5.
        }
      } catch (err) {
        const msg = String(err.stack || err.message || err);
        log.push(`request ${req.id} failed: ${msg.split('\n')[0]}`);
        await query("UPDATE requests SET status = 'errored', processed_at = NOW(), error = ? WHERE id = ?", [msg, req.id]);
        summary.requests_errored++;
      }
    }

    // Step 5: refill discovery queue up to target via ONE batched agentic
    // call. Auto-themes + any user-requested topics are all served in the
    // same pass so they share the web_search budget.
    let queuedNow = await countQueued();
    if (queuedNow < targetQueue || forcedDiscoveryThemes.length > 0) {
      const autoThemes = await chooseThemes({
        activitySummary: activity.summary,
        requests: pendingRequests,
        digest,
      });
      summary.themes = autoThemes.length;

      const allThemes = [...forcedDiscoveryThemes, ...autoThemes];
      const discoveryQuotaPerRun = await getInt('discovery_per_run');
      const needed = Math.max(0, targetQueue - queuedNow);
      // Honor at least one card per forced theme; the rest of the budget
      // covers auto-themed refill up to discovery_per_run.
      const target = Math.min(
        Math.max(forcedDiscoveryThemes.length, needed),
        discoveryQuotaPerRun + forcedDiscoveryThemes.length
      );

      if (target > 0 && allThemes.length > 0) {
        try {
          const { cardIds } = await synthesizeDiscoveryBatch({
            themes: allThemes,
            digest,
            targetCount: target,
          });
          summary.inserted.discovery += cardIds.length;
        } catch (err) {
          log.push(`discovery batch failed: ${(err.message || '').split('\n')[0]}`);
        }
      }

      // Mark discovery_topic requests processed regardless of whether the
      // batch produced a card for each one — failure is logged, but a single
      // failed topic shouldn't block the request from being marked drained.
      for (const t of forcedDiscoveryThemes) {
        await markRequestProcessed(t._requestId);
        summary.requests_processed++;
      }
    }

    // Step 6: refresh learning cards for active goals whose cards have all
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

    // Step 7: persist activity cursor only after a successful run.
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

async function markRequestProcessed(id) {
  await query("UPDATE requests SET status = 'processed', processed_at = NOW(), error = NULL WHERE id = ?", [id]);
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
