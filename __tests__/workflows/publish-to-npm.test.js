'use strict'

/**
 * publish-to-npm.yaml: the release job's tag step, executed.
 *
 * Reviews on #307 required the tag step to run in its own job with the only
 * write permission, and to fail loudly when the registry cannot be read. The
 * first is a static contract; the second is behaviour, and until now nothing
 * executed it. A registry blip that produced no tag, a green run, and a
 * dispatch telling four repositories to pull a version nobody can pin is the
 * exact failure this workflow exists to prevent.
 */

const fs = require('fs')
const path = require('path')
const YAML = require('yaml')
const { execRun } = require('./helpers/exec-run')

const WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'publish-to-npm.yaml')
const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'))

describe('publish-to-npm workflow: static contracts', () => {
  test('the tag step runs in its own job, with the only contents: write', () => {
    const { publish, release } = workflow.jobs
    expect(release).toBeDefined()
    expect(release.needs).toBe('publish')
    expect(release.permissions).toEqual({ contents: 'write' })
    expect((publish.permissions || {}).contents).toBe('read')
    expect((workflow.permissions || {}).contents).toBe('read')
  })

  test('publish does not persist the token into the checkout', () => {
    const checkout = workflow.jobs.publish.steps.find((s) => (s.uses || '').startsWith('actions/checkout'))
    expect(checkout.with['persist-credentials']).toBe(false)
  })

  test('runs are serialized so two publishes cannot race on the same tag', () => {
    expect(workflow.concurrency).toMatchObject({ group: 'publish-to-npm', 'cancel-in-progress': false })
  })
})

describe('publish-to-npm workflow: tag step (executed)', () => {
  const step = workflow.jobs.release.steps.find((s) => s.run && /tag/i.test(s.name || ''))
  const env = { GH_TOKEN: 't', GH_REPO: 'redpanda-data/docs-extensions-and-macros', GITHUB_SHA: 'abc123',
    PKG: '@redpanda-data/docs-extensions-and-macros', VERSION: '5.37.0' }
  // npm answers `view` with a scripted body and exit; gh logs every call and
  // answers `release view` per scenario; sleep is a no-op so retries are instant.
  const stubs = ({ npmOut, npmExit, releaseExists }) => ({
    npm: `printf '%s' '${npmOut}'; exit ${npmExit}`,
    gh: `echo "gh $*" >> "$HOME/gh.log"; if [ "$1 $2" = "release view" ]; then exit ${releaseExists ? 0 : 1}; fi; exit 0`,
    sleep: 'exit 0'
  })
  const created = (r) => (r.read('gh.log') || '').split('\n').some((l) => l.startsWith('gh release create'))

  test('a published version with no release yet gets a release created at GITHUB_SHA', () => {
    const r = execRun(step, { env, stubs: stubs({ npmOut: '5.37.0', npmExit: 0, releaseExists: false }) })
    expect(r.status).toBe(0)
    expect(created(r)).toBe(true)
    expect(r.read('gh.log')).toMatch(/--target abc123/)
    expect(r.all).toMatch(/Created release v5\.37\.0/)
  })

  test('an existing release is a no-op, not a failure', () => {
    const r = execRun(step, { env, stubs: stubs({ npmOut: '5.37.0', npmExit: 0, releaseExists: true }) })
    expect(r.status).toBe(0)
    expect(created(r)).toBe(false)
  })

  test('a confirmed 404 means not published: exits 0 with a notice and no tag', () => {
    const r = execRun(step, { env, stubs: stubs({ npmOut: 'npm ERR! code E404', npmExit: 1, releaseExists: false }) })
    expect(r.status).toBe(0)
    expect(created(r)).toBe(false)
    expect(r.all).toMatch(/is not on npm; nothing to tag/)
  })

  test('a registry error that is not a 404 retries, then fails loudly', () => {
    // The pre-review script treated every non-zero exit as "absent": no tag, a
    // green run, and dispatch proceeding. That must exit non-zero.
    const r = execRun(step, { env, stubs: stubs({ npmOut: 'npm ERR! code E500', npmExit: 1, releaseExists: false }) })
    expect(r.status).toBe(1)
    expect(created(r)).toBe(false)
    expect((r.all.match(/::warning::npm view attempt/g) || []).length).toBe(3)
    expect(r.all).toMatch(/Could not determine whether/)
  })
})
