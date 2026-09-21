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

  test('publish exposes whether IT published, so the release job can tell a fresh 404 from a stale one', () => {
    expect(workflow.jobs.publish.outputs.published).toBe('${{ steps.publish.outputs.type }}')
    const tagStep = workflow.jobs.release.steps.find((s) => s.run && /tag/i.test(s.name || ''))
    expect(tagStep.env.PUBLISHED_THIS_RUN).toBe('${{ needs.publish.outputs.published }}')
  })

  test('publish does not persist the token into the checkout', () => {
    const checkout = workflow.jobs.publish.steps.find((s) => (s.uses || '').startsWith('actions/checkout'))
    expect(checkout.with['persist-credentials']).toBe(false)
  })

  test('runs are serialized so two publishes cannot race on the same tag', () => {
    // Scoped to the release job and keyed by version, not workflow-wide.
    // GitHub keeps one PENDING run per group and cancels the previously
    // pending one, so a workflow-wide group could drop the middle of three
    // quick merges entirely: neither published nor tagged.
    expect(workflow.concurrency).toBeUndefined()
    expect(workflow.jobs.release.concurrency).toMatchObject({
      group: 'release-${{ needs.publish.outputs.version }}',
      'cancel-in-progress': false
    })
    // Keyed by version, so two runs for the same version still serialise.
    expect(workflow.jobs.release.concurrency.group).toContain('needs.publish.outputs.version')
  })
})

