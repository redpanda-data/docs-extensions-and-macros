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

const PKG_DEFAULT = workflow.on.workflow_call.inputs.doc_tools_package.default

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
function execRun (step, { env = {}, stubs = {}, expressions = {}, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-step-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)

  for (const [name, body] of Object.entries(stubs)) {
    const p = path.join(bin, name)
    fs.writeFileSync(p, body.startsWith('#!') ? body : `#!/bin/bash\n${body}\n`)
    fs.chmodSync(p, 0o755)
  }
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body)
  }

  // Substituted the way the runner does it: textually, before bash. The map
  // covers the expressions an EARLIER version of this workflow inlined into
  // its run: bodies as well as the ones the current version uses, so a
  // regression that moves an input back inline still executes here and fails
  // on behaviour rather than on an unresolved-placeholder error.
  const allExpressions = {
    '${{ github.repository }}': env.GITHUB_REPOSITORY || 'redpanda-data/redpanda',
    '${{ github.event.pull_request.number }}': env.PR || '7',
    '${{ github.event.pull_request.html_url }}': 'https://github.com/redpanda-data/redpanda/pull/7',
    '${{ inputs.doc_tools_package }}': env.PKG || PKG_DEFAULT,
    '${{ inputs.surfaces }}': env.SURFACES || '',
    '${{ inputs.dispatch_repo }}': env.DISPATCH_REPO || 'redpanda-data/docs-site',
    ...expressions
  }
  let body = step.run
  for (const [expr, value] of Object.entries(allExpressions)) {
    body = body.split(expr).join(value)
  }
  const unresolved = body.match(/\$\{\{[^}]*\}\}/g)
  if (unresolved) throw new Error(`unresolved expressions in step body: ${unresolved.join(', ')}`)

  const scriptPath = path.join(dir, 'step.sh')
  fs.writeFileSync(scriptPath, body)
  const outputFile = path.join(dir, 'github_output')
  fs.writeFileSync(outputFile, '')

  const result = spawnSync('/bin/bash', ['-e', scriptPath], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      GITHUB_OUTPUT: outputFile,
      ...env
    }
  })

  const outputs = {}
  for (const line of fs.readFileSync(outputFile, 'utf8').split('\n')) {
    const m = line.match(/^([^=]+)=(.*)$/)
    if (m) outputs[m[1]] = m[2]
  }

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    all: `${result.stdout || ''}${result.stderr || ''}`,
    outputs,
    dir,
    exists: (f) => fs.existsSync(path.join(dir, f)),
    size: (f) => (fs.existsSync(path.join(dir, f)) ? fs.statSync(path.join(dir, f)).size : -1),
    read: (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null)
  }
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

  test('the caller contract does not point at a ref that cannot resolve', () => {
    // The repo publishes no git tags, so a @v<version> example in the shim
    // hands every caller an unresolvable ref.
    const shim = fs.readFileSync(WORKFLOW_PATH, 'utf8')
    const refs = [...shim.matchAll(/doc-strings-review\.yml@([\w.\-/]+)/g)].map((m) => m[1])
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) expect(ref).not.toMatch(/^v\d/)
  })

  test('doc_tools_package pins a version, and the pin matches this package', () => {
    // An unpinned spec floats to whatever `latest` is at run time inside
    // engineering repos. Asserting it equals THIS package's version means a
    // release bump cannot silently leave the pin behind.
    expect(PKG_DEFAULT).toBe(`${pkgJson.name}@${pkgJson.version}`)
    expect(PKG_DEFAULT).toMatch(/@\d+\.\d+\.\d+$/)
  })

  test('the caller contract documents the permissions a caller must grant', () => {
    const header = fs.readFileSync(WORKFLOW_PATH, 'utf8').split('name: doc-strings-review')[0]
    expect(header).toMatch(/pull-requests:\s*write/)
    expect(header).toMatch(/pull_request_target/)
  })
})

describe('doc-strings-review workflow: lint step (executed)', () => {
  const step = stepNamed('Lint doc strings in the diff')
  const baseEnv = { BASE: 'deadbeef', SURFACES: '', PKG: PKG_DEFAULT }

  test('invokes the CLI through --package= so npx can resolve the doc-tools bin', () => {
    const r = execRun(step, {
      env: { ...baseEnv, LINT_JSON: '{"findings":[{"a":1},{"b":2}]}' },
      stubs: { npx: NPX_STUB }
    })
    const argv = fs.readFileSync(path.join(r.dir, 'npx-argv'), 'utf8').split('\n')
    expect(argv).toContain(`--package=${PKG_DEFAULT}`)
    // and the spec is NOT handed to npx as a bare positional, which is the
    // form that cannot resolve either declared bin.
    expect(argv).not.toContain(PKG_DEFAULT)
    expect(argv).toContain('lint-strings')
    expect(r.status).toBe(0)
    expect(r.outputs.count).toBe('2')
  })

  test('the bare npx form would produce count=0, not an empty count', () => {
    // Drive the same body with a stub that refuses to resolve a bin, which is
    // exactly what the shipped `npx --yes <pkg> doc-tools` form did: exit 1,
    // zero bytes. The gate must read 0 and annotate, never ''.
    const r = execRun(step, {
      env: { ...baseEnv, LINT_EXIT: '1' },
      stubs: {
        npx: '#!/bin/bash\necho \'npm error could not determine executable to run\' >&2\nexit 1\n'
      }
    })
    expect(r.outputs.count).toBe('0')
    expect(r.outputs.count).not.toBe('')
    expect(r.all).toMatch(/::warning::/)
    expect(r.status).toBe(0)
  })

  test('a zero-byte findings file yields count=0 (jq prints nothing there)', () => {
    const r = execRun(step, { env: baseEnv, stubs: { npx: NPX_STUB } })
    expect(r.size('lint-findings.json')).toBe(0)
    expect(r.outputs.count).toBe('0')
    expect(r.all).toMatch(/::warning::/)
  })

  test('non-JSON output yields count=0 rather than a non-numeric gate value', () => {
    const r = execRun(step, {
      env: { ...baseEnv, LINT_JSON: 'this is not json' },
      stubs: { npx: NPX_STUB }
    })
    expect(r.outputs.count).toBe('0')
    expect(r.all).toMatch(/::warning::/)
  })

  test('a clean lint reports count=0 and a dirty lint reports the real count', () => {
    const clean = execRun(step, {
      env: { ...baseEnv, LINT_JSON: '{"findings":[]}' },
      stubs: { npx: NPX_STUB }
    })
    expect(clean.outputs.count).toBe('0')
    const dirty = execRun(step, {
      env: { ...baseEnv, LINT_JSON: '{"findings":[{},{},{}]}' },
      stubs: { npx: NPX_STUB }
    })
    expect(dirty.outputs.count).toBe('3')
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
