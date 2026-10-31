'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const YAML = require('yaml')
const { execRun } = require('./helpers/exec-run')

/**
 * The docs PR review runs `doc-tools lint-screenshots` in its own job,
 * screenshot_lint, which checks out the PR head and holds no id-token.
 * screenshot_gate holds id-token for the vision pass, makes no direct
 * PR-head checkout (the claude-skill action's own checkout only runs
 * npm install -g, which ignores a project .npmrc), and reads the lint
 * result from an artifact. These tests check
 * the jobs' permissions and wiring, and execute the lint step's run: body
 * (helpers/exec-run.js) against a hostile checkout whose .npmrc points npm
 * at 127.0.0.1:9: the step's npx must not see that registry. A copy of the
 * step that runs npx from the checkout is the negative control.
 */

const ROOT = path.join(__dirname, '..', '..')
const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'docs-pr-review-reusable.yml'), 'utf8'))
const { screenshot_lint: LINT_JOB, screenshot_gate: GATE_JOB } = workflow.jobs
const stepNamed = (job, name) => {
  const step = job.steps.find((s) => s.name === name)
  if (!step) throw new Error(`no step named ${name}; steps: ${job.steps.map((s) => s.name || s.uses).join(', ')}`)
  return step
}
const LINT = stepNamed(LINT_JOB, 'Deterministic checks (doc-tools lint-screenshots)')
const HOSTILE_REGISTRY = 'http://127.0.0.1:9/'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-shots-'))
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}

// A PR head that tries to pick npm's registry, as a docs repo could: a
// package.json makes its directory npm's project root, and the .npmrc next
// to it is then npm's project config.
function hostileCheckout ({ modules = true } = {}) {
  const src = tmpdir()
  write(src, 'package.json', '{"name":"hostile","version":"1.0.0"}\n')
  write(src, '.npmrc', `registry=${HOSTILE_REGISTRY}\n`)
  if (modules) write(src, 'modules/manage/pages/a.adoc', '= A\n\nimage::missing.png[]\n')
  return src
}

// An npx that logs where it ran, whether GH_TOKEN reached it, the registry
// npm resolves from that directory, and its arguments, then writes an empty
// lint result to --output.
const NPX_PROBE = `#!/bin/bash
echo "$PWD|\${GH_TOKEN:-no-token}|$(npm config get registry)|$*" >> "$RUNNER_TEMP/npx.log"
out=""; prev=""
for a in "$@"; do [ "$prev" = --output ] && out="$a"; prev="$a"; done
echo '{"findings":[],"summary":{"errors":0,"warnings":0}}' > "$out"
`

function runLint ({ step = LINT, npx = NPX_PROBE, src = hostileCheckout() } = {}) {
  const runnerTemp = tmpdir()
  const r = execRun(step, {
    env: { RUNNER_TEMP: runnerTemp, GH_TOKEN: 'x', PR: '12', R: 'redpanda-data/docs', DOC_TOOLS_VERSION: '9.9.9', SRC: src },
    stubs: { gh: 'echo modules/manage/pages/a.adoc', npx },
  })
  const log = fs.existsSync(path.join(runnerTemp, 'npx.log')) ? fs.readFileSync(path.join(runnerTemp, 'npx.log'), 'utf8').trim().split('\n').map((l) => l.split('|')) : []
  const out = path.join(runnerTemp, 'screenshot-lint', 'screenshot-lint.json')
  return { ...r, runnerTemp, src, log, result: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null }
}

