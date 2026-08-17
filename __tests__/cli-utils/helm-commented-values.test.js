'use strict'

const {
  extractCommentedValueDocs,
  injectIntoAsciiDoc,
} = require('../../cli-utils/helm-commented-values')

describe('extractCommentedValueDocs', () => {
  test('documents a commented-out key with a helm-docs marker, deriving the path by indentation', () => {
    const yaml = [
      'external:',
      '  enabled: true',
      '  # -- Optional domain advertised to external clients',
      '  # If specified, then it will be appended to the `external.addresses` values as each broker\'s advertised address',
      '  # domain: local',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('external.domain')
    expect(entries[0].description).toContain('Optional domain advertised')
    expect(entries[0].description).toContain('advertised address')
    expect(entries[0].default).toBe('`nil`')
  })

  test('does not document real keys, which helm-docs already renders', () => {
    const yaml = [
      'external:',
      '  # -- Enable external access.',
      '  enabled: true',
    ].join('\n')

    expect(extractCommentedValueDocs(yaml)).toHaveLength(0)
  })

  test('plain comments without a marker do not document commented-out keys', () => {
    const yaml = [
      'external:',
      '  # Optional list of addresses that the Redpanda brokers advertise.',
      '  # addresses:',
      '  # - redpanda-0',
    ].join('\n')

    expect(extractCommentedValueDocs(yaml)).toHaveLength(0)
  })

  test('supports the explicit @doc syntax with continuation lines and @default', () => {
    const yaml = [
      'external:',
      '  enabled: true',
      '# @doc external.addresses -- Optional list of addresses that the brokers advertise.',
      '# Provide one entry for each broker.',
      '# @default -- `[]`',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('external.addresses')
    expect(entries[0].description).toContain('one entry for each broker')
    expect(entries[0].default).toBe('`[]`')
  })

  test('@doc entries terminate at a commented-out key instead of swallowing it', () => {
    const yaml = [
      'external:',
      '  enabled: true',
      '  # @doc external.addresses -- Optional list of advertised addresses.',
      '  # addresses:',
      '  # - redpanda-0',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('external.addresses')
    expect(entries[0].description).toBe('Optional list of advertised addresses.')
  })

  test('honors @default in helm-docs style blocks', () => {
    const yaml = [
      'external:',
      '  # -- Optional prefix template.',
      '  # @default -- `""`',
      '  # prefixTemplate: ""',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('external.prefixTemplate')
    expect(entries[0].default).toBe('`""`')
  })

  test('nesting pops correctly when indentation decreases', () => {
    const yaml = [
      'storage:',
      '  tiered:',
      '    enabled: true',
      'external:',
      '  # -- A domain.',
      '  # domain: local',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries[0].path).toBe('external.domain')
  })

  test('ignores URLs in comments and prose with trailing text', () => {
    const yaml = [
      'resources:',
      '  cpu:',
      '    # -- CPU settings. For details see',
      '    # https://github.com/redpanda-data/redpanda/issues/1234',
      '    # Note: this is prose with trailing text',
      '    # cores: 1',
      '',
      '    # -- Warning: If you use LoadBalancers, expect higher latency.',
      '    # Warning: standalone prose line',
      '    cores2: 1',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('resources.cpu.cores')
  })

  test('suppresses nested commented example structures under an emitted key', () => {
    const yaml = [
      '# -- Redpanda Service settings.',
      '# service:',
      '#   -- set service.name to override the default service name',
      '#   name: redpanda',
      '#   internal:',
      '#     annotations: {}',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('service')
  })

  test('suppresses a nested subtree indented before the comment marker', () => {
    // The same nesting as the test above, written with the indentation before
    // the '#' instead of after it. Counting only the spaces after the marker
    // let 'name' escape the subtree and emit as a bogus top-level path.
    const yaml = [
      '# -- Redpanda Service settings.',
      '# service:',
      '  # -- set service.name to override the default service name',
      '  # name: redpanda',
      '  # internal:',
      '    # annotations: {}',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries.map((e) => e.path)).toEqual(['service'])
  })

  test('treats indentation before and after the comment marker as equivalent', () => {
    const before = ['parent:', '  # -- A documented child.', '  # child: value'].join('\n')
    const after = ['parent:', '  # -- A documented child.', '  #   child: value'].join('\n')

    expect(extractCommentedValueDocs(before)).toEqual(extractCommentedValueDocs(after))
    expect(extractCommentedValueDocs(before)[0].path).toBe('parent.child')
  })

  test('ignores block scalar bodies', () => {
    const yaml = [
      'statefulset:',
      '  extraVolumes: |-',
      '    - name: fake',
      '      configMap:',
      '        name: fake',
      '  # -- A documented commented key.',
      '  # budget: {}',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('statefulset.budget')
  })
})

describe('injectIntoAsciiDoc', () => {
  const base = 'https://artifacthub.io/packages/helm/redpanda-data/redpanda?modal=values&path='
  const adoc = [
    '= Redpanda Helm Chart Specification',
    '',
    `=== link:++${base}external++[external]`,
    '',
    'External access settings.',
    '',
    '*Default:* `{}`',
    '',
    `=== link:++${base}external.enabled++[external.enabled]`,
    '',
    'Enable external access.',
    '',
    '*Default:* `true`',
    '',
    `=== link:++${base}external.type++[external.type]`,
    '',
    'External access type.',
    '',
    '*Default:* `"NodePort"`',
    '',
  ].join('\n')

  test('inserts new sections in alphabetical key order with the discovered URL prefix', () => {
    const { doc, injected } = injectIntoAsciiDoc(adoc, [
      { path: 'external.domain', description: 'Optional domain.', default: '`nil`' },
    ])

    expect(injected).toEqual(['external.domain'])
    const domainIdx = doc.indexOf('path=external.domain')
    const enabledIdx = doc.indexOf('path=external.enabled')
    const typeIdx = doc.indexOf('path=external.type')
    expect(domainIdx).toBeGreaterThan(-1)
    expect(domainIdx).toBeLessThan(enabledIdx)
    expect(enabledIdx).toBeLessThan(typeIdx)
    expect(doc).toContain(`=== link:++${base}external.domain++[external.domain]`)
    expect(doc).toContain('*Default:* `nil`')
    // AsciiDoc requires a blank line before the next section heading.
    expect(doc).toMatch(/\*Default:\* `nil`\n\n=== link/)
  })

  test('skips keys that are already documented', () => {
    const { doc, injected } = injectIntoAsciiDoc(adoc, [
      { path: 'external.enabled', description: 'Duplicate.', default: '`nil`' },
    ])

    expect(injected).toEqual([])
    expect(doc).toBe(adoc)
  })

  test('injects a path extracted twice only once, keeping the first entry', () => {
    const { doc, injected } = injectIntoAsciiDoc(adoc, [
      { path: 'external.domain', description: 'From @doc comment.', default: '`nil`' },
      { path: 'external.domain', description: 'From helm-docs comment.', default: '`""`' },
    ])

    expect(injected).toEqual(['external.domain'])
    expect(doc.match(/path=external\.domain/g)).toHaveLength(1)
    expect(doc).toContain('From @doc comment.')
    expect(doc).not.toContain('From helm-docs comment.')
  })

  test('appends keys that sort after every existing section', () => {
    const { doc, injected } = injectIntoAsciiDoc(adoc, [
      { path: 'external.zzz', description: 'Last key.', default: '`nil`' },
    ])

    expect(injected).toEqual(['external.zzz'])
    expect(doc.indexOf('path=external.zzz')).toBeGreaterThan(doc.indexOf('path=external.type'))
  })

  test('returns the document unchanged when it has no sections to anchor on', () => {
    const { doc, injected } = injectIntoAsciiDoc('= Empty\n', [
      { path: 'a.b', description: 'x', default: '`nil`' },
    ])

    expect(injected).toEqual([])
    expect(doc).toBe('= Empty\n')
  })
})
