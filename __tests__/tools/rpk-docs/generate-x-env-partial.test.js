'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  xOptionsFromTree,
  parseXList,
  keyToEnvVar,
  keyToAnchor,
  groupOptions,
  renderPartial,
  handleXEnvPartialGeneration
} = require('../../../tools/rpk-docs/generate-x-env-partial.js')

// A tree shaped like the one rpk prints, trimmed to two groups.
const grouped = {
  x_options: [
    { name: 'brokers', env: 'RPK_BROKERS', group: 'kafka', group_title: 'Kafka API', format: 'comma,delimited,host:ports', example: '127.0.0.1:9092', description: 'Kafka API brokers.' },
    { name: 'tls.enabled', env: 'RPK_TLS_ENABLED', group: 'kafka', group_title: 'Kafka API', format: 'boolean', example: 'true', description: 'Enable TLS.' },
    { name: 'admin.hosts', env: 'RPK_ADMIN_HOSTS', group: 'admin', group_title: 'Admin API', format: 'comma,delimited,host:ports', example: '127.0.0.1:9644', description: 'Admin API hosts.' }
  ]
}

// The same options as rpk printed them before it reported groups.
const ungrouped = {
  x_options: [
    { name: 'brokers', env: 'RPK_BROKERS', format: 'comma,delimited,host:ports', example: '127.0.0.1:9092', description: 'Kafka API brokers.' },
    { name: 'tls.enabled', env: 'RPK_TLS_ENABLED', format: 'boolean', example: 'true', description: 'Enable TLS.' },
    { name: 'admin.hosts', env: 'RPK_ADMIN_HOSTS', format: 'comma,delimited,host:ports', example: '127.0.0.1:9644', description: 'Admin API hosts.' }
  ]
}

describe('xOptionsFromTree', () => {
  test('carries the group rpk reports', () => {
    expect(xOptionsFromTree(JSON.stringify(grouped))).toEqual([
      { name: 'brokers', env: 'RPK_BROKERS', group: 'kafka', groupTitle: 'Kafka API' },
      { name: 'tls.enabled', env: 'RPK_TLS_ENABLED', group: 'kafka', groupTitle: 'Kafka API' },
      { name: 'admin.hosts', env: 'RPK_ADMIN_HOSTS', group: 'admin', groupTitle: 'Admin API' }
    ])
  })

  test('nulls the group for rpk versions that do not report one', () => {
    const opts = xOptionsFromTree(JSON.stringify(ungrouped))
    expect(opts.map(o => o.name)).toEqual(['brokers', 'tls.enabled', 'admin.hosts'])
    expect(opts.every(o => o.group === null && o.groupTitle === null)).toBe(true)
  })

  test('preserves rpk order rather than sorting', () => {
    const reversed = { x_options: [...grouped.x_options].reverse() }
    expect(xOptionsFromTree(JSON.stringify(reversed)).map(o => o.name))
      .toEqual(['admin.hosts', 'tls.enabled', 'brokers'])
  })

  test('derives env when the tree omits it', () => {
    const noEnv = { x_options: [{ name: 'tls.ca', group: 'kafka', group_title: 'Kafka API' }] }
    expect(xOptionsFromTree(JSON.stringify(noEnv))[0].env).toBe('RPK_TLS_CA')
  })

  test('returns null for a tree with no x_options, and for non-JSON', () => {
    expect(xOptionsFromTree(JSON.stringify({ name: 'rpk', commands: [] }))).toBeNull()
    expect(xOptionsFromTree(JSON.stringify({ x_options: [] }))).toBeNull()
    expect(xOptionsFromTree('not json')).toBeNull()
  })
})

describe('groupOptions', () => {
  test('groups in first-seen order', () => {
    const groups = groupOptions(xOptionsFromTree(JSON.stringify(grouped)))
    expect(groups.map(g => g.title)).toEqual(['Kafka API', 'Admin API'])
    expect(groups[0].options.map(o => o.name)).toEqual(['brokers', 'tls.enabled'])
  })

  test('gives a non-contiguous group one heading, not two', () => {
    const split = [
      { name: 'brokers', env: 'RPK_BROKERS', groupTitle: 'Kafka API' },
      { name: 'admin.hosts', env: 'RPK_ADMIN_HOSTS', groupTitle: 'Admin API' },
      { name: 'tls.enabled', env: 'RPK_TLS_ENABLED', groupTitle: 'Kafka API' }
    ]
    const groups = groupOptions(split)
    expect(groups.map(g => g.title)).toEqual(['Kafka API', 'Admin API'])
    expect(groups[0].options.map(o => o.name)).toEqual(['brokers', 'tls.enabled'])
  })

  test('refuses to group when any option has no group', () => {
    expect(groupOptions(xOptionsFromTree(JSON.stringify(ungrouped)))).toBeNull()
    expect(groupOptions([
      { name: 'brokers', env: 'RPK_BROKERS', groupTitle: 'Kafka API' },
      { name: 'tls.enabled', env: 'RPK_TLS_ENABLED', groupTitle: null }
    ])).toBeNull()
  })
})

