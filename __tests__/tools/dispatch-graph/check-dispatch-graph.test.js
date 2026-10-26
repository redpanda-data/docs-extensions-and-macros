'use strict'

/**
 * The run-record classifier and the whole check against a stubbed GitHub API.
 *
 * The scenarios mirror the 2026-10-22 audit, each with the shape that made it
 * invisible: a receiver with no listener (dispatch accepted and dropped), a
 * receiver that fails every run, a sender that has never fired, a listener no
 * one dispatches to (with and without a cron backstop), a payload variant no
 * sender carries, and the same edge dispatched from two repos. A healthy edge
 * and a clean graph are the negative controls: the check must exit 0 on them,
 * or a weekly issue announcing nothing would train everyone to ignore it.
 *
 * Also under test: an unreadable repo is exit 2, never 0. An unauthenticated
 * run cannot see the private docs repos, and the one thing this check must
 * never do is call that clean.
 */

const fs = require('fs')
const path = require('path')
const { summarizeRuns, classifyReceiver, classifySender } = require('../../../tools/dispatch-graph/classify-runs')
const { runCheck, buildGraph, formatReport, createGitHubApi, DEFAULT_REPOS, SENTINEL } = require('../../../tools/dispatch-graph/check-dispatch-graph')

const FIXTURES = path.join(__dirname, 'fixtures')
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

// ---------------------------------------------------------------------------
// Run fixtures
// ---------------------------------------------------------------------------

function run (i, conclusion, event = 'repository_dispatch') {
  return {
    id: i,
    event,
    status: conclusion ? 'completed' : 'in_progress',
    conclusion,
    created_at: new Date(Date.UTC(2026, 9, 22) - i * 86400000).toISOString(),
    html_url: `https://github.com/x/y/actions/runs/${i}`,
  }
}
const nRuns = (n, conclusion, event) => Array.from({ length: n }, (_, i) => run(i + 1, conclusion, event))

describe('summarizeRuns', () => {
  test('never ran', () => {
    const s = summarizeRuns([])
    expect(s).toMatchObject({ total: 0, dispatchRuns: 0, lastRunAt: null })
    expect(s.window.failRate).toBeNull()
  })

  test('counts conclusions, dispatch runs and the newest run', () => {
    const s = summarizeRuns([...nRuns(3, 'failure'), run(9, 'success', 'workflow_dispatch')])
    expect(s.total).toBe(4)
    expect(s.byConclusion).toEqual({ failure: 3, success: 1 })
    expect(s.dispatchRuns).toBe(3)
    expect(s.lastRunAt).toBe(run(1).created_at)
    expect(s.lastRunUrl).toMatch(/runs\/1$/)
  })

  test('the window is the newest N runs; skipped and cancelled do not count either way', () => {
    const runs = [...nRuns(5, 'failure'), ...nRuns(5, 'skipped').map((r, i) => ({ ...r, id: 50 + i, created_at: run(50 + i).created_at })), ...nRuns(30, 'success').map((r, i) => ({ ...r, id: 100 + i, created_at: run(100 + i).created_at }))]
    const s = summarizeRuns(runs, { window: 20 })
    expect(s.window.size).toBe(20)
    expect(s.window.considered).toBe(15)
    expect(s.window.failures).toBe(5)
    expect(s.window.failRate).toBeCloseTo(5 / 15)
  })

  test('sorts newest first even if the input is not', () => {
    const s = summarizeRuns([run(3, 'success'), run(1, 'failure'), run(2, 'success')])
    expect(s.lastConclusion).toBe('failure')
  })
})

describe('classifyReceiver', () => {
  test('never ran', () => expect(classifyReceiver(summarizeRuns([])).status).toBe('never-ran'))

  test('all failing is failing (the 48 of 48 case)', () => {
    const c = classifyReceiver(summarizeRuns(nRuns(48, 'failure')))
    expect(c.status).toBe('failing')
    expect(c.failRate).toBe(1)
  })

  test('mostly failing is failing (the 39 of 47 case)', () => {
    const c = classifyReceiver(summarizeRuns([...nRuns(20, 'failure'), ...nRuns(8, 'success').map((r, i) => ({ ...r, created_at: run(100 + i).created_at }))]))
    expect(c.status).toBe('failing')
  })

  test('exactly at the threshold is not above it', () => {
    const runs = [...nRuns(10, 'failure'), ...nRuns(10, 'success').map((r, i) => ({ ...r, id: 20 + i, created_at: run(20 + i).created_at }))]
    expect(classifyReceiver(summarizeRuns(runs)).status).toBe('healthy')
    expect(classifyReceiver(summarizeRuns(runs), { threshold: 0.4 }).status).toBe('failing')
  })

  test('healthy', () => {
    expect(classifyReceiver(summarizeRuns([...nRuns(19, 'success'), run(30, 'failure')])).status).toBe('healthy')
  })

  test('only manual runs is no-dispatch-runs (the generate-crd case)', () => {
    expect(classifyReceiver(summarizeRuns(nRuns(3, 'success', 'workflow_dispatch'))).status).toBe('no-dispatch-runs')
  })

  test('runs exist but none concluded is quiet', () => {
    expect(classifyReceiver(summarizeRuns(nRuns(2, null))).status).toBe('quiet')
  })
})

