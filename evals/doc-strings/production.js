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
 * Throw unless a removed span is one unit: a second sentence end, a list item
 * after its first line, or a blank line inside it means the splitter merged
 * two units, and removing it would drop more than the sentence that names a
 * file.
 */
function assertOneUnit (unit) {
  const body = unit.replace(/^\s*\n/, '').trim()
  if (/[.?!]\s+\S/.test(body) || /\n[ \t]*(?:[-*]|\d+\.)\s/.test(body) || /\n[ \t]*\n/.test(body)) {
    throw new Error(`sabotage would remove more than one sentence: ${JSON.stringify(body.slice(0, 120))}`)
  }
}

/**
 * The production prompt with every sentence that names a staged standard
 * removed. This is the must-read sabotage: the files are still in the
 * workspace, the model is simply never told they are there or to apply them,
 * so a harness that still reports "read before suggesting" is not reading
 * the transcript.
 *
 * The prompt is cut into units at a sentence end (., ? or ! before
 * whitespace), at a colon that ends a line, before a bullet or numbered
 * item, where a list item's unindented next line starts, and at a blank line, so removing one unit never takes a list item or
 * the next paragraph with it. A unit is removed when it names a staged file,
 * and so is a unit right after a removed one that opens with a pronoun
 * pointing back at it ("If it is absent or empty, ..."), which would
 * otherwise be left with no referent. References to "the writing standard"
 * elsewhere are reworded to the bar the prompt states inline, so the stripped
 * prompt reads as one that never had the files, not as a broken one.
 *
 * Guards, each a harness error rather than a weaker sabotage: no file name
 * may survive, and every removed unit must be a single sentence that either
 * names a file or is such a pronoun follow-on.
 */
function stripStandardsInstructions (prompt) {
  const names = MUST_READ.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const naming = new RegExp(`(?:^|[^A-Za-z0-9_/-])(?:${names.join('|')})(?![A-Za-z0-9_-])`)
  const units = []
  for (const u of prompt.split(/(?<=[.?!])(?=\s)|(?<=:)(?=\n)|(?=\n[ \t]*(?:[-*]|\d+\.)\s)|(?=\n[ \t]*\n)/)) {
    // A list item ends where an unindented line starts, punctuated or not;
    // its continuation lines are indented.
    if (/^\n?[ \t]*(?:[-*]|\d+\.)\s/.test(u)) units.push(...u.split(/(?<=.)(?=\n\S)/s))
    else units.push(u)
  }
  const backReference = /^\s*(?:If (?:it|they)|It|They|This|These|Its|Their)\b/
  const kept = []
  const removed = []
  let prevRemoved = false
  for (const u of units) {
    const drop = naming.test(u) || (prevRemoved && backReference.test(u))
    if (drop) removed.push(u)
    else kept.push(u)
    prevRemoved = drop
  }
  removed.forEach(assertOneUnit)
  const out = kept.join('')
    .replace(/the(\s+)writing\s+standard's\s+quality\s+bar/g, 'this$1quality bar')
    .replace(/\s+and\s+the\s+standard\s+supports\s+the\s+objection/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  for (const n of MUST_READ) {
    if (out.includes(n)) throw new Error(`sabotage left ${n} in the prompt; the sentence splitter missed one`)
  }
  return out
}

/**
 * Keep the staged standards out of `git status` for the must-read sabotage.
 * Claude Code shows the model the repository's git status when a session
 * starts, so untracked files are listed by name even when the prompt never
 * mentions them; measured on claude-opus-5, a stripped-prompt run then
 * opened both from that listing alone. An info/exclude entry hides them from
 * the listing without moving them: a model that looks (ls, a Read) still
 * finds them.
 */
function hideFromGitStatus (repoDir, names) {
  const info = path.join(repoDir, '.git', 'info')
  if (!fs.existsSync(path.join(repoDir, '.git'))) return
  fs.mkdirSync(info, { recursive: true })
  fs.appendFileSync(path.join(info, 'exclude'), names.map((n) => `/${n}\n`).join(''))
}

/**
 * The production prompt with its Actions expressions filled in, as Actions
 * would for a caller passing these inputs. committableSuggestions mirrors the
 * workflow input of the same name (default true). withoutStandards is the
 * must-read sabotage, see stripStandardsInstructions.
 */
function renderPrompt (prompt, vars, { withoutStandards = false } = {}) {
  const committable = vars.committableSuggestions !== false
  const filled = prompt
    .replace(/\$\{\{\s*github\.repository\s*\}\}/g, vars.repository)
    .replace(/\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/g, String(vars.prNumber))
    // Spacing-tolerant, and '' inside the quoted text is an Actions-escaped
    // apostrophe.
    .replace(/\$\{\{\s*!inputs\.committable_suggestions\s*&&\s*'((?:[^']|'')*)'\s*\|\|\s*''\s*\}\}/g, (_, text) => (committable ? '' : text.replace(/''/g, "'")))
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
 * Every tool call in a stream-json transcript, in order, plus the final result
 * event and the number of JSON events the stream held (zero means the CLI did
 * not emit stream-json at all, which is the harness's problem, not the
 * model's).
 *
 * Each call records `seq`, the position of the event that issued it, and,
 * once its tool_result arrives, `resultSeq`, `error` and `output` (the text
 * the model was shown). A call whose result never arrived (turn limit hit,
 * session cut off) keeps `answered: false`. Calls a subagent made carry
 * `subagent: true`: their results went to the subagent, not to the reviewer.
 */
function parseStream (raw) {
  const calls = []
  const byId = new Map()
  let result = null
  let events = 0
  let seq = 0
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let ev
    try { ev = JSON.parse(t) } catch { continue }
    if (!ev || typeof ev !== 'object') continue
    events++
    seq++
    const subagent = Boolean(ev.parent_tool_use_id)
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block && block.type === 'tool_use' && typeof block.name === 'string') {
          const call = {
            index: calls.length, id: block.id, name: block.name, input: block.input || {},
            seq, subagent, answered: false, resultSeq: null, error: false, output: ''
          }
          calls.push(call)
          if (block.id) byId.set(block.id, call)
        }
      }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block && block.type === 'tool_result' && byId.has(block.tool_use_id)) {
          const call = byId.get(block.tool_use_id)
          call.answered = true
          call.resultSeq = seq
          call.error = Boolean(block.is_error)
          call.output = resultText(block.content)
        }
      }
    } else if (ev.type === 'result') {
      result = ev
    }
  }
  return { calls, result, events }
}

