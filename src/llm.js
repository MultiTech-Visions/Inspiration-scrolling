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
    messages: [{ role: 'user', content: dataBlock }],
  });

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
// to, strip the fence. Anything else passes through unmodified so JSON.parse
// can fail loudly.
function stripCodeFence(s) {
  if (!s.startsWith('```')) return s;
  const firstNewline = s.indexOf('\n');
  if (firstNewline === -1) return s;
  let body = s.slice(firstNewline + 1);
  if (body.endsWith('```')) body = body.slice(0, -3);
  return body.trim();
}

// Agentic pipeline step: the model has tools available (any mix of custom
// client-side tools that we dispatch + Anthropic server tools like web_search)
// and we loop until it stops calling client tools (or hits maxSteps). The
// final text block is parsed as JSON exactly like callPipelineStep.
//
// `tools`     — array of custom client-side tool defs (name, description,
//               input_schema). Their handlers are wired through `dispatch`.
// `dispatch`  — async (toolName, input) → result. Required when `tools` has
//               entries; ignored otherwise.
// `webSearch` — optional. { maxUses, blockedDomains } enables Anthropic's
//               server-side web_search tool. Search URLs returned across ALL
//               loop iterations are accumulated and returned to the caller so
//               source_urls can be filtered against fabrications.
async function runAgenticStep({
  promptKey,
  initialMessage,
  tools = [],
  dispatch = null,
  webSearch = null,
  maxTokens = 4096,
  maxSteps = 12,
}) {
  if (typeof promptKey !== 'string' || promptKey.length === 0) {
    throw new Error('runAgenticStep requires promptKey');
  }
  if (typeof initialMessage !== 'string' || initialMessage.length === 0) {
    throw new Error('runAgenticStep requires initialMessage');
  }
  if (!Array.isArray(tools)) {
    throw new Error('runAgenticStep: tools must be an array');
  }
  if (tools.length > 0 && typeof dispatch !== 'function') {
    throw new Error('runAgenticStep: dispatch function required when tools are provided');
  }
  if (tools.length === 0 && !webSearch) {
    throw new Error('runAgenticStep: at least one of `tools` or `webSearch` must be provided');
  }

  const instruction = await getInstruction(promptKey);
  const model = await getString('llm_model');
  const effort = await getString('llm_effort');

  const apiTools = [...tools];
  if (webSearch) {
    const searchTool = {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: webSearch.maxUses,
    };
    if (Array.isArray(webSearch.blockedDomains) && webSearch.blockedDomains.length > 0) {
      searchTool.blocked_domains = webSearch.blockedDomains;
    }
    apiTools.push(searchTool);
  }

  const messages = [{ role: 'user', content: initialMessage }];
  const toolTrace = [];
  const searchResults = [];
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
      tools: apiTools,
    });

    // Accumulate web_search results from this iteration before deciding
    // whether to loop. The model emits these between turns when it uses the
    // server tool.
    for (const block of response.content) {
      if (block.type !== 'web_search_tool_result') continue;
      const items = Array.isArray(block.content) ? block.content : [];
      for (const item of items) {
        if (item && item.type === 'web_search_result' && typeof item.url === 'string') {
          searchResults.push({ url: item.url, title: item.title || null });
        }
      }
    }

    if (response.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      // Server tools (web_search) are handled by Anthropic and never reach us
      // as a tool_use block — they show up as web_search_tool_result above.
      // Anything we see here is a client tool we own.
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
    searchResults,
    usage: response.usage,
    stop_reason: response.stop_reason,
  };
}

module.exports = { callPipelineStep, runAgenticStep };
