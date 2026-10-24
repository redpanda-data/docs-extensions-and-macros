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

// Shell programs that print some or all of a file. Only a `cat` whose output
// reaches the model prints the whole file; the others print the lines they
// select. A command that only names the file (ls, echo, wc, stat, test) has
// not opened it at all.
const SHELL_READERS = new Set(['cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'less', 'more', 'nl'])

// The Read tool returns this many lines when the call sets no limit.
const READ_DEFAULT_LINES = 2000

/**
 * A shell command split into simple commands (at |, ||, &&, ;, &, parentheses
 * and newlines), each a list of words with quotes removed. Operators inside
 * quotes stay in the word, so `grep "a|b" terminology.md` is one command.
 * Redirection operators end a word, so `< terminology.md` yields the name.
 * Each segment records whether its output goes somewhere other than the
 * model: `piped` when a single | ends it, `redirected` when it has a >.
 */
function shellSegments (command) {
  const segments = []
  let words = []
  let word = ''
  let quote = null
  let inWord = false
  let redirected = false
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false }
  const endSegment = (piped = false) => {
    endWord()
    if (words.length) segments.push({ words, piped, redirected })
    words = []
    redirected = false
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      inWord = true
    } else if (ch === '\\' && i + 1 < command.length) {
      word += command[++i]
      inWord = true
    } else if (ch === '|') {
      // `||` is a list operator; a lone `|` (or `|&`) pipes this command's output.
      if (command[i + 1] === '|') { endSegment(); i++ } else endSegment(true)
    } else if (ch === '&' && command[i + 1] === '>') {
      // `&>` sends stdout and stderr to a file.
      endWord()
      redirected = true
      i++
    } else if (';&()\n'.includes(ch)) {
      endSegment()
    } else if (ch === '>') {
      // `2>file` and `2>&1` move stderr only; stdout still reaches the model.
      // Any other > (`>`, `>>`, `1>`, `>&2`) takes stdout away from it.
      if (!(inWord && word === '2')) redirected = true
      if (inWord && /^\d$/.test(word)) { word = ''; inWord = false }
      endWord()
      if (command[i + 1] === '&' && /\d/.test(command[i + 2] || '')) i += 2
    } else if (/\s/.test(ch) || ch === '<') {
      endWord()
    } else {
      word += ch
      inWord = true
    }
  }
  endSegment()
  return segments
}

/** The staged file a path-like shell token or Read path refers to, if any. */
function stagedFile (token, cwd) {
  if (!token.includes('/')) return MUST_READ.includes(token) ? token : null
  const abs = path.resolve(cwd, token)
  return MUST_READ.includes(path.basename(abs)) && realDir(path.dirname(abs)) === realDir(cwd) ? path.basename(abs) : null
}

/** Line count of a staged file in the workspace, or null when it cannot be read. */
function stagedLines (file, cwd) {
  try {
    const text = fs.readFileSync(path.join(cwd, file), 'utf8')
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  } catch {
    return null
  }
}

/**
 * Whether a Read call returned the whole file. With no offset and no limit,
 * Read returns the first READ_DEFAULT_LINES lines, which is the whole of a
 * file no longer than that (a file that cannot be measured is taken to be).
 * A limit, or an offset past the first line, covers the whole file only when
 * it starts at line 1 and the limit reaches the file's last line.
 */
function readIsWhole (input, lines) {
  const offset = Number(input.offset) || 0
  if (offset > 1) return false
  if (input.limit == null) return lines == null || lines <= READ_DEFAULT_LINES
  return lines != null && Number(input.limit) >= lines
}

/**
 * Every staged file a tool call opened, in the order it named them, each with
 * whether the call returned the whole file (`full`) or only part of it.
 */