/** The text of a tool_result's content, which is a string or a list of blocks. */
function resultText (content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
  return ''
}

/** A directory with symlinks resolved, so /var and /private/var on macOS compare equal. */
function realDir (dir) {
  try { return fs.realpathSync(dir) } catch { return path.resolve(dir) }
}

/** The lines of a staged file in the workspace, without a trailing empty line, or null. */
function stagedLines (file, cwd) {
  try {
    const lines = fs.readFileSync(path.join(cwd, file), 'utf8').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines
  } catch {
    return null
  }
}

// A line of Read tool output: the line number, a tab (or an arrow in older
// CLI versions), then the line as the file holds it.
const READ_LINE = /^\s*(\d+)(?:\t|→)(.*)$/

/**
 * Which lines of a staged file one tool result showed the model, judged from
 * the output itself rather than from the command or the Read arguments. A
 * Read result is numbered, so each numbered line that matches the file counts,
 * and ranged Reads combine. A Bash result counts only when the whole file is
 * in it, so a cat that was piped into head, captured into a variable,
 * truncated by the tool's output cap, or run in another directory on a
 * different file shows nothing. Returns a Set of 1-based line numbers.
 */
function linesShown (call, file, lines, cwd) {
  const shown = new Set()
  if (!call.answered || !call.output) return shown
  if (call.name === 'Read') {
    if (typeof call.input.file_path !== 'string') return shown
    const abs = path.resolve(cwd, call.input.file_path)
    if (path.basename(abs) !== file || realDir(path.dirname(abs)) !== realDir(cwd)) return shown
    for (const l of call.output.split('\n')) {
      const m = l.match(READ_LINE)
      if (!m) continue
      const n = Number(m[1])
      if (n >= 1 && n <= lines.length && lines[n - 1] === m[2]) shown.add(n)
    }
    return shown
  }
  if (call.name === 'Bash') {
    const whole = lines.join('\n').trimEnd()
    if (whole && call.output.includes(whole)) lines.forEach((_, i) => shown.add(i + 1))
  }
  return shown
}

