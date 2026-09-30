'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const YAML = require('yaml')
const { spawnSync } = require('child_process')

/**
 * The doc-strings review workflow runs inside OTHER repos' PRs with
 * pull-requests: write, and every one of its steps carries
 * continue-on-error or a fail-open posture. That combination means a broken
 * step produces no signal at all, so reading the YAML is not enough: these
 * tests EXECUTE each `run:` body under the same shell GitHub Actions uses
 * (`bash -e`), with gh/npx/jq stubbed, and assert the observable behaviour.
 *
 * A green check that cannot fail is worth nothing, so each executed test
 * asserts the behaviour a specific past defect produced:
 *   - `npx --yes <pkg> doc-tools` cannot resolve the bin (doc-tools and
 *     doc-tools-mcp are bin names, not the package-name segment), so it
 *     exited 1 with zero bytes of output for every version.
 *   - `jq '.findings|length'` over that 0-byte file printed NOTHING and
 *     exited 0, so `|| echo 0` never fired, count became '' and every
 *     `count != '0'` step ran over an absent findings file.
 *   - the tamper guard piped a failing gh into grep and so failed OPEN.
 *   - the standard fetch left a 0-byte "authoritative" file behind.
 */

const WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'doc-strings-review.yml')
const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'))
const job = workflow.jobs['doc-strings-review']
const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'))

// The doc_tools_package input defaults to empty; the Resolve step derives the
// real spec from the workflow's own ref. Lint-step tests run with a
// representative resolved spec, the shape the resolver emits.
const RESOLVED_PKG = `${pkgJson.name}@${pkgJson.version}`

function stepNamed (name) {
  const step = job.steps.find((s) => s.name === name)
  if (!step) throw new Error(`no step named ${name}; steps: ${job.steps.map((s) => s.name || s.uses).join(', ')}`)
  return step
}

const runSteps = job.steps.filter((s) => typeof s.run === 'string')

/**
 * Execute one step's `run:` body the way the runner does.
 *
 * GitHub Actions substitutes ${{ }} expressions textually BEFORE handing the
 * body to bash, then runs it as `bash -e {0}`. Both details matter: textual
 * substitution is what makes an unquoted input injectable, and `-e` without
 * `-o pipefail` is what let a failing gh in a pipeline look like success.
 */
const { execRun: execRunShared } = require('./helpers/exec-run')

// This workflow's expression defaults; see helpers/exec-run.js for the runner.
//
// The map covers the expressions an EARLIER version of this workflow inlined
// into its run: bodies as well as the ones the current version uses, so a
// regression that moves an input back inline still executes here and fails on
// behaviour rather than on an unresolved-placeholder error.
function execRun (step, opts = {}) {
  const env = opts.env || {}
  return execRunShared(step, {
    ...opts,
    defaults: {
      '${{ github.repository }}': env.GITHUB_REPOSITORY || 'redpanda-data/redpanda',
      '${{ github.event.pull_request.number }}': env.PR || '7',
      '${{ github.event.pull_request.html_url }}': 'https://github.com/redpanda-data/redpanda/pull/7',
      '${{ inputs.doc_tools_package }}': env.PKG || RESOLVED_PKG,
      '${{ steps.pkg.outputs.pkg }}': env.PKG || RESOLVED_PKG,
      '${{ inputs.surfaces }}': env.SURFACES || '',
      '${{ inputs.dispatch_repo }}': env.DISPATCH_REPO || 'redpanda-data/docs-site'
    }
  })
}

// An npx stub that reproduces npm exec's actual bin resolution: with no
// --package flag, npm infers the bin name from the package-name segment of
// the positional spec and fails when no such bin exists. This is the real
// 'npm error could not determine executable to run', exit 1, zero stdout.
const NPX_STUB = `#!/bin/bash
printf '%s\\n' "$@" > "$HOME/npx-argv"
pkg=""
for a in "$@"; do
  case "$a" in
    --package=*) pkg="\${a#--package=}" ;;
  esac
done
if [ -z "$pkg" ]; then
  echo 'npm error could not determine executable to run' >&2
  exit 1
fi
if [ -n "$LINT_JSON" ]; then printf '%s' "$LINT_JSON"; fi
exit \${LINT_EXIT:-0}
`

