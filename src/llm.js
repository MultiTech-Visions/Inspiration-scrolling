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
//
// Optional `webSearch` enables Anthropic's server-side web_search tool. When
// enabled, the response also carries the list of URLs the search actually
// returned (callers use this to filter out any URLs the model hallucinated).
async function callPipelineStep({ promptKey, dataBlock, maxTokens = 4096, webSearch = null }) {
  if (typeof promptKey !== 'string' || promptKey.length === 0) {
    throw new Error('callPipelineStep requires a promptKey');
  }
  if (typeof dataBlock !== 'string' || dataBlock.length === 0) {
    throw new Error('callPipelineStep requires a non-empty dataBlock');
  }

  const instruction = await getInstruction(promptKey);
  const model = await getString('llm_model');
  const effort = await getString('llm_effort');

  const request = {
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
  };

  if (webSearch) {
    const tool = {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: webSearch.maxUses,
    };
    if (Array.isArray(webSearch.blockedDomains) && webSearch.blockedDomains.length > 0) {
      tool.blocked_domains = webSearch.blockedDomains;
    }
    request.tools = [tool];
  }

  const response = await client().messages.create(request);

  // Collect every URL the web_search tool actually returned. The model may
  // still cite a different URL in its JSON answer — caller is responsible for
  // filtering source_urls against this list so we never publish a fabricated
  // link.
  const searchResults = [];
  let raw = null;
  for (const block of response.content) {
    if (block.type === 'web_search_tool_result') {
      const items = Array.isArray(block.content) ? block.content : [];
      for (const item of items) {
        if (item && item.type === 'web_search_result' && typeof item.url === 'string') {
          searchResults.push({ url: item.url, title: item.title || null });
        }
      }
    } else if (block.type === 'text') {
      // Keep the LAST text block — when web_search runs, the model emits an
      // intermediate text block before the tool call and the final JSON
      // answer afterward.
      raw = block.text;
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
    searchResults,
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

// Agentic pipeline step: same instruction-then-data shape, but the model has
// client-side tools available and we loop until it stops calling them (or we
// hit the step budget). The final text block is parsed as JSON exactly like
// callPipelineStep.
async function runAgenticStep({
  promptKey,
  initialMessage,
  tools,
  dispatch,
  maxTokens = 4096,
  maxSteps = 12,
}) {
  if (typeof promptKey !== 'string' || promptKey.length === 0) {
    throw new Error('runAgenticStep requires promptKey');
  }
  if (typeof initialMessage !== 'string' || initialMessage.length === 0) {
    throw new Error('runAgenticStep requires initialMessage');
  }
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('runAgenticStep requires non-empty tools array');
  }
  if (typeof dispatch !== 'function') {
    throw new Error('runAgenticStep requires dispatch function');
  }

  const instruction = await getInstruction(promptKey);
  const model = await getString('llm_model');
  const effort = await getString('llm_effort');

  const messages = [{ role: 'user', content: initialMessage }];
  const toolTrace = [];
  let response = null;

  for (let step = 0; step < maxSteps; step++) {
    response = await client().messages.create({
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
      messages,
      tools,
    });

    if (response.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      let result;
      let isError = false;
      try {
        result = await dispatch(block.name, block.input || {});
      } catch (err) {
        result = { error: String(err.message || err) };
        isError = true;
      }
      const serialized = typeof result === 'string' ? result : JSON.stringify(result);
      const resultBlock = {
        type: 'tool_result',
        tool_use_id: block.id,
        content: serialized,
      };
      if (isError) resultBlock.is_error = true;
      toolResults.push(resultBlock);
      toolTrace.push({ step, name: block.name, input: block.input, ok: !isError });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  if (!response) {
    throw new Error(`runAgenticStep ${promptKey}: no response produced`);
  }

  let raw = null;
  for (const block of response.content) {
    if (block.type === 'text') raw = block.text;
  }
  if (raw === null) {
    throw new Error(`runAgenticStep ${promptKey} ended without final text block (stop_reason=${response.stop_reason}, steps=${toolTrace.length}). Likely hit maxSteps=${maxSteps} mid-loop.`);
  }

  const trimmed = stripCodeFence(raw.trim());
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`runAgenticStep ${promptKey} returned non-JSON: ${err.message}. Raw started with: ${trimmed.slice(0, 200)}`);
  }

  return {
    parsed,
    toolTrace,
    usage: response.usage,
    stop_reason: response.stop_reason,
  };
}

module.exports = { callPipelineStep, runAgenticStep };