function readTargets (call, cwd) {
  if (call.name === 'Read' && typeof call.input.file_path === 'string') {
    const abs = path.resolve(cwd, call.input.file_path)
    if (realDir(path.dirname(abs)) !== realDir(cwd) || !MUST_READ.includes(path.basename(abs))) return []
    const file = path.basename(abs)
    return [{ file, full: readIsWhole(call.input, stagedLines(file, cwd)) }]
  }
  if (call.name === 'Bash' && typeof call.input.command === 'string') {
    // A file is opened when a segment of the command runs one of
    // SHELL_READERS and names it, one file per name. It was read in full only
    // when that program is `cat` (which the step's allowed tools list) and
    // its output is neither piped nor redirected: `cat a.md b.md` reads both
    // whole, `grep`, `head`, `sed` or `cat a.md | head` read part of it. A
    // path-qualified name has to resolve to the workspace; a bare name is
    // relative to it.
    const found = []
    for (const { words, piped, redirected } of shellSegments(call.input.command)) {
      // Skip leading VAR=value assignments to find the program.
      let i = 0
      while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++
      if (i >= words.length || !SHELL_READERS.has(path.basename(words[i]))) continue
      const full = path.basename(words[i]) === 'cat' && !piped && !redirected
      for (const token of words.slice(i + 1)) {
        if (token.startsWith('-')) continue
        const file = stagedFile(token, cwd)
        if (!file) continue
        const prev = found.find((f) => f.file === file)
        if (!prev) found.push({ file, full })
        else if (full) prev.full = true
      }
    }
    return found
  }
  return []
}

/**
 * The must-read verdict for one run. Every file in MUST_READ has to have been
 * read in full, by a Read that returned the whole file or a `cat` of it whose
 * output reached the model, by a call that did not error; and when the model
 * posted any inline comment, such a read has to come before the first
 * comment: a standard consulted after the suggestions were posted did not
 * shape them. A grep, head, sed or ranged Read opened the file but showed the
 * model only part of it, so it is recorded and does not count.
 */
function checkMustRead (calls, cwd, files = MUST_READ) {
  const firstComment = calls.findIndex((c) => c.name === COMMENT_TOOL)
  const reads = calls
    .flatMap((c) => readTargets(c, cwd).map((t) => ({ call: c, file: t.file, full: t.full })))
    .filter((r) => files.includes(r.file))
    .map((r) => ({
      file: r.file,
      index: r.call.index,
      tool: r.call.name,
      how: r.call.name === 'Bash' ? r.call.input.command : r.call.input.file_path,
      full: r.full,
      error: r.call.error
    }))
  const perFile = files.map((file) => {
    const opened = reads.filter((r) => r.file === file && !r.error)
    const ok = opened.filter((r) => r.full)
    const before = firstComment === -1 ? ok : ok.filter((r) => r.index < firstComment)
    return {
      file,
      read: ok.length > 0,
      read_before_first_comment: before.length > 0,
      indices: ok.map((r) => r.index),
      partial_indices: opened.filter((r) => !r.full).map((r) => r.index)
    }
  })
  const partial = perFile.filter((f) => !f.read && f.partial_indices.length > 0).map((f) => f.file)
  const missing = perFile.filter((f) => !f.read && f.partial_indices.length === 0).map((f) => f.file)
  const late = perFile.filter((f) => f.read && !f.read_before_first_comment).map((f) => f.file)
  const pass = missing.length === 0 && partial.length === 0 && late.length === 0
  let detail
  if (pass) {
    detail = perFile.map((f) => `${f.file} at call #${f.indices.join(',#')}`).join('; ') +
      (firstComment === -1 ? '; no inline comment posted' : `; first inline comment at call #${firstComment}`)
  } else {
    const parts = []
    if (missing.length) parts.push(`never read: ${missing.join(', ')}`)
    if (partial.length) {
      parts.push(`read only in part (grep, head, sed or a ranged Read): ${partial.map((f) => {
        const r = reads.find((x) => x.file === f && !x.error && !x.full)
        return `${f} (#${r.index} ${r.tool}: ${String(r.how).slice(0, 80)})`
      }).join(', ')}`)
    }
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
  // A repository that doesn't exist, so a model that looks the PR up with
  // `gh pr view` gets an error rather than a real, unrelated PR.
  const prompt = renderPrompt(step.with.prompt, { repository: 'example-org/doc-strings-eval-fixture', prNumber: 1 }, { withoutStandards })

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
