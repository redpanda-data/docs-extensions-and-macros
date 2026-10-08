'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const YAML = require('yaml')

const { execRun } = require('./helpers/exec-run')

/**
 * The Connect docs check runs inside connect's PRs. Two properties matter
 * more than any other and are easy to break with a one-line edit:
 *
 *   - the org bot token that clones the private doc sources must never reach
 *     the Antora process (Antora loads extensions and Asciidoctor code from
 *     npm; nothing it runs should be able to read a token),
 *   - the build-log check blocks and the rendered-HTML check does not.
 *
 * Reading the YAML is not enough for either, so the key `run:` bodies are
 * also EXECUTED under bash -e with git/npx stubbed.
 */

const REPO_ROOT = path.join(__dirname, '..', '..')
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'connect-docs-check.yml')
const workflowText = fs.readFileSync(WORKFLOW_PATH, 'utf8')
const workflow = YAML.parse(workflowText)
const job = workflow.jobs['connect-docs-check']

function stepNamed (name) {
  const step = job.steps.find((s) => s.name === name)
  if (!step) throw new Error(`no step named ${name}; steps: ${job.steps.map((s) => s.name || s.uses).join(', ')}`)
  return step
}
const indexOf = (name) => job.steps.indexOf(stepNamed(name))
const runSteps = job.steps.filter((s) => typeof s.run === 'string')

const CLONE = 'Clone the private doc sources'
const DROP = 'Drop credentials from the job environment'
const BUILD = 'Build the docs with the PR\'s generated tree'
const LOG_CHECK = 'Check the build log (blocking)'
const HTML_CHECK = 'Check the rendered HTML (warning only)'
const DIFF = 'Diff the generated docs against the merge base'

const SECRETISH = /secrets\.|ACTIONS_BOT_TOKEN|TOKEN|aws_cred/i

/** A WORK directory with the rp-connect-docs clone the steps cd into. */
function workDir () {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-work-'))
  fs.mkdirSync(path.join(work, 'sources', 'rp-connect-docs'), { recursive: true })
  return work
}

describe('connect-docs-check workflow: static contracts', () => {
  test('is a reusable workflow taking the generated-tree artifacts', () => {
    const call = workflow.on.workflow_call
    expect(call.inputs.docs_artifact.required).toBe(true)
    expect(call.inputs.base_docs_artifact.default).toBe('')
    expect(Object.keys(call.secrets)).toEqual(expect.arrayContaining(['actions_bot_token', 'aws_cred_account_id']))
  })

  test('skips drafts and fork PRs', () => {
    expect(job.if).toMatch(/!github\.event\.pull_request\.draft/)
    expect(job.if).toMatch(/head\.repo\.full_name == github\.repository/)
  })

  test('no workflow_call input is interpolated into a run: body', () => {
    for (const step of runSteps) expect(step.run).not.toMatch(/\$\{\{\s*inputs\./)
  })

  test('every run: body sets pipefail', () => {
    for (const step of runSteps) {
      expect(step.run.split('\n').some((l) => /^\s*set -[a-z]*o pipefail/.test(l))).toBe(true)
    }
  })

  test('installs docs-extensions-and-macros from this workflow\'s own commit', () => {
    const checkout = job.steps.find((s) => s.uses && s.uses.startsWith('actions/checkout') && s.with && s.with.repository === 'redpanda-data/docs-extensions-and-macros')
    expect(checkout.with.ref).toMatch(/job\.workflow_sha/)
    expect(checkout.with['persist-credentials']).toBe(false)
    expect(stepNamed('Install Antora and docs-extensions-and-macros').run).toMatch(/npm pack[\s\S]*npm install --no-save[^\n]*\$tarball/)
  })

  test('uses the playbook file under the tool directory, and that playbook has only local sources', () => {
    expect(stepNamed('Install Antora and docs-extensions-and-macros').run).toContain('tools/connect-docs/ci-playbook.yml')
    const playbook = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, 'tools', 'connect-docs', 'ci-playbook.yml'), 'utf8'))
    const urls = playbook.content.sources.map((s) => s.url)
    expect(urls).toEqual(['.', '../docs', '../docs', '../cloud-docs', '../redpanda-labs', '../docs-site'])
    // The asset-mode extension that reads REDPANDA_CONNECT_DOCS_DIR is loaded.
    expect(playbook.antora.extensions.map((e) => e.require)).toContain('@redpanda-data/docs-extensions-and-macros/extensions/modify-connect-tag-playbook')
    // set-latest-version logs an error without a GitHub token, which would
    // turn every run red.
    expect(JSON.stringify(playbook)).not.toMatch(/set-latest-version/)
  })

  test('the caller contract grants every permission the job declares', () => {
    const comments = workflowText.split('\n').filter((l) => l.startsWith('#')).join('\n')
    for (const scope of Object.keys(job.permissions)) expect(comments).toMatch(new RegExp(`^#\\s+${scope}:`, 'm'))
  })
})

