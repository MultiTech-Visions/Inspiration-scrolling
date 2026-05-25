'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const { getInstruction } = require('./prompts');
const { getString } = require('./settings');

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Missing ANTHROPIC_API_KEY — refusing to make LLM calls without an API key');
  }
  _client = new Anthropic();
  return _client;
}

// Pipeline = instruction_text (editable, cached system prompt) + data block
// (constructed in code, never interpolated into instruction). Returns the
// parsed JSON object. We refuse to silently recover from malformed model
// output — the caller asked for JSON, if we can't parse JSON we throw.
async function callPipelineStep({ promptKey, dataBlock, maxTokens = 4096 }) {
  if (typeof promptKey !== 'string' || promptKey.length === 0) {
    throw new Error('callPipelineStep requires a promptKey');
  }
  if (typeof dataBlock !== 'string' || dataBlock.length === 0) {
    throw new Error('callPipelineStep requires a non-empty dataBlock');
  }

  const instruction = await getInstruction(promptKey);
  const model = await getString('llm_model');
  const effort = await getString('llm_effort');

  const response = await client().messages.create({
    model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    system: [
      {
        type: 'text',
        text: instruction,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      { role: 'user', content: dataBlock },
    ],
  });

  // Pull the first text block. We do NOT swallow anything — if the model
  // returned only thinking with no text, that is a real error.
  let raw = null;
  for (const block of response.content) {
    if (block.type === 'text') {
      raw = block.text;
      break;
    }
  }
  if (raw === null) {
    throw new Error(`LLM step ${promptKey} returned no text content (stop_reason=${response.stop_reason})`);
  }

  const trimmed = stripCodeFence(raw.trim());
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`LLM step ${promptKey} returned non-JSON output: ${err.message}. Raw output started with: ${trimmed.slice(0, 200)}`);
  }
  return {
    parsed,
    usage: response.usage,
    stop_reason: response.stop_reason,
  };
}

// If the model wrapped its output in ```json ... ``` despite being asked not
// to, strip the fence. We do this surgically — anything else passes through
// unmodified so JSON.parse can fail loudly.
function stripCodeFence(s) {
  if (!s.startsWith('```')) return s;
  const firstNewline = s.indexOf('\n');
  if (firstNewline === -1) return s;
  let body = s.slice(firstNewline + 1);
  if (body.endsWith('```')) body = body.slice(0, -3);
  return body.trim();
}

module.exports = { callPipelineStep };
