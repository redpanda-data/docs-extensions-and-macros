'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const YAML = require('yaml')
const { spawnSync } = require('child_process')
const { execRun } = require('./helpers/exec-run')

/**
 * The reusable check-metadata workflow runs `doc-tools check-metadata
 * --suggest` by default and reports the suggestions in the job summary and as
 * notices, without ever failing the job. These tests execute the two steps'
 * run: bodies (helpers/exec-run.js) with npx stubbed, and once with npx running
 * this repository's own doc-tools on a real git checkout.
 */

const ROOT = path.join(__dirname, '..', '..')
const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'check-metadata.yml'), 'utf8'))
const job = workflow.jobs['check-metadata']
const stepNamed = (name) => {
  const step = job.steps.find((s) => s.name === name)
  if (!step) throw new Error(`no step named ${name}; steps: ${job.steps.map((s) => s.name || s.uses).join(', ')}`)
  return step
}
const CHECK = stepNamed('Check page metadata')
const REPORT = stepNamed('Report taxonomy suggestions')
const TAXONOMY = path.join(ROOT, '__tests__', 'fixtures', 'taxonomy', 'taxonomy.yml')
const BIN = path.join(ROOT, 'bin', 'doc-tools.js')

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'check-metadata-wf-'))

const suggestion = (over = {}) => ({
  file: 'modules/manage/pages/a.adoc',
  kind: 'docs',
  line: 1,
  uncategorized: true,
  facet: 'topic',
  attribute: 'page-categories',
  conceptId: 'tiered-storage',
  label: 'Tiered Storage',
  score: 14,
  reason: 'named in the title and 1 body mention',
  implies: [],
  evidence: [{ term: 'Tiered Storage', location: 'title', line: 1, via: 'prefLabel', label: 'Tiered Storage' }],
  ...over,
})
const result = ({ suggestions = [], findings = [], uncategorized = [], needs = [] } = {}) => ({
  files: 1,
  pages: 1,
  solutions: 0,
  findings,
  summary: { errors: findings.filter((f) => f.severity === 'error').length, warnings: findings.filter((f) => f.severity !== 'error').length },
  suggest: { minScore: { docs: 5, solution: 3 }, limit: { docs: 3, solution: 6 }, terminology: [], suggestions, needs, candidates: [], uncategorized },
})

// An npx that answers like doc-tools check-metadata: logs its arguments,
// writes `json` to the --output path, and exits `rc`.
const npxStub = ({ json, rc = 0 }) => `#!/bin/bash
echo "$*" >> npx.log
out=""; prev=""
for a in "$@"; do [ "$prev" = --output ] && out="$a"; prev="$a"; done
cat > "$out" <<'JSON'
${JSON.stringify(json)}
JSON
exit ${rc}
`

function runCheck ({ npx, suggest = 'true', strict = 'false' }) {
  return execRun(CHECK, {
    env: { BASE: 'origin/main', DOC_TOOLS_VERSION: '9.9.9', STRICT: strict, PATHS: '', TAXONOMY: '', SUGGEST: suggest, GITHUB_STEP_SUMMARY: path.join(tmpdir(), 'summary.md') },
    stubs: { npx },
  })
}

function runReport (json) {
  const summary = path.join(tmpdir(), 'summary.md')
  const files = json === undefined ? {} : { 'check-metadata.json': typeof json === 'string' ? json : JSON.stringify(json) }
  const r = execRun(REPORT, { env: { GITHUB_STEP_SUMMARY: summary }, files })
  return { ...r, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '', notices: r.stdout.split('\n').filter((l) => l.startsWith('::notice')) }
}

