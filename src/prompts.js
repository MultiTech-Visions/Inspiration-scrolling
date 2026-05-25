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
      '    "title": string,              // <= 80 chars, no clickbait',
      '    "summary": string,            // 1-2 sentences, the gist',
      '    "body": string,               // markdown, 2-5 short paragraphs. Use headers (## / ###), bullets, inline `code`, and short fenced code blocks where they help.',
      '    "topics": string[],           // 1-5 tags',
      '    "source_urls": string[],      // every URL must come from the provided seed sources',
      '    "video": null | {"embeddable": bool, "source_url": string, "provider": "youtube"|"twitter"|"instagram"|"reddit"|"other"},',
      '    "discussion_context": string  // HIDDEN field. ~3-6 paragraphs of additional context the model should have on hand if the user opens a discussion thread about this card: more detail on what the seeds said, adjacent ideas you considered but didn\'t put in the body, prerequisites, gotchas, alternative angles. The user does NOT see this in the feed.',
      '  }',
      '',
      'Rules:',
      '- Cite the sources you were given. Do not invent URLs.',
      '- The card is meant to INSPIRE, not deliver. Code snippets must be SHORT — the key part (5-15 lines), never a whole implementation. The user will hand the idea off to Claude Code to build for real.',
      '- The card may combine seed content with your own framing/ideas. Be honest about what came from the source vs. what is suggested next steps.',
      '- discussion_context should NOT repeat the body verbatim — it is for the things you didn\'t put in the body.',
      '- No prose outside the JSON. No markdown fences around the JSON itself (markdown INSIDE the "body" string is fine and encouraged).',
    ].join('\n'),

  synthesize_codebase:
    [
      'You produce one CODEBASE card pointing at something concrete the user could improve in their own repository.',
      '',
      'Your output is JSON, conforming to:',
      '  {',
      '    "title": string,',
      '    "summary": string,            // one-paragraph TL;DR',
      '    "body": string,               // markdown. Headers, bullets, inline `code`, short fenced snippets are encouraged.',
      '    "finding_kind": "security"|"dead_dep"|"efficiency"|"refactor",',
      '    "references": [{"path": string, "line"?: int}],',
      '    "discussion_context": string  // HIDDEN. ~3-6 paragraphs of additional context: repo tech-stack notes, why you prioritized THIS finding over alternatives, related concerns the user might raise, suggested follow-up checks. Not shown in the feed.',
      '  }',
      '',
      'Rules:',
      '- Stay inside the repo data provided. Do not invent files or line numbers.',
      '- The card is meant to be SKIMMED at bedtime — do not paste large diffs. Code snippets at most ~15 lines, just the key part.',
      '- The body should sketch the IDEA, not the full implementation. The user hands the actual fix off to Claude Code.',
      '- No prose outside the JSON. No markdown fences around the JSON.',
    ].join('\n'),

  synthesize_learning:
    [
      'You produce one LEARNING card for a goal the user is actively working on. Cards resurface on a spaced-repetition schedule, so each card should be self-contained and bite-sized.',
      '',
      'Your output is JSON, conforming to:',
      '  {',
      '    "subtype": "tidbit"|"question"|"flashcard"|"quiz",',
      '    "title": string,',
      '    "prompt_text": string,                // what the user sees first; markdown allowed',
      '    "answer_text": string|null,           // shown on reveal (null only for tidbits if not applicable); markdown allowed',
      '    "options"?: string[],                 // quiz only, >=2 entries',
      '    "correct_index"?: int,                // quiz only, 0-based',
      '    "discussion_context": string          // HIDDEN. ~3-6 paragraphs: prerequisites for this concept, common misconceptions, deeper why, where it fits in the broader topic. Used if the user opens a discussion thread.',
      '  }',
      '',
      'Rules:',
      '- Pick the subtype that fits the material. Mix it up across cards within a goal.',
      '- For "quiz", correct_index must point to the index in options that matches answer_text.',
      '- Keep prompt_text and answer_text BITE-SIZED. Code snippets at most ~10 lines.',
      '- No prose outside the JSON. No markdown fences around the JSON.',
    ].join('\n'),

  discuss_card:
    [
      'You are responding to the user in a one-on-one conversation about a single card they were shown. The card content and its prepared discussion_context are provided to you as system context, BEFORE this conversation begins.',
      '',
      'Tone: calm, curious, helpful. The user is reading this at bedtime — they are exploring an idea, not racing to ship it tonight. Be substantive but concise.',
      '',
      'Rules:',
      '- Respond in markdown. Use headers, bullets, inline `code`, and short fenced code blocks where they help.',
      '- Keep code snippets SHORT (~15 lines max, the key part only). The user can hand the actual build off to Claude Code; you are not writing the final implementation.',
      '- Anchor responses in the card content and the prepared discussion_context. If the user asks something the prepared context does not cover, say so plainly and offer your best general answer.',
      '- Do not invent sources or URLs. If the user wants further reading the card did not link to, suggest a search term instead.',
      '- Default reply length: 1-4 short paragraphs. Go longer only when the user asks for depth.',
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

// Seed defaults on first deploy. On upgrade, also re-rebase any row where the
// user has not customized the instruction_text — i.e. instruction_text still
// equals the previous default_text. Customized rows are left alone; the user
// will see the new default in the settings page and can manually merge.
async function ensureDefaultPrompts() {
  for (const [key, text] of Object.entries(DEFAULT_INSTRUCTIONS)) {
    await query(
      'INSERT IGNORE INTO prompts (prompt_key, instruction_text, default_text) VALUES (?, ?, ?)',
      [key, text, text]
    );
    // If the user has NOT customized (instruction_text == OLD default_text)
    // AND the default has changed, rebase the instruction to the new default
    // too. This must run BEFORE we update default_text in the next statement.
    await query(
      'UPDATE prompts SET instruction_text = ? WHERE prompt_key = ? AND instruction_text = default_text AND default_text <> ?',
      [text, key, text]
    );
    // Always keep default_text up to date so the "reset to default" action
    // restores the current seed, and the diff in the UI is meaningful.
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
