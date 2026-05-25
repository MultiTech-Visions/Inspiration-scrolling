'use strict';

const { query, queryOne } = require('./db');

// Editable instruction blocks per pipeline step. Pipeline = instruction_text
// (this) + constructed data block (built in code, never interpolated into the
// instruction). If a row is missing or blank we refuse to run — running on a
// silent default would defeat the point of the editable surface.

const DEFAULT_INSTRUCTIONS = {
  themes:
    [
      'You are summarizing recent developer activity into a small set of THEMES that should drive tonight\'s discovery feed.',
      '',
      'Your output is JSON, conforming to:',
      '  {"themes": [{"label": string, "weight": number (0..1), "reasoning": string}, ...]}',
      '',
      'Rules:',
      '- 3 to 8 themes.',
      '- A theme is a short noun phrase (e.g. "Rust async ecosystem", "MySQL JSON column quirks").',
      '- "weight" reflects how much of tonight\'s feed should lean on this theme.',
      '- "reasoning" is one sentence explaining WHY this theme fits this user right now.',
      '- No prose outside the JSON. No markdown fences.',
    ].join('\n'),

  synthesize_discovery:
    [
      'You write one DISCOVERY card for a calm, prepared, bedtime feed. The user is replacing late-night scrolling with this — keep the tone curious and grounded, never hype-y or anxious.',
      '',
      'Your output is JSON, conforming to:',
      '  {',
      '    "title": string,            // <= 80 chars, no clickbait',
      '    "summary": string,          // 1-2 sentences, the gist',
      '    "body": string,             // 2-5 short paragraphs, markdown allowed',
      '    "topics": string[],         // 1-5 tags',
      '    "source_urls": string[],    // every URL must come from the provided seed sources',
      '    "video": null | {"embeddable": bool, "source_url": string, "provider": "youtube"|"twitter"|"instagram"|"reddit"|"other"}',
      '  }',
      '',
      'Rules:',
      '- Cite the sources you were given. Do not invent URLs.',
      '- The card may combine the seed content with your own framing/ideas, but the framing must be honest about what came from the source vs. what is suggested next steps.',
      '- No prose outside the JSON. No markdown fences.',
    ].join('\n'),

  synthesize_codebase:
    [
      'You produce one CODEBASE card pointing at something concrete the user could improve in their own repository.',
      '',
      'Your output is JSON, conforming to:',
      '  {',
      '    "title": string,',
      '    "summary": string,           // one-paragraph TL;DR',
      '    "body": string,              // markdown; explain the finding and a suggested next step',
      '    "finding_kind": "security"|"dead_dep"|"efficiency"|"refactor",',
      '    "references": [{"path": string, "line"?: int}],',
      '  }',
      '',
      'Rules:',
      '- Stay inside the repo data provided. Do not invent files or line numbers.',
      '- The card is meant to be skimmed at bedtime — do not paste large diffs.',
      '- No prose outside the JSON. No markdown fences.',
    ].join('\n'),

  synthesize_learning:
    [
      'You produce one LEARNING card for a goal the user is actively working on. Cards resurface on a spaced-repetition schedule, so each card should be self-contained and bite-sized.',
      '',
      'Your output is JSON, conforming to:',
      '  {',
      '    "subtype": "tidbit"|"question"|"flashcard"|"quiz",',
      '    "title": string,',
      '    "prompt_text": string,                // what the user sees first',
      '    "answer_text": string|null,           // shown on reveal (null only for tidbits if not applicable)',
      '    "options"?: string[],                 // quiz only, >=2 entries',
      '    "correct_index"?: int                 // quiz only, 0-based',
      '  }',
      '',
      'Rules:',
      '- Pick the subtype that fits the material. Mix it up across cards within a goal.',
      '- For "quiz", correct_index must point to the index in options that matches answer_text.',
      '- No prose outside the JSON. No markdown fences.',
    ].join('\n'),
};

async function getInstruction(key) {
  const row = await queryOne('SELECT instruction_text FROM prompts WHERE prompt_key = ?', [key]);
  if (row === null) {
    throw new Error(`Missing prompt: ${key}. Run ensureDefaultPrompts() during bootstrap.`);
  }
  const text = row.instruction_text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error(`Prompt ${key} has empty instruction_text — refusing to run with a blank instruction. Reset to default via /api/prompts/${key}/reset.`);
  }
  return text;
}

async function ensureDefaultPrompts() {
  for (const [key, text] of Object.entries(DEFAULT_INSTRUCTIONS)) {
    await query(
      'INSERT IGNORE INTO prompts (prompt_key, instruction_text, default_text) VALUES (?, ?, ?)',
      [key, text, text]
    );
    // Refresh default_text in case we have improved the seed since first deploy;
    // leaves the user-edited instruction_text alone.
    await query(
      'UPDATE prompts SET default_text = ? WHERE prompt_key = ? AND default_text <> ?',
      [text, key, text]
    );
  }
}

async function getAllPrompts() {
  const rows = await query('SELECT prompt_key, instruction_text, default_text, updated_at FROM prompts ORDER BY prompt_key');
  return rows.map((r) => ({
    key: r.prompt_key,
    instruction_text: r.instruction_text,
    default_text: r.default_text,
    updated_at: r.updated_at,
  }));
}

async function setInstruction(key, text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Instruction text cannot be empty');
  }
  const row = await queryOne('SELECT prompt_key FROM prompts WHERE prompt_key = ?', [key]);
  if (row === null) throw new Error(`Unknown prompt key: ${key}`);
  await query('UPDATE prompts SET instruction_text = ? WHERE prompt_key = ?', [text, key]);
}

async function resetInstruction(key) {
  const row = await queryOne('SELECT default_text FROM prompts WHERE prompt_key = ?', [key]);
  if (row === null) throw new Error(`Unknown prompt key: ${key}`);
  await query('UPDATE prompts SET instruction_text = default_text WHERE prompt_key = ?', [key]);
}

module.exports = {
  DEFAULT_INSTRUCTIONS,
  getInstruction,
  ensureDefaultPrompts,
  getAllPrompts,
  setInstruction,
  resetInstruction,
};
