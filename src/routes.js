'use strict';

const fs = require('fs');
const path = require('path');

const { query, queryOne } = require('./db');
const { readFeed, getCard, getCardSources, markConsumed, countQueued } = require('./cards');
const { followSource } = require('./sources');
const { serializeAndValidateRequest } = require('./payload');
const { recordReview, setGoalStatus } = require('./pipeline/learning');
const { getAllSettings, setSetting, getInt } = require('./settings');
const { getAllPrompts, setInstruction, resetInstruction } = require('./prompts');
const { runOnce } = require('./run');
const { getRunLockStatus, forceReleaseRunLock } = require('./runLock');
const { parsePayload } = require('./payload');

const { discuss, listMessages } = require('./conversation');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const STATIC_FILES = {
  '/':              { file: 'index.html',    type: 'text/html; charset=utf-8' },
  '/index.html':    { file: 'index.html',    type: 'text/html; charset=utf-8' },
  '/settings':      { file: 'settings.html', type: 'text/html; charset=utf-8' },
  '/settings.html': { file: 'settings.html', type: 'text/html; charset=utf-8' },
  '/library':       { file: 'library.html',  type: 'text/html; charset=utf-8' },
  '/library.html':  { file: 'library.html',  type: 'text/html; charset=utf-8' },
  '/todos':         { file: 'todos.html',    type: 'text/html; charset=utf-8' },
  '/todos.html':    { file: 'todos.html',    type: 'text/html; charset=utf-8' },
  '/styles.css':    { file: 'styles.css',    type: 'text/css; charset=utf-8' },
  '/app.js':        { file: 'app.js',        type: 'application/javascript; charset=utf-8' },
  '/settings.js':   { file: 'settings.js',   type: 'application/javascript; charset=utf-8' },
  '/library.js':    { file: 'library.js',    type: 'application/javascript; charset=utf-8' },
  '/todos.js':      { file: 'todos.js',      type: 'application/javascript; charset=utf-8' },
  '/markdown.js':   { file: 'markdown.js',   type: 'application/javascript; charset=utf-8' },
};

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') return JSON.parse(req.body);
  }
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (raw.length === 0) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(new Error(`Invalid JSON request body: ${err.message}`)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function serveStatic(res, filePath, contentType) {
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR)) {
    sendError(res, 400, 'Invalid path');
    return;
  }
  let body;
  try {
    body = await fs.promises.readFile(full);
  } catch (err) {
    sendError(res, 404, `Not found: ${filePath}`);
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', 'no-cache');
  res.end(body);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // Static files
  if (method === 'GET' && STATIC_FILES[pathname]) {
    const s = STATIC_FILES[pathname];
    return await serveStatic(res, s.file, s.type);
  }

  try {
    if (method === 'GET' && pathname === '/api/feed') {
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
        return sendError(res, 400, 'limit must be an integer between 1 and 100');
      }
      const cards = await readFeed({ limit });
      const queued = await countQueued();
      const refillThreshold = await getInt('queue_refill_threshold');
      return sendJson(res, 200, { cards, queued, refill_threshold: refillThreshold });
    }

    if (method === 'GET' && pathname.startsWith('/api/cards/') && pathname.endsWith('/sources')) {
      const id = parseInt(pathname.split('/')[3], 10);
      if (!Number.isInteger(id)) return sendError(res, 400, 'invalid card id');
      const sources = await getCardSources(id);
      return sendJson(res, 200, { sources });
    }

    if (method === 'POST' && pathname === '/api/feedback') {
      const body = await readJsonBody(req);
      return await handleFeedback(body, res);
    }

    if (method === 'POST' && pathname === '/api/requests') {
      const body = await readJsonBody(req);
      return await handleSubmitRequest(body, res);
    }

    if (method === 'POST' && pathname === '/api/run-now') {
      return await handleRunNow(res);
    }

    if (method === 'POST' && pathname === '/api/scheduler/run') {
      // Same handler, but stricter authentication recommended in production
      // (verify Cloud Scheduler OIDC token or shared secret header).
      return await handleRunNow(res);
    }

    if (method === 'GET' && pathname === '/api/status') {
      const status = await getRunLockStatus();
      const queued = await countQueued();
      return sendJson(res, 200, { lock: status, queued });
    }

    if (method === 'POST' && pathname === '/api/lock/force-release') {
      await forceReleaseRunLock();
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/settings') {
      const settings = await getAllSettings();
      const prompts = await getAllPrompts();
      return sendJson(res, 200, { settings, prompts });
    }

    if (method === 'PUT' && pathname === '/api/settings') {
      const body = await readJsonBody(req);
      if (typeof body !== 'object' || body === null) return sendError(res, 400, 'body must be an object of {key: value}');
      for (const [key, value] of Object.entries(body)) {
        if (typeof value !== 'string') return sendError(res, 400, `value for ${key} must be a string`);
        await setSetting(key, value);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'PUT' && pathname.startsWith('/api/prompts/')) {
      const key = decodeURIComponent(pathname.slice('/api/prompts/'.length));
      const body = await readJsonBody(req);
      if (typeof body.instruction_text !== 'string') {
        return sendError(res, 400, 'instruction_text required');
      }
      await setInstruction(key, body.instruction_text);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname.match(/^\/api\/prompts\/.+\/reset$/)) {
      const key = decodeURIComponent(pathname.slice('/api/prompts/'.length, -'/reset'.length));
      await resetInstruction(key);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/library') {
      return await handleLibrary(res);
    }

    if (method === 'POST' && pathname.match(/^\/api\/goals\/\d+\/status$/)) {
      const goal_id = parseInt(pathname.split('/')[3], 10);
      const body = await readJsonBody(req);
      if (typeof body.status !== 'string') return sendError(res, 400, 'status required');
      await setGoalStatus(goal_id, body.status);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/todos') {
      return await handleListTodos(res);
    }

    if (method === 'POST' && pathname.match(/^\/api\/todos\/\d+\/(done|undone|delete)$/)) {
      const parts = pathname.split('/');
      const card_id = parseInt(parts[3], 10);
      const action = parts[4];
      return await handleTodoAction(res, card_id, action);
    }

    if (method === 'GET' && pathname.match(/^\/api\/cards\/\d+\/messages$/)) {
      const card_id = parseInt(pathname.split('/')[3], 10);
      const card = await getCard(card_id);
      if (card === null) return sendError(res, 404, 'card not found');
      const messages = await listMessages(card_id);
      return sendJson(res, 200, {
        messages,
        card: {
          id: card.id,
          type: card.type,
          payload: card.payload,
          discussion_context: card.payload.discussion_context,
        },
      });
    }

    if (method === 'POST' && pathname.match(/^\/api\/cards\/\d+\/messages$/)) {
      const card_id = parseInt(pathname.split('/')[3], 10);
      const body = await readJsonBody(req);
      if (typeof body.content !== 'string' || body.content.trim().length === 0) {
        return sendError(res, 400, 'content is required');
      }
      const result = await discuss({ card_id, user_text: body.content });
      return sendJson(res, 200, result);
    }

    return sendError(res, 404, `Not found: ${method} ${pathname}`);
  } catch (err) {
    console.error('Route error:', err);
    return sendError(res, 500, err.message || 'Internal error');
  }
}