describe('doc-strings-review workflow: static contracts', () => {
  test('no workflow_call input is interpolated into a run: body', () => {
    // ${{ inputs.X }} is substituted textually before bash sees it, so a
    // caller-controlled input inside a run: body is command injection.
    // Inputs must reach the shell through env: and be quoted.
    for (const step of runSteps) {
      expect(step.run).not.toMatch(/\$\{\{\s*inputs\./)
    }
  })

  test('every run: body sets pipefail', () => {
    // Without pipefail the status of `gh ... | grep` is grep's, which is how
    // the tamper guard and the standard fetch both failed open.
    for (const step of runSteps) {
      expect(step.run.split('\n').some((l) => /^\s*set -[a-z]*u?[a-z]*o pipefail/.test(l))).toBe(true)
    }
  })

  test('the job requests id-token: write, which the review action needs', () => {
    // anthropics/claude-code-action mints an OIDC token. Its setupGitHubToken
    // short-circuits only when the github_token input is set; this workflow
    // passes anthropic_api_key and no github_token, so the action calls
    // core.getIDToken() and throws "Could not fetch an OIDC token" without this
    // scope. The review step carries continue-on-error, so the failure is
    // silent: the workflow reports success and posts nothing, on every PR.
    // Sibling org workflows using the action the same way declare it too.
    expect(Object.keys(job.permissions)).toEqual(expect.arrayContaining(['contents', 'pull-requests']))
    expect(job.permissions['id-token']).toBe('write')
  })

  test('the caller contract grants every permission the job declares', () => {
    // A called workflow cannot elevate past the caller's token, so any scope
    // this job declares must also appear in the shim callers copy, or the job
    // fails (or worse, silently no-ops) in every consuming repo.
    const shim = fs.readFileSync(WORKFLOW_PATH, 'utf8')
      .split('\n').filter((l) => l.startsWith('#'))
      .join('\n')
    for (const scope of Object.keys(job.permissions)) {
      expect(shim).toMatch(new RegExp(`^#\\s+${scope}:`, 'm'))
    }
  })

  test('the caller contract never shows a ref that would silently float', () => {
    // This used to assert the opposite end of the same problem: with no tags in
    // the repo, a `@v<version>` example handed callers an unresolvable ref, so
    // the example said `@main`. publish-to-npm.yaml now tags every published
    // version, but `@main` was always the worse failure: an unresolvable ref
    // fails the caller's job loudly, while `@main` runs whatever landed here
    // last, inside the caller's job, with their OIDC role and pull-requests:
    // write, and with no review in their repository.
    //
    // So the contract is: the example must be an obvious placeholder, never a
    // ref that resolves to moving code. People copy the block and skip the
    // prose, which is exactly how the old example contradicted the paragraph
    // beneath it.
    const shim = fs.readFileSync(WORKFLOW_PATH, 'utf8')
    const refs = [...shim.matchAll(/doc-strings-review\.yml@(\S+)/g)].map((m) => m[1])
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(ref).not.toBe('main')
      expect(ref).not.toMatch(/^(main|master|HEAD)$/)
      // A placeholder, i.e. not something git could resolve as-is.
      expect(ref).toMatch(/[<>]/)
    }
  })

  test('the caller contract tells security-sensitive callers to pin the SHA', () => {
    // A tag is a movable pointer and this repo has no `v*` tag ruleset yet, so
    // anyone with push access can re-point or delete a tag with no review.
    // Until that ruleset exists the SHA is the only real pin, and the header
    // has to say so rather than merely offer it as an alternative.
    const header = fs.readFileSync(WORKFLOW_PATH, 'utf8')
      .split('\n').filter((l) => l.startsWith('#')).join('\n')
    expect(header).toMatch(/Prefer the commit SHA/i)
    expect(header).toMatch(/ruleset/i)
  })

  test('doc_tools_package defaults to empty so the resolver decides', () => {
    // The version is derived from the workflow's own ref by the Resolve step;
    // a non-empty default here would silently shadow that and reintroduce the
    // hand-maintained pin this design removed. The input must still exist as
    // an explicit override.
    expect(workflow.on.workflow_call.inputs.doc_tools_package.default).toBe('')
  })

  test('the lint step consumes the resolver output, not the raw input', () => {
    // Wiring the input straight into the lint step would bypass the
    // ref-derived resolution for every caller that leaves the override empty.
    const lint = stepNamed('Lint doc strings in the diff')
    expect(lint.env.PKG).toBe('${{ steps.pkg.outputs.pkg }}')
    const cache = stepNamed('Cache the doc-tools npx install and extractor bootstrap')
    expect(cache.with.key).toContain('${{ steps.pkg.outputs.pkg }}')
  })

  test('the resolver reads its own commit from job.workflow_sha, not an OIDC claim', () => {
    // github.job_workflow_sha is a claim in the OIDC token, not a property of
    // the github context; as a ${{ }} expression it evaluates to the empty
    // string, so the resolver would silently fall through on every reusable
    // call. job.workflow_sha names the commit of the workflow file defining
    // the current job, which is this repository's.
    const step = stepNamed('Resolve the doc-tools package')
    expect(step.env.JOB_WF_SHA).toBe('${{ job.workflow_sha }}')
    expect(JSON.stringify(step.env)).not.toMatch(/github\.job_workflow_sha/)
  })

  test('the review gate conditions on declarations or removals, never on a finding count', () => {
    // A string can pass every mechanical rule and still tell an operator
    // nothing, and a deletion produces no findings at all, so gating the
    // review on a finding count would skip exactly the PRs the prose and
    // published-content passes exist for.
    const gated = job.steps.filter((s) => (s.if || '').includes('steps.lint.outputs'))
    expect(gated.length).toBeGreaterThan(0)
    for (const s of gated) {
      expect(s.if).toMatch(/steps\.lint\.outputs\.declarations/)
      expect(s.if).toMatch(/steps\.lint\.outputs\.removals/)
      expect(s.if).not.toMatch(/steps\.lint\.outputs\.count/)
    }
    // And the review itself is one of them.
    const review = job.steps.find((s) => s.name === 'Claude review with suggestions')
    expect(review.if).toMatch(/declarations != '0' \|\| steps\.lint\.outputs\.removals != '0'/)
  })

  test('the caller contract documents the permissions a caller must grant', () => {
    const header = fs.readFileSync(WORKFLOW_PATH, 'utf8').split('name: doc-strings-review')[0]
    expect(header).toMatch(/pull-requests:\s*write/)
    expect(header).toMatch(/pull_request_target/)
  })
})

describe('doc-strings-review workflow: lint step (executed)', () => {
  const step = stepNamed('Lint doc strings in the diff')
  const baseEnv = { BASE: 'deadbeef', SURFACES: '', PKG: RESOLVED_PKG }

  // These assert on `declarations` and `removals`, which are what the review,
  // credential and dispatch steps actually condition on. An earlier version of
  // this suite asserted a `count` output instead. That output gated nothing,
  // so the fail-closed paths below were only ever verified by proxy and the
  // real gate had no coverage at all.
  const JSON_2 = '{"findings":[{"a":1},{"b":2}],"summary":{"totalDeclarations":2,"removedSurfaceLines":0}}'

  test('invokes the CLI through --package= so npx can resolve the doc-tools bin', () => {
    const r = execRun(step, {
      env: { ...baseEnv, LINT_JSON: JSON_2 },
      stubs: { npx: NPX_STUB }
    })
    const argv = fs.readFileSync(path.join(r.dir, 'npx-argv'), 'utf8').split('\n')
    expect(argv).toContain(`--package=${RESOLVED_PKG}`)
    // and the spec is NOT handed to npx as a bare positional, which is the
    // form that cannot resolve either declared bin.
    expect(argv).not.toContain(RESOLVED_PKG)
    expect(argv).toContain('lint-strings')
    expect(r.status).toBe(0)
    expect(r.outputs.declarations).toBe('2')
  })

  test('the bare npx form leaves the gate at 0, never empty', () => {
    // Drive the same body with a stub that refuses to resolve a bin, which is
    // exactly what the shipped `npx --yes <pkg> doc-tools` form did: exit 1,
    // zero bytes. '' would read as truthy in `!= '0'` and open the gate over
    // an absent findings file, so both outputs must be a literal 0.
    const r = execRun(step, {
      env: { ...baseEnv, LINT_EXIT: '1' },
      stubs: {
        npx: '#!/bin/bash\necho \'npm error could not determine executable to run\' >&2\nexit 1\n'
      }
    })
    expect(r.outputs.declarations).toBe('0')
    expect(r.outputs.removals).toBe('0')
    expect(r.outputs.declarations).not.toBe('')
    expect(r.outputs.removals).not.toBe('')
    expect(r.all).toMatch(/::warning::/)
    expect(r.status).toBe(0)
  })

  test('a zero-byte findings file closes the gate (jq prints nothing there)', () => {
    const r = execRun(step, { env: baseEnv, stubs: { npx: NPX_STUB } })
    expect(r.size('lint-findings.json')).toBe(0)
    expect(r.outputs.declarations).toBe('0')
    expect(r.outputs.removals).toBe('0')
    expect(r.all).toMatch(/::warning::/)
  })

  test('non-JSON output closes the gate rather than emitting a non-numeric value', () => {
    const r = execRun(step, {
      env: { ...baseEnv, LINT_JSON: 'this is not json' },
      stubs: { npx: NPX_STUB }
    })
    expect(r.outputs.declarations).toBe('0')
    expect(r.outputs.removals).toBe('0')
    expect(r.all).toMatch(/::warning::/)
  })

  test('a lint with zero findings still opens the gate, so clean strings reach the review', () => {
    // The whole point of gating on declarations rather than findings: the lint
    // is mechanical, and a string can pass every rule while telling an
    // operator nothing. A PR whose strings are all mechanically clean must
    // still get the prose pass.
    const clean = execRun(step, {
      env: { ...baseEnv, LINT_JSON: '{"findings":[],"summary":{"totalDeclarations":4,"removedSurfaceLines":0}}' },
      stubs: { npx: NPX_STUB }
    })
    expect(clean.outputs.declarations).toBe('4')
    expect(clean.outputs.removals).toBe('0')
  })

  test('a deletion-only PR opens the gate through removals', () => {
    // Declarations are extracted from HEAD, so a PR that only removes a
    // property reports totalDeclarations 0 and would skip every step below,
    // including the published-content check that treats a removed surface as
    // high impact. removals is the second half of the gate for that case.
    const deleted = execRun(step, {
      env: { ...baseEnv, LINT_JSON: '{"findings":[],"summary":{"totalDeclarations":0,"removedSurfaceLines":12}}' },
      stubs: { npx: NPX_STUB }
    })
    expect(deleted.outputs.declarations).toBe('0')
    expect(deleted.outputs.removals).toBe('12')
  })

  test('an empty surfaces input does not abort the step under errexit', () => {
    // `[ -n "$SURFACES" ] && ARGS+=(...)` returns 1 when surfaces is empty,
    // which errexit turns into a dead step. The all-surfaces default is the
    // common case, so it has to survive.
    const r = execRun(step, {
      env: { ...baseEnv, SURFACES: '', LINT_JSON: '{"findings":[]}' },
      stubs: { npx: NPX_STUB }
    })
    expect(r.status).toBe(0)
    const argv = fs.readFileSync(path.join(r.dir, 'npx-argv'), 'utf8')
    expect(argv).not.toMatch(/--surface/)
  })

  test('a surfaces input reaches the CLI as one quoted argument', () => {
    const r = execRun(step, {
      env: { ...baseEnv, SURFACES: 'properties,helm', LINT_JSON: '{"findings":[]}' },
      stubs: { npx: NPX_STUB }
    })
    const argv = fs.readFileSync(path.join(r.dir, 'npx-argv'), 'utf8').split('\n')
    expect(argv).toContain('--surface')
    expect(argv).toContain('properties,helm')
  })

  test('a hostile package input cannot execute a command', () => {
    // The npx stub succeeds here on purpose: a stub that exits non-zero would
    // let errexit abort the script before the injected command ran, and the
    // test would pass for the wrong reason.
    const r = execRun(step, {
      env: { ...baseEnv, PKG: 'pkg; touch PWNED; true' },
      stubs: { npx: '#!/bin/bash\nprintf \'{"findings":[]}\'\nexit 0\n' }
    })
    expect(r.exists('PWNED')).toBe(false)
  })
})

describe('doc-strings-review workflow: tamper guard (executed)', () => {
  const step = stepNamed('Abort if PR modifies review configuration from a non-writer')
  const env = { GH_TOKEN: 't', GITHUB_REPOSITORY: 'redpanda-data/redpanda', PR: '7', AUTHOR: 'someone' }

  test('fails CLOSED when gh fails', () => {
    // A security check must abort the job on an API outage, not wave the PR
    // through. Piping a failing gh into grep exits 0 through grep's status.
    const r = execRun(step, {
      env,
      stubs: { gh: '#!/bin/bash\necho "gh: API rate limit exceeded" >&2\nexit 1\n' }
    })
    expect(r.status).not.toBe(0)
  })

  // The stubs above hand the step a bare list of filenames, which is what the
  // step WANTS rather than what `gh api` returns, so they never exercise the
  // --jq filter. That is precisely how a wrong field name survived review: the
  // endpoint returns `filename`, and asking for `.path` yields one null per
  // file, so the guard greps blank lines and passes every PR. This stub
  // emulates `gh api --jq` for real: it emits the API's own JSON shape and
  // applies whatever filter the workflow asked for.
  const ghApiStub = (payload) => `#!/bin/bash
args=("$@")
filter=""
for i in "\${!args[@]}"; do
  if [ "\${args[$i]}" = "--jq" ]; then filter="\${args[$((i+1))]}"; fi
done
if [ -n "$filter" ]; then
  printf '%s' '${JSON.stringify(payload)}' | jq -r "$filter"
else
  printf '%s' '${JSON.stringify(payload)}'
fi
`

  test('selects the field this endpoint actually returns, not a plausible one', () => {
    // Real shape: pulls/{n}/files items carry filename, status, additions...
    // and no `path` key at all.
    const payload = [
      { filename: '.github/workflows/doc-strings-review.yml', status: 'modified', additions: 3 },
      { filename: 'src/v/config/configuration.cc', status: 'modified', additions: 1 }
    ]
    const r = execRun(step, {
      env: { ...env, AUTHOR: 'outsider' },
      stubs: {
        gh: ghApiStub(payload),
        jq: `#!/bin/bash\nexec ${JSON.stringify(require('child_process').execSync('command -v jq').toString().trim())} "$@"\n`
      }
    })
    // The PR edits a protected workflow and the author is not a writer, so the
    // guard MUST abort. With `.path` it silently passed.
    expect(r.status).not.toBe(0)
  })

  test('fails CLOSED when the file query returns nothing usable', () => {
    // A pull request always changes at least one file, so an empty list means
    // the query is broken, not that there is nothing to check.
    const r = execRun(step, {
      env,
      stubs: { gh: '#!/bin/bash\nexit 0\n' }
    })
    expect(r.status).not.toBe(0)
  })

  test('reads the file list with a paginated request, defeating the 100-file cap', () => {
    const r = execRun(step, {
      env,
      stubs: {
        gh: '#!/bin/bash\nprintf \'%s\\n\' "$@" >> "$HOME/gh-argv"\necho src/v/config/configuration.cc\n'
      }
    })
    const argv = fs.readFileSync(path.join(r.dir, 'gh-argv'), 'utf8')
    expect(argv).toMatch(/--paginate/)
    expect(argv).toMatch(/pulls\/7\/files/)
    expect(r.status).toBe(0)
  })

  test.each([
    ['.github/workflows/doc-strings-review.yml', true],
    ['.github/actions/setup/action.yml', true],
    ['action.yml', true],
    ['.claude/settings.json', true],
    ['CLAUDE.md', true],
    ['src/v/config/configuration.cc', false]
  ])('a non-writer touching %s aborts: %s', (changedPath, shouldAbort) => {
    const r = execRun(step, {
      env,
      stubs: {
        gh: `#!/bin/bash
case "$*" in
  *collaborators*) echo read ;;
  *) echo '${changedPath}' ;;
esac
`
      }
    })
    if (shouldAbort) {
      expect(r.status).not.toBe(0)
      expect(r.all).toMatch(/::error::/)
    } else {
      expect(r.status).toBe(0)
    }
  })

  test('a writer touching review configuration is allowed through', () => {
    const r = execRun(step, {
      env,
      stubs: {
        gh: `#!/bin/bash
case "$*" in
  *collaborators*) echo admin ;;
  *) echo '.github/workflows/doc-strings-review.yml' ;;
esac
`
      }
    })
    expect(r.status).toBe(0)
  })
})

describe('doc-strings-review workflow: writing-standard fetch (executed)', () => {
  const step = stepNamed('Fetch the writing standard')
  const STANDARD = 'embedded-reference-strings.md'

  test('a failed fetch leaves NO file, not a zero-byte authoritative standard', () => {
    const r = execRun(step, {
      env: { GH_TOKEN: 'bot' },
      stubs: { gh: '#!/bin/bash\necho "gh: Not Found (HTTP 404)" >&2\nexit 1\n' }
    })
    expect(r.size(STANDARD)).toBe(-1)
    expect(r.all).toMatch(/::warning::/)
  })

  test('an empty-but-successful response is also discarded', () => {
    const r = execRun(step, {
      env: { GH_TOKEN: 'bot' },
      stubs: { gh: '#!/bin/bash\nexit 0\n' }
    })
    expect(r.size(STANDARD)).toBe(-1)
  })

  test('a stale file from an earlier step cannot survive a failed fetch', () => {
    const r = execRun(step, {
      env: { GH_TOKEN: 'bot' },
      files: { [STANDARD]: 'stale contents from a previous run' },
      stubs: { gh: '#!/bin/bash\nexit 1\n' }
    })
    expect(r.size(STANDARD)).toBe(-1)
  })

  test('a successful fetch promotes the decoded standard', () => {
    const b64 = Buffer.from('# Embedded reference strings\n').toString('base64')
    const r = execRun(step, {
      env: { GH_TOKEN: 'bot' },
      stubs: { gh: `#!/bin/bash\nprintf '%s' '${b64}'\n` }
    })
    expect(r.read(STANDARD)).toBe('# Embedded reference strings\n')
  })

  test('no bot token means no file at all', () => {
    const r = execRun(step, {
      env: { GH_TOKEN: '' },
      stubs: { gh: '#!/bin/bash\necho SHOULD_NOT_RUN >&2\nexit 1\n' }
    })
    expect(r.status).toBe(0)
    expect(r.size(STANDARD)).toBe(-1)
  })
})

describe('doc-strings-review workflow: doc-impact dispatch (executed)', () => {
  const step = stepNamed('Dispatch doc-impact')
  const expressions = {
    '${{ github.repository }}': 'redpanda-data/redpanda',
    '${{ github.event.pull_request.number }}': '7',
    '${{ github.event.pull_request.html_url }}': 'https://github.com/redpanda-data/redpanda/pull/7'
  }
  const GH_RECORDER = '#!/bin/bash\nprintf \'%s\\n\' "$@" >> "$HOME/gh-argv"\ncat > "$HOME/gh-stdin"\n'
  const env = { GH_TOKEN: 'bot', DISPATCH_REPO: 'redpanda-data/docs-site' }

  const valid = {
    findings: [{
      surface: 'properties',
      name: 'cloud_storage_cache_size',
      change_kind: 'default-changed',
      affected_pages: ['https://docs.redpanda.com/current/manage/tiered-storage/'],
      summary: 'The documented default no longer matches the source.'
    }],
    proposed_ticket: { title: 'Update tiered storage cache default', body: 'See PR.' }
  }

  function dispatch (docImpact, extraEnv = {}) {
    return execRun(step, {
      env: { ...env, ...extraEnv },
      expressions,
      stubs: { gh: GH_RECORDER },
      files: docImpact === null ? {} : { 'doc-impact.json': JSON.stringify(docImpact) }
    })
  }

  test('a well-formed report is dispatched to the configured repo', () => {
    const r = dispatch(valid)
    expect(r.status).toBe(0)
    const argv = fs.readFileSync(path.join(r.dir, 'gh-argv'), 'utf8')
    expect(argv).toMatch(/repos\/redpanda-data\/docs-site\/dispatches/)
    const payload = JSON.parse(fs.readFileSync(path.join(r.dir, 'gh-stdin'), 'utf8'))
    expect(payload.event_type).toBe('doc-impact')
    expect(payload.client_payload.impact.findings).toHaveLength(1)
  })

  test.each([
    ['a finding missing required fields', { findings: [{ surface: 'properties' }], proposed_ticket: { title: 't', body: 'b' } }],
    ['an off-site affected_pages URL', {
      findings: [{ ...valid.findings[0], affected_pages: ['https://evil.example.com/x'] }],
      proposed_ticket: { title: 't', body: 'b' }
    }],
    ['a non-string affected_pages entry', {
      findings: [{ ...valid.findings[0], affected_pages: [{ url: 'x' }] }],
      proposed_ticket: { title: 't', body: 'b' }
    }],
    ['no proposed_ticket', { findings: valid.findings }],
    ['more than ten findings', {
      findings: Array.from({ length: 11 }, () => valid.findings[0]),
      proposed_ticket: { title: 't', body: 'b' }
    }],
    ['findings as an object', { findings: { surface: 'properties' }, proposed_ticket: { title: 't', body: 'b' } }]
  ])('%s is not dispatched', (_label, docImpact) => {
    // The report is model-authored from untrusted PR content and a bot token
    // forwards it cross-repo to open Jira tickets, so the shape is checked
    // here rather than trusted.
    const r = dispatch(docImpact)
    expect(fs.existsSync(path.join(r.dir, 'gh-argv'))).toBe(false)
    expect(r.all).toMatch(/::warning::/)
    expect(r.status).toBe(0)
  })

  test('a hostile dispatch_repo input cannot execute a command', () => {
    const r = dispatch(valid, { DISPATCH_REPO: 'x; touch PWNED; true' })
    expect(r.exists('PWNED')).toBe(false)
  })

  test('no report and no token both skip quietly', () => {
    expect(dispatch(null).status).toBe(0)
    expect(dispatch(valid, { GH_TOKEN: '' }).status).toBe(0)
  })
})

describe('doc-strings-review workflow: ADP mint (executed)', () => {
  // A curl stub that records its own argv and writes a token file, so the
  // assertions are about what the mint ACTUALLY sends rather than about the
  // YAML's text.
  const CURL_STUB = `#!/bin/bash
printf '%s\\n' "$@" > "$HOME/curl-argv"
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] && printf '{"access_token":"tok-abc"}' > "$out"
printf '200'
exit 0
`
  const JQ_STUB = `#!/bin/bash
# Only the one query this step makes.
f="\${!#}"
grep -o '"access_token":"[^"]*"' "$f" 2>/dev/null | sed 's/.*:"//;s/"$//'
exit 0
`

  function mint ({ secretId, tokenUrl, audience, credEnv }) {
    const step = stepNamed('Mint the ADP gateway token')
    // RUNNER_TEMP and GITHUB_ENV are runner-provided; without them
    // `set -u` aborts the step before curl is ever reached. Pointing
    // RUNNER_TEMP at the cwd keeps the token file inside the temp dir.
    const dirEnv = {
      CLIENT_SECRET_ID: secretId,
      TOKEN_URL: tokenUrl,
      TOKEN_AUDIENCE: audience,
      RUNNER_TEMP: '.',
      GITHUB_ENV: 'github_env',
      ...credEnv
    }
    return execRun(step, {
      env: dirEnv,
      stubs: { curl: CURL_STUB, jq: JQ_STUB }
    })
  }

  const IDP = 'https://aigw.d6kjl4h19241bg3ek3h0.clusters.rdpa.co/oauth/idp/token'
  const CLOUD = 'https://auth.prd.cloud.redpanda.com/oauth/token'

  test('the agent path sends NO audience parameter', () => {
    const r = mint({
      secretId: 'sdlc/prod/github/docs_doc_strings_client',
      tokenUrl: IDP,
      audience: '',
      credEnv: {
        DOCS_DOC_STRINGS_CLIENT_ID: 'serviceaccounts/doc-strings-review',
        DOCS_DOC_STRINGS_CLIENT_SECRET: 's3cret'
      }
    })
    const argv = r.read('curl-argv') || ''
    expect(r.status).toBe(0)
    expect(argv).toContain(IDP)
    // The whole point: not `audience=` either, which satisfies neither endpoint.
    expect(argv).not.toMatch(/audience/)
  })

  test('a standalone service account can still send an audience', () => {
    const r = mint({
      secretId: 'sdlc/prod/github/adp_priv_client',
      tokenUrl: CLOUD,
      audience: 'cloudv2-production.redpanda.cloud',
      credEnv: { ADP_PRIV_CLIENT_ID: 'opaque', ADP_PRIV_CLIENT_SECRET: 's3cret' }
    })
    const argv = r.read('curl-argv') || ''
    expect(r.status).toBe(0)
    expect(argv).toContain(CLOUD)
    expect(argv).toContain('audience=cloudv2-production.redpanda.cloud')
  })

  test('a non-https token endpoint is rejected before curl runs', () => {
    const r = mint({
      secretId: 'sdlc/prod/github/docs_doc_strings_client',
      tokenUrl: 'http://aigw.d6kjl4h19241bg3ek3h0.clusters.rdpa.co/oauth/idp/token',
      audience: '',
      credEnv: {
        DOCS_DOC_STRINGS_CLIENT_ID: 'serviceaccounts/doc-strings-review',
        DOCS_DOC_STRINGS_CLIENT_SECRET: 's3cret'
      }
    })
    expect(r.status).not.toBe(0)
    expect(r.all).toContain('must be https')
    expect(r.exists('curl-argv')).toBe(false)
  })

  test('the credential env names follow the secret id, not a fixed prefix', () => {
    const r = mint({
      secretId: 'sdlc/prod/github/docs_doc_strings_client',
      tokenUrl: IDP,
      audience: '',
      credEnv: {
        DOCS_DOC_STRINGS_CLIENT_ID: 'serviceaccounts/doc-strings-review',
        DOCS_DOC_STRINGS_CLIENT_SECRET: 's3cret'
      }
    })
    expect(r.read('curl-argv') || '').toContain('client_id=serviceaccounts/doc-strings-review')
  })

  test('the OLD fixed names no longer satisfy the new default secret', () => {
    // The regression #302 fixed, asserted from the other side: a caller that
    // supplies adp_priv_client's env names while pointing at the docs secret
    // gets a warning and no mint, not a silent fail-open.
    const r = mint({
      secretId: 'sdlc/prod/github/docs_doc_strings_client',
      tokenUrl: IDP,
      audience: '',
      credEnv: { ADP_PRIV_CLIENT_ID: 'opaque', ADP_PRIV_CLIENT_SECRET: 's3cret' }
    })
    expect(r.status).not.toBe(0)
    expect(r.all).toContain('DOCS_DOC_STRINGS_CLIENT_ID')
    expect(r.exists('curl-argv')).toBe(false)
  })

  test('a hyphenated secret segment is sanitised the way the secrets action does it', () => {
    // aws-secretsmanager-get-secrets upper-cases and replaces every
    // non-alphanumeric with _, so the JSON keys of a secret named
    // .../docs-doc-strings-client arrive as DOCS_DOC_STRINGS_CLIENT_*. A prefix
    // that only upper-cased produced DOCS-DOC-STRINGS-CLIENT_ID, an invalid
    // bash name, and the indirect expansion aborted under set -u before the
    // warning could print.
    const r = mint({
      secretId: 'sdlc/prod/github/docs-doc-strings-client',
      tokenUrl: IDP,
      audience: '',
      credEnv: {
        DOCS_DOC_STRINGS_CLIENT_ID: 'serviceaccounts/doc-strings-review',
        DOCS_DOC_STRINGS_CLIENT_SECRET: 's3cret'
      }
    })
    expect(r.status).toBe(0)
    expect(r.read('curl-argv') || '').toContain('client_id=serviceaccounts/doc-strings-review')
  })

  test('the scrub step derives the credential env names exactly as the mint does', () => {
    const derive = (run) => (run.match(/prefix=\$\(printf '%s' "\$CLIENT_SECRET_ID" \| [^\n]*\)/) || [])[0]
    const mintLine = derive(stepNamed('Mint the ADP gateway token').run)
    const scrubLine = derive(stepNamed('Drop fetched credentials from the review\'s environment').run)
    expect(mintLine).toBeTruthy()
    expect(scrubLine).toBe(mintLine)
  })

  test('the workflow defaults are the agent path', () => {
    const inputs = workflow.on.workflow_call.inputs
    expect(inputs.adp_client_secret_id.default).toBe('sdlc/prod/github/docs_doc_strings_client')
    expect(inputs.adp_token_url.default).toBe(IDP)
    expect(inputs.adp_token_audience.default).toBe('')
  })
})

describe('doc-strings-review workflow: package resolution (executed)', () => {
  const step = stepNamed('Resolve the doc-tools package')
  const NAME = '@redpanda-data/docs-extensions-and-macros'

  // Every gh stub below counts its invocations, because the retry loop is
  // only observable through the call count: a stub that merely succeeds or
  // fails cannot distinguish "read once" from "read three times".
  const COUNT = 'n=$(cat "$HOME/gh-calls" 2>/dev/null || echo 0); echo $((n+1)) > "$HOME/gh-calls"\n'

  // gh stub emulating `gh api <url> --jq .content`: records argv, prints the
  // base64 content a real contents-API call returns. base64 -d and jq run for
  // real downstream, so the decode path is exercised, not assumed.
  const b64Package = (version) =>
    Buffer.from(JSON.stringify({ name: NAME, version })).toString('base64')
  const ghContents = (version) =>
    `#!/bin/bash\n${COUNT}printf '%s\\n' "$@" >> "$HOME/gh-argv"\nprintf '%s' '${b64Package(version)}'\n`
  // Fails the first attempt with a 500, then serves the real content: the
  // transient-blip shape the retry exists for.
  const ghFailThenContents = (version) =>
    `#!/bin/bash\n${COUNT}if [ "$(cat "$HOME/gh-calls")" -lt 2 ]; then echo "gh: HTTP 500" >&2; exit 1; fi\nprintf '%s' '${b64Package(version)}'\n`
  const GH_ALWAYS_FAILS = `#!/bin/bash\n${COUNT}echo "gh: HTTP 500" >&2\nexit 1\n`
  // The backoff is real seconds in the runner; stub it so the suite does not
  // pay them, and record the delays so the backoff itself stays assertable.
  const SLEEP_STUB = '#!/bin/bash\nprintf \'%s\\n\' "$@" >> "$HOME/sleep-argv"\n'
  const NPM_OK = '#!/bin/bash\nprintf \'%s\\n\' "$@" >> "$HOME/npm-argv"\necho 5.30.0\n'
  const NPM_MISSING = '#!/bin/bash\necho \'npm error code E404\' >&2\nexit 1\n'
  const baseEnv = { OVERRIDE: '', JOB_WF_SHA: '', WF_SHA: '', GH_TOKEN: 't' }

  test('an explicit override is used verbatim and nothing is resolved', () => {
    const r = execRun(step, {
      env: { ...baseEnv, OVERRIDE: `${NAME}@9.9.9` },
      stubs: { gh: '#!/bin/bash\ntouch "$HOME/gh-called"\nexit 1\n' }
    })
    expect(r.status).toBe(0)
    expect(r.outputs.pkg).toBe(`${NAME}@9.9.9`)
    expect(r.exists('gh-called')).toBe(false)
  })

  test('resolves the version committed at the reusable workflow ref', () => {
    const r = execRun(step, {
      env: { ...baseEnv, JOB_WF_SHA: 'cafe123' },
      stubs: { gh: ghContents('5.30.0'), npm: NPM_OK }
    })
    expect(r.status).toBe(0)
    expect(r.outputs.pkg).toBe(`${NAME}@5.30.0`)
    const argv = r.read('gh-argv')
    expect(argv).toMatch(/package\.json\?ref=cafe123/)
    // and the resolved spec was verified against the registry before use
    expect(r.read('npm-argv')).toMatch(/@5\.30\.0/)
  })

  test('falls back to workflow_sha for a same-repo (non-reusable) run', () => {
    const r = execRun(step, {
      env: { ...baseEnv, WF_SHA: 'beef456' },
      stubs: { gh: ghContents('5.30.0'), npm: NPM_OK }
    })
    expect(r.outputs.pkg).toBe(`${NAME}@5.30.0`)
    expect(r.read('gh-argv')).toMatch(/ref=beef456/)
  })

  test('a failed contents read is retried three times, then falls open to @latest', () => {
    const r = execRun(step, {
      env: { ...baseEnv, JOB_WF_SHA: 'cafe123' },
      stubs: { gh: GH_ALWAYS_FAILS, sleep: SLEEP_STUB }
    })
    expect(r.status).toBe(0)
    expect(r.outputs.pkg).toBe(`${NAME}@latest`)
    expect(r.all).toMatch(/::warning::/)
    // Retried, not abandoned on the first error, and bounded so a hard 404
    // cannot spin: exactly three reads with two backoffs between them.
    expect(r.read('gh-calls').trim()).toBe('3')
    expect(r.read('sleep-argv').trim().split('\n')).toEqual(['2', '4'])
  })

  test('a transient read failure is retried and the pinned version still wins', () => {
    // The defect this guards: one flaky read swapped @latest into a caller
    // that pinned a ref precisely to freeze what runs inside its PRs, and the
    // only signal was a ::warning:: in someone else's workflow log.
    const r = execRun(step, {
      env: { ...baseEnv, JOB_WF_SHA: 'cafe123' },
      stubs: { gh: ghFailThenContents('5.30.0'), npm: NPM_OK, sleep: SLEEP_STUB }
    })
    expect(r.status).toBe(0)
    expect(r.outputs.pkg).toBe(`${NAME}@5.30.0`)
    expect(r.read('gh-calls').trim()).toBe('2')
    expect(r.all).toMatch(/::notice::.*retrying/)
    // and it stopped as soon as the read succeeded
    expect(r.read('sleep-argv').trim().split('\n')).toEqual(['2'])
  })

  test('a settled answer is not retried', () => {
    // A package.json that parses to a non-version is not a transient fault,
    // so retrying it only delays the fall-open. Reading it again would also
    // mask a genuinely broken ref behind three round trips.
    const r = execRun(step, {
      env: { ...baseEnv, JOB_WF_SHA: 'cafe123' },
      stubs: { gh: ghContents('not-a-version'), npm: NPM_OK, sleep: SLEEP_STUB }
    })
    expect(r.outputs.pkg).toBe(`${NAME}@latest`)
    expect(r.read('gh-calls').trim()).toBe('1')
    expect(r.exists('sleep-argv')).toBe(false)
  })

  test('a non-semver version in package.json falls open to @latest', () => {
    // jq -r over a malformed document prints null/garbage rather than failing;
    // the guard has to catch the value, not the exit status.
    const r = execRun(step, {
      env: { ...baseEnv, JOB_WF_SHA: 'cafe123' },
      stubs: { gh: ghContents('not-a-version'), npm: NPM_OK }
    })
    expect(r.outputs.pkg).toBe(`${NAME}@latest`)
    expect(r.all).toMatch(/::warning::/)
  })

  test('a resolved version missing from npm falls open to @latest', () => {
    // The publish window: main already carries the new version but the
    // publish job has not finished. @latest is simply the previous release.
    const r = execRun(step, {
      env: { ...baseEnv, JOB_WF_SHA: 'cafe123' },
      stubs: { gh: ghContents('5.30.0'), npm: NPM_MISSING }
    })
    expect(r.outputs.pkg).toBe(`${NAME}@latest`)
    expect(r.all).toMatch(/publish in flight/)
  })

  test('no ref at all falls open to @latest without calling gh', () => {
    const r = execRun(step, {
      env: baseEnv,
      stubs: { gh: '#!/bin/bash\ntouch "$HOME/gh-called"\nexit 1\n' }
    })
    expect(r.status).toBe(0)
    expect(r.outputs.pkg).toBe(`${NAME}@latest`)
    expect(r.exists('gh-called')).toBe(false)
  })

  test('a hostile override cannot execute a command', () => {
    const r = execRun(step, {
      env: { ...baseEnv, OVERRIDE: 'x; touch PWNED; true' },
      stubs: { gh: '#!/bin/bash\nexit 0\n' }
    })
    expect(r.exists('PWNED')).toBe(false)
  })
})

// Review once: the state that keeps a later push from re-reviewing a string,
// the lint report that stands in when no model runs, and the single summary
// comment. Each test pins the behavior that made the review noisy before.
describe('doc-strings-review workflow: review once (executed)', () => {
  const JQ = require('child_process').execSync('command -v jq').toString().trim()

  // gh stub backed by a JSON file of comments: `--jq` filters apply to the
  // stored payload with real jq, and POST/PATCH calls are recorded.
  const ghCommentsStub = `#!/bin/bash
args=("$@")
filter=""; method=GET; body=""
for i in "\${!args[@]}"; do
  case "\${args[$i]}" in
    --jq) filter="\${args[$((i+1))]}" ;;
    --method) method="\${args[$((i+1))]}" ;;
    -F) body="\${args[$((i+1))]#body=@}" ;;
  esac
done
url=""
for a in "$@"; do case "$a" in repos/*) url="$a" ;; esac; done
printf '%s %s\\n' "$method" "$url" >> "$HOME/gh-calls"
if [ "$method" != GET ]; then cp "$body" "$HOME/posted-body"; exit 0; fi
case "$url" in
  */issues/comments/*) payload=$(${JSON.stringify(JQ)} --argjson id "\${url##*/}" '.[] | select(.id == $id)' "$HOME/comments.json") ;;
  *) payload=$(cat "$HOME/comments.json") ;;
esac
if [ -n "$filter" ]; then printf '%s' "$payload" | ${JSON.stringify(JQ)} -r "$filter"; else printf '%s' "$payload"; fi
`

  describe('recovering fingerprints from earlier suggestions', () => {
    const step = stepNamed('Recover reviewed fingerprints from earlier suggestions')
    const env = (dir) => ({ GH_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', PR: '7', STATE_DIR: path.join(dir, 'state') })

    test('only bot-authored markers count, merged with the cached state', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-state-'))
      fs.mkdirSync(path.join(dir, 'state'))
      fs.writeFileSync(path.join(dir, 'state', 'reviewed.txt'), 'aaaaaaaaaaaaaaaa\n')
      const comments = [
        // The footer as it actually reaches GitHub: claude-code-action strips
        // HTML comments, so the marker is a visible <sub> line.
        { id: 1, user: { login: 'claude[bot]', type: 'Bot' }, body: 'Fix it.\n<sub>doc-strings-review:fp=bbbbbbbbbbbbbbbb</sub>' },
        { id: 2, user: { login: 'someone', type: 'User' }, body: '<!-- doc-strings-review:fp=cccccccccccccccc -->' }
      ]
      const r = execRun(step, { env: env(dir), stubs: { gh: ghCommentsStub }, files: { 'comments.json': JSON.stringify(comments) } })
      expect(r.status).toBe(0)
      expect(fs.readFileSync(path.join(dir, 'state', 'reviewed.txt'), 'utf8').trim().split('\n'))
        .toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'])
    })

    test('a failed comment read keeps the cached state and does not fail the step', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-state-'))
      fs.mkdirSync(path.join(dir, 'state'))
      fs.writeFileSync(path.join(dir, 'state', 'reviewed.txt'), 'aaaaaaaaaaaaaaaa\n')
      const r = execRun(step, { env: env(dir), stubs: { gh: '#!/bin/bash\nexit 1\n' } })
      expect(r.status).toBe(0)
      expect(fs.readFileSync(path.join(dir, 'state', 'reviewed.txt'), 'utf8').trim()).toBe('aaaaaaaaaaaaaaaa')
    })
  })

  describe('lint step', () => {
    const step = stepNamed('Lint doc strings in the diff')
    const baseEnv = { BASE: 'deadbeef', SURFACES: '', PKG: RESOLVED_PKG, LINT_JSON: '{"findings":[],"summary":{"totalDeclarations":0}}' }

    test('passes the reviewed state to the CLI when there is one', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-state-'))
      fs.writeFileSync(path.join(dir, 'reviewed.txt'), 'aaaaaaaaaaaaaaaa\n')
      const r = execRun(step, { env: { ...baseEnv, STATE_DIR: dir }, stubs: { npx: NPX_STUB } })
      const argv = fs.readFileSync(path.join(r.dir, 'npx-argv'), 'utf8').split('\n')
      expect(argv).toContain('--reviewed')
      expect(argv).toContain(path.join(dir, 'reviewed.txt'))
    })

    test('a first run passes no --reviewed at all', () => {
      const r = execRun(step, { env: { ...baseEnv, STATE_DIR: path.join(os.tmpdir(), 'no-such-dsr-state') }, stubs: { npx: NPX_STUB } })
      const argv = fs.readFileSync(path.join(r.dir, 'npx-argv'), 'utf8').split('\n')
      expect(argv).not.toContain('--reviewed')
      expect(r.status).toBe(0)
    })
  })

  describe('lint report in the job summary', () => {
    const step = stepNamed('Write the lint report to the job summary')

    test('renders findings as a table, escaping pipes so a string cannot break it', () => {
      const lint = {
        findings: [{ name: 'a_prop', file: 'src/v/config/configuration.cc', line_start: 10, rules: [{ id: 'too-short', severity: 'warning', message: 'Use a | b\nnot this' }] }],
        summary: { totalDeclarations: 3, alreadyReviewed: 2, flaggedDeclarations: 1, removedDeclarations: [{ name: 'old_prop', surface: 'properties' }] }
      }
      const r = execRun(step, { env: { GITHUB_STEP_SUMMARY: 'summary.md' }, files: { 'lint-findings.json': JSON.stringify(lint) } })
      expect(r.status).toBe(0)
      const out = r.read('summary.md')
      expect(out).toMatch(/New or changed declarations to review: 3\. Already reviewed on an earlier push: 2\./)
      expect(out).toMatch(/Removed or renamed: `old_prop` \(properties\)/)
      const row = out.split('\n').find((l) => l.includes('a_prop'))
      expect(row).toContain('Use a \\| b not this')
      expect(row.split(/(?<!\\)\|/).length - 2).toBe(4)
    })

    test('no report file is said plainly rather than failing', () => {
      const r = execRun(step, { env: { GITHUB_STEP_SUMMARY: 'summary.md' } })
      expect(r.status).toBe(0)
      expect(r.read('summary.md')).toMatch(/No lint report/)
    })
  })

  describe('summary comment', () => {
    const step = stepNamed('Update the review summary comment')
    const env = { GH_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', PR: '7', HEAD_SHA: 'abcdef1234567' }

    test('no summary file means no comment at all', () => {
      const r = execRun(step, { env, stubs: { gh: ghCommentsStub }, files: { 'comments.json': '[]' } })
      expect(r.status).toBe(0)
      expect(r.exists('gh-calls')).toBe(false)
    })

    test('the first summary creates one comment', () => {
      const r = execRun(step, {
        env,
        stubs: { gh: ghCommentsStub },
        files: { 'comments.json': '[]', 'review-summary.md': 'Affected published content: x' }
      })
      expect(r.status).toBe(0)
      expect(r.read('gh-calls')).toMatch(/^POST repos\/o\/r\/issues\/7\/comments$/m)
      const body = r.read('posted-body')
      expect(body.startsWith('<!-- doc-strings-review:summary -->')).toBe(true)
      expect(body).toMatch(/push abcdef1/)
    })

    test('a later summary edits the same comment, newest push first, with one marker', () => {
      const previous = '<!-- doc-strings-review:summary -->\n### Doc-strings review, push 1111111\n\nold news\n\n_Suggestions are optional. Each string is reviewed once; editing it gets a fresh review on the next push._\n'
      const comments = [
        { id: 5, user: { login: 'someone', type: 'User' }, body: 'quoting <!-- doc-strings-review:summary -->' },
        { id: 9, user: { login: 'github-actions[bot]', type: 'Bot' }, body: previous }
      ]
      const r = execRun(step, {
        env,
        stubs: { gh: ghCommentsStub },
        files: { 'comments.json': JSON.stringify(comments), 'review-summary.md': 'new news' }
      })
      expect(r.status).toBe(0)
      expect(r.read('gh-calls')).toMatch(/^PATCH repos\/o\/r\/issues\/comments\/9$/m)
      expect(r.read('gh-calls')).not.toMatch(/^POST/m)
      const body = r.read('posted-body')
      expect(body.split('<!-- doc-strings-review:summary -->').length - 1).toBe(1)
      expect(body.indexOf('new news')).toBeLessThan(body.indexOf('old news'))
      expect(body.split('_Suggestions are optional.').length - 1).toBe(1)
    })
  })

  describe('recording what was reviewed', () => {
    const step = stepNamed('Record the reviewed fingerprints')

    test('adds pending and removed fingerprints, deduplicated, ignoring junk', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-state-'))
      fs.writeFileSync(path.join(dir, 'reviewed.txt'), 'aaaaaaaaaaaaaaaa\n')
      const lint = {
        declarations: [{ fingerprint: 'bbbbbbbbbbbbbbbb' }, { fingerprint: 'aaaaaaaaaaaaaaaa' }, { fingerprint: '$(touch pwned)' }],
        summary: { removedDeclarations: [{ fingerprint: 'cccccccccccccccc' }] }
      }
      const r = execRun(step, { env: { STATE_DIR: dir }, files: { 'lint-findings.json': JSON.stringify(lint) } })
      expect(r.status).toBe(0)
      expect(fs.readFileSync(path.join(dir, 'reviewed.txt'), 'utf8').trim().split('\n'))
        .toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'])
      expect(r.exists('pwned')).toBe(false)
    })
  })

  describe('static contracts', () => {
    const review = stepNamed('Claude review with suggestions')

    test('the model cannot post a top-level comment itself', () => {
      expect(review.with.claude_args).not.toMatch(/add_issue_comment/)
      expect(review.with.claude_args).toMatch(/create_inline_comment/)
    })

    test('state is saved only after a review that actually ran', () => {
      expect(stepNamed('Record the reviewed fingerprints').if).toMatch(/steps\.review\.outputs\.execution_file != ''/)
      expect(stepNamed('Save the review state').if).toMatch(/steps\.record\.outcome == 'success'/)
    })

    test('restore and save use the same per-PR key prefix', () => {
      const restore = stepNamed('Restore the review state').with
      const save = stepNamed('Save the review state').with
      expect(save.key).toBe(restore.key)
      expect(restore.key.startsWith(restore['restore-keys'])).toBe(true)
      expect(save.path).toBe(restore.path)
    })

    test('the prompt caps inline comments and tells the model to mark each one', () => {
      expect(review.with.prompt).toMatch(/AT MOST 10 inline comments/)
      // Visible, because the action's comment tools strip HTML comments.
      expect(review.with.prompt).toMatch(/<sub>doc-strings-review:fp=FINGERPRINT<\/sub>/)
      expect(review.with.prompt).not.toMatch(/<!-- doc-strings-review:fp/)
      expect(review.with.prompt).not.toMatch(/Finish with one summary comment/)
    })

    test('the prompt reviews strings in their page context and keeps articles', () => {
      expect(review.with.prompt).toMatch(/REVIEW IN CONTEXT/)
      expect(review.with.prompt).toMatch(/Each entry carries context/)
      expect(review.with.prompt).toMatch(/articles and subjects/)
      expect(review.with.prompt).toMatch(/Every flag, command, path and URL goes in inline code/)
      // The related-string comment is the named exception to the
      // suggestion-block rule, and still carries the fingerprint footer.
      expect(review.with.prompt).toMatch(/one exception to the suggestion rules above/)
      expect(review.with.prompt).toMatch(/still ends with the changed declaration's\s+fingerprint footer/)
    })
  })
})
