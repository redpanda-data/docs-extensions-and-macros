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
 *   listener-without-sender        a docs-repo listener nothing dispatches to, or whose every sender is disabled (no cron backstop)
 *   sender-never-fired             the sending workflow has no runs at all
 *   receiver-failing               more than --fail-threshold of the receiver's newest runs failed
 *   receiver-never-received        the sender has fired, the receiver has never run from a dispatch
 *   payload-variant-without-sender a receiver's choice input lists a value no sender ever sends
 *   duplicate-sender               the same edge is dispatched from more than one repo (one is usually stale)
 *   sender-step-never-succeeded    the sender's dispatch step has an `if:` and did not succeed in any recent run checked
 *   receiver-disabled              the receiving workflow is disabled (state is not active), so dispatches are dropped
 *
 * Informational (do not affect the exit code):
 *   listener-without-sender (cron) nothing dispatches to it, but a schedule runs it anyway
 *   unscanned-target               a dispatch to a repo outside the configured list
 *   unresolved-sender              a dispatch whose target or type cannot be read from the file
 *   reusable-sender                a workflow_call-only sender, whose runs live in its callers
 *   receiver-no-dispatch-runs      a receiver that has only ever run by hand or on a schedule
 *   parse-error                    a workflow file that is not valid YAML
 *   archived-repo                  a configured repo that is archived; its workflows cannot run, so it sends nothing
 *   renamed-repo                   a configured repo that GitHub redirects to a new name; it is checked under the new name
 *   conditional-sender             a gated dispatch step that could not be located in the jobs API, so the workflow run counts
 *   sender-disabled                a sending workflow that is disabled, so it dispatches nothing and is left out of the sender checks
 *
 * Workflow states are read after the graph is built, so the graph-level
 * checks (sender-without-listener, payload-variant-without-sender) still
 * count a disabled sender as a sender.
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
    // repos.get follows a rename redirect, so full_name is the current name.
    async getRepo (slug) {
      const { data } = await octokit.repos.get(split(slug))
      return { fullName: data.full_name, defaultBranch: data.default_branch, archived: Boolean(data.archived) }
    },
    async listWorkflows (slug) {
      const workflows = await octokit.paginate(octokit.actions.listRepoWorkflows, { ...split(slug), per_page: 100 })
      return workflows.map((w) => ({ path: w.path, state: w.state }))
    },
    async listJobsForRun (slug, runId) {
      const { data } = await octokit.actions.listJobsForWorkflowRun({ ...split(slug), run_id: runId, per_page: 100 })
      return data.jobs || []
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
    async listWorkflowRuns (slug, file, perPage, opts = {}) {
      const params = { ...split(slug), workflow_id: file, per_page: perPage }
      if (opts.event) params.event = opts.event
      const { data } = await octokit.actions.listWorkflowRuns(params)
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
  const notes = []
  const aliases = {} // configured slug (lowercase) -> current full_name (lowercase)
  const seen = new Set()

  await mapLimit(repos, concurrency, async ({ repo: configured, role }) => {
    let ref
    let files
    let repo = String(configured).toLowerCase()
    try {
      const meta = api.getRepo
        ? await api.getRepo(configured)
        : { fullName: configured, defaultBranch: await api.getDefaultBranch(configured), archived: false }
      repo = String(meta.fullName || configured).toLowerCase()
      ref = meta.defaultBranch
      if (repo !== String(configured).toLowerCase()) {
        aliases[String(configured).toLowerCase()] = repo
        notes.push({ kind: 'renamed-repo', message: `${configured} has been renamed to ${repo}; it is checked under the new name. Update the configured list.` })
      }
      if (seen.has(repo)) return // configured twice, for example under an old and a new name
      seen.add(repo)
      if (meta.archived) {
        // Archived repos cannot run workflows, so nothing in them sends or
        // receives. Kept in the scanned set so a dispatch aimed at one is
        // still reported as having no listener.
        notes.push({ kind: 'archived-repo', message: `${repo} is archived; its workflows cannot run, so it is skipped as a sender and has no listeners.` })
        scanned.push({ repo, role, ref, workflows: 0, archived: true })
        return
      }
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
  return { listeners, senders, unreadable, parseErrors, scanned, notes, aliases }
}

function describeError (err) {
  const status = err && err.status ? ` (HTTP ${err.status})` : ''
  return `${(err && err.message) || String(err)}${status}`
}

/**
 * Join senders and listeners into edges and derive the structural findings
 * (everything that can be known from the files alone).
 */
function buildGraph ({ listeners, senders, scannedRepos, docsRepos, aliases = {} }) {
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
    // A dispatch aimed at a repo's old name is redirected by GitHub, so it is
    // an edge to the repo under its current name.
    if (s.targetRepo && aliases[s.targetRepo]) s.targetRepo = aliases[s.targetRepo]
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
async function recordRuns ({ edges, api, perPage, window, threshold, concurrency, stepRuns = 20, docsRepos = [] }) {
  const docsSet = new Set(docsRepos)
  const workflows = new Map() // repo/file -> { repo, file, listener }
  for (const e of edges) {
    for (const s of e.senders) {
      const k = `${s.repo}/${s.file}`
      if (!workflows.has(k)) workflows.set(k, { repo: s.repo, file: s.file, listener: false })
    }
    for (const l of e.listeners) workflows.set(`${l.repo}/${l.file}`, { repo: l.repo, file: l.file, listener: true })
  }
  const runs = new Map()
  const rawRuns = new Map()
  const runsUnreadable = []
  let extraCalls = 0
  await mapLimit([...workflows.values()], concurrency, async ({ repo, file, listener }) => {
    try {
      const list = await api.listWorkflowRuns(repo, file, perPage)
      const summary = summarizeRuns(list, { window })
      // A listener that also runs on push, pull_request or a schedule can
      // fill a whole page with those runs and push its dispatch runs off the
      // end. Only when the page is full and holds no dispatch run is the
      // filtered query needed; a shorter page is the complete history.
      if (listener && summary.dispatchRuns === 0 && list.length >= perPage) {
        extraCalls += 1
        const dispatched = await api.listWorkflowRuns(repo, file, perPage, { event: 'repository_dispatch' })
        const only = (dispatched || []).filter((r) => !r.event || r.event === 'repository_dispatch')
        const d = summarizeRuns(only, { window })
        summary.dispatchRuns = d.total
        summary.lastDispatchRunAt = d.lastRunAt
      }
      runs.set(`${repo}/${file}`, summary)
      rawRuns.set(`${repo}/${file}`, list)
    } catch (err) {
      runsUnreadable.push({ repo, file, error: describeError(err) })
    }
  })

  // A disabled workflow receives nothing: GitHub still answers the dispatch
  // with 204. A disabled sender sends nothing, so it is neither a dead edge
  // nor a duplicate. One workflow list per repo in the graph.
  const states = new Map() // repo -> Map(file -> state)
  if (api.listWorkflows) {
    const graphRepos = [...new Set([...workflows.values()].map((w) => w.repo))]
    await mapLimit(graphRepos, concurrency, async (repo) => {
      try {
        extraCalls += 1
        const list = await api.listWorkflows(repo)
        states.set(repo, new Map(list.map((w) => [String(w.path).replace(/^\.github\/workflows\//, ''), w.state])))
      } catch (err) {
        runsUnreadable.push({ repo, file: '(workflow list)', error: describeError(err) })
      }
    })
  }

  // A sender whose dispatch step (or its job) is gated by `if:` has not
  // dispatched just because the workflow ran. Read the jobs of its newest
  // completed runs, newest first, and stop at the first run where the step
  // succeeded. Bounded by stepRuns per workflow; jobs are cached per run.
  // The bound is generous because a gate like "only on a non-prerelease tag"
  // skips the step on most runs: on 2026-10-22 connect's release.yml needed
  // 7 runs and a window of 5 reported a working sender as dead.
  const jobsCache = new Map()
  const getJobs = async (repo, runId) => {
    const k = `${repo}#${runId}`
    if (!jobsCache.has(k)) {
      extraCalls += 1
      jobsCache.set(k, api.listJobsForRun(repo, runId))
    }
    return jobsCache.get(k)
  }
  const stepChecks = new Map() // sender object -> { checked, succeeded, located }
  const conditional = []
  for (const e of edges) for (const s of e.senders) if (s.conditional && !conditional.includes(s)) conditional.push(s)
  if (api.listJobsForRun) {
    await mapLimit(conditional, concurrency, async (s) => {
      const list = rawRuns.get(`${s.repo}/${s.file}`)
      if (!list || list.length === 0) return
      const completed = list
        .filter((r) => r.status === 'completed' && r.id !== undefined)
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .slice(0, stepRuns)
      const check = { checked: 0, succeeded: 0, located: 0 }
      try {
        for (const r of completed) {
          const jobs = await getJobs(s.repo, r.id)
          check.checked += 1
          const conclusion = dispatchStepConclusion(jobs, s.stepRef)
          if (conclusion === undefined) continue
          check.located += 1
          if (conclusion === 'success') { check.succeeded += 1; break }
        }
        stepChecks.set(s, check)
      } catch (err) {
        runsUnreadable.push({ repo: s.repo, file: `${s.file} (jobs)`, error: describeError(err) })
      }
    })
  }

  const findings = []
  const info = []
  const reportedSenders = new Set()
  const stateOf = (w) => states.get(w.repo) && states.get(w.repo).get(w.file)
  for (const e of edges) {
    const target = shortRepo(e.targetRepo)
    let anySenderFired = false
    const activeSenders = []
    const disabledSenders = []
    for (const s of e.senders) {
      const id = `${s.repo}/${s.file}`
      const state = stateOf(s)
      if (state && state !== 'active') {
        disabledSenders.push({ s, state })
        continue
      }
      activeSenders.push(s)
      const summary = runs.get(id)
      if (!summary) continue
      if (s.conditional && summary.total > 0) {
        const check = stepChecks.get(s)
        if (check && check.succeeded > 0) {
          anySenderFired = true
        } else if (check && check.located > 0) {
          if (!reportedSenders.has(`${id}#step`)) {
            reportedSenders.add(`${id}#step`)
            findings.push({
              severity: 'error',
              kind: 'sender-step-never-succeeded',
              edge: e.key,
              message: `${describeSender(s)} ran, but its dispatch step "${s.stepRef.stepName}" (if: ${s.condition}) did not succeed in any of the newest ${check.checked} completed run(s), so it has not dispatched ${e.eventType} recently.`,
            })
          }
        } else {
          // The step could not be found in the jobs API (a job name built
          // from an expression, say), or the jobs could not be read at all.
          // The workflow run is the best evidence left.
          anySenderFired = true
          info.push({
            kind: 'conditional-sender',
            edge: e.key,
            message: `${describeSender(s)} dispatches only when ${s.condition}; its dispatch step was not found in the jobs of its recent runs (the step may be newer than those runs), so a workflow run is counted as a dispatch.`,
          })
        }
        continue
      }
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
    // Name the senders left on the edge and when they last ran, so a reader
    // can tell when the copy still active is the stale one.
    const lastRun = (s) => {
      const r = runs.get(`${s.repo}/${s.file}`)
      return r ? (r.total === 0 ? 'never ran' : `last run ${day(r.lastRunAt)}`) : 'runs unknown'
    }
    for (const { s, state } of disabledSenders) {
      const key = `${s.repo}/${s.file}#disabled#${e.key}`
      if (reportedSenders.has(key)) continue
      reportedSenders.add(key)
      const left = activeSenders.length
        ? `Still sending ${target}#${e.eventType}: ${activeSenders.map((a) => `${describeSender(a)} (${lastRun(a)})`).join('; ')}.`
        : `No active sender of ${target}#${e.eventType} is left.`
      info.push({
        kind: 'sender-disabled',
        edge: e.key,
        message: `${describeSender(s)} is ${state}, so it dispatches nothing and is left out of the sender checks. ${left}`,
      })
    }
    // Every sender disabled: nothing will dispatch to the listeners, which is
    // the same as having no sender at all.
    if (e.senders.length && activeSenders.length === 0) {
      for (const l of e.listeners) {
        if (!docsSet.has(l.repo)) continue
        if (l.cronBackstop) {
          info.push({
            kind: 'listener-without-sender',
            edge: e.key,
            message: `${target}/${l.file} listens for ${e.eventType} but every sender is disabled; a schedule runs it anyway`,
          })
        } else {
          findings.push({
            severity: 'error',
            kind: 'listener-without-sender',
            edge: e.key,
            message: `${target}/${l.file} listens for ${e.eventType} but every sender is disabled, and it has no cron backstop, so it only runs by hand.`,
          })
        }
      }
    }
    // The same (target, type) dispatched from more than one repo with
    // payloads that cannot be told apart is almost always a stale copy left
    // behind by a repo move. Senders whose literal payloads differ (one
    // event, several plugin values) are distinct variants, not duplicates.
    const byPayload = new Map()
    for (const s of activeSenders) {
      const sig = JSON.stringify(Object.entries(s.payload || {}).sort())
      if (!byPayload.has(sig)) byPayload.set(sig, [])
      byPayload.get(sig).push(s)
    }
    for (const group of byPayload.values()) {
      const repos = [...new Set(group.map((s) => s.repo))]
      if (repos.length < 2) continue
      const described = group.map((s) => `${describeSender(s)} (${lastRun(s)})`)
      findings.push({
        severity: 'warning',
        kind: 'duplicate-sender',
        edge: e.key,
        message: `${target}#${e.eventType} is dispatched with the same payload from ${repos.length} repos: ${described.join('; ')}. One is usually a stale copy left behind by a repo move.`,
      })
    }
    for (const l of e.listeners) {
      const state = stateOf(l)
      if (state && state !== 'active') {
        findings.push({
          severity: 'error',
          kind: 'receiver-disabled',
          edge: e.key,
          message: `${target}/${l.file} is ${state}, so it does not run on ${e.eventType}. GitHub accepts the dispatch (204) and drops it.`,
        })
        continue
      }
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
  return { runs, runsUnreadable, findings, info, stepChecks, extraCalls }
}

/**
 * The conclusion of the dispatch step in one run's jobs, or undefined when the
 * step cannot be found. A matrix job is reported as "name (a, b)", so any job
 * whose name starts with the job's name counts; success in any of them wins.
 */
function dispatchStepConclusion (jobs, ref) {
  if (!ref) return undefined
  const matching = (jobs || []).filter((j) => j.name === ref.jobName || String(j.name).startsWith(`${ref.jobName} (`) ||
    (ref.jobName !== ref.jobKey && (j.name === ref.jobKey || String(j.name).startsWith(`${ref.jobKey} (`))))
  let found
  for (const j of matching) {
    // A job skipped by its own `if:` has no steps; its dispatch step did not run.
    if (j.conclusion === 'skipped' && (!j.steps || j.steps.length === 0)) { found = found || 'skipped'; continue }
    const steps = j.steps || []
    const step = steps.find((st) => st.name === ref.stepName) || steps.find((st) => st.number === ref.stepNumber && !ref.stepName)
    if (!step) continue
    if (step.conclusion === 'success') return 'success'
    found = step.conclusion || 'unknown'
  }
  return found
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
 * @param {number} [opts.stepRuns=20] - most runs whose jobs are read per gated sender
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
  const docsRepos = scan.scanned.filter((r) => r.role === 'docs').map((r) => r.repo)
  const graph = buildGraph({ listeners: scan.listeners, senders: scan.senders, scannedRepos, docsRepos, aliases: scan.aliases })
  const runRecord = await recordRuns({ edges: graph.edges, api, perPage, window, threshold, concurrency, stepRuns: opts.stepRuns, docsRepos })

  const findings = [...graph.findings, ...runRecord.findings]
  const info = [
    ...scan.notes,
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
      conditional: Boolean(s.conditional),
      condition: s.condition || null,
      dispatchStep: runRecord.stepChecks.get(s) || null,
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
    extraCalls: runRecord.extraCalls,
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
          sender: s ? `${shortRepo(s.repo)}/${s.file}${s.conditional ? ' [if]' : ''}` : '(none)',
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
