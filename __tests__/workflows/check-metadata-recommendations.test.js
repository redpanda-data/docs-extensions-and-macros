'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const YAML = require('yaml')
const { execRun } = require('./helpers/exec-run')

/**
 * The reusable check-metadata workflow runs `doc-tools recommendations-diff`
 * by default and never fails on it. These tests execute the step's run: body
 * (helpers/exec-run.js) with npx stubbed: a result, published data that
 * could not be read, a doc-tools without the subcommand, and a crash.
 */

const ROOT = path.join(__dirname, '..', '..')
const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'check-metadata.yml'), 'utf8'))
const job = workflow.jobs['check-metadata']
const STEP = job.steps.find((s) => s.name === 'Report recommendation changes')

// An npx that logs its arguments, writes `json` to --output (unless null),
// appends `summary` to --summary, prints `stdout`, and exits `rc`.
const npxStub = ({ json, rc = 0, stdout = '', summary = '' }) => `#!/bin/bash
echo "$*" >> npx.log
out=""; sum=""; prev=""
for a in "$@"; do [ "$prev" = --output ] && out="$a"; [ "$prev" = --summary ] && sum="$a"; prev="$a"; done
${json === null ? '' : `cat > "$out" <<'JSON'\n${JSON.stringify(json)}\nJSON`}
${summary ? `printf '%s\\n' '${summary}' >> "$sum"` : ''}
${stdout ? `echo "${stdout}"` : ''}
exit ${rc}
`

function run ({ npx, origin = '', taxonomy = '' }) {
  const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recs-wf-')), 'summary.md')
  const r = execRun(STEP, {
    env: { BASE: 'origin/main', DOC_TOOLS_VERSION: '9.9.9', ORIGIN: origin, TAXONOMY: taxonomy, GITHUB_STEP_SUMMARY: summary },
    stubs: { npx },
  })
  return { ...r, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '', notices: r.stdout.split('\n').filter((l) => l.startsWith('::notice')) }
}

const OK = { status: 'ok', docs: [], summary: { docs: 0, appear: 0, disappear: 0, rerank: 0 } }

describe('check-metadata workflow: recommendations-diff', () => {
  test('the recommendations input defaults to true, with an empty origin', () => {
    const inputs = workflow.on.workflow_call.inputs
    expect(inputs.recommendations).toMatchObject({ type: 'boolean', default: true })
    expect(inputs.recommendations_origin).toMatchObject({ type: 'string', default: '' })
    expect(STEP.if).toMatch(/inputs\.recommendations\b/)
    expect(STEP.env).toMatchObject({ ORIGIN: '${{ inputs.recommendations_origin }}', BASE: 'origin/${{ github.base_ref }}' })
  })

  test('runs against the PR base with the summary and JSON; --origin and --taxonomy only when set', () => {
    const plain = run({ npx: npxStub({ json: OK }) })
    expect(plain.status).toBe(0)
    expect(plain.read('npx.log').trim()).toMatch(/^--yes --package @redpanda-data\/docs-extensions-and-macros@9\.9\.9 doc-tools recommendations-diff --changed origin\/main --output recommendations-diff\.json --summary \S+summary\.md$/)
    const set = run({ npx: npxStub({ json: OK }), origin: 'https://preview.example', taxonomy: 'tax.yml' })
    expect(set.read('npx.log')).toMatch(/--origin https:\/\/preview\.example --taxonomy tax\.yml/)
    expect(set.notices).toEqual([])
  })

  test('a result goes to the log and the summary the CLI wrote, with no notice', () => {
    const r = run({ npx: npxStub({ json: { ...OK, summary: { docs: 1, appear: 1, disappear: 0, rerank: 0 } }, stdout: 'recommendations-diff: 1 appear', summary: '### Solution recommendations' }) })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/recommendations-diff: 1 appear/)
    expect(r.summary).toMatch(/### Solution recommendations/)
    expect(r.notices).toEqual([])
  })

  test('published data that cannot be read is a notice with the reason, and exit 0', () => {
    const r = run({ npx: npxStub({ json: { status: 'unavailable', reason: 'fetching https://docs.redpanda.com/assets/data/doc-concepts.json failed with HTTP 404' } }) })
    expect(r.status).toBe(0)
    expect(r.notices).toEqual(['::notice title=recommendations-diff::Recommendations not checked: fetching https://docs.redpanda.com/assets/data/doc-concepts.json failed with HTTP 404'])
  })

  test('a doc-tools without the subcommand is a notice, and exit 0', () => {
    const r = run({ npx: npxStub({ json: null, rc: 1, stdout: "error: unknown command 'recommendations-diff'" }) })
    expect(r.status).toBe(0)
    expect(r.notices).toEqual([expect.stringMatching(/doc-tools 9\.9\.9 has no recommendations-diff/)])
  })

  test('a crash is a notice, never a failed job', () => {
    for (const stub of [{ json: null, rc: 2, stdout: 'recommendations-diff: git merge-base failed' }, { json: null, rc: 137 }]) {
      const r = run({ npx: npxStub(stub) })
      expect(r.status).toBe(0)
      expect(r.notices).toEqual([expect.stringMatching(/could not run \(exit (2|137)\)/)])
    }
  })

  test('the JSON is uploaded with the check-metadata result', () => {
    const upload = job.steps.find((s) => s.name === 'Upload the result')
    expect(upload.with.path.split('\n').map((s) => s.trim()).filter(Boolean)).toEqual(['check-metadata.json', 'recommendations-diff.json'])
  })
})
