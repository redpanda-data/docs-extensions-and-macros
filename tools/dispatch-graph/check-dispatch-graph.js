'use strict'

/**
 * Health check for the repository_dispatch graph between Redpanda's
 * engineering repos and its docs repos.
 *
 * A repository_dispatch is accepted with HTTP 204 whether or not a workflow
 * listens for it, and a receiver that fails on every run is indistinguishable,
 * from the sender's side, from one that succeeds on every run. Both halves of
 * an edge therefore have to be read from the outside: the workflow files on
 * each repo's default branch say who sends what to whom, and the Actions runs
 * API says whether each half has ever run and how it has been going. This
 * module does both and turns the result into findings a scheduled job can
 * file as one issue.
 *
 * Findings (exit 1):
 *   sender-without-listener        a dispatch nothing in the target repo listens for
 *   listener-without-sender        a docs-repo listener nothing dispatches to (no cron backstop)
 *   sender-never-fired             the sending workflow has no runs at all
 *   receiver-failing               more than --fail-threshold of the receiver's newest runs failed
 *   receiver-never-received        the sender has fired, the receiver has never run from a dispatch
 *   payload-variant-without-sender a receiver's choice input lists a value no sender ever sends
 *   duplicate-sender               the same edge is dispatched from more than one repo (one is usually stale)
 *
 * Informational (do not affect the exit code):
 *   listener-without-sender (cron) nothing dispatches to it, but a schedule runs it anyway
 *   unscanned-target               a dispatch to a repo outside the configured list
 *   unresolved-sender              a dispatch whose target or type cannot be read from the file
 *   reusable-sender                a workflow_call-only sender, whose runs live in its callers
 *   receiver-no-dispatch-runs      a receiver that has only ever run by hand or on a schedule
 *   parse-error                    a workflow file that is not valid YAML
 *
 * Could-not-run (exit 2) is anything that stops the check seeing the whole
 * graph: a repo that cannot be read, a runs query that fails. The findings
 * from the readable part are still reported, but the run never exits 0.
 */

const { parseListeners, parseSenders } = require('./parse-workflows')
const { summarizeRuns, classifyReceiver, classifySender, formatRate } = require('./classify-runs')

/**
 * The repos whose workflows make up the graph. Engineering repos send,
 * docs repos receive; the roles only decide which side "no counterpart" is
 * reported on. Every sender and listener found in any of them is included.
 */
const DEFAULT_REPOS = [
  { repo: 'redpanda-data/streaming-enterprise', role: 'engineering' },
  { repo: 'redpanda-data/redpanda', role: 'engineering' },
  { repo: 'redpanda-data/cloudv2', role: 'engineering' },
  { repo: 'redpanda-data/redpanda-operator', role: 'engineering' },
  { repo: 'redpanda-data/connect', role: 'engineering' },
  { repo: 'redpanda-data/console', role: 'engineering' },
  { repo: 'redpanda-data/helm-charts', role: 'engineering' },
  { repo: 'redpanda-data/redpanda-check', role: 'engineering' },
  { repo: 'redpanda-data/docs', role: 'docs' },
  { repo: 'redpanda-data/cloud-docs', role: 'docs' },
  { repo: 'redpanda-data/rp-connect-docs', role: 'docs' },
  { repo: 'redpanda-data/api-docs', role: 'docs' },
  { repo: 'redpanda-data/adp-docs', role: 'docs' },
  { repo: 'redpanda-data/docs-site', role: 'docs' },
  { repo: 'redpanda-data/docs-ui', role: 'docs' },
  { repo: 'redpanda-data/docs-extensions-and-macros', role: 'docs' },
]

const SENTINEL = 'DISPATCH_GRAPH_FINDINGS_CONFIRMED'

/**
 * Thin adapter over Octokit so the check can be exercised against a stub.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 */
