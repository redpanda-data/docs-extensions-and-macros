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

  test('publish runs only when release-please created a release', () => {
    expect(publish.needs).toBe('release-please')
    expect(publish.if).toBe("needs.release-please.outputs.release_created == 'true'")
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

  test('dispatch waits for a publish', () => {
    expect(dispatch.needs).toBe('publish')
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
