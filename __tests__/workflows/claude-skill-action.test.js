'use strict'

const fs = require('fs')
const path = require('path')
const YAML = require('yaml')

const { execRun } = require('./helpers/exec-run')

/**
 * The claude-skill action serves two kinds of caller:
 *
 *   - PR review (docs-pr-review-reusable.yml), which passes pr_number and
 *     needs the PR head checked out and the base branch's CLAUDE.md loaded,
 *   - headless curation (docs update-release-notes.yml), which has no PR,
 *     downloads its inputs into the workspace first, and needs both of those
 *     steps skipped. A checkout into the workspace root deletes those inputs.
 *
 * These tests pin that split, and check that pr_number cannot carry anything
 * but digits into the git ref and API path it is used in.
 */

const REPO_ROOT = path.join(__dirname, '..', '..')
const ACTION_PATH = path.join(REPO_ROOT, '.github', 'actions', 'claude-skill', 'action.yml')
const action = YAML.parse(fs.readFileSync(ACTION_PATH, 'utf8'))
const steps = action.runs.steps

const NO_PR = "inputs.pr_number != ''"
const prCheckout = steps.find((s) => s.uses && s.uses.startsWith('actions/checkout') && s.with && s.with.ref && s.with.ref.includes('inputs.pr_number'))
const claudeMdStep = steps.find((s) => s.name && s.name.startsWith("Load this repo's CLAUDE.md"))
const prNumberCheck = steps.find((s) => s.name === 'Assert pr_number is empty or a number')

function runCheck (value, repo = 'redpanda-data/docs') {
  return execRun(prNumberCheck, { env: { PR_NUMBER: value, REPO: repo } })
}

describe('claude-skill pr_number input', () => {
  it('is optional and defaults to empty', () => {
    expect(action.inputs.pr_number.required).toBe(false)
    expect(action.inputs.pr_number.default).toBe('')
  })

  it('makes repo optional, because only the PR steps use it', () => {
    expect(action.inputs.repo.required).toBe(false)
    expect(action.inputs.repo.default).toBe('')
    const users = steps.filter((s) => JSON.stringify(s).includes('inputs.repo'))
    for (const s of users) {
      expect([prCheckout, claudeMdStep, prNumberCheck]).toContain(s)
    }
  })

  it('rejects a pr_number with no repo', () => {
    const r = runCheck('2972', '')
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/repo is required when pr_number is set/)
  })

  it('accepts an empty pr_number with no repo', () => {
    expect(runCheck('', '').status).toBe(0)
  })

  it('gates the PR head checkout on a PR being under review', () => {
    expect(prCheckout).toBeDefined()
    expect(prCheckout.if).toBe(NO_PR)
  })

  it('gates the base-branch CLAUDE.md step on a PR being under review', () => {
    expect(claudeMdStep).toBeDefined()
    expect(claudeMdStep.if).toBe(NO_PR)
  })

  it('uses pr_number only in the gated steps and the check', () => {
    const users = steps.filter((s) => JSON.stringify(s).includes('inputs.pr_number'))
    for (const s of users) {
      expect([prCheckout, claudeMdStep, prNumberCheck]).toContain(s)
    }
  })

  it('still checks out the pinned plugin into its own subdirectory, never the workspace root', () => {
    const plugin = steps.find((s) => s.uses && s.uses.startsWith('actions/checkout') && s.with && s.with.repository === 'redpanda-data/docs-team-standards')
    expect(plugin).toBeDefined()
    expect(plugin.if).toBeUndefined()
    expect(plugin.with.path).toBe('.docs-team-standards-plugin')
  })

  it('runs the pr_number check before any step that uses it', () => {
    const idx = (s) => steps.indexOf(s)
    expect(idx(prNumberCheck)).toBeGreaterThanOrEqual(0)
    expect(idx(prNumberCheck)).toBeLessThan(idx(prCheckout))
    expect(idx(prNumberCheck)).toBeLessThan(idx(claudeMdStep))
  })
})

describe('Assert pr_number is empty or a number', () => {
  it('accepts an empty value and says the PR steps are skipped', () => {
    const r = runCheck('')
    expect(r.status).toBe(0)
    expect(r.all).toMatch(/no PR under review/)
  })

  it('accepts a PR number', () => {
    const r = runCheck('2972')
    expect(r.status).toBe(0)
    expect(r.all).not.toMatch(/no PR under review/)
  })

  it.each([
    ['a ref suffix', '1/head'],
    ['letters', '12a'],
    ['a shell payload', '1; echo pwned'],
    ['whitespace', ' 1'],
  ])('rejects %s', (_label, value) => {
    const r = runCheck(value)
    expect(r.status).not.toBe(0)
    expect(r.all).toMatch(/pr_number must be empty or digits only/)
    // The error message echoes the value, so check that the payload did not RUN:
    // a run would print pwned on a line of its own.
    expect(r.all.split('\n')).not.toContain('pwned')
  })
})

