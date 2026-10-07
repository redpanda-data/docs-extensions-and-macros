'use strict'

/**
 * Doc-impact eval driver, reached through `run-evals.js --doc-impact`.
 *
 * Runs the PUBLISHED-CONTENT IMPACT pass of doc-strings-review.yml headless
 * against frozen PR inputs (pr-diff.patch, lint-findings.json, PR title and
 * description), with the redpanda-docs MCP server replayed from recordings,
 * and scores whether the run left a doc-impact.json the production dispatch
 * gate accepts. See the "Doc-impact assessment" section of ../README.adoc.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const evalLib = require('../lib')
const lib = require('./lib')

const HERE = __dirname
const DEFAULT_ITEMS = path.join(HERE, 'items.json')
const CONTROLS = path.join(HERE, 'controls.json')
// An item set keeps its frozen inputs and recordings beside it, so a set
// from a private repository can live in a private location and still run
// from this checkout with --items.
const dataDirs = (itemsFile) => ({ fixtures: path.join(path.dirname(itemsFile), 'fixtures'), recordings: path.join(path.dirname(itemsFile), 'recordings') })
let FIXTURES = path.join(HERE, 'fixtures')
let RECORDINGS = path.join(HERE, 'recordings')
/** Read frozen inputs and recordings from beside `itemsFile`. */
function useItemsFile (itemsFile) {
  ({ fixtures: FIXTURES, recordings: RECORDINGS } = dataDirs(itemsFile))
}
const TOOLS_SNAPSHOT = path.join(HERE, 'mcp-tools.json')
const REPLAY_SERVER = path.join(HERE, 'replay-server.js')
const RESULTS = path.join(HERE, '..', 'results')

const USAGE = `Usage: node evals/doc-strings/run-evals.js --doc-impact [options]
  --items <file>          item file (default evals/doc-strings/doc-impact/items.json);
                          its fixtures/ and recordings/ are read beside it
  --controls              run the positive and negative controls instead of items
  --case <id>[,<id>]      run only these items
  --mcp replay|record|live
                          replay (default): serve recorded docs responses
                          record: call the live server and save recordings
                          live: call the live server, save nothing
  --merge                 with --mcp record: add the new calls to the item's
                          existing recording instead of replacing it
  --mcp-config <json|file>
                          MCP config for record/live (default: the workflow's)
  --include-unconfirmed   also run and score weak, unconfirmed items
  --model <model>         default sonnet, the workflow's non-gateway model
  --workflow <file>       read the prompt, tools and dispatch gate from this
                          copy of doc-strings-review.yml instead of this
                          checkout's (for example, the base branch's copy)
  --json                  print the scored summary as JSON on stdout
  --keep-temp             keep each item's working directory
  --refresh-diffs         freeze pr-diff.patch and lint-findings.json for
                          each item via gh and git (network), then exit`

function parseArgs (argv) {
  const o = { items: DEFAULT_ITEMS, controls: false, cases: null, mcp: 'replay', mcpConfig: null, merge: false, includeUnconfirmed: false, model: 'sonnet', workflow: null, json: false, keepTemp: false, refresh: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--items') o.items = path.resolve(argv[++i])
    else if (a === '--controls') o.controls = true
    else if (a === '--case') o.cases = (o.cases || []).concat(argv[++i].split(','))
    else if (a === '--mcp') o.mcp = argv[++i]
    else if (a === '--mcp-config') o.mcpConfig = argv[++i]
    else if (a === '--merge') o.merge = true
    else if (a === '--include-unconfirmed') o.includeUnconfirmed = true
    else if (a === '--model') o.model = argv[++i]
    else if (a === '--workflow') o.workflow = path.resolve(argv[++i])
    else if (a === '--json') o.json = true
    else if (a === '--keep-temp') o.keepTemp = true
    else if (a === '--refresh-diffs') o.refresh = true
    else {
      console.error(`Unknown argument: ${a}\n${USAGE}`)
      process.exit(2)
    }
  }
  if (!['replay', 'record', 'live'].includes(o.mcp)) {
    console.error(`--mcp must be replay, record or live\n${USAGE}`)
    process.exit(2)
  }
  if (o.merge && o.mcp !== 'record') {
    console.error(`--merge needs --mcp record\n${USAGE}`)
    process.exit(2)
  }
  return o
}

