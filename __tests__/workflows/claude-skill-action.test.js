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
