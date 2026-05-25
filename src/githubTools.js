'use strict';

const github = require('./github');

// Anthropic tool definitions for the codebase pipeline. All read-only, all
// scoped to a single (owner, name) repo bound when the dispatcher is built.
const GITHUB_TOOLS = [
  {
    name: 'list_pull_requests',
    description: 'List pull requests on the repository, most recently updated first. Use state="open" for in-flight work, "closed" for recently merged/closed PRs (GitHub returns both merged and closed-without-merge), "all" for both. Returns a compact list — call get_pull_request / get_pull_request_files for details.',
    input_schema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'PR state filter' },
        per_page: { type: 'integer', description: 'How many PRs to return (1-50). Default 20.' },
      },
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get full details of a single PR: title, body, author, head/base branches, merged/closed status, additions/deletions, changed_files count.',
    input_schema: {
      type: 'object',
      required: ['number'],
      properties: { number: { type: 'integer', description: 'PR number' } },
    },
  },
  {
    name: 'get_pull_request_files',
    description: 'Get the files changed in a PR with their patches (diff hunks). Patches are truncated if large. This is the primary way to see what a PR actually does.',
    input_schema: {
      type: 'object',
      required: ['number'],
      properties: { number: { type: 'integer' } },
    },
  },
  {
    name: 'get_pull_request_comments',
    description: 'Get the discussion on a PR: top-level discussion comments AND inline review comments tied to specific file lines. Sorted oldest-first.',
    input_schema: {
      type: 'object',
      required: ['number'],
      properties: { number: { type: 'integer' } },
    },
  },
  {
    name: 'get_pull_request_commits',
    description: 'List commits contained in a PR with their messages and SHAs. Use this when the PR has multiple commits and you want to understand the progression.',
    input_schema: {
      type: 'object',
      required: ['number'],
      properties: { number: { type: 'integer' } },
    },
  },
  {
    name: 'list_commits',
    description: 'List recent commits on the default branch (or a specific ref/sha if provided). Use this to see what is moving outside the PR flow.',
    input_schema: {
      type: 'object',
      properties: {
        per_page: { type: 'integer', description: '1-30. Default 20.' },
        sha: { type: 'string', description: 'Branch name or commit SHA to start from. Default: repo default branch.' },
      },
    },
  },
  {
    name: 'get_commit',
    description: 'Get a single commit including the files it changed and their patches. Patches are truncated if large.',
    input_schema: {
      type: 'object',
      required: ['sha'],
      properties: { sha: { type: 'string' } },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues on the repository (NOT pull requests — GitHub conflates them in their issues API, this filters PRs out).',
    input_schema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        per_page: { type: 'integer', description: '1-50. Default 20.' },
      },
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue including its full body and comments.',
    input_schema: {
      type: 'object',
      required: ['number'],
      properties: { number: { type: 'integer' } },
    },
  },
];

// Factory: returns a dispatch(name, input) closure bound to one repo. The
// LLM never sees owner/name — they're injected here so the model can't get
// confused or be tricked into looking at a different repo.
function makeGithubDispatch(owner, name) {
  const handlers = {
    list_pull_requests: (i) => github.listPullRequests(owner, name, i),
    get_pull_request: (i) => github.getPullRequest(owner, name, i.number),
    get_pull_request_files: (i) => github.getPullRequestFiles(owner, name, i.number),
    get_pull_request_comments: (i) => github.getPullRequestComments(owner, name, i.number),
    get_pull_request_commits: (i) => github.getPullRequestCommits(owner, name, i.number),
    list_commits: (i) => github.listCommits(owner, name, i),
    get_commit: (i) => github.getCommit(owner, name, i.sha),
    list_issues: (i) => github.listIssues(owner, name, i),
    get_issue: (i) => github.getIssue(owner, name, i.number),
  };
  return async function dispatch(toolName, input) {
    const handler = handlers[toolName];
    if (!handler) throw new Error(`Unknown tool: ${toolName}`);
    return await handler(input || {});
  };
}

module.exports = { GITHUB_TOOLS, makeGithubDispatch };