describe('classifySender', () => {
  test('never fired', () => expect(classifySender(summarizeRuns([])).status).toBe('never-fired'))
  test('fired', () => expect(classifySender(summarizeRuns(nRuns(1, 'success', 'release'))).status).toBe('fired'))
})

// ---------------------------------------------------------------------------
// Whole check against a stubbed API
// ---------------------------------------------------------------------------

/**
 * @param {Object<string, Object<string, string>>} files - repo -> { workflowFile: yamlText }
 * @param {Object<string, Array>} runs - "repo/file" -> workflow_runs
 * @param {object} [opts]
 * @param {string[]} [opts.unreadable] - repos whose reads fail with 404
 * @param {string[]} [opts.runsUnreadable] - "repo/file" whose runs query fails
 * @param {Object<string, {fullName?: string, archived?: boolean}>} [opts.meta] - configured repo -> what repos.get returns
 * @param {Object<string, Object<string, string>>} [opts.states] - repo -> { file: workflow state }; default active
 * @param {Object<string, Array>} [opts.jobs] - "repo#runId" -> jobs for that run
 */
function fakeApi (files, runs, opts = {}) {
  const calls = []
  const notFound = (what) => Object.assign(new Error(`Not Found: ${what}`), { status: 404 })
  return {
    calls,
    async getDefaultBranch (repo) {
      calls.push(['branch', repo])
      if ((opts.unreadable || []).includes(repo)) throw notFound(repo)
      return repo.endsWith('streaming-enterprise') ? 'dev' : 'main'
    },
    async getRepo (repo) {
      calls.push(['repo', repo])
      if ((opts.unreadable || []).includes(repo)) throw notFound(repo)
      const m = (opts.meta || {})[repo] || {}
      const fullName = m.fullName || repo
      return { fullName, defaultBranch: fullName.endsWith('streaming-enterprise') ? 'dev' : 'main', archived: Boolean(m.archived) }
    },
    async listWorkflows (repo) {
      calls.push(['workflows', repo])
      const st = (opts.states || {})[repo] || {}
      return Object.keys(files[repo] || {}).map((f) => ({ path: `.github/workflows/${f}`, state: st[f] || 'active' }))
    },
    async listJobsForRun (repo, runId) {
      calls.push(['jobs', repo, runId])
      return (opts.jobs || {})[`${repo}#${runId}`] || []
    },
    async listWorkflowFiles (repo, ref) {
      calls.push(['list', repo, ref])
      return Object.keys(files[repo] || {})
    },
    async getFileText (repo, p, ref) {
      calls.push(['file', repo, p, ref])
      const name = p.replace(/^\.github\/workflows\//, '')
      if (!files[repo] || files[repo][name] === undefined) throw notFound(p)
      return files[repo][name]
    },
    async listWorkflowRuns (repo, file, perPage, q = {}) {
      calls.push(['runs', repo, file, perPage, q.event || null])
      if ((opts.runsUnreadable || []).includes(`${repo}/${file}`)) throw notFound(`${repo}/${file} runs`)
      // Like the API: newest first, filtered by event when asked, capped at per_page.
      return (runs[`${repo}/${file}`] || []).filter((r) => !q.event || r.event === q.event).slice(0, perPage)
    },
  }
}

const ENG = (repo) => ({ repo: `redpanda-data/${repo}`, role: 'engineering' })
const DOCS = (repo) => ({ repo: `redpanda-data/${repo}`, role: 'docs' })

const listener = (type, extra = '') => [
  'name: L', 'on:', '  repository_dispatch:', `    types: [${type}]`, extra, 'jobs:', '  j:', '    runs-on: x', '    steps:', '      - run: echo',
].join('\n')
const cronListener = (type) => listener(type, '  schedule:\n    - cron: "0 6 * * *"')
const sender = (target, type, payload) => [
  'name: S', 'on:', '  release:', '    types: [published]', 'jobs:', '  j:', '    runs-on: x', '    steps:',
  '      - uses: peter-evans/repository-dispatch@v4', '        with:', `          repository: redpanda-data/${target}`, `          event-type: ${type}`,
  payload ? `          client-payload: '${JSON.stringify(payload)}'` : '',
].join('\n')

const kinds = (result) => result.findings.map((f) => f.kind).sort()
const infoKinds = (result) => result.info.map((i) => i.kind).sort()

describe('runCheck: a healthy graph is exit 0', () => {
  test('one edge, sender fired, receiver succeeding', async () => {
    const api = fakeApi(
      { 'redpanda-data/eng': { 'send.yml': sender('docs', 'ev') }, 'redpanda-data/docs': { 'recv.yml': listener('ev') } },
      { 'redpanda-data/eng/send.yml': nRuns(5, 'success', 'release'), 'redpanda-data/docs/recv.yml': nRuns(5, 'success') },
    )
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(r.exitCode).toBe(0)
    expect(r.findings).toEqual([])
    expect(r.counts).toMatchObject({ repos: 2, senders: 1, listeners: 1, edges: 1 })
    expect(formatReport(r)).toMatch(/✓ No findings/)
    expect(formatReport(r)).not.toContain(SENTINEL)
  })

  test('a receiver with a few failures is still healthy', async () => {
    const api = fakeApi(
      { 'redpanda-data/eng': { 'send.yml': sender('docs', 'ev') }, 'redpanda-data/docs': { 'recv.yml': listener('ev') } },
      { 'redpanda-data/eng/send.yml': nRuns(5, 'success', 'release'), 'redpanda-data/docs/recv.yml': [...nRuns(17, 'success'), ...nRuns(3, 'failure').map((x, i) => ({ ...x, id: 90 + i, created_at: run(90 + i).created_at }))] },
    )
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(r.exitCode).toBe(0)
  })
})

describe('runCheck: the audit findings, each reproduced from fixtures', () => {
  test('1. sender listens for release, has never run; receiver has only manual runs', async () => {
    const api = fakeApi(
      { 'redpanda-data/redpanda-operator': { 'dispatch-crd-docs.yml': sender('docs', 'generate-crd-docs') }, 'redpanda-data/docs': { 'generate-crd.yml': listener('generate-crd-docs') } },
      { 'redpanda-data/redpanda-operator/dispatch-crd-docs.yml': [], 'redpanda-data/docs/generate-crd.yml': nRuns(3, 'success', 'workflow_dispatch') },
    )
    const r = await runCheck({ repos: [ENG('redpanda-operator'), DOCS('docs')], api })
    expect(r.exitCode).toBe(1)
    expect(kinds(r)).toEqual(['sender-never-fired'])
    expect(r.findings[0].message).toMatch(/release created by a workflow using GITHUB_TOKEN/)
    expect(infoKinds(r)).toEqual(['receiver-no-dispatch-runs'])
  })

  test('2. one dispatch with no listener, the other to a receiver failing every run', async () => {
    const twoTargets = read('sender-peter-evans.yml')
    const api = fakeApi(
      {
        'redpanda-data/helm-charts': { 'dispatch_helm_docs.yaml': twoTargets.replace('generate-crd-docs', 'generate-helm-spec-docs') },
        'redpanda-data/docs': {},
        'redpanda-data/rp-connect-docs': { 'generate-helm-spec.yml': listener('generate-helm-spec-docs') },
      },
      { 'redpanda-data/helm-charts/dispatch_helm_docs.yaml': nRuns(48, 'success', 'push'), 'redpanda-data/rp-connect-docs/generate-helm-spec.yml': nRuns(48, 'failure') },
    )
    const r = await runCheck({ repos: [ENG('helm-charts'), DOCS('docs'), DOCS('rp-connect-docs')], api })
    expect(r.exitCode).toBe(1)
    expect(kinds(r)).toEqual(['receiver-failing', 'sender-without-listener'])
    const failing = r.findings.find((f) => f.kind === 'receiver-failing')
    expect(failing.message).toMatch(/failed 20 of its newest 20 runs \(100%\)/)
    const noListener = r.findings.find((f) => f.kind === 'sender-without-listener')
    expect(noListener.message).toMatch(/docs#generate-helm-spec-docs/)
    expect(noListener.message).toMatch(/accepts the dispatch \(204\)/)
  })

  test('3. receiver failing 39 of 47 is above the threshold over the newest 20', async () => {
    const runs = [...nRuns(39, 'failure'), ...nRuns(8, 'success').map((x, i) => ({ ...x, id: 200 + i, created_at: run(200 + i).created_at }))]
    const api = fakeApi(
      { 'redpanda-data/redpanda-operator': { 'acc.yml': sender('docs', 'trigger-acceptance-test-pull') }, 'redpanda-data/docs': { 'fetch-acceptance-tests.yml': listener('trigger-acceptance-test-pull') } },
      { 'redpanda-data/redpanda-operator/acc.yml': nRuns(47, 'success', 'push'), 'redpanda-data/docs/fetch-acceptance-tests.yml': runs },
    )
    const r = await runCheck({ repos: [ENG('redpanda-operator'), DOCS('docs')], api })
    expect(kinds(r)).toEqual(['receiver-failing'])
  })

  test('4. a choice-input variant no sender dispatches', async () => {
    const api = fakeApi(
      {
        'redpanda-data/cloudv2': { 'rpai.yml': sender('docs', 'update-rpk-plugin-docs', { plugin: 'ai' }) },
        'redpanda-data/redpanda-check': { 'release.yml': sender('docs', 'update-rpk-plugin-docs', { plugin: 'check' }) },
        'redpanda-data/redpanda-operator': { 'release.yml': sender('docs', 'update-rpk-plugin-docs', { plugin: 'k8s' }) },
        'redpanda-data/connect': { 'release.yml': read('negative-workflow-dispatch-only.yml') },
        'redpanda-data/docs': { 'update-rpk-plugin-docs.yml': read('listener-types.yml').replace('[trigger-property-docs-generation, trigger-cloud-property-sync]', '[update-rpk-plugin-docs]') },
      },
      Object.fromEntries([
        ['redpanda-data/cloudv2/rpai.yml', nRuns(3, 'success', 'release')],
        ['redpanda-data/redpanda-check/release.yml', nRuns(3, 'success', 'release')],
        ['redpanda-data/redpanda-operator/release.yml', nRuns(3, 'success', 'release')],
        ['redpanda-data/docs/update-rpk-plugin-docs.yml', nRuns(10, 'success')],
      ]),
    )
    const r = await runCheck({ repos: [ENG('cloudv2'), ENG('redpanda-check'), ENG('redpanda-operator'), ENG('connect'), DOCS('docs')], api })
    expect(kinds(r)).toEqual(['payload-variant-without-sender'])
    expect(r.findings[0].message).toMatch(/plugin: connect/)
    // Three senders with distinct payloads are variants, not duplicates.
    expect(kinds(r)).not.toContain('duplicate-sender')
  })

  test('5. docs listeners with no sender: cron-backstopped is informational, bare is a finding', async () => {
    const api = fakeApi(
      { 'redpanda-data/cloud-docs': { 'update-cloud-regions.yml': cronListener('trigger-cloud-regions'), 'orphan.yml': listener('nobody-sends-this') } },
      { 'redpanda-data/cloud-docs/update-cloud-regions.yml': nRuns(40, 'success', 'schedule'), 'redpanda-data/cloud-docs/orphan.yml': [] },
    )
    const r = await runCheck({ repos: [DOCS('cloud-docs')], api })
    expect(kinds(r)).toEqual(['listener-without-sender'])
    expect(r.findings[0].message).toMatch(/orphan\.yml/)
    expect(infoKinds(r)).toEqual(['listener-without-sender'])
    expect(r.info[0].message).toMatch(/update-cloud-regions\.yml.*schedule runs it anyway/)
  })

  test('5b. a cron-backstopped orphan alone is exit 0', async () => {
    const api = fakeApi(
      { 'redpanda-data/cloud-docs': { 'update-cloud-regions.yml': cronListener('trigger-cloud-regions') } },
      { 'redpanda-data/cloud-docs/update-cloud-regions.yml': nRuns(40, 'success', 'schedule') },
    )
    const r = await runCheck({ repos: [DOCS('cloud-docs')], api })
    expect(r.exitCode).toBe(0)
    expect(r.info).toHaveLength(1)
  })

  test('6. the same edge with the same payload from two repos, with each sender\'s last run', async () => {
    const api = fakeApi(
      {
        'redpanda-data/redpanda': { 'dispatch-docs-updates.yml': sender('api-docs', 'redpanda-openapi-bundle') },
        'redpanda-data/streaming-enterprise': { 'dispatch-docs-updates.yml': sender('api-docs', 'redpanda-openapi-bundle') },
        'redpanda-data/api-docs': { 'get-admin-api-spec.yml': listener('redpanda-openapi-bundle') },
      },
      {
        'redpanda-data/redpanda/dispatch-docs-updates.yml': [run(63, 'success', 'release')],
        'redpanda-data/streaming-enterprise/dispatch-docs-updates.yml': [run(6, 'success', 'release')],
        'redpanda-data/api-docs/get-admin-api-spec.yml': nRuns(5, 'success'),
      },
    )
    const r = await runCheck({ repos: [ENG('redpanda'), ENG('streaming-enterprise'), DOCS('api-docs')], api })
    expect(r.exitCode).toBe(1)
    expect(kinds(r)).toEqual(['duplicate-sender'])
    expect(r.findings[0].severity).toBe('warning')
    expect(r.findings[0].message).toMatch(/redpanda\/dispatch-docs-updates\.yml \(last run 2026-08-20\)/)
    expect(r.findings[0].message).toMatch(/streaming-enterprise\/dispatch-docs-updates\.yml \(last run 2026-10-16\)/)
  })
})

describe('runCheck: scope and resolution', () => {
  test('a dispatch to a repo outside the scanned set is informational, never a finding', async () => {
    const api = fakeApi(
      { 'redpanda-data/console': { 'rd.yml': read('sender-non-docs-target.yml') } },
      { 'redpanda-data/console/rd.yml': nRuns(2, 'success', 'push') },
    )
    const r = await runCheck({ repos: [ENG('console')], api })
    expect(r.exitCode).toBe(0)
    expect(infoKinds(r)).toEqual(['unscanned-target'])
  })

  test('engineering-side listeners nothing dispatches to are left out of the graph', async () => {
    const api = fakeApi(
      { 'redpanda-data/eng': { 'backport.yml': listener('backport-command') } },
      {},
    )
    const r = await runCheck({ repos: [ENG('eng')], api })
    expect(r.exitCode).toBe(0)
    expect(r.edges).toEqual([])
    expect(r.counts.outOfScopeListeners).toBe(1)
    // Their runs are not fetched either.
    expect(api.calls.filter((c) => c[0] === 'runs')).toEqual([])
  })

  test('an any-type listener matches every dispatch to its repo', async () => {
    const api = fakeApi(
      { 'redpanda-data/eng': { 's.yml': sender('docs', 'whatever') }, 'redpanda-data/docs': { 'any.yml': read('listener-any-type.yml') } },
      { 'redpanda-data/eng/s.yml': nRuns(1, 'success', 'release'), 'redpanda-data/docs/any.yml': nRuns(1, 'success') },
    )
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(r.exitCode).toBe(0)
    expect(r.edges[0].listeners).toHaveLength(1)
  })

  test('an unresolvable sender is reported, not guessed', async () => {
    const api = fakeApi({ 'redpanda-data/eng': { 'u.yml': read('sender-unresolved.yml') } }, {})
    const r = await runCheck({ repos: [ENG('eng')], api })
    expect(r.exitCode).toBe(0)
    expect(infoKinds(r)).toEqual(['unresolved-sender'])
  })

  test('a reusable (workflow_call-only) sender with no runs of its own is not "never fired"', async () => {
    const api = fakeApi(
      { 'redpanda-data/dem': { 'review.yml': read('sender-jq-input.yml') }, 'redpanda-data/docs-site': { 'impact.yml': listener('doc-impact') } },
      { 'redpanda-data/dem/review.yml': [], 'redpanda-data/docs-site/impact.yml': nRuns(5, 'success') },
    )
    const r = await runCheck({ repos: [DOCS('dem'), DOCS('docs-site')], api })
    expect(r.exitCode).toBe(0)
    expect(infoKinds(r)).toEqual(['reusable-sender'])
  })

  test('a sender that fired while the receiver never ran from a dispatch is a finding', async () => {
    const api = fakeApi(
      { 'redpanda-data/eng': { 's.yml': sender('docs', 'ev') }, 'redpanda-data/docs': { 'r.yml': listener('ev') } },
      { 'redpanda-data/eng/s.yml': nRuns(4, 'success', 'release'), 'redpanda-data/docs/r.yml': nRuns(2, 'success', 'workflow_dispatch') },
    )
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(kinds(r)).toEqual(['receiver-never-received'])
  })

  test('an unparseable workflow is informational and does not stop the scan', async () => {
    const api = fakeApi(
      { 'redpanda-data/docs': { 'bad.yml': 'on: [\n', 'good.yml': cronListener('x') } },
      { 'redpanda-data/docs/good.yml': nRuns(1, 'success', 'schedule') },
    )
    const r = await runCheck({ repos: [DOCS('docs')], api })
    expect(r.exitCode).toBe(0)
    expect(infoKinds(r)).toEqual(['listener-without-sender', 'parse-error'])
  })
})

describe('runCheck: dispatch runs are counted even when other events fill the page', () => {
  // The listener also runs on pull_request. Its 50 newest runs are all PR
  // runs and its last dispatch run is the 61st, beyond one page.
  const busy = Array.from({ length: 70 }, (_, i) => run(i + 1, 'success', i === 60 ? 'repository_dispatch' : 'pull_request'))
  const files = { 'redpanda-data/eng': { 's.yml': sender('docs', 'ev') }, 'redpanda-data/docs': { 'r.yml': listener('ev', '  pull_request:') } }

  test('a dispatch run beyond the newest page is still a received dispatch', async () => {
    const api = fakeApi(files, { 'redpanda-data/eng/s.yml': nRuns(1, 'success', 'release'), 'redpanda-data/docs/r.yml': busy })
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(kinds(r)).toEqual([])
    expect(r.exitCode).toBe(0)
    expect(api.calls).toContainEqual(['runs', 'redpanda-data/docs', 'r.yml', 50, 'repository_dispatch'])
  })

  test('negative control: a full page and no dispatch run anywhere is still receiver-never-received', async () => {
    const api = fakeApi(files, { 'redpanda-data/eng/s.yml': nRuns(1, 'success', 'release'), 'redpanda-data/docs/r.yml': nRuns(70, 'success', 'pull_request') })
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(kinds(r)).toEqual(['receiver-never-received'])
  })

  test('a page that is not full is the whole history, so no filtered query is made', async () => {
    const api = fakeApi(files, { 'redpanda-data/eng/s.yml': nRuns(1, 'success', 'release'), 'redpanda-data/docs/r.yml': nRuns(5, 'success') })
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(r.exitCode).toBe(0)
    expect(api.calls.filter((c) => c[0] === 'runs' && c[4])).toEqual([])
  })
})

describe('runCheck: a gated dispatch step counts only when it ran', () => {
  const gated = [
    'name: S', 'on:', '  push:', '  release:', '    types: [published]', 'jobs:', '  dispatch:', '    runs-on: x', '    steps:',
    '      - name: Dispatch', "        if: github.event_name == 'release'", '        uses: peter-evans/repository-dispatch@v4',
    '        with:', '          repository: redpanda-data/docs', '          event-type: ev',
  ].join('\n')
  const files = { 'redpanda-data/eng': { 's.yml': gated }, 'redpanda-data/docs': { 'r.yml': listener('ev') } }
  const senderRuns = nRuns(8, 'success', 'push')
  const jobsWith = (conclusion) => Object.fromEntries(senderRuns.map((r) => [`redpanda-data/eng#${r.id}`, [
    { name: 'dispatch', conclusion: 'success', steps: [{ name: 'Set up job', number: 1, conclusion: 'success' }, { name: 'Dispatch', number: 2, conclusion }] },
  ]]))

  test('the sender is recorded as conditional', async () => {
    const api = fakeApi(files, { 'redpanda-data/eng/s.yml': senderRuns, 'redpanda-data/docs/r.yml': nRuns(3, 'success') }, { jobs: jobsWith('success') })
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(r.edges[0].senders[0]).toMatchObject({ conditional: true, condition: "github.event_name == 'release'" })
    expect(formatReport(r)).toMatch(/eng\/s\.yml \[if\]/)
  })

  test('the step succeeded in the newest run: fired, one jobs call', async () => {
    const api = fakeApi(files, { 'redpanda-data/eng/s.yml': senderRuns, 'redpanda-data/docs/r.yml': nRuns(3, 'success') }, { jobs: jobsWith('success') })
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(r.exitCode).toBe(0)
    expect(api.calls.filter((c) => c[0] === 'jobs')).toHaveLength(1)
  })

  test('the step was skipped in every run checked: a finding, and no more than stepRuns jobs calls', async () => {
    const api = fakeApi(files, { 'redpanda-data/eng/s.yml': senderRuns, 'redpanda-data/docs/r.yml': nRuns(3, 'success', 'workflow_dispatch') }, { jobs: jobsWith('skipped') })
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api, stepRuns: 5 })
    expect(kinds(r)).toEqual(['sender-step-never-succeeded'])
    expect(r.findings[0].message).toMatch(/"Dispatch" \(if: github.event_name == 'release'\)/)
    expect(api.calls.filter((c) => c[0] === 'jobs')).toHaveLength(5)
    // The receiver's lack of dispatch runs is explained by the sender, not reported twice.
    expect(kinds(r)).not.toContain('receiver-never-received')
  })

  test('a job skipped by its own if: has no steps and counts as not dispatched', async () => {
    const jobs = Object.fromEntries(senderRuns.map((r) => [`redpanda-data/eng#${r.id}`, [{ name: 'dispatch', conclusion: 'skipped', steps: [] }]]))
    const api = fakeApi(files, { 'redpanda-data/eng/s.yml': senderRuns, 'redpanda-data/docs/r.yml': nRuns(3, 'success') }, { jobs })
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(kinds(r)).toEqual(['sender-step-never-succeeded'])
  })

  test('a step that cannot be found in the jobs falls back to the workflow run, with a note', async () => {
    const api = fakeApi(files, { 'redpanda-data/eng/s.yml': senderRuns, 'redpanda-data/docs/r.yml': nRuns(3, 'success') }, { jobs: {} })
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(r.exitCode).toBe(0)
    expect(infoKinds(r)).toContain('conditional-sender')
  })

  test('negative control: an ungated sender makes no jobs calls', async () => {
    const api = fakeApi(
      { 'redpanda-data/eng': { 's.yml': sender('docs', 'ev') }, 'redpanda-data/docs': { 'r.yml': listener('ev') } },
      { 'redpanda-data/eng/s.yml': nRuns(3, 'success', 'release'), 'redpanda-data/docs/r.yml': nRuns(3, 'success') },
    )
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(r.exitCode).toBe(0)
    expect(r.edges[0].senders[0].conditional).toBe(false)
    expect(api.calls.filter((c) => c[0] === 'jobs')).toEqual([])
  })
})