describe('connect-docs-check workflow: no token in the Antora step', () => {
  test('the job-level env carries no credential', () => {
    for (const value of Object.values(job.env || {})) expect(String(value)).not.toMatch(SECRETISH)
  })

  test('only the clone step references the bot token', () => {
    const users = job.steps.filter((s) => /ACTIONS_BOT_TOKEN|secrets\.actions_bot_token/.test(JSON.stringify(s.env || {})))
    expect(users.map((s) => s.name)).toEqual([CLONE])
  })

  test('the Antora step env has no token, and Antora runs with JSON logs and failure level fatal', () => {
    const build = stepNamed(BUILD)
    for (const [key, value] of Object.entries(build.env || {})) {
      expect(key).not.toMatch(SECRETISH)
      expect(String(value)).not.toMatch(SECRETISH)
    }
    expect(build.env.REDPANDA_CONNECT_DOCS_DIR).toMatch(/connect-docs-check\/head$/)
    expect(build.run).toMatch(/--log-format json/)
    expect(build.run).toMatch(/--log-failure-level fatal/)
    expect(build.uses).toBeUndefined()
  })

  test('credentials are dropped from the job env after the clone and before anything installs or builds', () => {
    expect(indexOf(DROP)).toBeGreaterThan(indexOf(CLONE))
    expect(indexOf(DROP)).toBeLessThan(indexOf('Install Antora and docs-extensions-and-macros'))
    expect(indexOf(DROP)).toBeLessThan(indexOf(BUILD))
    // Secrets Manager and the AWS role export into the job env; the ones that
    // read the bot token must come before the drop. The preview's own come
    // after the build (see the deploy preview tests).
    const exporters = job.steps.filter((s) => s.uses && /aws-actions\//.test(s.uses) && !/preview/.test(s.name))
    expect(exporters).toHaveLength(2)
    for (const s of exporters) expect(job.steps.indexOf(s)).toBeLessThan(indexOf(DROP))
    expect(stepNamed(DROP).if).toBe('always()')
  })

  test('the drop step blanks the token and the AWS session credentials', () => {
    const r = execRun(stepNamed(DROP), { env: { GITHUB_ENV: path.join(os.tmpdir(), `cdc-env-${process.pid}`) } })
    expect(r.status).toBe(0)
    const env = fs.readFileSync(path.join(os.tmpdir(), `cdc-env-${process.pid}`), 'utf8')
    for (const v of ['ACTIONS_BOT_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
      expect(env).toContain(`${v}=\n`)
    }
  })

  // git stub: records argv and the auth header it was handed, and creates the
  // clone directory with a .git/config holding whatever git would persist.
  const GIT_STUB = `#!/bin/bash
if [ "$1" = "clone" ]; then
  printf '%s\\n' "$*" >> "$HOME/git-argv"
  printf '%s|%s\\n' "\${GIT_CONFIG_KEY_0:-}" "\${GIT_CONFIG_VALUE_0:-}" >> "$HOME/git-auth"
  dest="\${@: -1}"
  mkdir -p "$dest/.git"
  printf '[remote "origin"]\\n' > "$dest/.git/config"
  if [ -n "\${PERSIST:-}" ]; then printf '[http]\\n  extraheader = x\\n' >> "$dest/.git/config"; fi
  exit 0
fi
if [ "$1" = "-C" ]; then echo abc1234; exit 0; fi
exit 0
`

  test('the clone step clones every source with the token in GIT_CONFIG_* only, never argv', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-clone-'))
    const r = execRun(stepNamed(CLONE), { env: { WORK: work, TOKEN: 'ghs_secretvalue', RPCN_REF: 'main' }, stubs: { git: GIT_STUB } })
    expect(r.status).toBe(0)
    const argv = r.read('git-argv')
    for (const repo of ['rp-connect-docs', 'docs', 'cloud-docs', 'docs-site', 'redpanda-labs']) {
      expect(argv).toContain(`https://github.com/redpanda-data/${repo}.git`)
    }
    expect(argv).not.toContain('ghs_secretvalue')
    expect(argv).not.toContain(Buffer.from('x-access-token:ghs_secretvalue').toString('base64'))
    const auth = r.read('git-auth').trim().split('\n')
    expect(auth).toHaveLength(5)
    for (const line of auth) {
      expect(line).toBe(`http.https://github.com/.extraheader|AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_secretvalue').toString('base64')}`)
    }
  })

  test('the clone step fails when a clone persisted credentials', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-clone-'))
    const r = execRun(stepNamed(CLONE), { env: { WORK: work, TOKEN: 't', RPCN_REF: 'main', PERSIST: '1' }, stubs: { git: GIT_STUB } })
    expect(r.status).toBe(1)
    expect(r.all).toMatch(/persisted credentials/)
  })

  test('the clone step fails with a clear error when no token is available', () => {
    const r = execRun(stepNamed(CLONE), { env: { WORK: workDir(), TOKEN: '', RPCN_REF: 'main' }, stubs: { git: GIT_STUB } })
    expect(r.status).toBe(1)
    expect(r.all).toMatch(/No token to clone/)
    expect(r.exists('git-argv')).toBe(false)
  })
})