function sh (cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}:\n${(r.stderr || r.stdout || '').slice(0, 2000)}`)
  return r.stdout
}

// ---------------------------------------------------------------------------
// Inputs: frozen fixtures for real items, materialized repos for controls
// ---------------------------------------------------------------------------

function diffHeader (leftOut) {
  return '# Source diff of this PR against its merge base.\n' +
    `# Left out (generated docs, lockfiles, vendored code, test data): ${leftOut} file(s).\n\n`
}

function capDiff (text, byteLimit) {
  if (!byteLimit || Buffer.byteLength(text) <= byteLimit) return text
  return Buffer.from(text).subarray(0, byteLimit).toString('utf8') +
    `\n# Diff truncated at ${byteLimit} bytes. Read the changed files directly for the rest.\n`
}

/**
 * A control's inputs come from the real tools, like every other eval case:
 * materialize the fixture mini-repo, commit base, apply the head edits,
 * then run lint-strings --diff and git diff exactly as the workflow does.
 */
function materializeControl (item) {
  const fx = item.fixture
  const repo = evalLib.materializeRepo(fx.layout)
  try {
    const applyAll = (edits) => {
      const byFile = new Map()
      for (const e of edits || []) {
        if (!byFile.has(e.file)) byFile.set(e.file, [])
        byFile.get(e.file).push(e)
      }
      for (const [file, list] of byFile) evalLib.applyEdits(path.join(repo.dir, file), list)
    }
    applyAll(fx.base_edits)
    const base = evalLib.gitInit(repo.dir)
    let head = fx.head_edits || []
    if (fx.head_edits_from_case) {
      const { CASES } = require('../cases')
      const source = CASES.find((c) => c.id === fx.head_edits_from_case)
      if (!source || !Array.isArray(source.diffEdits)) throw new Error(`head_edits_from_case: no case ${fx.head_edits_from_case} with diffEdits`)
      head = source.diffEdits.map((e) => ({ file: repo.targetRel, ...e }))
    }
    if (!head.length) throw new Error(`${item.id}: the fixture has no head edits, so the diff would be empty`)
    applyAll(head)
    evalLib.gitCommitAll(repo.dir, item.title)
    const findings = evalLib.runLint(repo.dir, repo.surface, ['--diff', base])
    const diff = diffHeader(0) + evalLib.gitDiff(repo.dir, base)
    return { diff, findings: JSON.stringify(findings, null, 2) + '\n' }
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true })
  }
}

function frozenInputs (item) {
  const dir = path.join(FIXTURES, item.id)
  const diffFile = path.join(dir, 'pr-diff.patch')
  const findingsFile = path.join(dir, 'lint-findings.json')
  if (!fs.existsSync(diffFile) || !fs.existsSync(findingsFile)) {
    throw new Error(`no frozen inputs in ${path.relative(process.cwd(), dir)}; run --refresh-diffs --case ${item.id}`)
  }
  return { diff: fs.readFileSync(diffFile, 'utf8'), findings: fs.readFileSync(findingsFile, 'utf8') }
}

/**
 * Freeze an item's inputs the way the workflow builds them: a partial clone
 * at head_sha, lint-strings --diff base_sha from this checkout's doc-tools,
 * and the merge-base source diff with the workflow's own excludes and cap.
 */