describe('runCheck: archived repos, disabled workflows, case and renames', () => {
  const healthyRuns = { 'redpanda-data/eng/s.yml': nRuns(3, 'success', 'release'), 'redpanda-data/docs/r.yml': nRuns(3, 'success') }

  test('an archived repo is skipped as a sender, with an info note', async () => {
    const api = fakeApi(
      { 'redpanda-data/old': { 's.yml': sender('docs', 'ev') }, 'redpanda-data/docs': { 'r.yml': cronListener('ev') } },
      { 'redpanda-data/old/s.yml': [], 'redpanda-data/docs/r.yml': nRuns(3, 'success', 'schedule') },
      { meta: { 'redpanda-data/old': { archived: true } } },
    )
    const r = await runCheck({ repos: [ENG('old'), DOCS('docs')], api })
    expect(kinds(r)).toEqual([])
    expect(infoKinds(r)).toEqual(['archived-repo', 'listener-without-sender'])
    expect(api.calls.filter((c) => c[0] === 'list' && c[1] === 'redpanda-data/old')).toEqual([])
  })

  test('a disabled listener is an error even when its past runs look healthy', async () => {
    const api = fakeApi(
      { 'redpanda-data/eng': { 's.yml': sender('docs', 'ev') }, 'redpanda-data/docs': { 'r.yml': listener('ev') } },
      healthyRuns,
      { states: { 'redpanda-data/docs': { 'r.yml': 'disabled_manually' } } },
    )
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(kinds(r)).toEqual(['receiver-disabled'])
    expect(r.findings[0].message).toMatch(/disabled_manually/)
  })

  test('negative control: an active listener is not flagged, and the workflow list is one call per repo in the graph', async () => {
    const api = fakeApi({ 'redpanda-data/eng': { 's.yml': sender('docs', 'ev') }, 'redpanda-data/docs': { 'r.yml': listener('ev') } }, healthyRuns)
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(r.exitCode).toBe(0)
    expect(api.calls.filter((c) => c[0] === 'workflows').map((c) => c[1]).sort()).toEqual(['redpanda-data/docs', 'redpanda-data/eng'])
  })

  // The stale copy left in the frozen public repo after the move to
  // streaming-enterprise: disabling it is the fix, so the check must accept it.
  const duplicateFiles = {
    'redpanda-data/redpanda': { 'dispatch-docs-updates.yml': sender('api-docs', 'redpanda-openapi-bundle') },
    'redpanda-data/streaming-enterprise': { 'dispatch-docs-updates.yml': sender('api-docs', 'redpanda-openapi-bundle') },
    'redpanda-data/api-docs': { 'get-admin-api-spec.yml': listener('redpanda-openapi-bundle') },
  }
  const duplicateRuns = {
    'redpanda-data/redpanda/dispatch-docs-updates.yml': [run(63, 'success', 'release')],
    'redpanda-data/streaming-enterprise/dispatch-docs-updates.yml': [run(6, 'success', 'release')],
    'redpanda-data/api-docs/get-admin-api-spec.yml': nRuns(5, 'success'),
  }
  const duplicateRepos = [ENG('redpanda'), ENG('streaming-enterprise'), DOCS('api-docs')]

  test('a disabled sender is not a duplicate, with an info note', async () => {
    const api = fakeApi(duplicateFiles, duplicateRuns, { states: { 'redpanda-data/redpanda': { 'dispatch-docs-updates.yml': 'disabled_manually' } } })
    const r = await runCheck({ repos: duplicateRepos, api })
    expect(r.exitCode).toBe(0)
    expect(kinds(r)).toEqual([])
    expect(infoKinds(r)).toEqual(['sender-disabled'])
    expect(r.info[0].message).toMatch(/redpanda\/dispatch-docs-updates\.yml is disabled_manually/)
  })

  test('negative control: the same two senders, both active, are still a duplicate', async () => {
    const r = await runCheck({ repos: duplicateRepos, api: fakeApi(duplicateFiles, duplicateRuns) })
    expect(kinds(r)).toEqual(['duplicate-sender'])
    expect(infoKinds(r)).toEqual([])
  })

  test('a disabled sender that never ran is not sender-never-fired', async () => {
    const api = fakeApi(
      { 'redpanda-data/eng': { 's.yml': sender('docs', 'ev') }, 'redpanda-data/docs': { 'r.yml': cronListener('ev') } },
      { 'redpanda-data/eng/s.yml': [], 'redpanda-data/docs/r.yml': nRuns(3, 'success', 'schedule') },
      { states: { 'redpanda-data/eng': { 's.yml': 'disabled_inactivity' } } },
    )
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(kinds(r)).toEqual([])
    expect(infoKinds(r)).toEqual(['receiver-no-dispatch-runs', 'sender-disabled'])
  })

  test('a mixed-case repository: target matches the lowercase listener', async () => {
    const api = fakeApi(
      { 'redpanda-data/eng': { 's.yml': sender('docs', 'ev').replace('redpanda-data/docs', 'Redpanda-Data/Docs') }, 'redpanda-data/docs': { 'r.yml': listener('ev') } },
      healthyRuns,
    )
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(kinds(r)).toEqual([])
    expect(r.edges.map((e) => e.key)).toEqual(['redpanda-data/docs#ev'])
  })

  test('a renamed repo is followed and keyed by its current full_name, and dispatches to the old name resolve', async () => {
    const api = fakeApi(
      { 'redpanda-data/eng': { 's.yml': sender('old-docs', 'ev') }, 'redpanda-data/docs': { 'r.yml': listener('ev') } },
      healthyRuns,
      { meta: { 'redpanda-data/old-docs': { fullName: 'redpanda-data/docs' } } },
    )
    const r = await runCheck({ repos: [ENG('eng'), DOCS('old-docs')], api })
    expect(kinds(r)).toEqual([])
    expect(infoKinds(r)).toEqual(['renamed-repo'])
    expect(r.scanned.map((x) => x.repo)).toEqual(['redpanda-data/docs', 'redpanda-data/eng'])
    expect(r.edges.map((e) => e.key)).toEqual(['redpanda-data/docs#ev'])
  })

  test('a repo configured under both its old and new name is scanned once', async () => {
    const api = fakeApi(
      { 'redpanda-data/docs': { 'r.yml': cronListener('ev') } },
      { 'redpanda-data/docs/r.yml': nRuns(1, 'success', 'schedule') },
      { meta: { 'redpanda-data/old-docs': { fullName: 'redpanda-data/docs' } } },
    )
    const r = await runCheck({ repos: [DOCS('old-docs'), DOCS('docs')], api })
    expect(r.scanned).toHaveLength(1)
    expect(r.counts.listeners).toBe(1)
  })
})

