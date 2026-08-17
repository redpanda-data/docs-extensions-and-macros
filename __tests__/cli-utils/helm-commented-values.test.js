'use strict'

const {
  extractCommentedValueDocs,
  injectIntoAsciiDoc,
  filterEntriesBySchema,
  isPathAllowedBySchema,
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

// Each test in the regression suites below reproduces a defect found in
// review; keep them green on any change to this tooling.

describe('extractCommentedValueDocs regressions', () => {
  test('a prose line shaped like a key does not steal the block from the documented key', () => {
    const yaml = [
      'external:',
      '  # -- The domain.',
      '  # example:',
      '  #   domain: foo.com',
      '  # domain: ""',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries.map((e) => e.path)).toEqual(['external.domain'])
    expect(entries[0].description).toBe('The domain.')
  })

  test('a "# default: value" prose line does not steal the block from the documented key', () => {
    const yaml = [
      'gateway:',
      '  # -- Request timeout.',
      '  # default: 30s',
      '  # timeout: null',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries.map((e) => e.path)).toEqual(['gateway.timeout'])
    expect(entries[0].description).toBe('Request timeout.')
  })

  test('a wrapped URL in a description is not treated as a key (operator chart shape)', () => {
    const yaml = [
      'connectController:',
      '  enabled: false',
      '  # -- Default Redpanda Connect image applied to every Pipeline CR that',
      '  # does not pin its own `.spec.image`; the operator falls back to the',
      '  # constant baked into the binary (currently',
      '  # docker.redpanda.com/redpandadata/connect:4.101.0).',
      '  # image:',
      '  #   repository: docker.redpanda.com/redpandadata/connect',
      '  #   tag: "4.101.0"',
      '  # -- Monitoring configuration for Connect pipeline pods.',
      '  monitoring:',
      '    enabled: false',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries.map((e) => e.path)).toEqual(['connectController.image'])
    expect(entries[0].description).toContain('Default Redpanda Connect image')
    expect(entries[0].description).toContain('docker.redpanda.com/redpandadata/connect:4.101.0')
  })

  test('a blank line inside a commented-out example subtree does not fabricate a path from a stale parent', () => {
    const yaml = [
      'image:',
      '  spec: onRootMismatch',
      '# -- Redpanda Service settings.',
      '# service:',
      '',
      '#   -- set service.name to override the default service name',
      '#   name: redpanda',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries.map((e) => e.path)).toEqual(['service'])
  })

  test('the last shallowest key line wins in a deprecation-notice block', () => {
    const yaml = [
      'storage:',
      '  tiered:',
      '    credentialsSecretRef:',
      '      accessKey:',
      '        configurationKey: cloud_storage_access_key',
      '      # -- DEPRECATED `configurationKey`, `name` and `key`. Please use `accessKey` and `secretKey`',
      '      # configurationKey: cloud_storage_secret_key',
      '      # name:',
      '      # key:',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('storage.tiered.credentialsSecretRef.key')
  })

  test('skips block scalar bodies that use an explicit indentation indicator', () => {
    for (const indicator of ['|2', '>2', '|-2', '|2-']) {
      const yaml = [
        `banner: ${indicator}`,
        '  # -- Fake doc from scalar content',
        '  # fake: value',
        'real: 1',
      ].join('\n')

      expect(extractCommentedValueDocs(yaml)).toEqual([])
    }
  })

  test('comment dividers made of dashes are not description markers', () => {
    const yaml = [
      'external:',
      '  # ----------------',
      '  # domain: local',
    ].join('\n')

    expect(extractCommentedValueDocs(yaml)).toEqual([])
  })

  test('honors @default written after the commented-out key', () => {
    const yaml = [
      'external:',
      '  # -- Optional domain.',
      '  # domain: local',
      '  # @default -- `"local"`',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries).toHaveLength(1)
    expect(entries[0].default).toBe('`"local"`')
  })

  test('handles CRLF line endings', () => {
    const yaml = [
      'external:',
      '  # -- Optional domain.',
      '  # domain: local',
    ].join('\r\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries.map((e) => e.path)).toEqual(['external.domain'])
  })
})

describe('filterEntriesBySchema', () => {
  const schema = {
    type: 'object',
    properties: {
      storage: {
        type: 'object',
        properties: {
          tiered: {
            type: 'object',
            properties: {
              credentialsSecretRef: {
                type: 'object',
                additionalProperties: false,
                properties: { accessKey: {}, secretKey: {} },
              },
            },
          },
        },
      },
      external: { type: 'object' },
      certs: {
        type: 'object',
        additionalProperties: false,
        patternProperties: { '^rp-': { type: 'object' } },
      },
      referenced: { $ref: '#/definitions/something' },
    },
  }

  test('rejects paths forbidden by additionalProperties: false', () => {
    expect(isPathAllowedBySchema(schema, 'storage.tiered.credentialsSecretRef.configurationKey')).toBe(false)
    expect(isPathAllowedBySchema(schema, 'storage.tiered.credentialsSecretRef.key')).toBe(false)
  })

  test('accepts declared properties, open objects, pattern matches, and unresolvable nodes', () => {
    expect(isPathAllowedBySchema(schema, 'storage.tiered.credentialsSecretRef.accessKey')).toBe(true)
    expect(isPathAllowedBySchema(schema, 'external.domain')).toBe(true)
    expect(isPathAllowedBySchema(schema, 'certs.rp-default')).toBe(true)
    expect(isPathAllowedBySchema(schema, 'certs.other')).toBe(false)
    expect(isPathAllowedBySchema(schema, 'referenced.anything')).toBe(true)
    expect(isPathAllowedBySchema(schema, 'undeclaredTopLevel')).toBe(true)
  })

  test('splits entries into accepted and rejected', () => {
    const entries = [
      { path: 'external.domain' },
      { path: 'storage.tiered.credentialsSecretRef.configurationKey' },
    ]
    const { accepted, rejected } = filterEntriesBySchema(entries, schema)
    expect(accepted.map((e) => e.path)).toEqual(['external.domain'])
    expect(rejected.map((e) => e.path)).toEqual(['storage.tiered.credentialsSecretRef.configurationKey'])
  })
})

describe('injectIntoAsciiDoc regressions', () => {
  const base = 'https://artifacthub.io/packages/helm/redpanda-data/redpanda?modal=values&path='

  test('neutralizes description lines that would parse as AsciiDoc structure', () => {
    const adoc = [
      `=== link:++${base}alpha++[alpha]`,
      '',
      'Alpha.',
      '',
      '*Default:* `nil`',
      '',
    ].join('\n')

    const { doc } = injectIntoAsciiDoc(adoc, [
      {
        path: 'beta',
        description: 'Optional domain.\n\n==== Advanced usage ====\nMore text.\n----',
        default: '`nil`',
      },
    ])

    expect(doc).toContain('{empty}==== Advanced usage ====')
    expect(doc).toContain('{empty}----')
    expect(doc).not.toMatch(/^==== Advanced usage ====$/m)
    expect(doc).not.toMatch(/^----$/m)
  })

  test('scans section headings whose key label contains brackets', () => {
    const adoc = [
      `=== link:++${base}storage.tiered++[storage.tiered]`,
      '',
      'Tiered.',
      '',
      `=== link:++${base}storage.volume%5B0%5D.name++[storage.volume[0].name]`,
      '',
      'Volume name.',
      '',
      `=== link:++${base}test.create++[test.create]`,
      '',
      'Test hook.',
      '',
    ].join('\n')

    const { doc, injected, sectionsFound } = injectIntoAsciiDoc(adoc, [
      { path: 'storage.uvw', description: 'New value.', default: '`nil`' },
    ])

    expect(sectionsFound).toBe(3)
    expect(injected).toEqual(['storage.uvw'])
    expect(doc.indexOf('path=storage.uvw')).toBeGreaterThan(doc.indexOf('path=storage.tiered'))
    expect(doc.indexOf('path=storage.uvw')).toBeLessThan(doc.indexOf('path=storage.volume%5B0%5D.name'))
  })

  test('reports zero sections when value headings are at an unexpected level', () => {
    const adoc = [
      `==== link:++${base}external++[external]`,
      '',
      'External.',
      '',
    ].join('\n')

    const { doc, injected, sectionsFound } = injectIntoAsciiDoc(adoc, [
      { path: 'external.domain', description: 'Domain.', default: '`nil`' },
    ])

    expect(sectionsFound).toBe(0)
    expect(injected).toEqual([])
    expect(doc).toBe(adoc)
  })

  test('appends a last-sorting key before a trailing level-3 heading', () => {
    const adoc = [
      `=== link:++${base}alpha++[alpha]`,
      '',
      'Alpha.',
      '',
      '*Default:* `nil`',
      '',
      '=== Chart Requirements',
      '',
      'Some requirements body.',
      '',
    ].join('\n')

    const { doc, injected } = injectIntoAsciiDoc(adoc, [
      { path: 'zeta', description: 'Last key.', default: '`nil`' },
    ])

    expect(injected).toEqual(['zeta'])
    expect(doc.indexOf('path=zeta')).toBeGreaterThan(doc.indexOf('path=alpha'))
    expect(doc.indexOf('path=zeta')).toBeLessThan(doc.indexOf('=== Chart Requirements'))
  })
})
