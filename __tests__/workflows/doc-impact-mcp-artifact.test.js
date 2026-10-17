'use strict'

const fs = require('fs')
const path = require('path')
const YAML = require('yaml')
const { execRun } = require('./helpers/exec-run')

/**
 * The doc-strings review saves the docs MCP calls it made as a workflow
 * artifact, so the doc-impact eval can replay what the docs said at review
 * time. These steps must never fail the review, must upload only when the
 * review ran and made docs calls, and must hold only the recording.
 */

const ROOT = path.join(__dirname, '..', '..')
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'doc-strings-review.yml')
const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'))
const job = workflow.jobs['doc-strings-review']
const FIXTURE = path.join(ROOT, '__tests__', 'tools', 'fixtures', 'doc-impact-recording', 'execution-file.json')
const CLI = path.join(ROOT, 'bin', 'doc-tools.js')

const EXTRACT = 'Extract the docs MCP calls for the doc-impact eval'
const UPLOAD = 'Upload the docs MCP recording'
const stepNamed = (name) => {
  const step = job.steps.find((s) => s.name === name)
  if (!step) throw new Error(`no step named ${name}`)
  return step
}
const indexOf = (name) => job.steps.findIndex((s) => s.name === name)

// An npx that runs this checkout's doc-tools, the way the resolved package
// would once it carries the command.
const NPX_REAL = `#!/bin/bash
printf '%s\\n' "$@" > "$HOME/npx-argv"
while [ $# -gt 0 ] && [ "$1" != doc-tools ]; do shift; done
shift
exec "${process.execPath}" "${CLI}" "$@"
`
// An npx whose doc-tools predates the command: commander's real failure.
const NPX_OLD = `#!/bin/bash
echo "error: unknown command 'doc-impact-recording'" >&2
exit 1
`

function runExtract ({ npx = NPX_REAL, executionFile = FIXTURE } = {}) {
  const step = stepNamed(EXTRACT)
  const res = execRun({ run: step.run }, {
    stubs: { npx },
    env: {
      PKG: '@redpanda-data/docs-extensions-and-macros@9.9.9',
      EXECUTION_FILE: executionFile,
      REPO: 'redpanda-data/redpanda-operator',
      PR: '1615',
      DOCS_MCP_URL: step.env.DOCS_MCP_URL,
      OUT_DIR: 'out'
    }
  })
  return res
}

describe('doc-impact MCP artifact: wiring', () => {
  test('runs after the review and before the dispatch, never failing the job', () => {
    const review = indexOf('Claude review with suggestions')
    expect(indexOf(EXTRACT)).toBeGreaterThan(review)
    expect(indexOf(UPLOAD)).toBe(indexOf(EXTRACT) + 1)
    for (const name of [EXTRACT, UPLOAD]) {
      expect(stepNamed(name)['continue-on-error']).toBe(true)
      expect(stepNamed(name).if).toMatch(/^always\(\) && /)
    }
  })

  test('extracts only when the review step actually ran', () => {
    // claude-code-action leaves no execution file when it skips itself.
    expect(stepNamed(EXTRACT).if).toContain("steps.review.outputs.execution_file != ''")
    expect(stepNamed(EXTRACT).env.EXECUTION_FILE).toBe('${{ steps.review.outputs.execution_file }}')
  })

  test('uploads only a saved recording, per PR and attempt, for about 90 days', () => {
    const up = stepNamed(UPLOAD)
    expect(up.if).toContain("steps.mcp_recording.outputs.saved == 'true'")
    expect(up.uses).toMatch(/^actions\/upload-artifact@/)
    expect(up.with.name).toBe('doc-impact-mcp-${{ github.event.pull_request.number }}-${{ github.run_attempt }}')
    expect(up.with.path).toBe('${{ runner.temp }}/doc-impact-mcp/recording.json')
    expect(up.with['retention-days']).toBe(90)
  })

  test('records the same docs server the review is configured with', () => {
    const args = stepNamed('Claude review with suggestions').with.claude_args
    const config = JSON.parse(args.match(/--mcp-config '([^']+)'/)[1])
    expect(stepNamed(EXTRACT).env.DOCS_MCP_URL).toBe(config.mcpServers['redpanda-docs'].url)
  })

  test('uses the resolved doc-tools package, like the lint step', () => {
    expect(stepNamed(EXTRACT).env.PKG).toBe('${{ steps.pkg.outputs.pkg }}')
  })
})

describe('doc-impact MCP artifact: extract step (executed)', () => {
  test('writes the recording under the item id and marks it saved', () => {
    const r = runExtract()
    expect(r.status).toBe(0)
    expect(r.outputs.saved).toBe('true')
    const rec = JSON.parse(r.read('out/recording.json'))
    expect(rec).toMatchObject({ item: 'redpanda-operator-1615', server_url: 'https://docs.redpanda.com/mcp', source: 'production' })
    expect(rec.calls.map((c) => c.tool)).toEqual(['ask_redpanda_question', 'get_api_reference_content'])
    expect(r.read('npx-argv')).toContain('--package=@redpanda-data/docs-extensions-and-macros@9.9.9')
  })

  test('no docs calls: a notice, nothing saved, step succeeds', () => {
    const r = runExtract({ executionFile: path.join(ROOT, 'package.json') })
    expect(r.status).toBe(0)
    expect(r.outputs.saved).toBeUndefined()
    expect(r.exists('out/recording.json')).toBe(false)
    expect(r.all).toMatch(/::notice::The review made no docs MCP calls/)
  })

  test('a doc-tools release without the command: a notice, nothing saved, step succeeds', () => {
    const r = runExtract({ npx: NPX_OLD })
    expect(r.status).toBe(0)
    expect(r.outputs.saved).toBeUndefined()
    expect(r.all).toMatch(/::notice::Could not extract the docs MCP calls/)
  })
})
