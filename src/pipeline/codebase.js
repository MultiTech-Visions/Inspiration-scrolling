'use strict';

const { callPipelineStep } = require('../llm');
const github = require('../github');
const { insertCard } = require('../cards');

// Codebase cards are only generated for an explicit user request — never
// speculatively. Scope is the requested repo(s) only.
async function synthesizeCodebaseForRequest(req) {
  const { owner, name } = req.body.repo;
  const focus = req.body.focus || '';

  const [meta, langs, readme, manifest] = await Promise.all([
    github.fetchRepoMetadata(owner, name),
    github.fetchRepoLanguages(owner, name),
    github.fetchRepoReadme(owner, name).catch(() => null),
    github.fetchPackageManifest(owner, name).catch(() => null),
  ]);

  const ref = meta.default_branch || 'main';

  const dataBlock = [
    `=== Repository: ${owner}/${name} ===`,
    `Default branch: ${ref}`,
    `Description: ${meta.description || '(none)'}`,
    `Stars: ${meta.stargazers_count}  Forks: ${meta.forks_count}  Open issues: ${meta.open_issues_count}`,
    `Pushed at: ${meta.pushed_at}`,
    `Languages: ${Object.keys(langs).join(', ') || '(unknown)'}`,
    focus ? `User focus: ${focus}` : '',
    '',
    '=== README (truncated) ===',
    readme ? readme.slice(0, 4000) : '(no README found)',
    '',
    '=== Manifest ===',
    manifest ? `path=${manifest.path}\n${manifest.body.slice(0, 4000)}` : '(no manifest found)',
    '',
    'Pick ONE concrete finding — security update, dead dependency, efficiency opportunity, or refactor — and write a card pointing at it. Cite real file paths from the manifest or README; do not invent paths.',
  ].filter(Boolean).join('\n');

  const { parsed } = await callPipelineStep({
    promptKey: 'synthesize_codebase',
    dataBlock,
    maxTokens: 3000,
  });

  parsed.repo = { owner, name, ref };
  parsed.generated_at = new Date().toISOString();
  // references is required by the schema — if the model didn't return one,
  // we let validation throw loudly downstream rather than fabricate an empty array.

  const card_id = await insertCard({
    type: 'codebase',
    payload: parsed,
    score: 8.0,
  });
  return card_id;
}

module.exports = { synthesizeCodebaseForRequest };