function createGitHubApi (octokit) {
  const split = (slug) => {
    const [owner, repo] = slug.split('/')
    return { owner, repo }
  }
  return {
    async getDefaultBranch (slug) {
      const { data } = await octokit.repos.get(split(slug))
      return data.default_branch
    },
    async listWorkflowFiles (slug, ref) {
      const { data } = await octokit.repos.getContent({ ...split(slug), path: '.github/workflows', ref })
      if (!Array.isArray(data)) return []
      return data
        .filter((e) => e.type === 'file' && /\.ya?ml$/i.test(e.name))
        .map((e) => e.name)
    },
    async getFileText (slug, path, ref) {
      const { data } = await octokit.repos.getContent({ ...split(slug), path, ref })
      if (Array.isArray(data) || typeof data.content !== 'string') throw new Error(`${slug}:${path} is not a file`)
      return Buffer.from(data.content, data.encoding || 'base64').toString('utf8')
    },
    async listWorkflowRuns (slug, file, perPage) {
      const { data } = await octokit.actions.listWorkflowRuns({ ...split(slug), workflow_id: file, per_page: perPage })
      return data.workflow_runs || []
    },
  }
}

function isReusableOnly (sender) {
  const t = (sender.triggers || []).filter((x) => x !== 'workflow_call')
  return (sender.triggers || []).includes('workflow_call') && t.length === 0
}

function edgeKey (repo, type) {
  return `${repo}#${type}`
}