/**
 * The run step retries once. An attempt counts as done only when the CLI
 * exits 0 AND writes verdict.json: the v26.1.20 release-notes run exited 0
 * after 7 of its 20 minutes with nothing written, and was never retried.
 *
 * The stub claude takes its outcome per attempt from PLAN (one word per
 * attempt: verdict, none, report, fail, failreport, or killed) and prints a
 * claude-run.json whose result text is SECRET, so the tests can check that
 * the log never carries it. report and failreport also write report.md;
 * killed prints nothing, like an attempt its timeout stopped.
 */
describe('Run skill retry', () => {
  const runStep = steps.find((s) => s.name && s.name.startsWith('Run skill'))

  const stubs = {
    timeout: 'shift; exec "$@"',
    claude: [
      'n=$(( $(cat count 2>/dev/null || echo 0) + 1 )); echo "$n" > count',
      'outcome=$(echo "$PLAN" | cut -d" " -f"$n")',
      '[ "$outcome" = killed ] && exit 124',
      'echo "{\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"num_turns\\":$n,\\"duration_ms\\":1,\\"result\\":\\"SECRET\\"}"',
      'case "$outcome" in',
      '  verdict) echo "{}" > "$OUTPUT_DIR/verdict.json" ;;',
      '  report) echo "notes" > "$OUTPUT_DIR/report.md" ;;',
      '  fail) exit 1 ;;',
      '  failreport) echo "notes" > "$OUTPUT_DIR/report.md"; exit 1 ;;',
      'esac'
    ].join('\n')
  }

  function run (plan, timeoutMin = '20') {
    return execRun(runStep, {
      stubs,
      files: { 'out/.keep': '' },
      env: {
        PLAN: plan,
        OUTPUT_DIR: 'out',
        TIMEOUT_MIN: timeoutMin,
        PROMPT: 'x',
        GH_READONLY_SHIM: '/nonexistent',
        AWS_BEARER_TOKEN_BEDROCK: 'x'
      }
    })
  }

  it.each([
    ['a verdict on the first attempt', 'verdict', '1', 'false'],
    ['no verdict, then a verdict', 'none verdict', '2', 'false'],
    ['no verdict twice', 'none none', '2', 'true'],
    ['a failed exit, then a verdict', 'fail verdict', '2', 'false'],
    ['a failed exit twice', 'fail fail', '2', 'true'],
  ])('handles %s', (_label, plan, attempts, failed) => {
    const r = run(plan)
    expect(r.status).toBe(0)
    expect(r.read('count').trim()).toBe(attempts)
    expect(r.outputs.claude_failed).toBe(failed)
    expect(r.exists('out/verdict.json')).toBe(failed === 'false')
  })

  it('names a clean exit with no verdict in the retry warning', () => {
    expect(run('none verdict').all).toMatch(/exited 0 but wrote no verdict\.json, retrying once/)
    expect(run('fail verdict').all).toMatch(/failed \(exit 1\), retrying once/)
  })

  it('logs how each failed attempt ended, but never the result text', () => {
    const r = run('none none')
    expect(r.all).toMatch(/Claude run: subtype=success is_error=false turns=1 /)
    expect(r.all).toMatch(/Claude run: subtype=success is_error=false turns=2 /)
    expect(r.all).not.toMatch(/SECRET/)
  })

  it('says so when an attempt left no claude-run.json content', () => {
    const r = run('killed killed')
    expect(r.outputs.claude_failed).toBe('true')
    expect(r.all).toMatch(/Claude run: no readable claude-run\.json/)
  })

  // A clean exit with no verdict finished, so the files it wrote stay. A
  // failed exit may have died partway, so its files go.
  it('keeps the report of a last attempt that exited 0 with no verdict', () => {
    const r = run('none report')
    expect(r.outputs.claude_failed).toBe('true')
    expect(r.exists('out/report.md')).toBe(true)
    expect(r.all).toMatch(/wrote no verdict\.json — treating as unavailable/)
  })

  it('removes the report of a last attempt that failed', () => {
    const r = run('fail failreport')
    expect(r.outputs.claude_failed).toBe('true')
    expect(r.exists('out/report.md')).toBe(false)
    expect(r.exists('out/claude-run.json')).toBe(true)
  })

  it('does not show an earlier attempt\'s report beside a later one', () => {
    const r = run('report none')
    expect(r.read('count').trim()).toBe('2')
    expect(r.exists('out/report.md')).toBe(false)
  })

  it.each([
    ['exited 0 with no verdict', 'report', 'exited 0 but wrote no verdict\\.json', true],
    ['failed', 'failreport', 'failed \\(exit 1\\)', false],
  ])('does not retry an attempt that %s when under five minutes remain', (_label, plan, why, kept) => {
    const r = run(plan, '4')
    expect(r.read('count').trim()).toBe('1')
    expect(r.outputs.claude_failed).toBe('true')
    expect(r.all).toMatch(new RegExp(`Claude run ${why} and under 300s .* not retrying`))
    expect(r.exists('out/report.md')).toBe(kept)
  })
})
