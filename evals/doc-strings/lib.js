'use strict'

/**
 * Shared machinery for the doc-strings eval harness.
 *
 * Everything here is deterministic: fixture materialization, real doc-tools
 * invocations, model-output parsing, and the mechanical checks that turn an
 * executed model output into a verdict. No assertion in this file ever
 * inspects model prose - verdicts come from re-running the linter, the
 * extractor, and the overrides audit against the APPLIED output.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '../..')
const DOC_TOOLS = path.join(REPO_ROOT, 'bin', 'doc-tools.js')
const LINT_FIXTURES = path.join(REPO_ROOT, 'tools', 'lint-strings', 'fixtures')
const EVAL_FIXTURES = path.join(__dirname, 'fixtures')

const propertiesSurface = require(path.join(REPO_ROOT, 'tools/lint-strings/surfaces/properties'))
const metricsSurface = require(path.join(REPO_ROOT, 'tools/lint-strings/surfaces/metrics'))
const rpkSurface = require(path.join(REPO_ROOT, 'tools/lint-strings/surfaces/rpk'))
const { deepEqual, normalizeText, detectDocsMarkup } = require(path.join(REPO_ROOT, 'tools/overrides-audit/classify.js'))

const SURFACE_MODULES = { properties: propertiesSurface, metrics: metricsSurface, rpk: rpkSurface }

/** Repo-relative target file per surface, shaped like the real repos. */
const SURFACE_LAYOUT = {
  properties: {
    files: [
      { from: path.join(LINT_FIXTURES, 'properties', 'lint_fixture.cc'), to: 'src/v/config/configuration.cc' },
      { from: path.join(LINT_FIXTURES, 'properties', 'lint_fixture.h'), to: 'src/v/config/configuration.h' }
    ],
    target: 'src/v/config/configuration.cc'
  },
  metrics: {
    files: [{ from: path.join(LINT_FIXTURES, 'metrics', 'lint_probe.cc'), to: 'src/v/cluster/lint_probe.cc' }],
    target: 'src/v/cluster/lint_probe.cc'
  },
  'metrics-conforming': {
    files: [{ from: path.join(EVAL_FIXTURES, 'conforming_probe.cc'), to: 'src/v/cluster/eval_probe.cc' }],
    target: 'src/v/cluster/eval_probe.cc',
    surface: 'metrics'
  },
  rpk: {
    files: [{ from: path.join(LINT_FIXTURES, 'rpk', 'lint_cmd.go'), to: 'src/go/rpk/pkg/cli/cluster/lint_cmd.go' }],
    target: 'src/go/rpk/pkg/cli/cluster/lint_cmd.go'
  }
}

// ---------------------------------------------------------------------------
// Fixture materialization
// ---------------------------------------------------------------------------

/**
 * Materialize a fixture mini-repo in a temp dir.
 *
 * @param {string} layoutName - Key into SURFACE_LAYOUT.
 * @param {Array} [edits] - [{ find, replace }] applied to the target file.
 *   `find` must occur exactly once or materialization throws (a stale edit
 *   must never silently produce a different case than intended).
 * @returns {{ dir, surface, targetRel, targetAbs }}
 */
function materializeRepo (layoutName, edits = []) {
  const layout = SURFACE_LAYOUT[layoutName]
  if (!layout) throw new Error(`Unknown layout: ${layoutName}`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `doc-strings-eval-${layoutName}-`))
  for (const file of layout.files) {
    const dest = path.join(dir, file.to)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(file.from, dest)
  }
  const targetAbs = path.join(dir, layout.target)
  applyEdits(targetAbs, edits)
  return { dir, surface: layout.surface || layoutName, targetRel: layout.target, targetAbs }
}

/** Apply find/replace edits; every `find` must match exactly once. */
function applyEdits (fileAbs, edits) {
  if (!edits || edits.length === 0) return
  let text = fs.readFileSync(fileAbs, 'utf8')
  for (const edit of edits) {
    const first = text.indexOf(edit.find)
    if (first === -1) throw new Error(`Fixture edit not found in ${fileAbs}: ${JSON.stringify(edit.find.slice(0, 80))}`)
    if (text.indexOf(edit.find, first + 1) !== -1) throw new Error(`Fixture edit is ambiguous in ${fileAbs}: ${JSON.stringify(edit.find.slice(0, 80))}`)
    text = text.slice(0, first) + edit.replace + text.slice(first + edit.find.length)
  }
  fs.writeFileSync(fileAbs, text)
}

/** git init + initial commit (for diff-mode cases). */
function gitInit (dir) {
  run('git', ['init', '-q'], dir)
  run('git', ['config', 'user.email', 'eval@localhost'], dir)
  run('git', ['config', 'user.name', 'doc-strings-eval'], dir)
  run('git', ['add', '-A'], dir)
  run('git', ['commit', '-q', '-m', 'base'], dir)
  return run('git', ['rev-parse', 'HEAD'], dir).stdout.trim()
}

