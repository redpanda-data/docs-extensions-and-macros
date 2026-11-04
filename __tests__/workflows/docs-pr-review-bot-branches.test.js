'use strict'

const fs = require('fs')
const path = require('path')
const YAML = require('yaml')
const { execRun } = require('./helpers/exec-run')

/**
 * The docs PR review skips bot-authored PRs, except a bot PR whose head
 * branch matches review_bot_branch_patterns: the Slack docs drafter opens
 * its PRs as vbotbuildovich on slack-draft/<thread> branches, and those are
 * reviewed like a human PR, SME gate included. These tests execute the
 * gate step's run: body with gh stubbed and check which way each PR goes.
 */

const ROOT = path.join(__dirname, '..', '..')
const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'docs-pr-review-reusable.yml'), 'utf8'))
const gateJob = Object.values(workflow.jobs).find((j) => (j.steps || []).some((s) => s.id === 'eval'))
const GATE = gateJob.steps.find((s) => s.id === 'eval')
const DEFAULT_PATTERNS = (workflow.on.workflow_call.inputs.review_bot_branch_patterns || {}).default

const SHA = 'a'.repeat(40)
const pr = ({ login = 'vbotbuildovich', type = 'User', branch = 'slack-draft/1761-123', draft = false, labels = [] } = {}) => ({
  head: { sha: SHA, ref: branch, repo: { full_name: 'redpanda-data/docs' } },
  user: { login, type },
  draft,
  title: 'docs: draft from Slack',
  labels: labels.map((name) => ({ name })),
  requested_reviewers: []
})

// Answers the calls the gate makes, logging each one. Statuses are
// remembered so the exactly-once claim reads back the status it wrote:
// the completed-review count is 0, and the latest docs-review status is
// whatever this run last set.
const ghStub = (prJson) => `#!/bin/bash
echo "$*" >> "$HOME/gh.log"
case "$2" in
  repos/*/pulls/*/reviews) echo '[]' ;;
  repos/*/pulls/*) cat <<'JSON'
${JSON.stringify(prJson)}
JSON
  ;;
  repos/*/commits/*/status)
    if [[ "$*" == *length* ]]; then echo 0
    else jq -nc --arg d "$(cat "$HOME/status" 2> /dev/null)" '{description: $d, updated_at: "2026-10-27T00:00:00Z"}'
    fi ;;
  repos/*/statuses/*)
    for a in "$@"; do [[ "$a" == description=* ]] && printf '%s' "\${a#description=}" > "$HOME/status"; done
    echo '{}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
`

function runGate (prJson, { patterns = DEFAULT_PATTERNS, smeGate = 'true', botPolicy = 'skip' } = {}) {
  return execRun(GATE, {
    env: {
      // Workflow- and job-level env the gate reads (REVIEW_STATUS_CONTEXT).
      ...(workflow.env || {}),
      ...(gateJob.env || {}),
      GH_TOKEN: 'x',
      PR: '7',
      R: 'redpanda-data/docs',
      EVENT_NAME: 'pull_request_target',
      EVENT_ACTION: 'ready_for_review',
      DOC_TEAM: 'writer1,writer2',
      PLUGIN_REF: 'b'.repeat(40),
      SME_GATE: smeGate,
      BOT_PR_POLICY: botPolicy,
      BOT_LOGINS: 'vbotbuildovich',
      REVIEW_BOT_BRANCHES: patterns,
      SKIP_BRANCHES: '',
      SKIP_TITLES: '',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_RUN_ID: '1'
    },
    stubs: { gh: ghStub(prJson) }
  })
}

describe('docs PR review gate: bot PRs on review_bot_branch_patterns branches', () => {
  test('the default covers the Slack drafter branches', () => {
    expect(DEFAULT_PATTERNS).toBe('slack-draft/*')
  })

  test('a ready drafter PR is gated like a human PR: it waits for an SME', () => {
    const r = runGate(pr())
    expect(r.status).toBe(0)
    expect(r.all).toMatch(/matches review_bot_branch_patterns 'slack-draft\/\*': reviewed like a human PR/)
    expect(r.all).not.toMatch(/bot_pr_policy=skip/)
    expect(r.outputs.run_review).toBe('false')
    // It reached the SME gate and held it with a pending status, which a
    // skipped PR never gets.
    expect(r.read('gh.log')).toMatch(/statuses\/a{40}.*state=pending/)
  })

  test('a ready drafter PR in a repo without an SME step is reviewed', () => {
    const r = runGate(pr(), { smeGate: 'false' })
    expect(r.status).toBe(0)
    expect(r.outputs.run_review).toBe('true')
    expect(r.outputs.sme_mode).toBe('repo-not-gated')
  })

  test('a drafter PR still in draft is not reviewed', () => {
    const r = runGate(pr({ draft: true }))
    expect(r.outputs.run_review).toBe('false')
    expect(r.all).toMatch(/is a draft/)
    expect(r.read('gh.log') || '').not.toMatch(/statuses/)
  })

  test('other bot PRs are still skipped', () => {
    const r = runGate(pr({ branch: 'auto-docs/update-property-docs' }))
    expect(r.outputs.run_review).toBe('false')
    expect(r.all).toMatch(/bot-authored \(@vbotbuildovich\) and bot_pr_policy=skip/)
    expect(r.read('gh.log') || '').not.toMatch(/statuses/)
  })

  test('control: with no patterns the drafter PR is skipped as a bot PR', () => {
    const r = runGate(pr(), { patterns: '' })
    expect(r.outputs.run_review).toBe('false')
    expect(r.all).toMatch(/bot_pr_policy=skip/)
  })

  test('a human PR on a slack-draft branch is unaffected', () => {
    const r = runGate(pr({ login: 'writer3' }), { smeGate: 'false' })
    expect(r.outputs.run_review).toBe('true')
    expect(r.all).not.toMatch(/review_bot_branch_patterns/)
  })
})
