'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { previewString, publishRpkString } = require('../../../tools/preview-string')
const properties = require('../../../tools/lint-strings/surfaces/properties')

const FIXTURES = path.join(__dirname, '../../../tools/lint-strings/fixtures')

describe('publishRpkString mirrors the generate-rpk-docs pipeline', () => {
  const helpers = require('../../../tools/rpk-docs/generate-rpk-docs')

  test('Long: ALLCAPS lines become === section headings', () => {
    const out = publishRpkString('long', 'Query the cluster.\n\nEXAMPLES\n\nrpk foo bar', helpers)
    expect(out).toContain('=== Examples')
    expect(out).not.toContain('EXAMPLES')
  })

  test('Short: capped to two sentences with a terminal period', () => {
    const out = publishRpkString('short', 'Queries cluster for health overview', helpers)
    expect(out).toBe('Queries cluster for health overview.')
  })

  test('flag usage: e.g. rewritten, period ensured', () => {
    const out = publishRpkString('flag', 'Duration of tests, e.g. 300ms', helpers)
    expect(out).toContain('for example,')
    expect(out.endsWith('.')).toBe(true)
  })
})

describe('preview-string rpk (fixture repo)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-string-rpk-'))

  beforeAll(() => {
    const cliDir = path.join(repo, 'src', 'go', 'rpk', 'pkg', 'cli')
    fs.mkdirSync(cliDir, { recursive: true })
    fs.copyFileSync(path.join(FIXTURES, 'rpk', 'lint_cmd.go'), path.join(cliDir, 'lint_cmd.go'))
  })

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('command preview shows the source pane and the transformed pane', () => {
    const out = previewString({ repo, surface: 'rpk', name: 'badshort', log: () => {} })
    expect(out).toContain('AS SOURCE')
    expect(out).toContain('AS PUBLISHED (after formatDescription)')
    // The killer demo: the intended ALLCAPS line ships as a === heading
    expect(out).toContain('=== Usage details')
  })

  test('flag preview is addressed with a -- prefix', () => {
    const out = previewString({ repo, surface: 'rpk', name: '--watch', log: () => {} })
    expect(out).toContain('--watch (flag usage)')
    expect(out).toContain('Blocks and writes out all changes')
  })

  test('unknown names fail with a clear error', () => {
    expect(() => previewString({ repo, surface: 'rpk', name: 'no-such-cmd', log: () => {} }))
      .toThrow(/No rpk command named "no-such-cmd"/)
  })
})

describe('preview-string helm/crd/connect output shapes (fixture repos)', () => {
  test('helm preview renders the key heading and @default annotation', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-string-helm-'))
    try {
      const chartDir = path.join(repo, 'charts', 'fixture', 'chart')
      fs.mkdirSync(chartDir, { recursive: true })
      fs.copyFileSync(path.join(FIXTURES, 'helm', 'lint_values.yaml'), path.join(chartDir, 'values.yaml'))
      const out = previewString({ repo, surface: 'helm', name: 'external.domain', log: () => {} })
      expect(out).toContain('=== external.domain')
      expect(out).toContain('Optional domain advertised to external clients.')
      expect(out).toContain('*Default:* `nil`')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  test('crd preview renders the table-cell shape and accepts Struct.field addressing', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-string-crd-'))
    try {
      const apiDir = path.join(repo, 'operator', 'api', 'redpanda', 'v1alpha2')
      fs.mkdirSync(apiDir, { recursive: true })
      fs.copyFileSync(path.join(FIXTURES, 'crd', 'lint_types.go'), path.join(apiDir, 'lint_types.go'))
      fs.copyFileSync(path.join(FIXTURES, 'crd', 'crd-ref-docs-config.yaml'), path.join(repo, 'operator', 'crd-ref-docs-config.yaml'))
      const out = previewString({ repo, surface: 'crd', name: 'WidgetSpec.cluster', log: () => {} })
      expect(out).toContain('*`cluster`*')
      expect(out).toContain('kubectl explain')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  test('connect preview ships the description as the page body', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-string-connect-'))
    try {
      const implDir = path.join(repo, 'internal', 'impl', 'fixture')
      fs.mkdirSync(implDir, { recursive: true })
      fs.copyFileSync(path.join(FIXTURES, 'connect', 'lint_connect.go'), path.join(implDir, 'lint_connect.go'))
      const out = previewString({ repo, surface: 'connect', name: 'seed_brokers', log: () => {} })
      expect(out).toContain('A list of broker addresses')
      // No description in source ships blank, stated plainly
      const naked = previewString({ repo, surface: 'connect', name: 'naked_field', log: () => {} })
      expect(naked).toContain('this ships blank')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})

// Properties preview runs the REAL Python extractor and the real Handlebars
// template. Requires the property-extractor venv and tree-sitter grammar
// (built by the Makefile / doc-tools property-docs, or by a previous
// lint-strings run). Skipped when they are absent so unit runs stay hermetic.
const canRunExtractor = fs.existsSync(properties.VENV_PYTHON) &&
  fs.existsSync(path.join(properties.TREESITTER_DIR, 'src', 'parser.c'))

const describeIntegration = canRunExtractor ? describe : describe.skip

describeIntegration('preview-string properties (real extractor over fixtures)', () => {
  jest.setTimeout(240000)

  let repo

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-string-props-'))
    fs.mkdirSync(path.join(repo, 'src', 'v', 'config'), { recursive: true })
    fs.copyFileSync(path.join(FIXTURES, 'properties', 'lint_fixture.h'), path.join(repo, 'src', 'v', 'config', 'configuration.h'))
    fs.copyFileSync(path.join(FIXTURES, 'properties', 'lint_fixture.cc'), path.join(repo, 'src', 'v', 'config', 'configuration.cc'))
  })

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('renders the property through the real Handlebars template', () => {
    const out = previewString({ repo, surface: 'properties', name: 'cluster_id', log: () => {} })
    expect(out).toContain('AS SOURCE (rendered from your checkout)')
    expect(out).toContain('=== cluster_id')
    expect(out).toContain('| Property | Value')
    expect(out).not.toContain('MASKED-BY-OVERRIDE')
  })

  test('with --overrides, a differing override renders a second pane and the masking notice', () => {
    const overridesPath = path.join(repo, 'overrides.json')
    fs.writeFileSync(overridesPath, JSON.stringify({
      properties: { cluster_id: { description: 'Overridden description from the docs repo.' } }
    }))
    const out = previewString({ repo, surface: 'properties', name: 'cluster_id', overrides: overridesPath, log: () => {} })
    expect(out).toContain('AS SHIPPED (override applied)')
    expect(out).toContain('Overridden description from the docs repo.')
    expect(out).toContain('MASKED-BY-OVERRIDE')
    expect(out).toContain('"description"')
  })

  test('an override file without an entry states the source ships as-is', () => {
    const overridesPath = path.join(repo, 'no-entry.json')
    fs.writeFileSync(overridesPath, JSON.stringify({ properties: {} }))
    const out = previewString({ repo, surface: 'properties', name: 'cluster_id', overrides: overridesPath, log: () => {} })
    expect(out).toContain('the source string ships as-is')
  })
})