describe('publish-to-npm workflow: tag step (executed)', () => {
  const step = workflow.jobs.release.steps.find((s) => s.run && /tag/i.test(s.name || ''))
  const env = { GH_TOKEN: 't', GH_REPO: 'redpanda-data/docs-extensions-and-macros', GITHUB_SHA: 'abc123',
    PKG: '@redpanda-data/docs-extensions-and-macros', VERSION: '5.37.0' }
  // npm answers `view` with a scripted body and exit; gh logs every call and
  // answers `release view` per scenario; sleep is a no-op so retries are instant.
  //
  // `release view` is answered per CALL, not once: the script views before
  // creating and again after a failed create, and the whole point of the
  // recheck is that the answer can change between the two. A single fixed
  // answer cannot express "it appeared while we were creating it".
  // createFails makes `release create` exit non-zero; existsAfterCreate is
  // what the recheck sees, defaulting to the pre-check answer.
  const stubs = ({ npmOut, npmExit, releaseExists, createFails = false, existsAfterCreate = null }) => ({
    npm: `printf '%s' '${npmOut}'; exit ${npmExit}`,
    gh: `
echo "gh $*" >> "$HOME/gh.log"
if [ "$1 $2" = "release view" ]; then
  n=$(cat "$HOME/view.count" 2>/dev/null || echo 0)
  echo $((n + 1)) > "$HOME/view.count"
  if [ "$n" = "0" ]; then exit ${releaseExists ? 0 : 1}; fi
  exit ${(existsAfterCreate === null ? releaseExists : existsAfterCreate) ? 0 : 1}
fi
if [ "$1 $2" = "release create" ]; then
  ${createFails ? 'echo "HTTP 422: already_exists" >&2; exit 1' : 'exit 0'}
fi
exit 0`,
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

  test('create losing the race to a concurrent run is success, not a failed job', () => {
    // The gap the recheck exists for, and previously unexercised because the
    // gh stub always succeeded on create. Two runs for the same version can
    // both pass the pre-check; the loser's create fails on already_exists. If
    // that took the job down, a release that DOES exist would show as a red
    // run, and the dispatch job after it would be skipped.
    const r = execRun(step, {
      env,
      stubs: stubs({ npmOut: '5.37.0', npmExit: 0, releaseExists: false, createFails: true, existsAfterCreate: true })
    })
    expect(r.status).toBe(0)
    expect(created(r)).toBe(true)
    expect(r.all).toMatch(/already existed by the time we created it/)
  })

  test('a create that fails for any other reason fails the job and reports why', () => {
    // The other side of the same branch: when the recheck finds no release,
    // the failure is real and must not be swallowed, or a version would be
    // published to npm with no tag and a green run.
    const r = execRun(step, {
      env,
      stubs: stubs({ npmOut: '5.37.0', npmExit: 0, releaseExists: false, createFails: true, existsAfterCreate: false })
    })
    expect(r.status).toBe(1)
    expect(r.all).toMatch(/::error::Failed to create release v5\.37\.0/)
    // The underlying gh message is surfaced, not discarded.
    expect(r.all).toMatch(/already_exists/)
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

  // A 404 right after this run's own publish is read-after-write lag, not
  // absence: trusting the first 404 here reproduces the exact
  // silent-skip-with-green-run these tests exist to close, on the run that
  // matters most (the one that just published). On v5.46.0 (2026-09-21) this
  // lag ran 2-4 minutes on a real publish, which is why the budget below is
  // 10 attempts, not 3: the first shipped version of this retry only budgeted
  // ~30s total and failed loudly on a version that had, in fact, published.
  const npmCountStub = (failCount) => `
n=$(cat "$HOME/npm.count" 2>/dev/null || echo 0)
n=$((n + 1))
echo $n > "$HOME/npm.count"
if [ "$n" -le ${failCount} ]; then
  printf 'npm ERR! code E404'
  exit 1
fi
printf '5.37.0'
exit 0`

  test("a 404 right after this run's own publish is retried, not trusted immediately", () => {
    const r = execRun(step, {
      env: { ...env, PUBLISHED_THIS_RUN: 'patch' },
      stubs: { ...stubs({ npmOut: '', npmExit: 0, releaseExists: false }), npm: npmCountStub(2) }
    })
    expect(r.status).toBe(0)
    expect(created(r)).toBe(true)
    expect((r.all.match(/::warning::npm view attempt/g) || []).length).toBe(2)
  })

  test("a 404 that persists across all 10 retries after this run's own publish fails loudly, not a silent skip", () => {
    const r = execRun(step, {
      env: { ...env, PUBLISHED_THIS_RUN: 'patch' },
      stubs: stubs({ npmOut: 'npm ERR! code E404', npmExit: 1, releaseExists: false })
    })
    expect(r.status).toBe(1)
    expect(created(r)).toBe(false)
    expect((r.all.match(/::warning::npm view attempt/g) || []).length).toBe(10)
    expect(r.all).toMatch(/was just published by this run but never appeared on npm/)
  })

  test("a 404 that clears on attempt 9 of 10 after this run's own publish still gets tagged", () => {
    // The budget exists to survive lag longer than the old 3-attempt/~30s
    // window, not just to survive it by one attempt's margin.
    const r = execRun(step, {
      env: { ...env, PUBLISHED_THIS_RUN: 'patch' },
      stubs: { ...stubs({ npmOut: '', npmExit: 0, releaseExists: false }), npm: npmCountStub(8) }
    })
    expect(r.status).toBe(0)
    expect(created(r)).toBe(true)
    expect((r.all.match(/::warning::npm view attempt/g) || []).length).toBe(8)
  })

  test('without PUBLISHED_THIS_RUN, a 404 is still trusted immediately (no regression on reruns)', () => {
    // A rerun of the workflow, or a push that did not bump the version, has no
    // publish output. The pre-existing fast path for a confirmed absence must
    // still skip without spending three retries.
    const r = execRun(step, { env, stubs: stubs({ npmOut: 'npm ERR! code E404', npmExit: 1, releaseExists: false }) })
    expect(r.status).toBe(0)
    expect(created(r)).toBe(false)
    expect((r.all.match(/::warning::npm view attempt/g) || []).length).toBe(0)
    expect(r.all).toMatch(/is not on npm; nothing to tag/)
  })
})