describe('runCheck: could-not-run is exit 2 and never looks clean', () => {
  test('an unreadable repo (404: private, no token) is exit 2 even when everything readable is healthy', async () => {
    const api = fakeApi(
      { 'redpanda-data/eng': { 's.yml': sender('docs', 'ev') } },
      { 'redpanda-data/eng/s.yml': nRuns(1, 'success', 'release') },
      { unreadable: ['redpanda-data/docs'] },
    )
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(r.exitCode).toBe(2)
    expect(r.unreadable).toEqual([expect.objectContaining({ repo: 'redpanda-data/docs' })])
    // The readable half is still reported, so a partial run is still useful.
    expect(formatReport(r)).toMatch(/Could not read 1 thing/)
    expect(formatReport(r)).toMatch(/needs a token/)
  })

  test('a runs query that fails is exit 2, findings elsewhere notwithstanding', async () => {
    const api = fakeApi(
      { 'redpanda-data/eng': { 's.yml': sender('docs', 'ev') }, 'redpanda-data/docs': { 'r.yml': listener('ev') } },
      { 'redpanda-data/eng/s.yml': [] },
      { runsUnreadable: ['redpanda-data/docs/r.yml'] },
    )
    const r = await runCheck({ repos: [ENG('eng'), DOCS('docs')], api })
    expect(r.exitCode).toBe(2)
    expect(kinds(r)).toContain('sender-never-fired')
  })

  test('runCheck without an api throws rather than scanning nothing', async () => {
    await expect(runCheck({})).rejects.toThrow(/requires an api/)
  })
})

