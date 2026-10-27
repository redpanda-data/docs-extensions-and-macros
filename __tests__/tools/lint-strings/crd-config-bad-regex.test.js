'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const crd = require('../../../tools/lint-strings/surfaces/crd')

/**
 * crd-ref-docs-config.yaml is a config file for a Go tool, so it may
 * legally contain Go/RE2-only regex syntax (inline flags, named groups)
 * that JS's RegExp constructor rejects. One bad pattern must not crash the
 * whole lint run - it should be skipped, with a warning, while every valid
 * pattern in the same config still loads.
 */
function stageConfig (yamlBody) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-crd-badregex-'))
  fs.mkdirSync(path.join(repo, 'operator'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'operator', 'crd-ref-docs-config.yaml'), yamlBody)
  return repo
}

describe('crd loadConfig with an invalid (Go-only) regex pattern', () => {
  let warnSpy

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  test('does not throw, skips the bad pattern, and keeps the valid ones', () => {
    const repo = stageConfig(`
processor:
  ignoreTypes:
  - '(?i)Secret'
  - 'List$'
  ignoreFields:
  - '(?P<name>migration)$'
`)

    let config
    expect(() => { config = crd.loadConfig(repo) }).not.toThrow()

    expect(config.ignoreTypes).toHaveLength(1)
    expect(config.ignoreTypes[0].test('List')).toBe(true)

    expect(config.ignoreFields).toHaveLength(0)

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('(?i)Secret'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('(?P<name>migration)$'))

    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('extract() over a repo with a bad pattern completes instead of crashing', () => {
    const repo = stageConfig(`
processor:
  ignoreTypes:
  - '(?i)Secret'
`)
    const apiDir = path.join(repo, 'operator', 'api', 'redpanda', 'v1alpha2')
    fs.mkdirSync(apiDir, { recursive: true })
    fs.writeFileSync(
      path.join(apiDir, 'types.go'),
      'package v1alpha2\n\ntype Cluster struct {\n\t// Name is the cluster name.\n\tName string `json:"name"`\n}\n'
    )

    let declarations
    expect(() => { declarations = crd.extract({ repo }) }).not.toThrow()
    expect(Array.isArray(declarations)).toBe(true)
    expect(warnSpy).toHaveBeenCalled()

    fs.rmSync(repo, { recursive: true, force: true })
  })
})