function shortRepo (slug) {
  return String(slug).replace(/^redpanda-data\//, '')
}

function describeSender (s) {
  return `${shortRepo(s.repo)}/${s.file}`
}

async function mapLimit (items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker () {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Read every workflow in every configured repo and return the parsed halves.
 */
async function scanRepos ({ repos, api, concurrency }) {
  const listeners = []
  const senders = []
  const unreadable = []
  const parseErrors = []
  const scanned = []

  await mapLimit(repos, concurrency, async ({ repo, role }) => {
    let ref
    let files
    try {
      ref = await api.getDefaultBranch(repo)
      files = await api.listWorkflowFiles(repo, ref)
    } catch (err) {
      unreadable.push({ repo, role, error: describeError(err) })
      return
    }
    const workflows = []
    for (const file of files) {
      let text
      try {
        text = await api.getFileText(repo, `.github/workflows/${file}`, ref)
      } catch (err) {
        unreadable.push({ repo, role, file, error: describeError(err) })
        continue
      }
      const where = { repo, file }
      try {
        const l = parseListeners(text, where).map((x) => ({ ...x, role }))
        const s = parseSenders(text, where).map((x) => ({ ...x, role }))
        listeners.push(...l)
        senders.push(...s)
        workflows.push({ file, listeners: l.length, senders: s.length })
      } catch (err) {
        parseErrors.push({ repo, file, error: err.message.split('\n')[0] })
      }
    }
    scanned.push({ repo, role, ref, workflows: workflows.length })
  })

  scanned.sort((a, b) => a.repo.localeCompare(b.repo))
  return { listeners, senders, unreadable, parseErrors, scanned }
}

function describeError (err) {
  const status = err && err.status ? ` (HTTP ${err.status})` : ''
  return `${(err && err.message) || String(err)}${status}`
}

/**
 * Join senders and listeners into edges and derive the structural findings
 * (everything that can be known from the files alone).
 */
function buildGraph ({ listeners, senders, scannedRepos, docsRepos }) {
  const scannedSet = new Set(scannedRepos)
  const docsSet = new Set(docsRepos)
  const listenersByKey = new Map()
  const anyTypeListeners = new Map() // repo -> listeners with eventType null
  for (const l of listeners) {
    if (l.eventType === null) {
      if (!anyTypeListeners.has(l.repo)) anyTypeListeners.set(l.repo, [])
      anyTypeListeners.get(l.repo).push(l)
      continue
    }
    const k = edgeKey(l.repo, l.eventType)
    if (!listenersByKey.has(k)) listenersByKey.set(k, [])
    listenersByKey.get(k).push(l)
  }

  const findings = []
  const info = []
  const edges = new Map() // key -> { targetRepo, eventType, senders: [], listeners: [] }

  const addEdge = (repo, type) => {
    const k = edgeKey(repo, type)
    if (!edges.has(k)) edges.set(k, { key: k, targetRepo: repo, eventType: type, senders: [], listeners: [] })
    return edges.get(k)
  }

  for (const s of senders) {
    if (s.unresolved || !s.targetRepo || !s.eventType) {
      info.push({
        kind: 'unresolved-sender',
        message: `${describeSender(s)}: dispatch target or event type cannot be resolved from the file (${s.raw || 'no literal value'})`,
        sender: s,
      })
      continue
    }
    if (!scannedSet.has(s.targetRepo)) {
      info.push({
        kind: 'unscanned-target',
        message: `${describeSender(s)} -> ${shortRepo(s.targetRepo)}#${s.eventType}: target repo is not in the scanned list, so its listener was not checked`,
        sender: s,
      })
      continue
    }
    const edge = addEdge(s.targetRepo, s.eventType)
    edge.senders.push(s)
    const matched = (listenersByKey.get(edge.key) || []).concat(anyTypeListeners.get(s.targetRepo) || [])
    for (const l of matched) if (!edge.listeners.includes(l)) edge.listeners.push(l)
  }

  for (const l of listeners) {
    if (l.eventType === null) continue
    const edge = addEdge(l.repo, l.eventType)
    if (!edge.listeners.includes(l)) edge.listeners.push(l)
  }

  for (const edge of edges.values()) {
    const target = shortRepo(edge.targetRepo)
    if (edge.senders.length && edge.listeners.length === 0) {
      for (const s of edge.senders) {
        findings.push({
          severity: 'error',
          kind: 'sender-without-listener',
          edge: edge.key,
          message: `${describeSender(s)} -> ${target}#${edge.eventType}: no workflow in ${edge.targetRepo} listens for this event. GitHub accepts the dispatch (204) and drops it.`,
        })
      }
    }
    if (edge.listeners.length && edge.senders.length === 0) {
      for (const l of edge.listeners) {
        if (!docsSet.has(l.repo)) continue // engineering-side listeners (slash commands, bots) are out of scope
        if (l.cronBackstop) {
          info.push({
            kind: 'listener-without-sender',
            edge: edge.key,
            message: `${target}/${l.file} listens for ${edge.eventType} but nothing in the scanned repos dispatches it; a schedule runs it anyway`,
          })
        } else {
          findings.push({
            severity: 'error',
            kind: 'listener-without-sender',
            edge: edge.key,
            message: `${target}/${l.file} listens for ${edge.eventType} but nothing in the scanned repos dispatches it, and it has no cron backstop, so it only runs by hand.`,
          })
        }
      }
    }
    // Choice inputs on a dispatch-driven workflow enumerate the variants it
    // expects. A variant no sender carries in its payload is a dead branch.
    for (const l of edge.listeners) {
      for (const [input, options] of Object.entries(l.choiceInputs || {})) {
        const sent = edge.senders.filter((s) => s.payload && s.payload[input] !== undefined)
        if (sent.length === 0) continue
        const sentValues = new Set(sent.map((s) => s.payload[input]))
        const missing = options.filter((o) => !sentValues.has(o))
        for (const value of missing) {
          findings.push({
            severity: 'error',
            kind: 'payload-variant-without-sender',
            edge: edge.key,
            message: `${target}/${l.file} expects ${input}: ${value} on ${edge.eventType}, but no scanned sender dispatches that value (senders send ${[...sentValues].join(', ')}).`,
          })
        }
      }
    }
  }

  // A listener in an engineering repo that nothing in the scanned set
  // dispatches to (slash-command bots, deploy hooks) is not part of the docs
  // graph; it leaves the edge list rather than padding the table.
  let outOfScopeListeners = 0
  const kept = [...edges.values()].filter((e) => {
    if (e.senders.length) return true
    if (e.listeners.some((l) => docsSet.has(l.repo))) return true
    outOfScopeListeners += e.listeners.length
    return false
  })

  return { edges: kept.sort((a, b) => a.key.localeCompare(b.key)), findings, info, outOfScopeListeners }
}

/**
 * Fetch the run record of every workflow that takes part in an edge and
 * derive the run-based findings.
 */
async function recordRuns ({ edges, api, perPage, window, threshold, concurrency }) {
  const workflows = new Map() // repo/file -> { repo, file, side }
  for (const e of edges) {
    for (const s of e.senders) workflows.set(`${s.repo}/${s.file}`, { repo: s.repo, file: s.file })
    for (const l of e.listeners) workflows.set(`${l.repo}/${l.file}`, { repo: l.repo, file: l.file })
  }
  const runs = new Map()
  const runsUnreadable = []
  await mapLimit([...workflows.values()], concurrency, async ({ repo, file }) => {
    try {
      const list = await api.listWorkflowRuns(repo, file, perPage)
      runs.set(`${repo}/${file}`, summarizeRuns(list, { window }))
    } catch (err) {
      runsUnreadable.push({ repo, file, error: describeError(err) })
    }
  })

  const findings = []
  const info = []
  const reportedSenders = new Set()
  for (const e of edges) {
    const target = shortRepo(e.targetRepo)
    let anySenderFired = false
    for (const s of e.senders) {
      const summary = runs.get(`${s.repo}/${s.file}`)
      if (!summary) continue
      const id = `${s.repo}/${s.file}`
      // A reusable workflow (workflow_call only) runs inside its callers'
      // jobs, so its own run list is empty by construction. Its edge is still
      // reported, but "never fired" cannot be read off this repo.
      if (isReusableOnly(s) && summary.total === 0) {
        anySenderFired = true
        if (!reportedSenders.has(id)) {
          reportedSenders.add(id)
          info.push({
            kind: 'reusable-sender',
            edge: e.key,
            message: `${describeSender(s)} is a reusable workflow (workflow_call), so its runs are recorded in the calling repos and not checked here.`,
          })
        }
        continue
      }
      const c = classifySender(summary)
      if (c.status === 'fired') anySenderFired = true
      if (c.status === 'never-fired' && !reportedSenders.has(id)) {
        reportedSenders.add(id)
        const hint = s.triggers.includes('release')
          ? ' It runs on release events; a release created by a workflow using GITHUB_TOKEN does not fire them.'
          : ''
        findings.push({
          severity: 'error',
          kind: 'sender-never-fired',
          edge: e.key,
          message: `${describeSender(s)} has never run, so it has never dispatched ${e.eventType}.${hint}`,
        })
      }
    }
    // The same (target, type) dispatched from more than one repo with
    // payloads that cannot be told apart is almost always a stale copy left
    // behind by a repo move. Senders whose literal payloads differ (one
    // event, several plugin values) are distinct variants, not duplicates.
    const byPayload = new Map()
    for (const s of e.senders) {
      const sig = JSON.stringify(Object.entries(s.payload || {}).sort())
      if (!byPayload.has(sig)) byPayload.set(sig, [])
      byPayload.get(sig).push(s)
    }
    for (const group of byPayload.values()) {
      const repos = [...new Set(group.map((s) => s.repo))]
      if (repos.length < 2) continue
      const described = group.map((s) => {
        const r = runs.get(`${s.repo}/${s.file}`)
        const last = r ? (r.total === 0 ? 'never ran' : `last run ${day(r.lastRunAt)}`) : 'runs unknown'
        return `${describeSender(s)} (${last})`
      })
      findings.push({
        severity: 'warning',
        kind: 'duplicate-sender',
        edge: e.key,
        message: `${target}#${e.eventType} is dispatched with the same payload from ${repos.length} repos: ${described.join('; ')}. One is usually a stale copy left behind by a repo move.`,
      })
    }
    for (const l of e.listeners) {
      const summary = runs.get(`${l.repo}/${l.file}`)
      if (!summary) continue
      const c = classifyReceiver(summary, { threshold })
      if (c.status === 'failing') {
        const w = summary.window
        findings.push({
          severity: 'error',
          kind: 'receiver-failing',
          edge: e.key,
          message: `${target}/${l.file} failed ${w.failures} of its newest ${w.considered} runs (${formatRate(c.failRate)}); last run ${summary.lastConclusion} at ${summary.lastRunAt}. ${summary.lastRunUrl || ''}`.trim(),
        })
      } else if (e.senders.length && anySenderFired && summary.dispatchRuns === 0) {
        findings.push({
          severity: 'error',
          kind: 'receiver-never-received',
          edge: e.key,
          message: `${target}/${l.file} has ${summary.total} run(s) but none from a repository_dispatch, although a sender of ${e.eventType} has fired.`,
        })
      } else if (e.senders.length && summary.dispatchRuns === 0) {
        info.push({
          kind: 'receiver-no-dispatch-runs',
          edge: e.key,
          message: `${target}/${l.file} has only ${summary.total} manual or scheduled run(s), never one from a repository_dispatch.`,
        })
      }
    }
  }
  return { runs, runsUnreadable, findings, info }
}

/**
 * Run the whole check.
 *
 * @param {object} opts
 * @param {Array<{repo: string, role: 'engineering'|'docs'}>} [opts.repos]
 * @param {ReturnType<typeof createGitHubApi>} opts.api
 * @param {number} [opts.threshold=0.5]
 * @param {number} [opts.window=20]
 * @param {number} [opts.perPage=50]
 * @param {number} [opts.concurrency=4]
 */
async function runCheck (opts) {
  const repos = opts.repos || DEFAULT_REPOS
  const api = opts.api
  if (!api) throw new Error('runCheck requires an api')
  const threshold = opts.threshold === undefined ? 0.5 : opts.threshold
  const window = opts.window || 20
  const perPage = opts.perPage || 50
  const concurrency = opts.concurrency || 4

  const scan = await scanRepos({ repos, api, concurrency })
  const scannedRepos = scan.scanned.map((s) => s.repo)
  const docsRepos = repos.filter((r) => r.role === 'docs').map((r) => r.repo)
  const graph = buildGraph({ listeners: scan.listeners, senders: scan.senders, scannedRepos, docsRepos })
  const runRecord = await recordRuns({ edges: graph.edges, api, perPage, window, threshold, concurrency })

  const findings = [...graph.findings, ...runRecord.findings]
  const info = [
    ...graph.info,
    ...runRecord.info,
    ...scan.parseErrors.map((p) => ({ kind: 'parse-error', message: `${shortRepo(p.repo)}/${p.file}: ${p.error}` })),
  ]

  const edges = graph.edges.map((e) => ({
    key: e.key,
    targetRepo: e.targetRepo,
    eventType: e.eventType,
    senders: e.senders.map((s) => ({
      repo: s.repo,
      file: s.file,
      form: s.form,
      triggers: s.triggers,
      payload: s.payload,
      runs: runRecord.runs.get(`${s.repo}/${s.file}`) || null,
    })),
    listeners: e.listeners.map((l) => ({
      repo: l.repo,
      file: l.file,
      cronBackstop: l.cronBackstop,
      runs: runRecord.runs.get(`${l.repo}/${l.file}`) || null,
    })),
  }))

  const unreadable = [...scan.unreadable, ...runRecord.runsUnreadable]
  const hasFindings = findings.length > 0
  const exitCode = unreadable.length ? 2 : hasFindings ? 1 : 0

  return {
    checkedAt: new Date().toISOString(),
    options: { threshold, window, perPage },
    scanned: scan.scanned,
    unreadable,
    counts: {
      repos: scan.scanned.length,
      senders: scan.senders.length,
      listeners: scan.listeners.length,
      edges: edges.length,
      outOfScopeListeners: graph.outOfScopeListeners,
      findings: findings.length,
      info: info.length,
    },
    edges,
    findings,
    info,
    exitCode,
  }
}

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

function pad (s, n) {
  s = String(s === undefined || s === null ? '' : s)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function day (iso) {
  return iso ? String(iso).slice(0, 10) : '-'
}

function runsCell (summary) {
  if (!summary) return 'unknown'
  if (summary.total === 0) return 'never ran'
  const parts = Object.entries(summary.byConclusion)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
  return parts.join(', ')
}

function formatReport (result) {
  const lines = []
  const c = result.counts
  const roles = result.scanned.reduce((acc, s) => { acc[s.role] = (acc[s.role] || 0) + 1; return acc }, {})
  lines.push(`Dispatch graph: ${c.repos} repos scanned (${roles.engineering || 0} engineering, ${roles.docs || 0} docs), ` +
    `${c.senders} senders, ${c.listeners} listeners, ${c.edges} edges` +
    (c.outOfScopeListeners ? ` (${c.outOfScopeListeners} engineering-side listeners with no docs sender left out).` : '.'))
  lines.push(`Receiver fail rate is over the newest ${result.options.window} runs; flagged above ${Math.round(result.options.threshold * 100)}%.`)
  lines.push('')

  if (result.unreadable.length) {
    lines.push(`✗ Could not read ${result.unreadable.length} thing(s); the graph below is incomplete:`)
    for (const u of result.unreadable) {
      lines.push(`  - ${shortRepo(u.repo)}${u.file ? '/' + u.file : ''}: ${u.error}`)
    }
    lines.push('  A private repo needs a token that can read it (REDPANDA_GITHUB_TOKEN, ACTIONS_BOT_TOKEN, GITHUB_TOKEN or GH_TOKEN).')
    lines.push('')
  }

  if (result.findings.length) {
    lines.push(`✗ ${result.findings.length} finding(s):`)
    for (const f of result.findings) {
      lines.push(`  [${f.kind}] ${f.message}`)
    }
  } else {
    lines.push('✓ No findings: every dispatch has a listener, every docs listener has a sender or a cron, and no receiver is failing.')
  }
  lines.push('')

  if (result.info.length) {
    lines.push(`ℹ ${result.info.length} informational:`)
    for (const i of result.info) lines.push(`  [${i.kind}] ${i.message}`)
    lines.push('')
  }

  // Edge table
  const rows = []
  for (const e of result.edges) {
    const senders = e.senders.length ? e.senders : [null]
    const listeners = e.listeners.length ? e.listeners : [null]
    for (const s of senders) {
      for (const l of listeners) {
        rows.push({
          sender: s ? `${shortRepo(s.repo)}/${s.file}` : '(none)',
          senderRuns: s ? (s.runs ? (s.runs.total === 0 ? 'never ran' : `${s.runs.total}, last ${day(s.runs.lastRunAt)}`) : 'unknown') : '',
          event: e.eventType,
          receiver: l ? `${shortRepo(l.repo)}/${l.file}` : `(none in ${shortRepo(e.targetRepo)})`,
          receiverRuns: l ? runsCell(l.runs) : '',
          fail: l && l.runs ? formatRate(l.runs.window.failRate) : '',
          last: l && l.runs ? day(l.runs.lastRunAt) : '',
          cron: l && l.cronBackstop ? 'cron' : '',
        })
      }
    }
  }
  const cols = [
    ['sender', 'SENDER'], ['senderRuns', 'SENDER RUNS'], ['event', 'EVENT'], ['receiver', 'RECEIVER'],
    ['receiverRuns', 'RECEIVER RUNS'], ['fail', 'FAIL'], ['last', 'LAST RUN'], ['cron', ''],
  ]
  const widths = cols.map(([k, h]) => Math.max(h.length, ...rows.map((r) => String(r[k]).length)))
  lines.push('Edges:')
  lines.push('  ' + cols.map(([, h], i) => pad(h, widths[i])).join('  ').trimEnd())
  for (const r of rows) {
    lines.push('  ' + cols.map(([k], i) => pad(r[k], widths[i])).join('  ').trimEnd())
  }
  return lines.join('\n')
}

module.exports = {
  DEFAULT_REPOS,
  SENTINEL,
  createGitHubApi,
  scanRepos,
  buildGraph,
  recordRuns,
  runCheck,
  formatReport,
}