describe('connect-docs-check workflow: what blocks and what warns', () => {
  // Records argv, writes a marker naming the command to any --output file
  // that a test has not already provided (the real commands write it before
  // exiting), then exits NPX_EXIT.
  const NPX_STUB = `#!/bin/bash
printf '%s\\n' "$*" >> "$HOME/npx-argv"
prev=""
for a in "$@"; do
  if [ "$prev" = "--output" ] && [ ! -e "$a" ]; then printf 'REPORT FROM %s\\n' "$3" > "$a"; fi
  prev="$a"
done
exit \${NPX_EXIT:-0}
`
  const summary = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-sum-')), 'summary.md')

  test('the build step records Antora\'s exit code instead of failing, so the log check decides', () => {
    const work = workDir()
    // Antora appends to --log-file, so a stale log would leak old errors in.
    fs.writeFileSync(path.join(work, 'antora.ndjson'), '{"level":"error","msg":"stale"}\n')
    const r = execRun(stepNamed(BUILD), {
      env: { WORK: work, CACHE_DIR: '/tmp/c', REDPANDA_CONNECT_DOCS_DIR: '/tmp/h', NPX_EXIT: '3' },
      stubs: { npx: NPX_STUB }
    })
    expect(r.status).toBe(0)
    expect(r.outputs.exit_code).toBe('3')
    expect(fs.readFileSync(path.join(work, 'antora.ndjson'), 'utf8')).toBe('')
    expect(r.read('npx-argv')).toMatch(/--log-file .*antora\.ndjson/)
  })

  test('the log check has no continue-on-error and runs after a failed build', () => {
    const step = stepNamed(LOG_CHECK)
    expect(step['continue-on-error']).toBeUndefined()
    expect(step.if).toMatch(/!cancelled\(\)/)
    expect(step.run).toMatch(/check-build-log/)
    expect(step.run).toMatch(/--min-pages/)
    // Errors from rp-connect-docs and the connect tree block; errors from
    // docs main and the other sources are listed only.
    expect(step.run).toMatch(/--blocking-sources redpanda-data\/rp-connect-docs,redpanda-data\/connect/)
  })

  test.each([
    ['a failing log check', { NPX_EXIT: '1', ANTORA_EXIT: '0' }, 1],
    ['Antora exiting non-zero with a clean log', { NPX_EXIT: '0', ANTORA_EXIT: '1' }, 1],
    ['a clean log and a clean exit', { NPX_EXIT: '0', ANTORA_EXIT: '0' }, 0]
  ])('the log check step blocks on %s', (_, env, status) => {
    const sum = summary()
    const r = execRun(stepNamed(LOG_CHECK), {
      env: { WORK: workDir(), MIN_PAGES: '400', GITHUB_STEP_SUMMARY: sum, ...env },
      stubs: { npx: NPX_STUB }
    })
    expect(r.status).toBe(status)
    // The summary is written whether the check passes or fails: a red check
    // with no explanation is the thing this step exists to prevent.
    expect(fs.readFileSync(sum, 'utf8')).toContain('REPORT FROM check-build-log')
  })

  test('the HTML check never blocks: continue-on-error, no --strict, and exit 0 when the check fails', () => {
    const step = stepNamed(HTML_CHECK)
    expect(step['continue-on-error']).toBe(true)
    expect(step.run).not.toMatch(/--strict/)
    const r = execRun(step, { env: { WORK: workDir(), GITHUB_STEP_SUMMARY: summary(), NPX_EXIT: '1' }, stubs: { npx: NPX_STUB } })
    expect(r.status).toBe(0)
    expect(r.all).toMatch(/::warning::The rendered HTML check could not run/)
  })

  test('the HTML check warns, not errors, when it has findings', () => {
    const work = workDir()
    fs.writeFileSync(path.join(work, 'html-check.json'), JSON.stringify({ total: 17 }))
    fs.writeFileSync(path.join(work, 'html-check.md'), '## Rendered HTML checks\n')
    const r = execRun(stepNamed(HTML_CHECK), { env: { WORK: work, GITHUB_STEP_SUMMARY: summary() }, stubs: { npx: NPX_STUB } })
    expect(r.status).toBe(0)
    expect(r.all).toMatch(/::warning::The rendered connect pages have 17/)
    expect(r.all).not.toMatch(/::error::/)
  })

  test('the diff step stages the rendered HTML of changed pages that were built', () => {
    const work = workDir()
    fs.writeFileSync(path.join(work, 'diff.md'), '## diff\n')
    fs.writeFileSync(path.join(work, 'diff.json'), JSON.stringify({
      pages: [{ sitePath: 'connect/components/inputs/kafka/index.html' }, { sitePath: 'connect/components/inputs/gone/index.html' }]
    }))
    fs.mkdirSync(path.join(work, 'site', 'connect', 'components', 'inputs', 'kafka'), { recursive: true })
    fs.writeFileSync(path.join(work, 'site', 'connect', 'components', 'inputs', 'kafka', 'index.html'), '<html></html>')
    const sum = summary()
    const r = execRun(stepNamed(DIFF), { env: { WORK: work, GITHUB_STEP_SUMMARY: sum }, stubs: { npx: NPX_STUB } })
    expect(r.status).toBe(0)
    expect(r.outputs.pages).toBe('1')
    expect(fs.existsSync(path.join(work, 'changed-pages', 'connect', 'components', 'inputs', 'kafka', 'index.html'))).toBe(true)
    expect(fs.readFileSync(sum, 'utf8')).toContain('## diff')
    expect(stepNamed(DIFF).if).toMatch(/inputs\.base_docs_artifact != ''/)
  })
})