describe('renderPartial', () => {
  test('sections the table by group, keeping every option', () => {
    const out = renderPartial(xOptionsFromTree(JSON.stringify(grouped)))
    expect(out).toContain('2+s|Kafka API')
    expect(out).toContain('2+s|Admin API')
    expect(out).toContain('|xref:reference:rpk/rpk-x-options.adoc#tls-enabled[tls.enabled] |RPK_TLS_ENABLED')
    // Headings must precede their own options, not trail them.
    expect(out.indexOf('2+s|Kafka API')).toBeLessThan(out.indexOf('[brokers]'))
    expect(out.indexOf('2+s|Admin API')).toBeLessThan(out.indexOf('[admin.hosts]'))
    expect(out.indexOf('[tls.enabled]')).toBeLessThan(out.indexOf('2+s|Admin API'))
    expect(out.match(/^\|xref:/gm)).toHaveLength(3)
  })

  test('renders one flat table when rpk reports no groups', () => {
    const out = renderPartial(xOptionsFromTree(JSON.stringify(ungrouped)))
    expect(out).not.toContain('2+s|')
    expect(out.match(/^\|xref:/gm)).toHaveLength(3)
  })

  test('keeps the generated banner and the tagged region in both shapes', () => {
    for (const tree of [grouped, ungrouped]) {
      const out = renderPartial(xOptionsFromTree(JSON.stringify(tree)))
      expect(out).toContain('// tag::generated[]')
      expect(out).toContain('// end::generated[]')
      expect(out).toContain('Do not edit manually')
      expect(out.trimEnd().endsWith('// end::generated[]')).toBe(true)
    }
  })
})

describe('keyToEnvVar and keyToAnchor', () => {
  test('env var prefixes, uppercases and replaces dots', () => {
    expect(keyToEnvVar('tls.insecure_skip_verify')).toBe('RPK_TLS_INSECURE_SKIP_VERIFY')
    expect(keyToEnvVar('brokers')).toBe('RPK_BROKERS')
  })

  test('anchors replace dots but keep underscores', () => {
    expect(keyToAnchor('tls.insecure_skip_verify')).toBe('tls-insecure_skip_verify')
    expect(keyToAnchor('globals.no_default_cluster')).toBe('globals-no_default_cluster')
  })
})

describe('parseXList', () => {
  test('reads keys from -X list text and skips noise', () => {
    const out = [
      'brokers=comma,delimited,host:ports',
      'tls.enabled=boolean',
      '',
      'not a flag line',
      'globals.no_default_cluster=boolean'
    ].join('\n')
    expect(parseXList(out)).toEqual(['brokers', 'tls.enabled', 'globals.no_default_cluster'])
  })
})

describe('handleXEnvPartialGeneration', () => {
  let dir
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-env-test-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  function writeSnapshot (tree, count) {
    // Pad to clear MIN_OPTIONS so the guard is not what fails these tests.
    const pad = Array.from({ length: count }, (_, i) => ({
      name: `globals.pad_${i}`,
      env: `RPK_GLOBALS_PAD_${i}`,
      group: tree.x_options[0].group ? 'globals' : undefined,
      group_title: tree.x_options[0].group_title ? 'rpk globals' : undefined
    }))
    const file = path.join(dir, 'tree.json')
    fs.writeFileSync(file, JSON.stringify({ raw_tree: { x_options: [...tree.x_options, ...pad] } }))
    return file
  }

  test('writes a sectioned partial from a snapshot that carries groups', () => {
    const output = path.join(dir, 'partial.adoc')
    const result = handleXEnvPartialGeneration({ fromJson: writeSnapshot(grouped, 20), output })
    expect(result.keyCount).toBe(23)
    expect(result.source).toMatch(/^snapshot /)
    const written = fs.readFileSync(output, 'utf8')
    expect(written).toContain('2+s|Kafka API')
    expect(written).toContain('2+s|rpk globals')
  })

  test('writes a flat partial from a snapshot with no groups', () => {
    const output = path.join(dir, 'partial.adoc')
    handleXEnvPartialGeneration({ fromJson: writeSnapshot(ungrouped, 20), output })
    expect(fs.readFileSync(output, 'utf8')).not.toContain('2+s|')
  })

  test('refuses a suspiciously small table rather than overwriting the partial', () => {
    const output = path.join(dir, 'partial.adoc')
    expect(() => handleXEnvPartialGeneration({ fromJson: writeSnapshot(grouped, 0), output }))
      .toThrow(/Parsed only 3 -X options/)
    expect(fs.existsSync(output)).toBe(false)
  })

  test('rejects a snapshot that predates x_options', () => {
    const file = path.join(dir, 'old.json')
    fs.writeFileSync(file, JSON.stringify({ raw_tree: { name: 'rpk', commands: [] } }))
    expect(() => handleXEnvPartialGeneration({ fromJson: file, output: path.join(dir, 'p.adoc') }))
      .toThrow(/has no x_options/)
  })

  test('requires an output path', () => {
    expect(() => handleXEnvPartialGeneration({ fromJson: 'ignored.json' }))
      .toThrow(/Missing required --output path/)
  })
})
