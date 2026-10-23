'use strict'

/**
 * Runs the PRODUCTION doc-strings review against a fixture repo.
 *
 * Everything the model sees comes from .github/workflows/doc-strings-review.yml
 * at this commit: the prompt text of the "Claude review with suggestions"
 * step, its allowed and disallowed tools, and its turn limit. The workspace
 * gets the same files the workflow writes before that step (lint-findings.json,
 * pr-diff.patch, and the writing standard and terminology the workflow
 * fetches). Because callers pin this workflow by SHA, testing the prompt as it
 * sits in this file is testing exactly what a caller gets when it bumps its
 * pin. Nothing here restates a rule.
 *
 * Two substitutions, both forced by running outside Actions:
 * - The github_inline_comment MCP server is a recording stand-in
 *   (mocks/inline-comment.js) instead of claude-code-action's, so comments
 *   land in a file the harness reads instead of on a pull request.
 * - ${{ ... }} expressions in the prompt are filled with fixture values; any
 *   expression left unfilled is a HARNESS_ERROR, never a silent blank.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const YAML = require('yaml')

const REPO_ROOT = path.resolve(__dirname, '../..')
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'doc-strings-review.yml')
const MOCK = path.join(__dirname, 'mocks', 'inline-comment.js')
const STEP = 'Claude review with suggestions'

// The model production callers run the review on. streaming-enterprise and
// redpanda-operator both pass gateway_model: us.anthropic.claude-opus-5.
// Name the exact model, never the CLI alias: `opus` resolves to the newest
// Opus the CLI knows, which stops being the one callers run.
const PRODUCTION_MODEL = 'claude-opus-5'

// The files the workflow's "Fetch the writing standard" step downloads from
// docs-team-standards main at run time (unpinned, an existing exception; see
// CLAUDE.md). The eval fetches the same files the same way so it reviews with
// what production reviews with today.
const FETCHED_STANDARDS = {
  'embedded-reference-strings.md': 'resources/writing-style/embedded-reference-strings.md',
  'terminology.md': 'resources/writing-style/terminology.md'
}

function loadStep () {
  const wf = YAML.parse(fs.readFileSync(WORKFLOW, 'utf8'))
  const step = wf.jobs['doc-strings-review'].steps.find((s) => s.name === STEP)
  if (!step || !step.with || !step.with.prompt) throw new Error(`"${STEP}" step or its prompt not found in doc-strings-review.yml`)
  return step
}

/** The claude_args flags the step passes, parsed from the folded scalar. */
function parseClaudeArgs (claudeArgs) {
  const grab = (flag) => {
    const m = claudeArgs.match(new RegExp(`${flag}\\s+"([^"]*)"`))
    return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : []
  }
  const turns = claudeArgs.match(/--max-turns\s+(\d+)/)
  const mcp = claudeArgs.match(/--mcp-config\s+'([^']+)'/)
  return {
    allowed: grab('--allowed-tools'),
    disallowed: grab('--disallowed-tools'),
    maxTurns: turns ? turns[1] : null,
    mcpServers: mcp ? JSON.parse(mcp[1]).mcpServers : {}
  }
}

/** The production prompt with its Actions expressions filled in. */
function renderPrompt (prompt, vars) {
  const filled = prompt
    .replace(/\$\{\{\s*github\.repository\s*\}\}/g, vars.repository)
    .replace(/\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/g, String(vars.prNumber))
  const left = filled.match(/\$\{\{[^}]*\}\}/g)
  if (left) throw new Error(`unfilled Actions expression(s) in the production prompt: ${[...new Set(left)].join(', ')}`)
  return filled
}