describe('check-metadata workflow: the suggest input', () => {
  test('defaults to true, so callers get suggestions without opting in', () => {
    const input = workflow.on.workflow_call.inputs.suggest
    expect(input).toMatchObject({ type: 'boolean', default: true })
    expect(CHECK.env.SUGGEST).toBe('${{ inputs.suggest }}')
    expect(REPORT.if).toMatch(/inputs\.suggest/)
  })

  test('suggest: true passes --suggest; false does not', () => {
    const on = runCheck({ npx: npxStub({ json: result() }) })
    expect(on.status).toBe(0)
    expect(on.read('npx.log')).toMatch(/check-metadata --changed origin\/main --output check-metadata\.json --suggest/)
    const off = runCheck({ npx: npxStub({ json: result() }), suggest: 'false' })
    expect(off.status).toBe(0)
    expect(off.read('npx.log')).not.toMatch(/--suggest/)
  })

  test('suggestions alone never fail the check, even with strict', () => {
    const r = runCheck({ npx: npxStub({ json: result({ suggestions: [suggestion()] }) }), strict: 'true' })
    expect(r.status).toBe(0)
    expect(r.read('npx.log')).toMatch(/--strict --suggest/)
    expect(r.stdout).not.toMatch(/::(error|warning)/)
  })

  test('findings still drive the exit code, and stay annotations of their own severity', () => {
    const finding = { file: 'modules/a/pages/x.adoc', line: 2, attribute: 'page-categories', value: 'Nope', severity: 'error', rule: 'unknown-value', message: 'Nope is not in the taxonomy' }
    const r = runCheck({ npx: npxStub({ json: result({ findings: [finding], suggestions: [suggestion()] }), rc: 1 }) })
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/^::error file=modules\/a\/pages\/x\.adoc,line=2,title=check-metadata unknown-value::Nope is not in the taxonomy$/m)
    expect(r.stdout).not.toMatch(/::notice/)
  })
})

