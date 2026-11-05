'use strict'

/**
 * publish-to-npm.yaml: static contracts for the release-please setup.
 *
 * Feature PRs no longer choose the version. release-please keeps a release PR
 * open, creates the `v<version>` tag when it merges, and only then does
 * `publish` run. These tests pin the parts a later edit could quietly undo:
 * publishing on every push again, giving the publish job write access, or
 * opening the release PR with a token that triggers no CI.
 */

const fs = require('fs')
const path = require('path')
const YAML = require('yaml')
const { execRun } = require('./helpers/exec-run')

const ROOT = path.join(__dirname, '..', '..')
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'publish-to-npm.yaml')
const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'))
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'))

describe('publish-to-npm workflow: static contracts', () => {
  const { 'release-please': rp, publish, dispatch } = workflow.jobs

  test('the workflow default is read-only', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  test('release-please is pinned to a commit and uses the bot token', () => {
    const step = rp.steps.find((s) => (s.uses || '').startsWith('googleapis/release-please-action@'))
    expect(step).toBeDefined()
    expect(step.uses).toMatch(/@[0-9a-f]{40}$/)
    // GITHUB_TOKEN would open a release PR that no workflow runs on.
    expect(step.with.token).toBe('${{ env.ACTIONS_BOT_TOKEN }}')
    expect(step.with['config-file']).toBe('release-please-config.json')
    expect(step.with['manifest-file']).toBe('.release-please-manifest.json')
    expect(rp.outputs.release_created).toBe('${{ steps.release.outputs.release_created }}')
  })

  test("release-please's own token needs no write scope", () => {
    // The action does its pushes, PR edits, tags and releases with the bot
    // token, so write scopes on GITHUB_TOKEN would be unused.
    expect(rp.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
  })

  test('two quick merges do not run release-please concurrently', () => {
    expect(rp.concurrency).toEqual({ group: 'release-please', 'cancel-in-progress': false })
  })

  test('publish runs only when release-please created a release, or for a recovery tag', () => {
    expect(publish.needs).toBe('release-please')
    expect(publish.if).toBe("needs.release-please.outputs.release_created == 'true' || inputs.tag != ''")
    expect(workflow.on.workflow_dispatch.inputs.tag).toMatchObject({ type: 'string', default: '' })
  })

  test('publish checks out the commit release-please tagged, not the event commit', () => {
    // They differ when a later push tags a release PR that an earlier, failed
    // run merged. Publishing github.sha would ship unreleased code under the
    // tag's version.
    expect(rp.outputs.sha).toBe('${{ steps.release.outputs.sha }}')
    const checkout = publish.steps.find((s) => (s.uses || '').startsWith('actions/checkout'))
    expect(checkout.with.ref).toBe('${{ inputs.tag || needs.release-please.outputs.sha }}')
  })

  test('publish cannot write to the repository', () => {
    expect(publish.permissions).toEqual({ 'id-token': 'write', contents: 'read' })
  })

  test('publish does not persist the token into the checkout', () => {
    const checkout = publish.steps.find((s) => (s.uses || '').startsWith('actions/checkout'))
    expect(checkout.with['persist-credentials']).toBe(false)
  })

  test('publish still publishes from this file, where npm trusted publishing expects it', () => {
    expect(publish.steps.some((s) => (s.uses || '').startsWith('JS-DevTools/npm-publish@'))).toBe(true)
  })

  test('dispatch waits for a publish and names the published commit', () => {
    expect(dispatch.needs).toBe('publish')
    const step = dispatch.steps.find((s) => (s.uses || '').startsWith('peter-evans/repository-dispatch'))
    expect(step.with['client-payload']).toContain('${{ needs.publish.outputs.sha }}')
    expect(publish.outputs.sha).toBe('${{ steps.ref.outputs.sha }}')
  })

  test('there is no hand-rolled tag job left to race release-please for the tag', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(['dispatch', 'publish', 'release-please'])
  })
})

describe('release-please config', () => {
  const config = readJson('release-please-config.json')
  const manifest = readJson('.release-please-manifest.json')
  const pkg = readJson('package.json')
  const root = config.packages['.']

  test('releases the root package as node with plain v<version> tags', () => {
    expect(Object.keys(config.packages)).toEqual(['.'])
    expect(root['release-type']).toBe('node')
    expect(root['package-name']).toBe(pkg.name)
    // A component prefix would change the tag to <name>-v<version>, which
    // breaks every caller pinned to v<version>.
    expect(root['include-component-in-tag']).toBe(false)
  })

  test('the manifest matches package.json', () => {
    // release-please writes both in the release PR. If they drift, the next
    // release is computed from the wrong base.
    expect(manifest['.']).toBe(pkg.version)
  })

  test('ci changes release, because pinned callers only see a workflow change through a new tag', () => {
    const ci = root['changelog-sections'].find((s) => s.type === 'ci')
    expect(ci).toBeDefined()
    expect(ci.hidden).not.toBe(true)
  })

  test('every type the PR title check accepts has a changelog section', () => {
    const titleWorkflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'pr-conventions.yml'), 'utf8'))
    const run = titleWorkflow.jobs.title.steps[0].run
    const types = run.match(/\^\(([a-z|]+)\)/)[1].split('|').sort()
    expect(root['changelog-sections'].map((s) => s.type).sort()).toEqual(types)
  })
})