let standardsCache = null
/** Download the standards the workflow fetches, once per run. */
function fetchStandards () {
  if (standardsCache) return standardsCache
  const out = {}
  for (const [name, repoPath] of Object.entries(FETCHED_STANDARDS)) {
    const r = spawnSync('gh', ['api', `repos/redpanda-data/docs-team-standards/contents/${repoPath}`, '-H', 'Accept: application/vnd.github.raw'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    if (r.status !== 0 || !r.stdout.trim()) throw new Error(`could not fetch ${repoPath} from docs-team-standards (gh exit ${r.status}): ${(r.stderr || '').slice(0, 200)}`)
    out[name] = r.stdout
  }
  standardsCache = out
  return out
}

/**
 * Write the workflow's pre-review files into the fixture repo and run the
 * production review step there.
 *
 * @param {object} o
 * @param {string} o.repoDir     fixture repo, the model's working directory
 * @param {object} o.lint        lint-strings JSON, as the workflow's lint step writes it
 * @param {string|null} o.diff   source diff, or null to leave pr-diff.patch absent
 * @param {string} [o.model]
 * @returns {{ output, comments, files, stderr, status, timedOut, ms, failed }}
 */
function runReview ({ repoDir, lint, diff, model = PRODUCTION_MODEL, timeoutMs = 600000 }) {
  const step = loadStep()
  const args = parseClaudeArgs(step.with.claude_args || '')
  // A repository that doesn't exist, so a model that looks the PR up with
  // `gh pr view` gets an error rather than a real, unrelated PR.
  const prompt = renderPrompt(step.with.prompt, { repository: 'example-org/doc-strings-eval-fixture', prNumber: 1 })

  fs.writeFileSync(path.join(repoDir, 'lint-findings.json'), JSON.stringify(lint, null, 2))
  if (diff != null) {
    fs.writeFileSync(path.join(repoDir, 'pr-diff.patch'),
      '# Source diff of this PR against its merge base.\n# Left out (generated docs, lockfiles, vendored code, test data): 0 file(s).\n\n' + diff)
  }
  for (const [name, text] of Object.entries(fetchStandards())) fs.writeFileSync(path.join(repoDir, name), text)

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-strings-prod-'))
  const log = path.join(scratch, 'inline-comments.jsonl')
  const mcpConfig = {
    mcpServers: {
      ...args.mcpServers,
      github_inline_comment: { type: 'stdio', command: process.execPath, args: [MOCK], env: { INLINE_COMMENT_LOG: log } }
    }
  }
  const mcpPath = path.join(scratch, 'mcp.json')
  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig))

  const cli = [
    '-p', '--output-format', 'text', '--model', model,
    // Load only the fixture repo's settings. The Actions runner has no user
    // settings, so a developer's own CLAUDE.md, plugins, and skills (such as
    // docs-team-standards, which ships the same standards) must not reach the
    // review here either.
    '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', mcpPath,
    '--allowed-tools', args.allowed.join(','),
    '--disallowed-tools', args.disallowed.join(',')
  ]
  if (args.maxTurns) cli.push('--max-turns', args.maxTurns)

  const started = Date.now()
  const r = spawnSync('claude', cli, { cwd: repoDir, input: prompt, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  const comments = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  const files = {}
  for (const name of ['doc-impact.json', 'review-summary.md']) {
    const p = path.join(repoDir, name)
    if (fs.existsSync(p)) files[name] = fs.readFileSync(p, 'utf8')
  }
  fs.rmSync(scratch, { recursive: true, force: true })

  // The executors parse model text. Present each recorded comment the way they
  // already read one: its span header, then its body with any suggestion block.
  const output = comments.map((c) => `FILE ${c.path} LINES ${c.startLine || c.line || 0}-${c.line || c.startLine || 0}\n${c.body}`).join('\n\n')
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT')
  return {
    prompt,
    output,
    transcript: r.stdout || '',
    comments,
    files,
    stderr: r.stderr || '',
    status: r.status,
    timedOut,
    ms: Date.now() - started,
    failed: timedOut || r.status !== 0
  }
}

module.exports = { runReview, loadStep, parseClaudeArgs, renderPrompt, PRODUCTION_MODEL, FETCHED_STANDARDS }
