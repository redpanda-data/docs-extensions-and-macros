/**
 * @jest-environment node
 *
 * review_generated_docs, doc_type rpcn_connectors. Connector descriptions come
 * from the connect and benthos specs, so having no overrides file is the normal
 * case: the review succeeds and points at the specs instead of erroring.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const { reviewGeneratedDocs, RPCN_SOURCE_GUIDANCE } = require('../../bin/mcp-tools/generated-docs-review')

describe('reviewGeneratedDocs rpcn_connectors', () => {
  let dir
  let cwd

  beforeEach(() => {
    cwd = process.cwd()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-review-'))
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    process.chdir(dir)
  })

  afterEach(() => {
    process.chdir(cwd)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('succeeds without an overrides file and points at the connect and benthos specs', () => {
    const result = reviewGeneratedDocs({ doc_type: 'rpcn_connectors' })

    expect(result.success).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.suggestions).toContain(RPCN_SOURCE_GUIDANCE)
    expect(RPCN_SOURCE_GUIDANCE).toMatch(/redpanda-data\/connect/)
    expect(RPCN_SOURCE_GUIDANCE).toMatch(/redpanda-data\/benthos/)
    expect(JSON.stringify(result)).not.toContain('docs-data/overrides.json')
  })

  it('ignores a leftover docs-data/overrides.json unless it is passed explicitly', () => {
    fs.mkdirSync(path.join(dir, 'docs-data'))
    fs.writeFileSync(path.join(dir, 'docs-data', 'overrides.json'),
      JSON.stringify({ inputs: [{ name: 'x', $ref: '#/definitions/missing' }] }))

    const result = reviewGeneratedDocs({ doc_type: 'rpcn_connectors' })

    expect(result.success).toBe(true)
    expect(result.files_analyzed).toBe(0)
    expect(result.issues).toEqual([])
  })

  it('still validates an overrides file that is passed explicitly (negative control)', () => {
    fs.writeFileSync(path.join(dir, 'custom.json'),
      JSON.stringify({ definitions: {}, inputs: [{ name: 'x', $ref: '#/definitions/missing' }] }))

    const result = reviewGeneratedDocs({ doc_type: 'rpcn_connectors', overrides_file: 'custom.json' })

    expect(result.success).toBe(true)
    expect(result.files_analyzed).toBe(1)
    expect(result.issues.some(i => i.issue === 'Invalid $ref: #/definitions/missing')).toBe(true)
  })

  it('errors when an explicitly passed overrides file is missing', () => {
    const result = reviewGeneratedDocs({ doc_type: 'rpcn_connectors', overrides_file: 'nope.json' })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Overrides file not found/)
    expect(result.suggestion).toContain(RPCN_SOURCE_GUIDANCE)
  })
})
