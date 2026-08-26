/**
 * The audit_overrides MCP tool must be able to reach the CLI's --repo
 * option, the way the CLI itself supports auditing straight from a local
 * checkout as an alternative to a pre-extracted JSON file.
 */

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process')
  return { ...actual, spawnSync: jest.fn() }
})

const { spawnSync } = require('child_process')
const { auditOverrides } = require('../../bin/mcp-tools/overrides-audit')

function mockSuccess (audit) {
  spawnSync.mockReturnValue({
    status: 0,
    stdout: JSON.stringify(audit),
    stderr: '',
    error: null
  })
}

describe('auditOverrides --repo forwarding', () => {
  beforeEach(() => {
    spawnSync.mockReset()
  })

  test('forwards args.repo as --repo on the spawned CLI command', () => {
    mockSuccess({ surface: 'properties', summary: { total: 0 } })

    const result = auditOverrides({
      overrides: 'docs-data/property-overrides.json',
      repo: '/checkout/redpanda'
    })

    expect(result.success).toBe(true)
    const cliArgs = spawnSync.mock.calls[0][1]
    const repoIndex = cliArgs.indexOf('--repo')
    expect(repoIndex).toBeGreaterThan(-1)
    expect(cliArgs[repoIndex + 1]).toBe('/checkout/redpanda')
    // repo is an alternative to extracted, not an addition to it
    expect(cliArgs).not.toContain('--extracted')
  })

  test('still forwards args.extracted as before when repo is not given', () => {
    mockSuccess({ surface: 'properties', summary: { total: 0 } })

    auditOverrides({
      overrides: 'docs-data/property-overrides.json',
      extracted: 'extracted.json'
    })

    const cliArgs = spawnSync.mock.calls[0][1]
    expect(cliArgs).toContain('--extracted')
    expect(cliArgs).not.toContain('--repo')
  })

  test('can pass both extracted and repo through untouched (CLI decides precedence)', () => {
    mockSuccess({ surface: 'properties', summary: { total: 0 } })

    auditOverrides({
      overrides: 'docs-data/property-overrides.json',
      extracted: 'extracted.json',
      repo: '/checkout/redpanda'
    })

    const cliArgs = spawnSync.mock.calls[0][1]
    expect(cliArgs).toContain('--extracted')
    expect(cliArgs).toContain('--repo')
  })
})