function gitCommitAll (dir, message) {
  run('git', ['add', '-A'], dir)
  run('git', ['commit', '-q', '-m', message], dir)
}

function gitDiff (dir, base) {
  return run('git', ['diff', `${base}...HEAD`], dir).stdout
}

function run (cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  return result
}

// ---------------------------------------------------------------------------
// Real doc-tools invocations (the system under test's deterministic side)
// ---------------------------------------------------------------------------

/** Run doc-tools lint-strings --format json and parse the result. */
function runLint (repoDir, surface, extraArgs = []) {
  const args = [DOC_TOOLS, 'lint-strings', '--repo', repoDir, '--surface', surface, '--format', 'json', ...extraArgs]
  const result = spawnSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`lint-strings failed (${result.status}):\n${result.stderr}`)
  return JSON.parse(result.stdout)
}

/** Run doc-tools overrides audit against a repo and parse the manifest. */
function runAudit (overridesPath, repoDir) {
  const args = [DOC_TOOLS, 'overrides', 'audit', '--overrides', overridesPath, '--repo', repoDir, '--format', 'json']
  const result = spawnSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`overrides audit failed (${result.status}):\n${result.stderr}`)
  return JSON.parse(result.stdout)
}

/** Re-extract declarations for a surface (semantic before/after comparison). */
function extractDeclarations (repoDir, surface) {
  if (surface === 'properties') {
    const json = propertiesSurface.runExtractor(repoDir, () => {})
    return json.properties || {}
  }
  return SURFACE_MODULES[surface].extract({ repo: repoDir, log: () => {} })
}

// ---------------------------------------------------------------------------
// Model CLI driver
// ---------------------------------------------------------------------------

/** True when the claude CLI is on PATH. */
function claudeAvailable () {
  const result = spawnSync('claude', ['--version'], { encoding: 'utf8' })
  return !result.error && result.status === 0
}

/**
 * Run the claude CLI headless with the prompt on stdin. The model gets no
 * tools: every case is self-contained in the prompt, and the harness - not
 * the model - applies and verifies the output.
 *
 * @returns {{ output, stderr, status, timedOut, ms }}
 */
function runClaude (prompt, { cwd, model = 'sonnet', timeoutMs = 300000 } = {}) {
  const started = Date.now()
  const result = spawnSync('claude', [
    '-p',
    '--output-format', 'text',
    '--model', model,
    '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite'
  ], {
    cwd,
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024
  })
  return {
    output: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    ms: Date.now() - started
  }
}

// ---------------------------------------------------------------------------
// Model-output parsing (structural, never semantic)
// ---------------------------------------------------------------------------

/** All fenced blocks with the given info tag (for example, "suggestion"). */
function parseFences (output, tag) {
  const blocks = []
  const pattern = new RegExp('```' + tag + '[ \\t]*\\n([\\s\\S]*?)\\n?```', 'g')
  let match
  while ((match = pattern.exec(output)) !== null) blocks.push(match[1])
  return blocks
}

/** All fenced ```json blocks, parsed; unparseable blocks are kept as errors. */
function parseJsonFences (output) {
  const parsed = []
  for (const block of parseFences(output, 'json')) {
    try {
      parsed.push({ ok: true, value: JSON.parse(block) })
    } catch (err) {
      parsed.push({ ok: false, error: err.message, raw: block })
    }
  }
  return parsed
}

/** Parse the `LINES <start>-<end>` header used by upstream-port cases. */
function parseLinesHeader (output) {
  const match = /^LINES\s+(\d+)\s*-\s*(\d+)\s*$/m.exec(output)
  if (!match) return null
  return { start: parseInt(match[1], 10), end: parseInt(match[2], 10) }
}

// ---------------------------------------------------------------------------
// Mechanical checks
// ---------------------------------------------------------------------------

/** Replace 1-indexed inclusive lines [start, end] of a file's text. */
function replaceSpan (text, start, end, replacementText) {
  const lines = text.split('\n')
  if (start < 1 || end > lines.length || start > end) {
    throw new Error(`Span ${start}-${end} out of range (file has ${lines.length} lines)`)
  }
  const replacementLines = replacementText.replace(/\n$/, '').split('\n')
  const next = lines.slice(0, start - 1).concat(replacementLines, lines.slice(end))
  return { text: next.join('\n'), replacementLines }
}

/**
 * Blank the contents of every double-quoted string literal (escape-aware),
 * merge adjacent literals (C/C++ concatenation), and neutralize whitespace
 * (word-word spaces survive as one space; spaces next to punctuation are
 * dropped, so clang-format re-wrapping is invisible). Two spans that differ
 * ONLY in string-literal contents and literal re-wrapping normalize to the
 * same text - so comparing normalized forms proves the model changed no
 * token outside the doc string.
 */
