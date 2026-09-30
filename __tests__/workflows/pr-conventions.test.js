'use strict'

/**
 * pr-conventions.yml, executed.
 *
 * release-please reads the squash-merged PR title, so a title without a
 * conventional prefix silently never releases. And a PR that bumps the
 * version by hand brings back the package.json conflicts that release-please
 * removed. Both checks are run here the way the runner runs them.
 */

const fs = require('fs')
const path = require('path')
const YAML = require('yaml')
const { execRun } = require('./helpers/exec-run')

const WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'pr-conventions.yml')
const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'))

test('reruns when the title is edited, so fixing a title clears the check', () => {
  expect(workflow.on.pull_request.types).toEqual(expect.arrayContaining(['opened', 'edited', 'synchronize', 'reopened']))
})

describe('title check (executed)', () => {
  const step = workflow.jobs.title.steps[0]
  const run = (title) => execRun(step, { env: { TITLE: title } })

  test('the title reaches bash through env, not ${{ }} in the body', () => {
    expect(step.run).not.toMatch(/\$\{\{/)
  })

  test.each([
    'feat: add a macro',
    'fix(rpcn-docs): render code spans literally',
    'ci(doc-strings-review): send the base branch',
    'feat!: drop Node 18',
    'refactor(tools)!: rename the CLI entry point',
    'docs: fix a typo'
  ])('accepts %p', (title) => {
    expect(run(title).status).toBe(0)
  })

  test.each([
    'Add docs-team CODEOWNERS (DOC-2496)',
    'DOC-1807: Kapa source groups',
    'feature: add a macro',
    'fix:no space',
    'fix(): empty scope',
    'Fix: capitalised type'
  ])('rejects %p', (title) => {
    const r = run(title)
    expect(r.status).toBe(1)
    expect(r.all).toMatch(/conventional-commit type/)
  })

  test('a title carrying shell syntax is only text', () => {
    const r = run('fix: $(touch pwned) `touch pwned2`')
    expect(r.status).toBe(0)
    expect(r.exists('pwned')).toBe(false)
    expect(r.exists('pwned2')).toBe(false)
  })
})

describe('no-version-bump check (executed)', () => {
  const step = workflow.jobs['no-version-bump'].steps[0]
  const b64 = (v) => Buffer.from(JSON.stringify({ name: 'x', version: v })).toString('base64')
  // gh answers `api repos/<repo>/contents/package.json?ref=<sha>` with the
  // version for that sha, base64-encoded the way the contents API returns it.
  const stubs = (versions) => ({
    gh: `
echo "gh $*" >> "$HOME/gh.log"
case "$2" in
${Object.entries(versions).map(([sha, v]) => `  *ref=${sha}) echo '${b64(v)}' ;;`).join('\n')}
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac`
  })
  const env = (over = {}) => ({
    GH_TOKEN: 't',
    BASE_REPO: 'redpanda-data/docs-extensions-and-macros',
    BASE_SHA: 'base1',
    HEAD_REPO: 'redpanda-data/docs-extensions-and-macros',
    HEAD_SHA: 'head1',
    HEAD_REF: 'fix/something',
    ...over
  })

  test('an unchanged version passes', () => {
    const r = execRun(step, { env: env(), stubs: stubs({ base1: '5.51.0', head1: '5.51.0' }) })
    expect(r.status).toBe(0)
    expect(r.all).toMatch(/Version unchanged \(5\.51\.0\)/)
  })

  test('a bumped version fails and says how to undo it', () => {
    const r = execRun(step, { env: env(), stubs: stubs({ base1: '5.51.0', head1: '5.52.0' }) })
    expect(r.status).toBe(1)
    expect(r.all).toMatch(/from 5\.51\.0 to 5\.52\.0/)
    expect(r.all).toMatch(/npm install --package-lock-only/)
  })

  test("the release PR is allowed to change the version and doesn't call the API", () => {
    const r = execRun(step, { env: env({ HEAD_REF: 'release-please--branches--main--components--docs-extensions-and-macros' }), stubs: stubs({}) })
    expect(r.status).toBe(0)
    expect(r.read('gh.log')).toBeNull()
  })

  test('a fork branch named like the release branch gets no exemption', () => {
    const r = execRun(step, {
      env: env({ HEAD_REF: 'release-please--branches--main--components--docs-extensions-and-macros', HEAD_REPO: 'someone/docs-extensions-and-macros' }),
      stubs: stubs({ base1: '5.51.0', head1: '9.0.0' })
    })
    expect(r.status).toBe(1)
  })

  test('an API failure fails the check instead of passing it', () => {
    const r = execRun(step, { env: env({ HEAD_SHA: 'missing' }), stubs: stubs({ base1: '5.51.0' }) })
    expect(r.status).not.toBe(0)
  })
})
