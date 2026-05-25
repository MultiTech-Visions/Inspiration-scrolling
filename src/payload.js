'use strict';

// Single choke point for card payloads. Every write goes through
// serializeAndValidate(); every read goes through parsePayload(). The schemas
// here are the contract — if a field is missing or the wrong type we throw
// loudly. No silent defaults, no `|| []`, no permissive parsing.

const CARD_TYPES = new Set(['discovery', 'codebase', 'learning']);
const LEARNING_SUBTYPES = new Set(['tidbit', 'question', 'flashcard', 'quiz']);
const CODEBASE_KINDS = new Set(['security', 'dead_dep', 'efficiency', 'refactor']);
const VIDEO_PROVIDERS = new Set(['youtube', 'twitter', 'instagram', 'reddit', 'other']);

function fail(card_type, field, reason) {
  throw new Error(`Invalid ${card_type} payload at "${field}": ${reason}`);
}

function requireString(obj, field, card_type, { allowEmpty = false } = {}) {
  const v = obj[field];
  if (typeof v !== 'string') fail(card_type, field, `expected string, got ${typeof v}`);
  if (!allowEmpty && v.length === 0) fail(card_type, field, 'empty string not allowed');
  return v;
}

function requireStringArray(obj, field, card_type) {
  const v = obj[field];
  if (!Array.isArray(v)) fail(card_type, field, `expected array, got ${typeof v}`);
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string' || v[i].length === 0) {
      fail(card_type, `${field}[${i}]`, 'expected non-empty string');
    }
  }
  return v;
}

function requireOneOf(obj, field, allowed, card_type) {
  const v = obj[field];
  if (!allowed.has(v)) fail(card_type, field, `expected one of [${[...allowed].join(', ')}], got ${JSON.stringify(v)}`);
  return v;
}

function requireIsoTimestamp(obj, field, card_type) {
  const v = obj[field];
  if (typeof v !== 'string') fail(card_type, field, `expected ISO timestamp string, got ${typeof v}`);
  const t = Date.parse(v);
  if (Number.isNaN(t)) fail(card_type, field, `not a valid ISO timestamp: ${JSON.stringify(v)}`);
  return v;
}

function requireBoolean(obj, field, card_type) {
  const v = obj[field];
  if (typeof v !== 'boolean') fail(card_type, field, `expected boolean, got ${typeof v}`);
  return v;
}

function requireInt(obj, field, card_type, { min, max } = {}) {
  const v = obj[field];
  if (!Number.isInteger(v)) fail(card_type, field, `expected integer, got ${JSON.stringify(v)}`);
  if (min !== undefined && v < min) fail(card_type, field, `must be >= ${min}, got ${v}`);
  if (max !== undefined && v > max) fail(card_type, field, `must be <= ${max}, got ${v}`);
  return v;
}