function normalizeNonLiteral (text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      out += '""'
      i++
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === '"') { i++; break }
        i++
      }
      continue
    }
    out += ch
    i++
  }
  let prev
  do {
    prev = out
    out = out.replace(/""\s*""/g, '""')
  } while (out !== prev)
  return out
    .replace(/\s+/g, ' ')
    .replace(/ ?([^A-Za-z0-9_ ]) ?/g, '$1')
    .trim()
}

/** Lines longer than the limit (returns offending [lineNumber, length]). */
function overlongLines (text, limit) {
  const bad = []
  text.replace(/\n$/, '').split('\n').forEach((line, idx) => {
    if (line.length > limit) bad.push([idx + 1, line.length])
  })
  return bad
}

/** Findings for one declaration name, as a flat list of {id, severity}. */
function findingsFor (lintResult, name) {
  const rules = []
  for (const finding of lintResult.findings) {
    if (finding.name === name) rules.push(...finding.rules.map((r) => ({ id: r.id, severity: r.severity })))
  }
  return rules
}

/**
 * Findings grouped per declaration name EXCLUDING the target, as a sorted
 * multiset fingerprint - line-number independent, so it is stable across
 * span-length changes. Used to prove untouched declarations kept exactly
 * their findings.
 */
function findingFingerprint (lintResult, excludeName) {
  const groups = []
  for (const finding of lintResult.findings) {
    if (finding.name === excludeName) continue
    groups.push(`${finding.surface}:${finding.name}:${finding.rules.map((r) => r.id).sort().join(',')}`)
  }
  return groups.sort()
}

const LINE_FIELDS = ['line_start', 'line_end']

/** Deep-copy an object minus the given keys. */
function omit (obj, keys) {
  const copy = JSON.parse(JSON.stringify(obj))
  for (const key of keys) delete copy[key]
  return copy
}

/**
 * Compare extracted properties before/after an edit.
 * Every non-target property must be unchanged (modulo line spans); the
 * target must be unchanged in every field EXCEPT description (modulo spans).
 */
function comparePropertyExtraction (before, after, targetName) {
  const problems = []
  const beforeNames = Object.keys(before).sort()
  const afterNames = Object.keys(after).sort()
  if (!deepEqual(beforeNames, afterNames)) {
    problems.push(`Property set changed: before=[${beforeNames}] after=[${afterNames}]`)
    return problems
  }
  for (const name of beforeNames) {
    if (name === targetName) {
      const a = omit(before[name], [...LINE_FIELDS, 'description'])
      const b = omit(after[name], [...LINE_FIELDS, 'description'])
      if (!deepEqual(a, b)) problems.push(`Target ${name}: a non-description field changed: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
    } else if (!deepEqual(omit(before[name], LINE_FIELDS), omit(after[name], LINE_FIELDS))) {
      problems.push(`Untouched property ${name} changed`)
    }
  }
  return problems
}

/**
 * Compare extracted metric/rpk declarations before/after. Declarations are
 * keyed by name + meta.kind; the target key may change its string, all
 * others must keep theirs byte-identical.
 */
function compareDeclExtraction (before, after, targetKey) {
  const problems = []
  const key = (d) => `${d.name}::${(d.meta && d.meta.kind) || ''}`
  const mapOf = (decls) => {
    const map = new Map()
    for (const d of decls) map.set(key(d), (map.get(key(d)) || []).concat([d.string]))
    return map
  }
  const beforeMap = mapOf(before)
  const afterMap = mapOf(after)
  if (beforeMap.size !== afterMap.size || [...beforeMap.keys()].some((k) => !afterMap.has(k))) {
    problems.push(`Declaration set changed: [${[...beforeMap.keys()]}] -> [${[...afterMap.keys()]}]`)
    return problems
  }
  for (const [k, strings] of beforeMap) {
    if (k === targetKey) continue
    if (!deepEqual(strings, afterMap.get(k))) problems.push(`Untouched declaration ${k} changed its string`)
  }
  return problems
}

module.exports = {
  REPO_ROOT,
  DOC_TOOLS,
  EVAL_FIXTURES,
  materializeRepo,
  applyEdits,
  gitInit,
  gitCommitAll,
  gitDiff,
  runLint,
  runAudit,
  extractDeclarations,
  claudeAvailable,
  runClaude,
  parseFences,
  parseJsonFences,
  parseLinesHeader,
  replaceSpan,
  normalizeNonLiteral,
  overlongLines,
  findingsFor,
  findingFingerprint,
  comparePropertyExtraction,
  compareDeclExtraction,
  normalizeText,
  detectDocsMarkup,
  deepEqual
}