describe('check-metadata workflow: the suggestions step', () => {
  test('a notice per suggestion, on its line, with the score and evidence', () => {
    const r = runReport(result({
      suggestions: [
        suggestion(),
        suggestion({ file: 'modules/b/pages/b.adoc', line: 3, uncategorized: false, conceptId: 'replication', label: 'Replication', score: 6.5, reason: 'named in 1 heading and 2 body mentions', evidence: [{ term: 'replication', location: 'heading', line: 5 }, { term: 'Replication', location: 'body', line: 9 }] }),
      ],
    }))
    expect(r.status).toBe(0)
    expect(r.notices).toEqual([
      '::notice file=modules/b/pages/b.adoc,line=3,title=check-metadata suggestion::Consider Replication (topic replication) in :page-categories:, score 6.5: named in 1 heading and 2 body mentions; "replication" in the heading, "Replication" in the body',
      '::notice file=modules/manage/pages/a.adoc,line=1,title=check-metadata suggestion::Consider Tiered Storage (topic tiered-storage) in :page-categories:, score 14: named in the title and 1 body mention; "Tiered Storage" in the title',
    ])
  })

  test('the summary lists every suggestion with its evidence, and marks pages without categories', () => {
    const r = runReport(result({ suggestions: [suggestion()], uncategorized: [{ file: 'modules/manage/pages/a.adoc', kind: 'docs', suggestions: 1 }, { file: 'modules/c/pages/empty.adoc', kind: 'docs', suggestions: 0 }] }))
    expect(r.summary).toMatch(/^### Suggested taxonomy values$/m)
    expect(r.summary).toMatch(/1 suggestion\(s\) at or above the minimum score \(5 on Product Docs pages, 3 on solution overviews\)/)
    expect(r.summary).toContain('| `modules/manage/pages/a.adoc:1` (no page-categories yet) | `:page-categories:` | Tiered Storage (`tiered-storage`) | 14 | named in the title and 1 body mention; `Tiered Storage` title, line 1 |')
    expect(r.summary).toMatch(/Pages with no page-categories whose text names no concept above the minimum score: `modules\/c\/pages\/empty\.adoc`\./)
  })

  test('at most 10 notices, the most GitHub shows per step; the summary keeps all of them', () => {
    const many = Array.from({ length: 14 }, (_, i) => suggestion({ file: `modules/a/pages/p${String(i).padStart(2, '0')}.adoc` }))
    const r = runReport(result({ suggestions: many }))
    expect(r.status).toBe(0)
    expect(r.notices).toHaveLength(10)
    expect(r.summary.split('\n').filter((l) => l.startsWith('| `modules/'))).toHaveLength(14)
  })

  test('escapes % and newlines in a notice, and pipes in a summary cell', () => {
    const r = runReport(result({ suggestions: [suggestion({ reason: 'named 100% in\nthe | title' })] }))
    expect(r.notices[0]).toMatch(/named 100%25 in%0Athe \| title/)
    expect(r.summary).toContain('named 100% in the \\| title')
  })

  test('no suggestions says so; no result, or a result without suggest, is a quiet exit 0', () => {
    const none = runReport(result())
    expect(none.status).toBe(0)
    expect(none.notices).toEqual([])
    expect(none.summary).toMatch(/No suggestions/)
    for (const json of [undefined, '', 'not json', JSON.stringify({ findings: [] })]) {
      const r = runReport(json)
      expect(r.status).toBe(0)
      expect(r.notices).toEqual([])
      expect(r.summary).toBe('')
      expect(r.stdout).toMatch(/no suggestions in the result/)
    }
  })
})

describe('check-metadata workflow: end to end with this repository\'s doc-tools', () => {
  const git = (cwd, ...args) => {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
    return res.stdout
  }

  test('a changed page without categories gets a notice on line 1 and a summary row; strict still passes', () => {
    const repo = tmpdir()
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@example.com')
    git(repo, 'config', 'user.name', 't')
    fs.mkdirSync(path.join(repo, 'modules/manage/pages'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'modules/manage/pages/old.adoc'), '= Old\n\nNothing.\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'checkout', '-qb', 'pr')
    fs.writeFileSync(path.join(repo, 'modules/manage/pages/tiered.adoc'), '= Tiered Storage\n:description: Offload Tiered Storage segments to object storage.\n\n== Enable Tiered Storage\n\nTiered Storage keeps older segments in object storage.\n')
    fs.writeFileSync(path.join(repo, 'modules/manage/pages/tagged.adoc'), '= Replication\n:page-categories: Security\n\n== Replication\n\nReplication copies data.\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'pr')

    // npx runs this checkout's doc-tools against the repo, with the fixture taxonomy.
    const npx = `#!/bin/bash
shift 4
exec "${process.execPath}" "${BIN}" "$@" --root "${repo}"
`
    const summaryFile = path.join(tmpdir(), 'summary.md')
    const check = execRun(CHECK, {
      env: { BASE: 'main', DOC_TOOLS_VERSION: 'local', STRICT: 'true', PATHS: '', TAXONOMY, SUGGEST: 'true', GITHUB_STEP_SUMMARY: summaryFile },
      stubs: { npx },
    })
    expect({ status: check.status, out: check.all }).toMatchObject({ status: 0 })
    const json = JSON.parse(check.read('check-metadata.json'))
    expect(json.findings).toEqual([])
    expect(json.suggest.suggestions.map((s) => `${s.file}:${s.line} ${s.conceptId} ${s.uncategorized}`)).toEqual([
      'modules/manage/pages/tagged.adoc:2 replication false',
      'modules/manage/pages/tiered.adoc:1 tiered-storage true',
    ])

    const r = runReport(json)
    expect(r.status).toBe(0)
    expect(r.notices).toEqual([
      expect.stringMatching(/^::notice file=modules\/manage\/pages\/tagged\.adoc,line=2,title=check-metadata suggestion::Consider Replication \(topic replication\) in :page-categories:, score [\d.]+: /),
      expect.stringMatching(/^::notice file=modules\/manage\/pages\/tiered\.adoc,line=1,title=check-metadata suggestion::Consider Tiered Storage \(topic tiered-storage\) in :page-categories:, score [\d.]+: named in the title/),
    ])
    expect(r.summary).toMatch(/\| `modules\/manage\/pages\/tiered\.adoc:1` \(no page-categories yet\) \| `:page-categories:` \| Tiered Storage \(`tiered-storage`\) \|/)
  })
})