describe('publish workflow: release check (executed)', () => {
  const step = workflow.jobs.publish.steps.find((s) => s.id === 'ref')
  const run = ({ tag = '', version = '', pkgVersion }) => execRun(step, {
    env: { TAG: tag, VERSION: version },
    files: { 'package.json': JSON.stringify({ version: pkgVersion }) },
    stubs: { git: 'echo abc123' }
  })

  test('a normal release publishes when package.json matches release-please', () => {
    const r = run({ version: '5.51.1', pkgVersion: '5.51.1' })
    expect(r.status).toBe(0)
    expect(r.outputs.sha).toBe('abc123')
  })

  test('a recovery tag publishes when package.json matches the tag', () => {
    const r = run({ tag: 'v5.51.1', pkgVersion: '5.51.1' })
    expect(r.status).toBe(0)
  })

  test('a recovery tag whose package.json disagrees is refused', () => {
    const r = run({ tag: 'v5.51.2', pkgVersion: '5.51.1' })
    expect(r.status).toBe(1)
    expect(r.all).toMatch(/says 5\.51\.1, expected 5\.51\.2/)
  })

  test('a checkout that is not the release is refused', () => {
    const r = run({ version: '5.51.1', pkgVersion: '5.51.0' })
    expect(r.status).toBe(1)
  })
})

describe('publish workflow: wait until npm serves the version (executed)', () => {
  const steps = workflow.jobs.publish.steps
  const step = steps.find((s) => s.id === 'served')
  // npm prints the version once the registry serves it. calls counts lookups,
  // so a stub can start serving on the Nth one.
  // The step's env resolves VERSION to the recovery tag (v<version>) when one
  // is given, else to release-please's version.
  const run = ({ servedFrom = 1, tag = '', version = '5.57.0' }) => execRun(step, {
    env: { VERSION: tag || version },
    files: { 'package.json': JSON.stringify({ name: '@redpanda-data/docs-extensions-and-macros', version: '5.57.0' }) },
    stubs: {
      npm: `n=$(( $(cat calls 2>/dev/null || echo 0) + 1 )); echo $n > calls; echo "$*" >> args; [ $n -ge ${servedFrom} ] && echo 5.57.0; exit 0`,
      sleep: 'exit 0'
    }
  })

  test('it runs after the publish, so dispatch waits for it', () => {
    const publishAt = steps.findIndex((s) => (s.uses || '').startsWith('JS-DevTools/npm-publish@'))
    expect(steps.indexOf(step)).toBeGreaterThan(publishAt)
    expect(workflow.jobs.dispatch.needs).toBe('publish')
  })

  test('it succeeds once npm serves the version', () => {
    const r = run({ servedFrom: 3 })
    expect(r.status).toBe(0)
    expect(r.all).toMatch(/serves @redpanda-data\/docs-extensions-and-macros@5\.57\.0 \(attempt 3\)/)
  })

  test('it looks up the exact version, also for a recovery tag', () => {
    const r = run({ tag: 'v5.57.0', version: '' })
    expect(r.status).toBe(0)
    expect(r.read('args')).toMatch(/^view @redpanda-data\/docs-extensions-and-macros@5\.57\.0 version$/m)
  })

  test('it fails, so dispatch does not run, when npm never serves the version', () => {
    const r = run({ servedFrom: 999 })
    expect(r.status).toBe(1)
    expect(r.all).toMatch(/still does not serve .*@5\.57\.0 after 10 minutes/)
  })
})