async function handleFeedback(body, res) {
  const kind = body.kind;
  if (kind === 'thumbs' || kind === 'heart') {
    if (!Number.isInteger(body.card_id)) return sendError(res, 400, 'card_id required');
    if (kind === 'thumbs' && body.value !== 'up' && body.value !== 'down') {
      return sendError(res, 400, 'thumbs value must be up|down');
    }
    const delta = kind === 'heart' ? 1.5 : (body.value === 'up' ? 0.5 : -0.7);
    const card = await getCard(body.card_id);
    if (card === null) return sendError(res, 404, 'card not found');

    // Apply topic-weight delta. Use the choke-point parser to read the topic
    // list (already done by getCard) and update topic_preferences.
    const topics = (card.payload.topics || []).slice(0, 8);
    for (const t of topics) {
      await query(
        'INSERT INTO topic_preferences (topic, weight) VALUES (?, GREATEST(0.1, 1.0 + ?)) ON DUPLICATE KEY UPDATE weight = GREATEST(0.1, weight + ?)',
        [t, delta, delta]
      );
    }
    // Type appetite shifts too.
    await query(
      'UPDATE type_appetite SET weight = GREATEST(0.1, weight + ?) WHERE type = ?',
      [delta * 0.3, card.type]
    );
    if (kind === 'thumbs' && body.value === 'down') {
      await query("UPDATE cards SET status = 'consumed', consumed_at = NOW() WHERE id = ?", [body.card_id]);
    }
    return sendJson(res, 200, { ok: true, applied_delta: delta, topics });
  }

  if (kind === 'follow') {
    if (!Number.isInteger(body.source_id)) return sendError(res, 400, 'source_id required');
    if (typeof body.followed !== 'boolean') return sendError(res, 400, 'followed must be boolean');
    await followSource(body.source_id, body.followed);
    return sendJson(res, 200, { ok: true });
  }

  if (kind === 'learning_outcome') {
    if (!Number.isInteger(body.card_id)) return sendError(res, 400, 'card_id required');
    if (body.result !== 'correct' && body.result !== 'incorrect') {
      return sendError(res, 400, "result must be 'correct' or 'incorrect'");
    }
    await recordReview({ card_id: body.card_id, result: body.result });
    return sendJson(res, 200, { ok: true });
  }

  if (kind === 'consume') {
    if (!Number.isInteger(body.card_id)) return sendError(res, 400, 'card_id required');
    await markConsumed(body.card_id);
    return sendJson(res, 200, { ok: true });
  }

  if (kind === 'save') {
    if (!Number.isInteger(body.card_id)) return sendError(res, 400, 'card_id required');
    // Save = drop from feed, surface on /todos. Apply a small positive topic
    // bump while we're here — saving is a deliberate positive signal.
    const card = await getCard(body.card_id);
    if (card === null) return sendError(res, 404, 'card not found');
    await query("UPDATE cards SET status = 'saved', saved_at = NOW() WHERE id = ?", [body.card_id]);
    if (card.type === 'discovery' && Array.isArray(card.payload.topics)) {
      for (const t of card.payload.topics.slice(0, 8)) {
        await query(
          'INSERT INTO topic_preferences (topic, weight) VALUES (?, GREATEST(0.1, 1.0 + 0.5)) ON DUPLICATE KEY UPDATE weight = GREATEST(0.1, weight + 0.5)',
          [t]
        );
      }
    }
    await query("UPDATE type_appetite SET weight = GREATEST(0.1, weight + 0.2) WHERE type = ?", [card.type]);
    return sendJson(res, 200, { ok: true });
  }

  return sendError(res, 400, `Unknown feedback kind: ${kind}`);
}

