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
 *
 * The run is captured as a stream-json transcript rather than final text, so
 * the harness sees every tool call the model made and in what order. That is
 * what the must-read check grades: the workflow stages the writing standard
 * and the terminology list as files and tells the model to apply them, and a
 * review that never opened them cannot have applied them, whatever its
 * suggestions say.
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
// redpanda-operator both pass gateway_model: us.anthropic.claude-opus-5; the
// exact id, never an alias, so a run is reproducible against what it named.
const PRODUCTION_MODEL = 'claude-opus-5'

// The files the workflow's "Fetch the writing standard" step downloads from
// docs-team-standards main at run time (unpinned, an existing exception; see
// CLAUDE.md). The eval fetches the same files the same way so it reviews with
// what production reviews with today.
const FETCHED_STANDARDS = {
  'embedded-reference-strings.md': 'resources/writing-style/embedded-reference-strings.md',
  'terminology.md': 'resources/writing-style/terminology.md'
}

// The files every production-path case must see the model open. The prompt
// names both as the standard the review applies, so a run that never read
// them reviewed from memory and is graded as such. Derived from the staged
// set so the two cannot drift apart.
const MUST_READ = Object.keys(FETCHED_STANDARDS)

// The inline-comment tool as the transcript names it. A read of a standard
// counts only if it comes before the first call to this.
const COMMENT_TOOL = 'mcp__github_inline_comment__create_inline_comment'

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

/**
 * The production prompt with every sentence that names a staged standard
 * removed. This is the must-read sabotage: the files are still in the
 * workspace, the model is simply never told they are there or to apply them,
 * so a harness that still reports "read before suggesting" is not reading
 * the transcript. A sentence ends at a period followed by whitespace or the
 * end of the text, so `terminology.md` and `lint-findings.json` do not split
 * one. The result must contain neither file name, or the sabotage is a
 * harness error rather than a weaker prompt.
 */
function stripStandardsInstructions (prompt) {
  const names = MUST_READ.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const naming = new RegExp(`(?:^|[^A-Za-z0-9_/-])(?:${names.join('|')})(?![A-Za-z0-9_-])`)
  const sentences = prompt.split(/(?<=\.)(?=\s|$)/)
  const kept = sentences.filter((s) => !naming.test(s))
  const out = kept.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  for (const n of MUST_READ) {
    if (out.includes(n)) throw new Error(`sabotage left ${n} in the prompt; the sentence splitter missed one`)
  }
  return out
}

/** The production prompt with its Actions expressions filled in. */
function renderPrompt (prompt, vars, { withoutStandards = false } = {}) {
  const filled = prompt
    .replace(/\$\{\{\s*github\.repository\s*\}\}/g, vars.repository)
    .replace(/\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/g, String(vars.prNumber))
  const left = filled.match(/\$\{\{[^}]*\}\}/g)
  if (left) throw new Error(`unfilled Actions expression(s) in the production prompt: ${[...new Set(left)].join(', ')}`)
  return withoutStandards ? stripStandardsInstructions(filled) : filled
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
 * Every tool call in a stream-json transcript, in order, with whether its
 * result came back as an error, plus the final result event.
 */
function parseStream (raw) {
  const calls = []
  const byId = new Map()
  let result = null
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let ev
    try { ev = JSON.parse(t) } catch { continue }
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block && block.type === 'tool_use' && typeof block.name === 'string') {
          const call = { index: calls.length, id: block.id, name: block.name, input: block.input || {}, error: false }
          calls.push(call)
          if (block.id) byId.set(block.id, call)
        }
      }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block && block.type === 'tool_result' && byId.has(block.tool_use_id)) {
          byId.get(block.tool_use_id).error = Boolean(block.is_error)
        }
      }
    } else if (ev.type === 'result') {
      result = ev
    }
  }
  return { calls, result }
}

/** A directory with symlinks resolved, so /var and /private/var on macOS compare equal. */
function realDir (dir) {
  try { return fs.realpathSync(dir) } catch { return path.resolve(dir) }
}