/** Whether a call names a staged file at all: the evidence for "tried but failed". */
function mentions (call, file) {
  if (call.name === 'Read') return typeof call.input.file_path === 'string' && path.basename(call.input.file_path) === file
  if (call.name === 'Bash') return typeof call.input.command === 'string' && call.input.command.includes(file)
  return false
}

/**
 * The must-read verdict for one run, graded from what each tool result
 * showed the model. Every file in MUST_READ has to have been shown in full
 * (every line, across one or more results), and when the model posted an
 * inline comment, those results have to have arrived before the first
 * comment that the tool accepted: a standard whose text came back after the
 * suggestions were written did not shape them, even if the read was issued
 * in the same turn. A rejected comment posted nothing, so it sets no
 * deadline. Subagent calls do not count: the reviewer saw only the
 * subagent's summary.
 *
 * A file that was not shown in full is reported by what happened: shown only
 * in part, every attempt errored, an attempt never got a result, or never
 * read at all.
 */
function checkMustRead (calls, cwd, files = MUST_READ) {
  const own = calls.filter((c) => !c.subagent)
  const firstCommentCall = own.find((c) => c.name === COMMENT_TOOL && c.answered && !c.error)
  const firstComment = firstCommentCall ? firstCommentCall.index : -1
  const deadline = firstCommentCall ? firstCommentCall.seq : Infinity
  const reads = []
  const perFile = files.map((file) => {
    const lines = stagedLines(file, cwd)
    const total = lines ? lines.length : 0
    const covered = new Set()
    const coveredBefore = new Set()
    const indices = []
    const partial = []
    const errored = []
    const unanswered = []
    for (const c of own) {
      if (!mentions(c, file) && !(c.name === 'Bash' && c.output)) continue
      const shown = lines ? linesShown(c, file, lines, cwd) : new Set()
      const named = mentions(c, file)
      if (shown.size === 0) {
        if (!named) continue
        if (!c.answered) unanswered.push(c.index)
        else if (c.error) errored.push(c.index)
        else partial.push(c.index)
        reads.push({ file, index: c.index, tool: c.name, how: c.name === 'Bash' ? c.input.command : c.input.file_path, lines: 0, of: total, error: c.error, answered: c.answered })
        continue
      }
      for (const n of shown) {
        covered.add(n)
        if (c.resultSeq < deadline) coveredBefore.add(n)
      }
      if (shown.size === total) indices.push(c.index)
      else partial.push(c.index)
      reads.push({ file, index: c.index, tool: c.name, how: c.name === 'Bash' ? c.input.command : c.input.file_path, lines: shown.size, of: total, error: c.error, answered: c.answered })
    }
    const read = total > 0 && covered.size === total
    return {
      file,
      lines: total,
      read,
      read_before_first_comment: total > 0 && coveredBefore.size === total,
      indices,
      partial_indices: partial,
      errored_indices: errored,
      unanswered_indices: unanswered
    }
  })
  const late = perFile.filter((f) => f.read && !f.read_before_first_comment)
  const notRead = perFile.filter((f) => !f.read)
  const pass = notRead.length === 0 && late.length === 0
  let detail
  if (pass) {
    detail = perFile.map((f) => `${f.file} (${f.lines} lines) at call #${(f.indices.length ? f.indices : f.partial_indices).join(',#')}`).join('; ') +
      (firstComment === -1 ? '; no inline comment posted' : `; first inline comment at call #${firstComment}`)
  } else {
    const parts = []
    const byKind = (pred) => notRead.filter(pred)
    const missing = byKind((f) => !f.partial_indices.length && !f.errored_indices.length && !f.unanswered_indices.length)
    const partial = byKind((f) => f.partial_indices.length)
    const errored = byKind((f) => !f.partial_indices.length && f.errored_indices.length)
    const unanswered = byKind((f) => !f.partial_indices.length && !f.errored_indices.length && f.unanswered_indices.length)
    if (missing.length) parts.push(`never read: ${missing.map((f) => f.file).join(', ')}`)
    if (partial.length) {
      parts.push(`read only in part: ${partial.map((f) => {
        const r = reads.filter((x) => x.file === f.file)
        const best = Math.max(...r.map((x) => x.lines))
        const first = r.find((x) => f.partial_indices.includes(x.index))
        return `${f.file} (${best} of ${f.lines} lines shown; #${first.index} ${first.tool}: ${String(first.how).slice(0, 80)})`
      }).join(', ')}`)
    }
    if (errored.length) parts.push(`every read errored: ${errored.map((f) => `${f.file} (#${f.errored_indices.join(',#')})`).join(', ')}`)
    if (unanswered.length) parts.push(`read never got a result: ${unanswered.map((f) => `${f.file} (#${f.unanswered_indices.join(',#')})`).join(', ')}`)
    if (late.length) parts.push(`read only after the first inline comment (call #${firstComment}): ${late.map((f) => f.file).join(', ')}`)
    parts.push(`tool calls: [${own.map((c) => c.name).join(', ') || 'none'}]`)
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
/**
 * The comments as the executors read them. With committable suggestions off
 * the review writes the rewrite in a ```text block; it is handed on under the
 * ```suggestion tag the executors parse.
 */
function normalizeComments (comments, committableSuggestions = true) {
  if (committableSuggestions) return comments
  return comments.map((c) => ({ ...c, body: c.body.replace(/```text\b/g, '```suggestion') }))
}

function runReview ({ repoDir, lint, diff, model = PRODUCTION_MODEL, committableSuggestions = true, timeoutMs = 600000, withoutStandards = false }) {
  const step = loadStep()
  const args = parseClaudeArgs(step.with.claude_args || '')
  // A repository that doesn't exist, so a model that looks the PR up with
  // `gh pr view` gets an error rather than a real, unrelated PR.
  const prompt = renderPrompt(step.with.prompt, { repository: 'example-org/doc-strings-eval-fixture', prNumber: 1, committableSuggestions }, { withoutStandards })

  fs.writeFileSync(path.join(repoDir, 'lint-findings.json'), JSON.stringify(lint, null, 2))
  if (diff != null) {
    fs.writeFileSync(path.join(repoDir, 'pr-diff.patch'),
      '# Source diff of this PR against its merge base.\n# Left out (generated docs, lockfiles, vendored code, test data): 0 file(s).\n\n' + diff)
  }
  for (const [name, text] of Object.entries(fetchStandards())) fs.writeFileSync(path.join(repoDir, name), text)
  if (withoutStandards) hideFromGitStatus(repoDir, MUST_READ)

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

  const stream = parseStream(r.stdout || '')
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT')
  // A CLI that exits 0 with no stream-json events ignored --output-format: the
  // must-read check would see no tool calls and blame the model for a review
  // it cannot see. That is the harness's failure.
  if (!timedOut && r.status === 0 && stream.events === 0) {
    throw new Error('the claude CLI exited 0 but printed no stream-json events; check that it supports --output-format stream-json --verbose')
  }
  const mustRead = checkMustRead(stream.calls, repoDir)

  // The executors parse model text. Present each recorded comment the way they
  // already read one: its span header, then its body with any suggestion block.
  // With committable suggestions off, the rewrite arrives in a ```text block;
  // count both forms so the run can assert which one the review used, then
  // hand the executors the rewrite under the tag they parse.
  const blockCounts = { suggestion: 0, text: 0 }
  for (const c of comments) {
    blockCounts.suggestion += (c.body.match(/```suggestion\b/g) || []).length
    blockCounts.text += (c.body.match(/```text\b/g) || []).length
  }
  // Both the output text and the comments get the same rewrite: the
  // executors check placement and footers on the comments, and with the raw
  // ```text bodies every off-mode case would fail on a correct review.
  const checked = normalizeComments(comments, committableSuggestions)
  const output = checked.map((c) =>
    `FILE ${c.path} LINES ${c.startLine || c.line || 0}-${c.line || c.startLine || 0}\n${c.body}`
  ).join('\n\n')
  return {
    prompt,
    output,
    // The final assistant text, as --output-format text would have printed it.
    transcript: stream.result && typeof stream.result.result === 'string' ? stream.result.result : '',
    stream: r.stdout || '',
    calls: stream.calls,
    mustRead,
    comments: checked,
    rawComments: comments,
    blockCounts,
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
  normalizeComments,
  stripStandardsInstructions,
  assertOneUnit,
  parseStream,
  linesShown,
  checkMustRead,
  PRODUCTION_MODEL,
  FETCHED_STANDARDS,
  MUST_READ,
  COMMENT_TOOL
}
