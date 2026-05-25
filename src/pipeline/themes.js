'use strict';

const { callPipelineStep } = require('../llm');
const { query } = require('../db');

// Read topic preferences + type appetite once per run, hand to the LLM as
// part of the data block.
async function gatherPreferences() {
  const topics = await query('SELECT topic, weight FROM topic_preferences ORDER BY weight DESC LIMIT 32');
  const appetite = await query('SELECT type, weight FROM type_appetite');
  return { topics, appetite };
}

function formatTopics(topics) {
  if (topics.length === 0) return '(none yet — user has not rated topics)';
  return topics.map((t) => `- ${t.topic} (weight ${t.weight.toFixed(2)})`).join('\n');
}

function formatAppetite(appetite) {
  return appetite.map((a) => `- ${a.type}: ${Number(a.weight).toFixed(2)}`).join('\n');
}

// activitySummary may be null (no GitHub activity / no username configured).
// In that case we fall back to the topic-preference list as the seed; the
// instruction explains how to handle a quiet night.
async function chooseThemes({ activitySummary, requests, preferences }) {
  const parts = [];
  if (activitySummary) {
    parts.push('=== Recent GitHub activity ===\n' + activitySummary);
  } else {
    parts.push('=== Recent GitHub activity ===\n(none — explore adjacent topics from the preference list below)');
  }
  parts.push('');
  parts.push('=== Topic preferences (higher weight = user wants more of this) ===');
  parts.push(formatTopics(preferences.topics));
  parts.push('');
  parts.push('=== Card-type appetite ===');
  parts.push(formatAppetite(preferences.appetite));
  if (requests && requests.length > 0) {
    parts.push('');
    parts.push('=== Pending user requests this run ===');
    for (const r of requests) {
      parts.push(`- intent=${r.body.intent}: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
  }

  const { parsed } = await callPipelineStep({
    promptKey: 'themes',
    dataBlock: parts.join('\n'),
    maxTokens: 2048,
  });

  if (!parsed || !Array.isArray(parsed.themes) || parsed.themes.length === 0) {
    throw new Error(`themes step returned no themes: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  for (const t of parsed.themes) {
    if (typeof t.label !== 'string' || t.label.length === 0) {
      throw new Error(`themes step returned theme without label: ${JSON.stringify(t)}`);
    }
    if (typeof t.weight !== 'number' || !Number.isFinite(t.weight)) {
      throw new Error(`themes step returned theme without numeric weight: ${JSON.stringify(t)}`);
    }
  }
  return parsed.themes;
}

module.exports = { gatherPreferences, chooseThemes };