/** Which staged file, if any, a tool call opened. */
function readTarget (call, cwd) {
  if (call.name === 'Read' && typeof call.input.file_path === 'string') {
    const abs = path.resolve(cwd, call.input.file_path)
    return realDir(path.dirname(abs)) === realDir(cwd) ? path.basename(abs) : null
  }
  if (call.name === 'Bash' && typeof call.input.command === 'string') {
    // The step allows `cat <file>` for the two standards, and the CLI lets a
    // read-only shell command (grep, head, sed) through in the same way in
    // production, so any command that names the staged file opened it. A
    // path-qualified name has to resolve to the workspace; a bare name is
    // relative to it. The evidence records the command, so a reviewer can
    // see whether the model read the file or grepped one term out of it.
    for (const raw of call.input.command.split(/[\s|;&()<>]+/)) {
      const token = raw.replace(/^['"]|['"]$/g, '')
      if (!token || token.startsWith('-')) continue
      if (!token.includes('/')) {
        if (MUST_READ.includes(token)) return token
        continue
      }
      const abs = path.resolve(cwd, token)
      if (MUST_READ.includes(path.basename(abs)) && realDir(path.dirname(abs)) === realDir(cwd)) return path.basename(abs)
    }
    return null
  }
  return null
}

/**
 * The must-read verdict for one run. Every file in MUST_READ has to have been
 * opened by a Read of it, or a shell command that names it, that did not
 * error; and when the model posted any inline comment, each such read has to
 * come before the first comment: a standard consulted after the suggestions
 * were posted did not shape them.
 */
function checkMustRead (calls, cwd, files = MUST_READ) {
  const firstComment = calls.findIndex((c) => c.name === COMMENT_TOOL)
  const reads = calls
    .map((c) => ({ call: c, file: readTarget(c, cwd) }))
    .filter((r) => r.file && files.includes(r.file))
    .map((r) => ({
      file: r.file,
      index: r.call.index,
      tool: r.call.name,
      how: r.call.name === 'Bash' ? r.call.input.command : r.call.input.file_path,
      error: r.call.error
    }))
  const perFile = files.map((file) => {
    const ok = reads.filter((r) => r.file === file && !r.error)
    const before = firstComment === -1 ? ok : ok.filter((r) => r.index < firstComment)
    return {
      file,
      read: ok.length > 0,
      read_before_first_comment: before.length > 0,
      indices: ok.map((r) => r.index)
    }
  })
  const missing = perFile.filter((f) => !f.read).map((f) => f.file)
  const late = perFile.filter((f) => f.read && !f.read_before_first_comment).map((f) => f.file)
  const pass = missing.length === 0 && late.length === 0
  let detail
  if (pass) {
    detail = perFile.map((f) => `${f.file} at call #${f.indices.join(',#')}`).join('; ') +
      (firstComment === -1 ? '; no inline comment posted' : `; first inline comment at call #${firstComment}`)
  } else {
    const parts = []
    if (missing.length) parts.push(`never read: ${missing.join(', ')}`)
    if (late.length) parts.push(`read only after the first inline comment (call #${firstComment}): ${late.join(', ')}`)
    parts.push(`tool calls: [${calls.map((c) => c.name).join(', ') || 'none'}]`)
    detail = parts.join('; ')
  }
  return { pass, files: perFile, first_comment_index: firstComment, reads, detail }
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
 * @param {boolean} [o.withoutStandards]  sabotage: strip every sentence naming a staged standard
 * @returns {{ output, comments, files, calls, mustRead, stderr, status, timedOut, ms, failed }}
 */
function runReview ({ repoDir, lint, diff, model = PRODUCTION_MODEL, timeoutMs = 600000, withoutStandards = false }) {
  const step = loadStep()
  const args = parseClaudeArgs(step.with.claude_args || '')
  const prompt = renderPrompt(step.with.prompt, { repository: 'redpanda-data/redpanda', prNumber: 1 }, { withoutStandards })

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

  // stream-json, so every tool_use the model issued is in the transcript
  // with its arguments. --verbose is what -p needs to emit the stream.
  const cli = [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', model,
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

  const stream = parseStream(r.stdout || '')
  const mustRead = checkMustRead(stream.calls, repoDir)

  // The executors parse model text. Present each recorded comment the way they
  // already read one: its span header, then its body with any suggestion block.
  const output = comments.map((c) => `FILE ${c.path} LINES ${c.startLine || c.line || 0}-${c.line || c.startLine || 0}\n${c.body}`).join('\n\n')
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT')
  return {
    prompt,
    output,
    // The final assistant text, as --output-format text would have printed it.
    transcript: stream.result && typeof stream.result.result === 'string' ? stream.result.result : '',
    stream: r.stdout || '',
    calls: stream.calls,
    mustRead,
    comments,
    files,
    stderr: r.stderr || '',
    status: r.status,
    timedOut,
    ms: Date.now() - started,
    failed: timedOut || r.status !== 0
  }
}

module.exports = {
  runReview,
  loadStep,
  parseClaudeArgs,
  renderPrompt,
  stripStandardsInstructions,
  parseStream,
  checkMustRead,
  PRODUCTION_MODEL,
  FETCHED_STANDARDS,
  MUST_READ,
  COMMENT_TOOL
}