describe('connect-docs-check workflow: deploy preview', () => {
  const FETCH = 'Fetch the preview token from Secrets Manager'
  const ASSUME = 'Assume the AWS role that can read the preview token'
  const PUBLISH = 'Publish the deploy preview'
  const LINK = 'Link the deploy preview from the commit'

  function siteDir () {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-prev-'))
    fs.mkdirSync(path.join(work, 'site', 'connect', 'home'), { recursive: true })
    fs.writeFileSync(path.join(work, 'site', 'connect', 'home', 'index.html'), '<html></html>')
    fs.mkdirSync(path.join(work, 'site', '_'))
    fs.mkdirSync(path.join(work, 'site', 'self-managed'))
    return work
  }
  const NETLIFY_STUB = `#!/bin/bash
printf '%s\\n' "$*" >> "$HOME/npx-argv"
cp -R "$4" "$HOME/deployed" 2>/dev/null || true
echo '{"deploy_url":"https://connect-pr-42--redpanda-connect.netlify.app"}'
`

  test('the preview token is fetched only after Antora, the checks, and the credential drop', () => {
    for (const later of [ASSUME, FETCH, PUBLISH, LINK]) {
      for (const earlier of [DROP, BUILD, LOG_CHECK, HTML_CHECK, DIFF]) {
        expect(indexOf(later)).toBeGreaterThan(indexOf(earlier))
      }
    }
  })

  test('a caller without the secret skips the preview instead of failing', () => {
    expect(stepNamed(ASSUME)['continue-on-error']).toBe(true)
    expect(stepNamed(FETCH)['continue-on-error']).toBe(true)
    const r = execRun(stepNamed(PUBLISH), { env: { WORK: siteDir(), PR_NUMBER: '42' }, stubs: { npx: 'touch "$HOME/npx-called"; exit 1' } })
    expect(r.status).toBe(0)
    expect(r.all).toMatch(/no deploy preview/)
    expect(r.exists('npx-called')).toBe(false)
  })

  test('deploys only the Connect sections as a draft with a per-PR alias, never to production', () => {
    expect(stepNamed(PUBLISH).run).not.toMatch(/--prod/)
    const work = siteDir()
    const r = execRun(stepNamed(PUBLISH), {
      env: { WORK: work, PR_NUMBER: '42', HEAD_SHA: 'abcdef1234567', NETLIFY_AUTH_TOKEN: 't', NETLIFY_SITE_ID: 's', GITHUB_STEP_SUMMARY: path.join(work, 'summary.md') },
      stubs: { npx: NETLIFY_STUB }
    })
    expect(r.status).toBe(0)
    const argv = r.read('npx-argv')
    expect(argv).toMatch(/netlify-cli@\d+\.\d+\.\d+ deploy/)
    expect(argv).toMatch(/--alias connect-pr-42/)
    expect(argv).not.toMatch(/--prod/)
    expect(fs.existsSync(path.join(work, 'preview', 'connect', 'home', 'index.html'))).toBe(true)
    expect(fs.existsSync(path.join(work, 'preview', 'self-managed'))).toBe(false)
    expect(fs.readFileSync(path.join(work, 'preview', 'robots.txt'), 'utf8')).toMatch(/Disallow: \//)
    expect(r.outputs.url).toBe('https://connect-pr-42--redpanda-connect.netlify.app/connect/home/')
  })

  test('links the preview with a commit status, not a comment', () => {
    const r = execRun(stepNamed(LINK), {
      env: { URL: 'https://x.netlify.app/connect/home/', REPO: 'redpanda-data/connect', HEAD_SHA: 'abc', GH_TOKEN: 't' },
      stubs: { gh: 'printf "%s\\n" "$*" >> "$HOME/gh-argv"' }
    })
    expect(r.status).toBe(0)
    expect(r.read('gh-argv')).toMatch(/repos\/redpanda-data\/connect\/statuses\/abc .*context=Connect docs preview .*target_url=https:\/\/x\.netlify\.app\/connect\/home\//)
    expect(job.permissions.statuses).toBe('write')
  })
})
