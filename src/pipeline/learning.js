'use strict';

const { callPipelineStep } = require('../llm');
const { query, queryOne } = require('../db');
const { insertCard } = require('../cards');

// Spaced-repetition tuning. Conservative SM-2-ish.
const INITIAL_INTERVAL_DAYS = 1;
const INITIAL_EASE = 2.5;

async function listActiveGoals() {
  return await query("SELECT id, topic, mastery_threshold, correct_streak, total_reviewed, total_correct FROM goals WHERE status = 'active' ORDER BY updated_at ASC");
}

async function createLearningGoal({ topic, mastery_threshold }) {
  if (typeof topic !== 'string' || topic.trim().length === 0) {
    throw new Error('createLearningGoal requires a topic');
  }
  const threshold = mastery_threshold || 5;
  const result = await query(
    'INSERT INTO goals (topic, mastery_threshold) VALUES (?, ?)',
    [topic.trim(), threshold]
  );
  return result.insertId;
}

// Recent review history per goal, used both for context to the LLM and for
// auto-mastery checks.
async function recentReviewSummary(goal_id, windowSize = 10) {
  const n = parseInt(windowSize, 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error('recentReviewSummary requires positive integer window');
  const rows = await query(
    `SELECT result, reviewed_at FROM learning_reviews WHERE goal_id = ? ORDER BY reviewed_at DESC LIMIT ${n}`,
    [goal_id]
  );
  return rows;
}

async function synthesizeLearningForGoal(goal) {
  const recent = await recentReviewSummary(goal.id, 10);
  const correctRate = recent.length === 0 ? 0 : recent.filter((r) => r.result === 'correct').length / recent.length;

  const dataBlock = [
    `=== Goal: ${goal.topic} ===`,
    `Reviewed so far: ${goal.total_reviewed} (${goal.total_correct} correct)`,
    `Current correct-streak: ${goal.correct_streak}`,
    `Recent window (last ${recent.length} reviews): ${(correctRate * 100).toFixed(0)}% correct`,
    '',
    'Write one learning card for this goal. Pick a subtype (tidbit/question/flashcard/quiz) that fits the material and varies from recent cards if possible.',
  ].join('\n');

  const { parsed } = await callPipelineStep({
    promptKey: 'synthesize_learning',
    dataBlock,
    maxTokens: 2000,
  });

  // Fill in spaced-repetition scheduling for a newly-minted card.
  const due_at = new Date(Date.now() + INITIAL_INTERVAL_DAYS * 86400_000).toISOString();
  parsed.spaced_repetition = {
    interval_days: INITIAL_INTERVAL_DAYS,
    ease: INITIAL_EASE,
    due_at,
    reviews: 0,
  };
  parsed.generated_at = new Date().toISOString();
  if (parsed.answer_text === undefined) parsed.answer_text = null;

  const card_id = await insertCard({
    type: 'learning',
    payload: parsed,
    score: 6.0,
    goal_id: goal.id,
  });
  return card_id;
}

// SM-2-ish update on review. We mutate the payload in place via the choke
// point: read parsed, update, re-serialize-and-validate.
const { serializeAndValidate, parsePayload } = require('../payload');

async function recordReview({ card_id, result }) {
  if (result !== 'correct' && result !== 'incorrect') {
    throw new Error(`recordReview: result must be 'correct' or 'incorrect', got ${JSON.stringify(result)}`);
  }
  const card = await queryOne('SELECT id, type, goal_id, payload FROM cards WHERE id = ?', [card_id]);
  if (card === null) throw new Error(`recordReview: card ${card_id} not found`);
  if (card.type !== 'learning') throw new Error(`recordReview: card ${card_id} is not a learning card`);
  if (card.goal_id === null) throw new Error(`recordReview: learning card ${card_id} has no goal_id`);

  const payload = parsePayload('learning', card.payload);
  const sr = payload.spaced_repetition;

  if (result === 'correct') {
    sr.interval_days = Math.max(1, sr.interval_days * sr.ease);
    sr.ease = Math.min(3.0, sr.ease + 0.1);
  } else {
    sr.interval_days = 1;
    sr.ease = Math.max(1.3, sr.ease - 0.2);
  }
  sr.reviews = sr.reviews + 1;
  sr.due_at = new Date(Date.now() + sr.interval_days * 86400_000).toISOString();

  const newPayload = serializeAndValidate('learning', payload);
  await query('UPDATE cards SET payload = ?, status = ? WHERE id = ?', [newPayload, result === 'correct' ? 'consumed' : 'queued', card_id]);

  await query(
    'INSERT INTO learning_reviews (card_id, goal_id, result) VALUES (?, ?, ?)',
    [card_id, card.goal_id, result]
  );

  if (result === 'correct') {
    await query(
      'UPDATE goals SET correct_streak = correct_streak + 1, total_reviewed = total_reviewed + 1, total_correct = total_correct + 1 WHERE id = ?',
      [card.goal_id]
    );
  } else {
    await query(
      'UPDATE goals SET correct_streak = 0, total_reviewed = total_reviewed + 1 WHERE id = ?',
      [card.goal_id]
    );
  }

  await maybeAutoMaster(card.goal_id);
}

async function maybeAutoMaster(goal_id) {
  const { getInt, getNumber } = require('../settings');
  const requiredStreak = await getInt('mastery_streak_required');
  const recentWindow = await getInt('mastery_recent_window');
  const recentPct = await getNumber('mastery_recent_pct');

  const goal = await queryOne('SELECT id, status, correct_streak FROM goals WHERE id = ?', [goal_id]);
  if (goal === null || goal.status !== 'active') return;

  if (goal.correct_streak >= requiredStreak) {
    await query("UPDATE goals SET status = 'mastered' WHERE id = ?", [goal_id]);
    return;
  }

  const win = parseInt(recentWindow, 10);
  if (!Number.isInteger(win) || win <= 0) throw new Error('mastery_recent_window must be a positive integer');
  const recent = await query(
    `SELECT result FROM learning_reviews WHERE goal_id = ? ORDER BY reviewed_at DESC LIMIT ${win}`,
    [goal_id]
  );
  if (recent.length >= recentWindow) {
    const ratio = recent.filter((r) => r.result === 'correct').length / recent.length;
    if (ratio >= recentPct) {
      await query("UPDATE goals SET status = 'mastered' WHERE id = ?", [goal_id]);
    }
  }
}

async function setGoalStatus(goal_id, status) {
  if (!['active', 'paused', 'mastered', 'cancelled'].includes(status)) {
    throw new Error(`setGoalStatus: invalid status ${JSON.stringify(status)}`);
  }
  const result = await query('UPDATE goals SET status = ? WHERE id = ?', [status, goal_id]);
  if (result.affectedRows === 0) {
    throw new Error(`setGoalStatus: goal ${goal_id} not found`);
  }
}

module.exports = {
  listActiveGoals,
  createLearningGoal,
  synthesizeLearningForGoal,
  recordReview,
  setGoalStatus,
};