function refreshItem (item, wf, cloneRoot) {
  const slug = item.repo.replace('/', '__')
  const dir = path.join(cloneRoot, slug)
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(cloneRoot, { recursive: true })
    sh('gh', ['repo', 'clone', item.repo, dir, '--', '--filter=blob:none', '--no-checkout', '--quiet'])
  }
  sh('git', ['-C', dir, 'fetch', '--quiet', '--filter=blob:none', 'origin', item.base_sha, item.head_sha])
  sh('git', ['-C', dir, 'checkout', '--quiet', '--force', '--detach', item.head_sha])

  const { excludes, byteLimit } = lib.extractDiffExcludes(wf.diffScript)
  const range = `${item.base_sha}...${item.head_sha}`
  const all = sh('git', ['-C', dir, 'diff', '--name-only', range]).split('\n').filter(Boolean)
  const kept = new Set(sh('git', ['-C', dir, 'diff', '--name-only', range, '--', '.', ...excludes]).split('\n').filter(Boolean))
  const leftOut = all.filter((f) => !kept.has(f)).length
  const body = sh('git', ['-C', dir, 'diff', '--no-color', '--no-ext-diff', range, '--', '.', ...excludes])
  const diff = capDiff(diffHeader(leftOut) + body, byteLimit)

  // The caller workflow in the engineering repo picks the surfaces it lints,
  // so read them from its own copy at head_sha, as the run did.
  const surfaces = callerSurfaces(dir)
  const lintArgs = [evalLib.DOC_TOOLS, 'lint-strings', '--repo', dir, '--diff', item.base_sha, '--format', 'json']
  if (surfaces) lintArgs.push('--surface', surfaces)
  const lint = spawnSync('node', lintArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (lint.error) throw lint.error
  if (lint.status !== 0 || !lint.stdout.trim()) throw new Error(`lint-strings exited ${lint.status}: ${(lint.stderr || '').slice(0, 2000)}`)
  const findings = JSON.parse(lint.stdout)

  const out = path.join(FIXTURES, item.id)
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'pr-diff.patch'), diff)
  fs.writeFileSync(path.join(out, 'lint-findings.json'), JSON.stringify(findings, null, 2) + '\n')
  const decls = (findings.summary && findings.summary.totalDeclarations) || 0
  const removals = (findings.summary && findings.summary.removedSurfaceLines) || 0
  return { bytes: Buffer.byteLength(diff), leftOut, decls, removals, surfaces }
}

const CALLER = '.github/workflows/doc-strings-review.yml'

/** The `surfaces:` input in a doc-strings-review caller workflow, or null. */
function parseSurfaces (text) {
  const m = String(text || '').match(/^\s+surfaces:\s*['"]?([a-z0-9,_-]+)['"]?\s*$/m)
  return m ? m[1] : null
}

/**
 * The surfaces the repo's own caller lints: its copy at head_sha, or, for a
 * PR older than the caller, the default branch's copy (what the review
 * would lint if the PR were opened today). null lints every surface.
 */
function callerSurfaces (dir) {
  const file = path.join(dir, CALLER)
  if (fs.existsSync(file)) return parseSurfaces(fs.readFileSync(file, 'utf8'))
  const r = spawnSync('git', ['-C', dir, 'show', `refs/remotes/origin/HEAD:${CALLER}`], { encoding: 'utf8' })
  return r.status === 0 ? parseSurfaces(r.stdout) : null
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

function liveMcpConfig (options, settings) {
  if (!options.mcpConfig) return settings.mcpConfig
  const raw = fs.existsSync(options.mcpConfig) ? fs.readFileSync(options.mcpConfig, 'utf8') : options.mcpConfig
  const cfg = JSON.parse(raw)
  if (!cfg.mcpServers || !cfg.mcpServers[lib.MCP_SERVER]) throw new Error(`--mcp-config must define a "${lib.MCP_SERVER}" server`)
  return cfg
}

function replayMcpConfig (recordingFile, logFile) {
  return {
    mcpServers: {
      [lib.MCP_SERVER]: {
        type: 'stdio',
        command: process.execPath,
        args: [REPLAY_SERVER],
        env: { DOC_IMPACT_RECORDING: recordingFile, DOC_IMPACT_TOOLS: TOOLS_SNAPSHOT, DOC_IMPACT_LOG: logFile }
      }
    }
  }
}

/** Parse a JSON-RPC reply that may arrive as JSON or as an SSE stream. */
function rpcBody (text) {
  const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  return JSON.parse(data.length ? data[data.length - 1] : text)
}

/** Snapshot tools/list from the live server so replay serves the same schemas. */
async function snapshotTools (cfg) {
  const server = cfg.mcpServers[lib.MCP_SERVER]
  if (server.type !== 'http' || !server.url) throw new Error('tool snapshot needs an http redpanda-docs server')
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(server.headers || {}) }
  const init = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'doc-impact-eval', version: '1' } } })
  })
  if (!init.ok) throw new Error(`initialize: HTTP ${init.status}`)
  const session = init.headers.get('mcp-session-id')
  const initBody = rpcBody(await init.text())
  const h2 = { ...headers, 'mcp-protocol-version': initBody.result.protocolVersion }
  if (session) h2['mcp-session-id'] = session
  await fetch(server.url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
  const list = await fetch(server.url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })
  if (!list.ok) throw new Error(`tools/list: HTTP ${list.status}`)
  const tools = rpcBody(await list.text()).result.tools
  const doc = { server_url: server.url, server_version: (initBody.result.serverInfo || {}).version || null, captured_at: new Date().toISOString(), tools }
  fs.writeFileSync(TOOLS_SNAPSHOT, JSON.stringify(doc, null, 2) + '\n')
  return doc
}