describe('buildGraph on its own', () => {
  test('senders and listeners join on target repo plus event type', () => {
    const g = buildGraph({
      senders: [{ repo: 'o/a', file: 'a.yml', targetRepo: 'o/d', eventType: 'ev', unresolved: false, payload: {}, triggers: ['push'] }],
      listeners: [{ repo: 'o/d', file: 'd.yml', eventType: 'ev', cronBackstop: false, choiceInputs: {} }],
      scannedRepos: ['o/a', 'o/d'],
      docsRepos: ['o/d'],
    })
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0].senders).toHaveLength(1)
    expect(g.edges[0].listeners).toHaveLength(1)
    expect(g.findings).toEqual([])
  })
})

describe('the default repo set', () => {
  test('names the audited senders and receivers with a role each', () => {
    const repos = DEFAULT_REPOS.map((r) => r.repo)
    for (const r of ['redpanda-data/streaming-enterprise', 'redpanda-data/redpanda', 'redpanda-data/cloudv2', 'redpanda-data/redpanda-operator',
      'redpanda-data/connect', 'redpanda-data/helm-charts', 'redpanda-data/redpanda-check', 'redpanda-data/docs', 'redpanda-data/cloud-docs',
      'redpanda-data/rp-connect-docs', 'redpanda-data/api-docs', 'redpanda-data/adp-docs', 'redpanda-data/docs-site', 'redpanda-data/docs-ui',
      'redpanda-data/docs-extensions-and-macros']) {
      expect(repos).toContain(r)
    }
    expect(DEFAULT_REPOS.every((r) => ['engineering', 'docs'].includes(r.role))).toBe(true)
  })
})

