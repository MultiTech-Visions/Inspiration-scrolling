'use strict';

const { runAgenticStep } = require('../llm');
const { getInt } = require('../settings');
const github = require('../github');
const { GITHUB_TOOLS, makeGithubDispatch } = require('../githubTools');
const { insertCard } = require('../cards');

// Codebase cards are only generated for an explicit user request — never
// speculatively. Scope is the requested repo. The model gets read-only GitHub
// tools (PRs, commits, issues) and is expected to investigate what is actually
// moving in the repo before writing a finding.
async function synthesizeCodebaseForRequest(req) {
  const { owner, name } = req.body.repo;
  const focus = req.body.focus || '';
  const maxSteps = await getInt('codebase_tool_max_steps');

  const [meta, langs, readme, manifest] = await Promise.all([
    github.fetchRepoMetadata(owner, name),
    github.fetchRepoLanguages(owner, name),
    github.fetchRepoReadme(owner, name).catch(() => null),
    github.fetchPackageManifest(owner, name).catch(() => null),
  ]);

  const ref = meta.default_branch || 'main';

  const initialMessage = [
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
    `You have read-only GitHub tools available (list_pull_requests, get_pull_request, get_pull_request_files, get_pull_request_comments, get_pull_request_commits, list_commits, get_commit, list_issues, get_issue). Use them to investigate what is actually moving in this repo — open PRs, recently merged work, in-flight discussions, recent commits, open issues. Your tool-call budget for this card is ${maxSteps} calls. When you have enough signal, return the final card JSON (no further tool calls).`,
  ].filter(Boolean).join('\n');

  const dispatch = makeGithubDispatch(owner, name);

  const { parsed, toolTrace } = await runAgenticStep({
    promptKey: 'synthesize_codebase',
    initialMessage,
    tools: GITHUB_TOOLS,
    dispatch,
    maxTokens: 4000,
    maxSteps,
  });

  parsed.repo = { owner, name, ref };
  parsed.generated_at = new Date().toISOString();

  const card_id = await insertCard({
    type: 'codebase',
    payload: parsed,
    score: 8.0,
  });
  console.log(`codebase card ${card_id} (${owner}/${name}): ${toolTrace.length} tool calls`);
  return card_id;
}

module.exports = { synthesizeCodebaseForRequest };
