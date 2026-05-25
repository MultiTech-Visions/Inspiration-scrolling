'use strict';

const { query, queryOne } = require('./db');

// Editable instruction blocks per pipeline step. Pipeline = instruction_text
// (this) + constructed data block (built in code, never interpolated into the
// instruction). If a row is missing or blank we refuse to run — running on a
// silent default would defeat the point of the editable surface.

const DEFAULT_INSTRUCTIONS = {
  digest:
    [
      'You distill the user\'s recent reactions, saves, and learning progress into a compact INSIGHTS digest. This digest is fed to downstream pipeline steps (theme selection, batched discovery generation) so those steps can act on what the user is currently doing without re-reading all the raw signals.',
      '',
      'Your output is JSON, conforming to:',
      '  {',
      '    "narrative": string,           // 2-3 sentences describing what the user is in right now',
      '    "leaning_into": string[],      // 3-6 concrete topic/area phrases getting positive signal lately',
      '    "cooling_on": string[],        // 0-3 things being signaled away from (consumed without saving, frequent dismissals, expired without engagement)',
      '    "streaks": string[],           // 0-5 short summaries of learning momentum (e.g. "Postgres internals — 7-streak, 18/22 overall")',
      '    "gaps_to_explore": string[]    // 1-4 adjacent topics the user has not engaged with but seem plausible from their interests',
      '  }',
      '',
      'Rules:',
      '- Be concrete. "Rust async ecosystem" beats "Rust". "MySQL JSON column quirks" beats "databases".',
      '- Distinguish "saved" (strong positive) from "consumed without saving" (read-and-moved-on, neutral-to-mild-negative) from "expired" (didn\'t even read it). Saves trump topic weights — they\'re the freshest, most deliberate signal.',
      '- Recency matters. A spike in the last week trumps a stale high weight.',
      '- gaps_to_explore should be plausible from the user\'s existing interests, not random suggestions. "Adjacent" is the key word.',
      '- If a signal area has almost no data, say so in the narrative rather than padding the arrays.',
      '- No prose outside the JSON. No markdown fences.',
    ].join('\n'),

  themes:
    [
      'You pick the THEMES that should drive tonight\'s discovery feed. Your inputs are: a pre-computed user insights digest (the most important input — read it first), the user\'s recent GitHub activity, and any pending user requests.',
      '',
      'Your output is JSON, conforming to:',
      '  {"themes": [{"label": string, "weight": number (0..1), "reasoning": string}, ...]}',
      '',
      'Rules:',
      '- 3 to 8 themes.',
      '- A theme is a short noun phrase (e.g. "Rust async ecosystem", "MySQL JSON column quirks").',
      '- Anchor primarily in the digest\'s `leaning_into` and `gaps_to_explore`. The GitHub activity is fresh context but the digest is the considered read on the user.',
      '- Avoid themes from the digest\'s `cooling_on` list unless the user has explicitly requested them.',
      '- "weight" reflects how much of tonight\'s feed should lean on this theme. Higher = more cards on it.',
      '- "reasoning" is one sentence explaining WHY this theme fits this user right now, ideally citing a specific digest signal.',
      '- If a pending user request specifies a topic, include it as a theme with weight 1.0 — that is non-negotiable.',
      '- No prose outside the JSON. No markdown fences.',
    ].join('\n'),

  synthesize_discovery:
    [
      'You produce a BATCH of DISCOVERY cards for a calm, prepared, bedtime feed in a single response. The user is replacing late-night scrolling with this — keep the tone curious and grounded, never hype-y or anxious.',
      '',
      'You have two tools:',
      '- web_search (server tool, generous budget). Search the open internet for real sources. Run many queries — across themes, around the digest\'s gaps_to_explore, around what the user is leaning into. Search broadly before committing.',
      '- bookmark_idea({ url, title, hook }). As you find promising sources during your searches, call bookmark_idea to keep them on your shortlist. "hook" is 1-2 sentences on why this is worth a card. You will write cards from your bookmarks at the end. The bookmarks list is your working memory across searches.',
      '',
      'Workflow:',
      '  1. Read the themes and the user insights digest carefully.',
      '  2. Search the web. Try several different queries — don\'t fixate on one theme. Cast a wide net.',
      '  3. As you find strong candidates, bookmark_idea them. Aim to gather noticeably more bookmarks than you intend to publish so you can pick the best.',
      '  4. When you have a strong shortlist (typically 1.5-2x the target card count), stop searching and write the cards.',
      '  5. Pick the strongest distinct cards. Distinct = different sources, different angles, different topics where possible.',
      '',
      'Your output is JSON, conforming to:',
      '  {',
      '    "cards": [',
      '      {',
      '        "title": string,              // <= 80 chars, no clickbait',
      '        "summary": string,            // 1-2 sentences, the gist',
      '        "body": string,               // markdown, 2-5 short paragraphs. Use headers (## / ###), bullets, inline `code`, and short fenced code blocks where they help.',
      '        "topics": string[],           // 1-5 tags',
      '        "source_urls": string[],      // every URL must be one you actually retrieved via web_search (typically a URL you bookmark_idea\'d)',
      '        "video": null | {"embeddable": bool, "source_url": string, "provider": "youtube"|"twitter"|"instagram"|"reddit"|"other"},',
      '        "discussion_context": string  // HIDDEN. ~3-6 paragraphs of additional context the model should have on hand if the user opens a discussion thread on this card: more on what the sources said, adjacent ideas you considered but didn\'t put in the body, prerequisites, gotchas, alternative angles. The user does NOT see this in the feed.',
      '      }',
      '    ]',
      '  }',
      '',
      'Rules:',
      '- Treat the target card count as a ceiling, not a quota. Fewer strong cards beats padding with weak ones. If the searches only produced 4 strong leads, return 4 cards.',
      '- Cards must be DISTINCT — different sources, different angles. Do not write two near-duplicate cards on the same finding.',
      '- Cite real URLs from your web_search results. Never invent or guess a URL.',
      '- Cards are meant to INSPIRE, not deliver. Code snippets short (5-15 lines), the key part only. The user hands the actual build off to Claude Code.',
      '- discussion_context should NOT repeat the body verbatim — it is for the things you didn\'t put in the body.',
      '- No prose outside the JSON. No markdown fences around the JSON itself (markdown INSIDE each "body" string is fine and encouraged).',
    ].join('\n'),

  synthesize_codebase:
    [
      'You produce one CODEBASE card pointing at something concrete the user could improve in their own repository.',
      '',
      'You have READ-ONLY GitHub tools available: list_pull_requests, get_pull_request, get_pull_request_files, get_pull_request_comments, get_pull_request_commits, list_commits, get_commit, list_issues, get_issue. The README and manifest alone are NOT enough — you need to see what is actually moving in the repo. A good investigation looks something like:',
      '  1. list_pull_requests (state=open and/or state=all) to see what is in flight or recently landed.',
      '  2. get_pull_request_files on the 1-3 PRs that look most relevant to the focus (or most active).',
      '  3. get_pull_request_comments on a PR with active discussion, if it reveals contested decisions.',
      '  4. list_commits + get_commit on anything moving outside the PR flow.',
      '  5. list_issues for known pain (security/dead-dep/efficiency complaints surface here).',
      'Spend tool calls cheaply but spend them. Stop calling tools the moment you have enough signal to write a grounded finding.',
      '',
      'Your output is JSON, conforming to:',
      '  {',
      '    "title": string,',
      '    "summary": string,            // one-paragraph TL;DR',
      '    "body": string,               // markdown. Headers, bullets, inline `code`, short fenced snippets are encouraged.',
      '    "finding_kind": "security"|"dead_dep"|"efficiency"|"refactor",',
      '    "references": [{"path": string, "line"?: int}],',
      '    "discussion_context": string  // HIDDEN. ~3-6 paragraphs of additional context: which PRs/commits/issues informed this finding, why you prioritized THIS over alternatives you saw, related concerns the user might raise, suggested follow-up checks. Not shown in the feed.',
      '  }',
      '',
      'Rules:',
      '- Ground the finding in evidence you actually retrieved (PR number, commit SHA, issue number). Do not invent file paths or line numbers — only cite paths you saw in a real PR/commit file list, or in the manifest/README.',
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