describe('docs PR review: screenshot jobs', () => {
  test('screenshot_lint, which checks out the PR head, holds no id-token', () => {
    expect(LINT_JOB.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
    const checkout = LINT_JOB.steps.find((s) => String(s.uses).startsWith('actions/checkout@'))
    expect(checkout.with).toMatchObject({ ref: 'refs/pull/${{ inputs.pr_number }}/head', path: '.screenshot-lint', 'persist-credentials': false })
    expect(LINT.env.SRC).toBe('${{ github.workspace }}/.screenshot-lint')
  })

  test('screenshot_gate, which holds id-token, makes no direct PR-head checkout and runs no npx', () => {
    expect(GATE_JOB.permissions['id-token']).toBe('write')
    for (const s of GATE_JOB.steps) {
      if (String(s.uses).startsWith('actions/checkout@')) expect(s.with && s.with.ref).toBeUndefined()
      expect(s.run || '').not.toMatch(/\bnpx\b|\bnpm\b/)
    }
    expect(GATE_JOB.steps.some((s) => s.name === LINT.name)).toBe(false)
  })

  test('a failed screenshot_lint cannot skip screenshot_gate, and skips only the vision pass', () => {
    expect(GATE_JOB.needs).toContain('screenshot_lint')
    expect(GATE_JOB.if).toMatch(/^!cancelled\(\) && needs\.classify\.result == 'success' && /)
    const download = GATE_JOB.steps.find((s) => String(s.uses).startsWith('actions/download-artifact@'))
    expect(download).toMatchObject({ 'continue-on-error': true, with: { name: 'screenshot-lint', path: '${{ runner.temp }}/screenshot-lint' } })
    const upload = LINT_JOB.steps.find((s) => String(s.uses).startsWith('actions/upload-artifact@'))
    expect(upload).toMatchObject({ if: 'always()', with: { name: 'screenshot-lint', path: '${{ runner.temp }}/screenshot-lint/' } })
    expect(stepNamed(GATE_JOB, 'Claude vision pass').if).toMatch(/needs\.screenshot_lint\.result == 'success'/)
    expect(stepNamed(GATE_JOB, 'Merge deterministic + vision verdicts').if).toBe('always()')
  })
})

describe('docs PR review: the lint-screenshots step', () => {
  test('runs npx from RUNNER_TEMP with --root at the checkout, without GH_TOKEN', () => {
    const r = runLint()
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.log).toHaveLength(1)
    const [cwd, token, , args] = r.log[0]
    expect(cwd).toBe(r.runnerTemp)
    expect(token).toBe('no-token')
    expect(args).toBe(`--yes --package @redpanda-data/docs-extensions-and-macros@9.9.9 doc-tools lint-screenshots --root ${r.src} --files ${r.runnerTemp}/screenshot-lint/changed-files.txt --format json --output ${r.runnerTemp}/screenshot-lint/result.json`)
    expect(r.result).toEqual({ blocking: [], suggestions: [], verdict: 'pass' })
  })

  test('a hostile .npmrc in the checkout does not reach npm', () => {
    const r = runLint()
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.log[0][2]).not.toBe(HOSTILE_REGISTRY)
  })

  test('negative control: the same step run from the checkout picks up the hostile registry', () => {
    const fromCheckout = { ...LINT, run: LINT.run.replace('cd "$RUNNER_TEMP" &&', 'cd "$SRC" &&') }
    expect(fromCheckout.run).not.toBe(LINT.run)
    const r = runLint({ step: fromCheckout })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.log[0][2]).toBe(HOSTILE_REGISTRY)
  })

  test('a checkout with no modules/ is not_run, and npx never runs', () => {
    const r = runLint({ src: hostileCheckout({ modules: false }) })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.log).toHaveLength(0)
    expect(r.result.not_run).toEqual([expect.stringMatching(/no root modules\/ directory/)])
  })

  test('with this repository\'s doc-tools, --root lints the checkout from outside it', () => {
    // npx runs this checkout's bin, as the published package would.
    const npx = `#!/bin/bash
while [ "$1" = --yes ] || [ "$1" = --package ]; do [ "$1" = --package ] && shift; shift; done
[ "$1" = doc-tools ] && shift
exec node "${path.join(ROOT, 'bin', 'doc-tools.js')}" "$@"
`
    const r = runLint({ npx })
    expect({ status: r.status, out: r.all }).toMatchObject({ status: 0 })
    expect(r.result.verdict).toBe('fail')
    expect(r.result.blocking.join('\n')).toMatch(/modules\/manage\/pages\/a\.adoc:3 .*missing\.png/)
  })
})
