'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const CLI = path.resolve(__dirname, '../../../bin/doc-tools.js')

/**
 * Run `doc-tools overrides triage-parse` with the given file paths.
 *
 * @param {string} candidatePath - Path passed to --candidate.
 * @param {string} responsePath - Path passed to --response.
 * @returns {import('child_process').SpawnSyncReturns<string>} Process result.
 */
function triageParse (candidatePath, responsePath) {
  return spawnSync(process.execPath, [CLI, 'overrides', 'triage-parse', '--candidate', candidatePath, '--response', responsePath], { encoding: 'utf8' })
}

describe('overrides triage-parse', () => {
  let dir
  let candidatePath

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-parse-'))
    candidatePath = path.join(dir, 'candidate.json')
    fs.writeFileSync(candidatePath, JSON.stringify({
      name: 'test_property',
      upstream_candidate_text: 'Override text.',
      source_text: 'Source text.'
    }))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a missing response file degrades to the AMBIGUOUS fallback', () => {
    const result = triageParse(candidatePath, path.join(dir, 'missing.txt'))
    expect(result.status).toBe(0)
    const row = JSON.parse(result.stdout)
    expect(row.agent_verdict).toBe('AMBIGUOUS')
    expect(row.triage_failed).toBe(true)
    expect(row.name).toBe('test_property')
  })

  test('a missing candidate file still fails the command', () => {
    const responsePath = path.join(dir, 'response.txt')
    fs.writeFileSync(responsePath, JSON.stringify({ verdict: 'AMBIGUOUS', reason: 'Unsure.' }))
    const result = triageParse(path.join(dir, 'missing.json'), responsePath)
    expect(result.status).not.toBe(0)
  })
})