// ---------------------------------------------------------------------------
// One item
// ---------------------------------------------------------------------------

function runClaude (prompt, { cwd, model, settings, mcpConfig, timeoutMs = 600000 }) {
  const started = Date.now()
  const r = spawnSync('claude', [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--max-turns', String(settings.maxTurns),
    // Only this run's MCP server, and none of the caller's user settings,
    // plugins or hooks: the eval must not depend on whose machine runs it.
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify(mcpConfig),
    '--allowed-tools', settings.allowedTools.join(','),
    '--disallowed-tools', settings.disallowedTools.concat(['Bash', 'Agent', 'Task', 'Skill', 'Workflow']).join(',')
  ], { cwd, input: prompt, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 })
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    status: r.status,
    timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'),
    ms: Date.now() - started
  }
}

// A refusal from the docs server's anonymous quota or rate limit is not a
// docs answer. See lib.limitRefusal for how one is recognized.
const quotaRefusals = lib.limitRefusals

function runItem (item, ctx) {
  const { options, prompts, settings, filter, caseDir } = ctx
  const ev = { id: item.id, label: item.label, status: 'OK', flagged: false, pages: [], names: [], mcp_calls: 0, replay_nearest: 0, replay_misses: 0, notes: [] }

  let inputs
  try {
    inputs = item.fixture ? materializeControl(item) : frozenInputs(item)
  } catch (err) {
    return { ...ev, status: 'HARNESS_ERROR', notes: [err.message] }
  }
  const findings = JSON.parse(inputs.findings)
  const decls = (findings.summary && findings.summary.totalDeclarations) || 0
  const removals = (findings.summary && findings.summary.removedSurfaceLines) || 0
  if (decls === 0 && removals === 0) {
    // The workflow skips the model entirely here, so the pass never runs.
    // Not scored: a no_change item would earn an abstention the pass never
    // made, and a needs_docs item could never be flagged.
    ev.status = 'GATE_CLOSED'
    ev.notes.push('lint gate closed (no declarations or removals): the workflow would not run the pass, so the item is not scored')
    return ev
  }

  const recordingFile = path.join(RECORDINGS, `${item.id}.json`)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-eval-'))
  const replayLog = path.join(work, '..', `${path.basename(work)}-replay.jsonl`)
  try {
    let mcpConfig
    if (options.mcp === 'replay') {
      if (!fs.existsSync(recordingFile)) return { ...ev, status: 'HARNESS_ERROR', notes: [`no recording at ${path.relative(process.cwd(), recordingFile)}; run --mcp record --case ${item.id}`] }
      // A recording that holds a quota refusal would replay the refusal as
      // the docs answer, so the run would grade the quota, not the pass.
      const poisoned = quotaRefusals(JSON.parse(fs.readFileSync(recordingFile, 'utf8')).calls)
      if (poisoned.length) return { ...ev, status: 'HARNESS_ERROR', notes: [`recording ${path.relative(process.cwd(), recordingFile)} holds ${poisoned.length} call(s) the docs server refused for its limit; delete it and re-record`] }
      mcpConfig = replayMcpConfig(recordingFile, replayLog)
    } else {
      mcpConfig = ctx.liveConfig
    }

    fs.writeFileSync(path.join(work, 'pr-diff.patch'), inputs.diff)
    fs.writeFileSync(path.join(work, 'lint-findings.json'), inputs.findings)
    fs.writeFileSync(path.join(work, 'pr-view.json'), JSON.stringify({ title: item.title, body: item.body, url: item.pr_url || null }, null, 2) + '\n')
    const prompt = lib.buildPrompt(prompts, item)
    fs.writeFileSync(path.join(caseDir, 'prompt.txt'), prompt)
    fs.copyFileSync(path.join(work, 'pr-diff.patch'), path.join(caseDir, 'pr-diff.patch'))
    fs.copyFileSync(path.join(work, 'lint-findings.json'), path.join(caseDir, 'lint-findings.json'))

    const run = runClaude(prompt, { cwd: work, model: options.model, settings, mcpConfig })
    ev.model_ms = run.ms
    fs.writeFileSync(path.join(caseDir, 'transcript.jsonl'), run.stdout)
    if (run.stderr) fs.writeFileSync(path.join(caseDir, 'stderr.txt'), run.stderr)
    const parsed = lib.parseStreamJson(run.stdout)
    if (run.timedOut || run.status !== 0 || !parsed.result || parsed.result.isError) {
      const why = run.timedOut ? 'timed out' : `exit ${run.status}${parsed.result ? `, ${parsed.result.subtype}` : ''}`
      return { ...ev, status: 'MODEL_ERROR', notes: [`claude ${why}: ${(run.stderr || (parsed.result && parsed.result.text) || '').split('\n')[0].slice(0, 300)}`] }
    }

    ev.mcp_calls = parsed.mcpCalls.length
    if (ev.mcp_calls > prompts.mcpBudget) ev.notes.push(`over the MCP budget: ${ev.mcp_calls} calls, the prompt allows ${prompts.mcpBudget}`)
    if (fs.existsSync(replayLog)) {
      const lines = fs.readFileSync(replayLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      ev.replay_nearest = lines.filter((l) => l.match === 'nearest').length
      ev.replay_misses = lines.filter((l) => l.match === 'miss').length
      fs.copyFileSync(replayLog, path.join(caseDir, 'replay-log.jsonl'))
    }
    // A refusal from the server's anonymous quota or rate limit is not a
    // docs answer. Saving it would replay the refusal on every later run,
    // and scoring it would grade the quota, not the pass.
    const refused = quotaRefusals(parsed.mcpCalls)
    if (refused.length) {
      return { ...ev, status: 'HARNESS_ERROR', notes: [`${refused.length} MCP call(s) refused by the docs server's limit${options.mcp === 'record' ? '; recording not saved' : ''}: ${lib.limitRefusal(refused[0]).slice(0, 200)}`] }
    }
    if (options.mcp === 'record') {
      fs.mkdirSync(RECORDINGS, { recursive: true })
      let rec = lib.buildRecording(item, parsed.mcpCalls, { recordedAt: new Date().toISOString(), serverUrl: (mcpConfig.mcpServers[lib.MCP_SERVER] || {}).url || null, model: options.model })
      if (options.merge && fs.existsSync(recordingFile)) {
        const merged = lib.mergeRecording(JSON.parse(fs.readFileSync(recordingFile, 'utf8')), rec)
        rec = merged.recording
        ev.notes.push(`merged ${merged.added} new MCP call(s) into the recording (${rec.calls.length} in all)`)
      } else {
        ev.notes.push(`recorded ${rec.calls.length} MCP call(s)`)
      }
      fs.writeFileSync(recordingFile, JSON.stringify(rec, null, 2) + '\n')
    }

    const impactFile = path.join(work, 'doc-impact.json')
    if (fs.existsSync(impactFile)) {
      const text = fs.readFileSync(impactFile, 'utf8')
      fs.writeFileSync(path.join(caseDir, 'doc-impact.json'), text)
      if (text.trim()) {
        // The dispatch step's own gate decides: a file it rejects never
        // becomes a ticket, so it is not a flag.
        const gate = lib.validateImpact(text, filter)
        if (gate.valid) {
          const impact = JSON.parse(text)
          ev.flagged = true
          ev.pages = lib.predictedPages(impact)
          ev.names = (impact.findings || []).map((f) => String(f.name))
        } else {
          ev.notes.push(`doc-impact.json ${gate.detail}`)
        }
      }
    }
    if (ev.replay_misses) {
      ev.status = 'REPLAY_INCOMPLETE'
      ev.notes.push(`${ev.replay_misses} MCP call(s) had no recording, so the verdict was made without those docs; not scored. Re-record with --mcp record --merge --case ${item.id}`)
    }
    return ev
  } finally {
    if (!options.keepTemp) fs.rmSync(work, { recursive: true, force: true })
    fs.rmSync(replayLog, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`)
const num = (v) => (v == null ? 'n/a' : v.toFixed(3))

function printTable (runs, scored) {
  const rows = scored.perItem.map((p) => {
    const r = runs.find((x) => x.id === p.id)
    const pages = p.page_expected != null ? `${p.page_hits}/${p.page_predicted} of ${p.page_expected}` : '-'
    return [p.id, p.label, p.status, p.flagged == null ? '-' : (p.flagged ? 'yes' : 'no'), p.correct == null ? '-' : (p.correct ? 'yes' : 'NO'), pages, String(r.mcp_calls), `${r.replay_nearest}/${r.replay_misses}`]
  })
  const head = ['item', 'label', 'status', 'flagged', 'correct', 'pages hit/pred of exp', 'mcp', 'near/miss']
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  process.stdout.write(`\n${line(head)}\n${widths.map((w) => '-'.repeat(w)).join('  ')}\n`)
  for (const r of rows) process.stdout.write(`${line(r)}\n`)
  for (const r of runs) for (const n of r.notes) process.stdout.write(`  ${r.id}: ${n}\n`)
}

function printSummary (scored, runs) {
  const c = scored.counts
  const misses = runs.reduce((s, r) => s + r.replay_misses, 0)
  process.stdout.write(`\nScored ${c.scored} item(s): ${c.needs_docs} needs_docs, ${c.no_change} no_change. Not scored: ${c.gate_closed} lint gate closed, ${c.replay_incomplete} replay incomplete, ${c.errors} error(s).\n`)
  process.stdout.write(`Flag recall F:        ${pct(scored.flag_recall)}\n`)
  process.stdout.write(`Abstention recall A:  ${pct(scored.abstention_recall)}\n`)
  process.stdout.write(`Headline 2FA/(F+A):   ${scored.headline_refused ? `refused: ${scored.headline_refused}` : num(scored.headline)}\n`)
  process.stdout.write(`Page precision:       ${pct(scored.page_precision)}\n`)
  process.stdout.write(`Page recall:          ${pct(scored.page_recall)}\n`)
  process.stdout.write(`Duplicate rate:       ${pct(scored.duplicate_rate)}${scored.duplicates.length ? ` (${scored.duplicates.join(', ')})` : ''}\n`)
  const nearest = runs.reduce((s, r) => s + (r.replay_nearest || 0), 0)
  if (nearest) process.stdout.write(`Replay nearest:       ${nearest} call(s) were answered with the closest recorded call (see each item's replay-log.jsonl).\n`)
  if (misses) process.stdout.write(`Replay misses:        ${misses} call(s) had no recording; those items are REPLAY_INCOMPLETE and not scored. Re-record them with --merge.\n`)
}

/**
 * Controls pass when the positive control is flagged with at least one
 * expected page and the negative control is not flagged, with no errors
 * and no replay misses (a miss means the run did not see recorded docs).
 */
function controlVerdict (runs, items) {
  const problems = []
  for (const r of runs) {
    const item = items.find((i) => i.id === r.id)
    if (r.status !== 'OK') { problems.push(`${r.id}: ${r.status}`); continue }
    if (r.replay_misses) problems.push(`${r.id}: ${r.replay_misses} replay miss(es)`)
    if (item.label === 'needs_docs') {
      if (!r.flagged) problems.push(`${r.id}: positive control not flagged`)
      else {
        const expected = new Set(item.expected_pages.map(lib.normalizeUrl))
        if (!r.pages.some((p) => expected.has(p))) problems.push(`${r.id}: flagged, but no affected page matches expected_pages (${r.pages.join(', ') || 'none'})`)
      }
    } else if (r.flagged) problems.push(`${r.id}: negative control flagged`)
  }
  return problems
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main (argv) {
  const options = parseArgs(argv)
  let items
  let wf
  let prompts
  let settings
  let filter
  try {
    items = options.controls ? lib.loadItems(CONTROLS, { synthetic: true }) : lib.loadItems(options.items)
    wf = lib.loadWorkflow(options.workflow || undefined)
    prompts = lib.extractImpactPrompt(wf.prompt)
    settings = lib.extractClaudeSettings(wf.claudeArgs)
    filter = lib.extractDispatchFilter(wf.dispatchScript)
  } catch (err) {
    console.error(`HARNESS_ERROR: ${err.message}`)
    return 2
  }

  if (options.cases) {
    const missing = options.cases.filter((id) => !items.some((i) => i.id === id))
    if (missing.length) {
      console.error(`Unknown item id(s): ${missing.join(', ')}`)
      return 2
    }
    items = items.filter((i) => options.cases.includes(i.id))
  }
  if (!options.controls) useItemsFile(options.items)
  const skipped = options.controls || options.includeUnconfirmed ? [] : items.filter((i) => !lib.isConfirmed(i))
  items = items.filter((i) => !skipped.includes(i))

  if (options.refresh) {
    const cloneRoot = path.join(os.tmpdir(), 'doc-impact-eval-clones')
    let failed = 0
    for (const item of items.filter((i) => !i.fixture)) {
      try {
        const r = refreshItem(item, wf, cloneRoot)
        process.stdout.write(`froze ${item.id}: diff ${r.bytes} bytes (${r.leftOut} file(s) left out), ${r.decls} declaration(s), ${r.removals} removed surface line(s), surfaces ${r.surfaces || 'all'}\n`)
      } catch (err) {
        failed++
        process.stdout.write(`FAILED ${item.id}: ${err.message.split('\n')[0]}\n`)
      }
    }
    process.stdout.write(`Clones are cached in ${cloneRoot}; delete it when you are done.\n`)
    return failed ? 1 : 0
  }

  if (items.length === 0) {
    console.error(`No items to run in ${path.relative(process.cwd(), options.controls ? CONTROLS : options.items)}${skipped.length ? ` (${skipped.length} unconfirmed skipped; pass --include-unconfirmed)` : ''}.`)
    return 2
  }

  if (!evalLib.claudeAvailable()) {
    console.log('SKIPPED: the claude CLI is not available on PATH. This eval drives real model calls.')
    return 3
  }
  if (options.mcp === 'replay' && !fs.existsSync(TOOLS_SNAPSHOT)) {
    console.error(`HARNESS_ERROR: no tool snapshot at ${path.relative(process.cwd(), TOOLS_SNAPSHOT)}; record first with --mcp record`)
    return 2
  }

  let liveConfig = null
  if (options.mcp !== 'replay') {
    try {
      liveConfig = liveMcpConfig(options, settings)
      if (options.mcp === 'record') {
        const snap = await snapshotTools(liveConfig)
        process.stdout.write(`Snapshot ${snap.tools.length} tool(s) from ${snap.server_url} (server ${snap.server_version || 'unknown'}).\n`)
      }
    } catch (err) {
      console.error(`HARNESS_ERROR: ${err.message}`)
      return 2
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const root = path.join(RESULTS, `${stamp}-doc-impact${options.controls ? '-controls' : ''}`)
  fs.mkdirSync(root, { recursive: true })
  const log = options.json ? (s) => process.stderr.write(s) : (s) => process.stdout.write(s)
  if (skipped.length) log(`Skipping ${skipped.length} unconfirmed item(s); pass --include-unconfirmed to run them.\n`)

  const runs = []
  for (const item of items) {
    const caseDir = path.join(root, item.id)
    fs.mkdirSync(caseDir, { recursive: true })
    log(`=== ${item.id} (${item.label}, mcp ${options.mcp}) ===\n`)
    let ev
    try {
      ev = runItem(item, { options, prompts, settings, filter, caseDir, liveConfig })
    } catch (err) {
      ev = { id: item.id, label: item.label, status: 'HARNESS_ERROR', flagged: false, pages: [], names: [], mcp_calls: 0, replay_nearest: 0, replay_misses: 0, notes: [err.stack.split('\n').slice(0, 3).join(' | ')] }
    }
    log(`    -> ${ev.status}, flagged ${ev.flagged ? 'yes' : 'no'}${ev.model_ms ? ` (${(ev.model_ms / 1000).toFixed(1)}s)` : ''}\n`)
    fs.writeFileSync(path.join(caseDir, 'evidence.json'), JSON.stringify(ev, null, 2) + '\n')
    runs.push(ev)
  }

  const scored = lib.score(runs.map((r) => ({ item: items.find((i) => i.id === r.id), status: r.status, flagged: r.flagged, pages: r.pages, names: r.names })))
  const controlProblems = options.controls ? controlVerdict(runs, items) : null
  const summary = {
    model: options.model,
    workflow: path.relative(process.cwd(), options.workflow || lib.WORKFLOW_PATH),
    mcp: options.mcp,
    controls: options.controls,
    include_unconfirmed: options.includeUnconfirmed,
    skipped_unconfirmed: skipped.map((i) => i.id),
    ...scored,
    items: runs,
    control_problems: controlProblems
  }
  fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')

  if (options.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
  } else {
    printTable(runs, scored)
    printSummary(scored, runs)
    process.stdout.write(`Results: ${path.relative(process.cwd(), root)}\n`)
  }

  if (options.controls) {
    const out = options.json ? process.stderr : process.stdout
    out.write(controlProblems.length ? `CONTROLS FAILED:\n${controlProblems.map((p) => `  ${p}`).join('\n')}\n` : 'CONTROLS PASSED: the positive control flagged an expected page and the negative control stayed silent.\n')
    return controlProblems.length ? 1 : 0
  }
  // A closed lint gate is a property of the item, not a failed run. Every
  // other unscored item means the numbers above cover less than the set.
  return runs.some((r) => r.status !== 'OK' && r.status !== 'GATE_CLOSED') ? 2 : 0
}

module.exports = { main, parseArgs, runItem, useItemsFile, materializeControl, controlVerdict, callerSurfaces, parseSurfaces, quotaRefusals }