describe('createGitHubApi adapts Octokit', () => {
  test('decodes file content and maps the runs call', async () => {
    const octokit = {
      repos: {
        get: async () => ({ data: { default_branch: 'dev', full_name: 'O/Renamed', archived: true } }),
        getContent: async ({ path: p }) => p === '.github/workflows'
          ? ({ data: [{ type: 'file', name: 'a.yml' }, { type: 'file', name: 'README.md' }, { type: 'dir', name: 'x' }] })
          : ({ data: { content: Buffer.from('name: hi').toString('base64'), encoding: 'base64' } }),
      },
      actions: {
        listWorkflowRuns: async (p) => ({ data: { workflow_runs: [{ id: p.per_page, event: p.event }] } }),
        listRepoWorkflows: async () => ({ data: { workflows: [{ path: '.github/workflows/a.yml', state: 'disabled_inactivity', id: 1 }] } }),
        listJobsForWorkflowRun: async (p) => ({ data: { jobs: [{ name: 'j', run: p.run_id }] } }),
      },
    }
    const api = createGitHubApi(octokit)
    expect(await api.getDefaultBranch('o/r')).toBe('dev')
    expect(await api.getRepo('o/r')).toEqual({ fullName: 'O/Renamed', defaultBranch: 'dev', archived: true })
    expect(await api.listWorkflowFiles('o/r', 'dev')).toEqual(['a.yml'])
    expect(await api.getFileText('o/r', '.github/workflows/a.yml', 'dev')).toBe('name: hi')
    expect(await api.listWorkflowRuns('o/r', 'a.yml', 50)).toEqual([{ id: 50 }])
    expect(await api.listWorkflowRuns('o/r', 'a.yml', 50, { event: 'repository_dispatch' })).toEqual([{ id: 50, event: 'repository_dispatch' }])
    expect(await api.listWorkflows('o/r')).toEqual([{ path: '.github/workflows/a.yml', state: 'disabled_inactivity' }])
    expect(await api.listJobsForRun('o/r', 7)).toEqual([{ name: 'j', run: 7 }])
  })
})