async function handleListTodos(res) {
  const rows = await query(
    `SELECT c.id, c.type, c.status, c.goal_id, c.payload, c.score, c.created_at,
            c.saved_at, c.done_at,
            g.topic AS goal_topic
       FROM cards c
       LEFT JOIN goals g ON c.goal_id = g.id
      WHERE c.status IN ('saved', 'done')
      ORDER BY c.status ASC, COALESCE(c.saved_at, c.created_at) DESC`
  );
  const cards = rows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    goal_id: r.goal_id,
    goal_topic: r.goal_topic,
    score: r.score,
    created_at: r.created_at,
    saved_at: r.saved_at,
    done_at: r.done_at,
    payload: parsePayload(r.type, r.payload),
  }));
  return sendJson(res, 200, { cards });
}

async function handleTodoAction(res, card_id, action) {
  if (!Number.isInteger(card_id)) return sendError(res, 400, 'invalid card id');
  const card = await queryOne('SELECT id, status FROM cards WHERE id = ?', [card_id]);
  if (card === null) return sendError(res, 404, 'card not found');
  if (action === 'done') {
    if (card.status !== 'saved' && card.status !== 'done') {
      return sendError(res, 409, `cannot mark done from status=${card.status}`);
    }
    await query("UPDATE cards SET status = 'done', done_at = NOW() WHERE id = ?", [card_id]);
  } else if (action === 'undone') {
    if (card.status !== 'done' && card.status !== 'saved') {
      return sendError(res, 409, `cannot unmark from status=${card.status}`);
    }
    await query("UPDATE cards SET status = 'saved', done_at = NULL WHERE id = ?", [card_id]);
  } else if (action === 'delete') {
    if (card.status !== 'saved' && card.status !== 'done') {
      return sendError(res, 409, `cannot delete from status=${card.status}`);
    }
    await query("UPDATE cards SET status = 'consumed', consumed_at = NOW() WHERE id = ?", [card_id]);
  } else {
    return sendError(res, 400, `unknown action ${action}`);
  }
  return sendJson(res, 200, { ok: true });
}


async function handleSubmitRequest(body, res) {
  // Validate via the choke point before storing.
  let serialized;
  try {
    serialized = serializeAndValidateRequest(body);
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  const immediate = body.immediate === true ? 1 : 0;
  const result = await query(
    'INSERT INTO requests (body, immediate) VALUES (?, ?)',
    [serialized, immediate]
  );
  let runResult = null;
  if (immediate) {
    // Fire the run synchronously so the user gets a card immediately. If a
    // run is already in progress it returns refusal — the request stays
    // pending for the next run.
    runResult = await runOnce({ trigger: 'immediate-request' });
  }
  return sendJson(res, 200, { ok: true, request_id: result.insertId, run: runResult });
}

async function handleRunNow(res) {
  const result = await runOnce({ trigger: 'manual' });
  return sendJson(res, 200, result);
}

async function handleLibrary(res) {
  const goals = await query('SELECT id, topic, status, mastery_threshold, correct_streak, total_reviewed, total_correct, created_at FROM goals ORDER BY status, updated_at DESC');
  const cardsByGoal = await query(`
    SELECT id, type, status, goal_id, payload, score, created_at
      FROM cards
     WHERE goal_id IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 500
  `);
  const grouped = {};
  for (const c of cardsByGoal) {
    const key = String(c.goal_id);
    if (!grouped[key]) grouped[key] = [];
    let payload;
    try { payload = parsePayload(c.type, c.payload); }
    catch (err) { payload = { error: err.message }; }
    grouped[key].push({
      id: c.id,
      type: c.type,
      status: c.status,
      score: c.score,
      created_at: c.created_at,
      payload,
    });
  }
  return sendJson(res, 200, { goals, cards_by_goal: grouped });
}

module.exports = { route };