function requireNumber(obj, field, card_type) {
  const v = obj[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(card_type, field, `expected finite number, got ${JSON.stringify(v)}`);
  return v;
}

function validateDiscovery(p) {
  requireString(p, 'title', 'discovery');
  requireString(p, 'summary', 'discovery');
  requireString(p, 'body', 'discovery');
  requireStringArray(p, 'topics', 'discovery');
  requireStringArray(p, 'source_urls', 'discovery');
  requireIsoTimestamp(p, 'generated_at', 'discovery');
  if (p.video !== null && p.video !== undefined) {
    if (typeof p.video !== 'object') fail('discovery', 'video', 'must be object or null');
    requireBoolean(p.video, 'embeddable', 'discovery.video');
    requireString(p.video, 'source_url', 'discovery.video');
    requireOneOf(p.video, 'provider', VIDEO_PROVIDERS, 'discovery.video');
  }
}

function validateCodebase(p) {
  requireString(p, 'title', 'codebase');
  requireString(p, 'summary', 'codebase');
  requireString(p, 'body', 'codebase');
  if (typeof p.repo !== 'object' || p.repo === null) fail('codebase', 'repo', 'must be object');
  requireString(p.repo, 'owner', 'codebase.repo');
  requireString(p.repo, 'name', 'codebase.repo');
  requireString(p.repo, 'ref', 'codebase.repo');
  requireOneOf(p, 'finding_kind', CODEBASE_KINDS, 'codebase');
  if (!Array.isArray(p.references)) fail('codebase', 'references', 'must be array');
  for (let i = 0; i < p.references.length; i++) {
    const r = p.references[i];
    if (typeof r !== 'object' || r === null) fail('codebase', `references[${i}]`, 'must be object');
    requireString(r, 'path', `codebase.references[${i}]`);
    if (r.line !== undefined && r.line !== null) requireInt(r, 'line', `codebase.references[${i}]`, { min: 1 });
  }
  requireIsoTimestamp(p, 'generated_at', 'codebase');
}

function validateLearning(p) {
  requireOneOf(p, 'subtype', LEARNING_SUBTYPES, 'learning');
  requireString(p, 'title', 'learning');
  requireString(p, 'prompt_text', 'learning');

  if (p.subtype === 'tidbit') {
    if (p.answer_text !== null && p.answer_text !== undefined) {
      requireString(p, 'answer_text', 'learning', { allowEmpty: true });
    }
  } else if (p.subtype === 'flashcard' || p.subtype === 'question') {
    requireString(p, 'answer_text', 'learning');
  } else if (p.subtype === 'quiz') {
    requireStringArray(p, 'options', 'learning');
    if (p.options.length < 2) fail('learning', 'options', 'quiz must have >=2 options');
    requireInt(p, 'correct_index', 'learning', { min: 0, max: p.options.length - 1 });
    requireString(p, 'answer_text', 'learning');
  }

  if (typeof p.spaced_repetition !== 'object' || p.spaced_repetition === null) {
    fail('learning', 'spaced_repetition', 'must be object');
  }
  const sr = p.spaced_repetition;
  requireNumber(sr, 'interval_days', 'learning.spaced_repetition');
  requireNumber(sr, 'ease', 'learning.spaced_repetition');
  requireIsoTimestamp(sr, 'due_at', 'learning.spaced_repetition');
  requireInt(sr, 'reviews', 'learning.spaced_repetition', { min: 0 });

  requireIsoTimestamp(p, 'generated_at', 'learning');
}

function validatePayload(type, payload) {
  if (!CARD_TYPES.has(type)) {
    throw new Error(`Unknown card type: ${JSON.stringify(type)}`);
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`Card payload must be a plain object; got ${Array.isArray(payload) ? 'array' : typeof payload}`);
  }
  if (type === 'discovery') validateDiscovery(payload);
  else if (type === 'codebase') validateCodebase(payload);
  else if (type === 'learning') validateLearning(payload);
}

function serializeAndValidate(type, payload) {
  validatePayload(type, payload);
  return JSON.stringify(payload);
}

function parsePayload(type, str) {
  if (typeof str !== 'string') {
    throw new Error(`parsePayload expects string, got ${typeof str}`);
  }
  let obj;
  try {
    obj = JSON.parse(str);
  } catch (err) {
    throw new Error(`Malformed payload JSON for type=${type}: ${err.message}`);
  }
  validatePayload(type, obj);
  return obj;
}

// Same shape applied to deferred requests so submission validates at the API
// boundary, not when the run wakes up and finds garbage.
const REQUEST_INTENTS = new Set(['codebase_audit', 'learning_goal', 'discovery_topic']);

function validateRequestBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Request body must be a plain object');
  }
  requireOneOf(body, 'intent', REQUEST_INTENTS, 'request');
  if (body.intent === 'codebase_audit') {
    if (typeof body.repo !== 'object' || body.repo === null) {
      throw new Error('Invalid request payload at "repo": must be object');
    }
    requireString(body.repo, 'owner', 'request.repo');
    requireString(body.repo, 'name', 'request.repo');
    if (body.focus !== undefined && body.focus !== null) {
      requireString(body, 'focus', 'request', { allowEmpty: true });
    }
  } else if (body.intent === 'learning_goal') {
    requireString(body, 'topic', 'request');
    if (body.mastery_threshold !== undefined && body.mastery_threshold !== null) {
      requireInt(body, 'mastery_threshold', 'request', { min: 1, max: 100 });
    }
  } else if (body.intent === 'discovery_topic') {
    requireString(body, 'topic', 'request');
  }
}

function serializeAndValidateRequest(body) {
  validateRequestBody(body);
  return JSON.stringify(body);
}

function parseRequest(str) {
  if (typeof str !== 'string') {
    throw new Error(`parseRequest expects string, got ${typeof str}`);
  }
  const obj = JSON.parse(str);
  validateRequestBody(obj);
  return obj;
}

module.exports = {
  CARD_TYPES,
  serializeAndValidate,
  parsePayload,
  serializeAndValidateRequest,
  parseRequest,
};
