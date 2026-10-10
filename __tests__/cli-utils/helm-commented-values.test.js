'use strict'

const {
  parseValuesFile,
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
  test('the first key line after the description is the documented key, as helm-docs reads it', () => {
    // helm-docs attaches a `# --` block to the key directly below it. A
    // key-shaped line right after the description is therefore read as the
    // key, and a later sibling with no comment of its own is not documented.
    const yaml = [
      'external:',
      '  # -- The domain.',
      '  # example:',
      '  #   domain: foo.com',
      '  # domain: ""',
    ].join('\n')

    const entries = extractCommentedValueDocs(yaml)
    expect(entries.map((e) => e.path)).toEqual(['external.example'])
    expect(entries[0].description).toBe('The domain.')
  })

  test('a later sibling key does not take the description from the key above it', () => {
    const yaml = [
      'gateway:',
      '  # -- Request timeout.',
      '  # timeout: 30s',
      '  # retries: 3',
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

  test('a deprecation-notice block documents its first key only', () => {
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
    expect(entries[0].path).toBe('storage.tiered.credentialsSecretRef.configurationKey')
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

// A `# --` marker followed by a run of commented-out sibling keys, the shape
// of the redpanda chart's `external` block. The fixtures are the block
// verbatim from redpanda-operator charts/redpanda/chart/values.yaml.
describe('extractCommentedValueDocs commented-out sibling runs', () => {
  // Tag charts/redpanda/v26.2.4: one `# --` marker for `domain`, followed by
  // siblings that carry only plain comments.
  const v2624External = [
      'external:',
      '  # -- Service allows you to manage the creation of an external kubernetes service object',
      '  service:',
      '    # -- Enabled if set to false will not create the external service type',
      '    # You can still set your cluster with external access but not create the supporting service (NodePort/LoadBalander).',
      '    # Set this to false if you rather manage your own service.',
      '    enabled: true',
      '  # -- Enable external access for each Service.',
      '  # You can toggle external access for each listener in',
      '  # `listeners.<service name>.external.<listener-name>.enabled`.',
      '  enabled: true',
      '  # -- External access type. Only `NodePort` and `LoadBalancer` are supported.',
      '  # If undefined, then advertised listeners will be configured in Redpanda,',
      '  # but the helm chart will not create a Service.',
      '  # You must create a Service manually.',
      '  # Warning: If you use LoadBalancers, you will likely experience higher latency and increased packet loss.',
      '  # NodePort is recommended in cases where latency is a priority.',
      '  type: NodePort',
      '  # Optional source range for external access. Only applicable when external.type is LoadBalancer',
      '  # sourceRanges: []',
      '  # -- Optional domain advertised to external clients',
      '  # If specified, then it will be appended to the `external.addresses` values as each broker\'s advertised address',
      '  # domain: local',
      '  # Optional list of addresses that the Redpanda brokers advertise.',
      '  # Provide one entry for each broker in order of StatefulSet replicas.',
      '  # The number of brokers is defined in statefulset.replicas.',
      '  # The values can be IP addresses or DNS names.',
      '  # If external.domain is set, the domain is appended to these values.',
      '  # There is an option to define a single external address for all brokers and leverage',
      '  # prefixTemplate as it will be calculated during initContainer execution.',
      '  # addresses:',
      '  # - redpanda-0',
      '  # - redpanda-1',
      '  # - redpanda-2',
      '  #',
      '  # annotations:',
      '    # For example:',
      '    # cloud.google.com/load-balancer-type: \"Internal\"',
      '    # service.beta.kubernetes.io/aws-load-balancer-type: nlb',
      '  # If you enable externalDns, each LoadBalancer service instance',
      '  # will be annotated with external-dns hostname',
      '  # matching external.addresses + external.domain',
      '  # externalDns:',
      '  #   enabled: true',
      '  # prefixTemplate: \"\"',
      '  # -- Gateway API TLSRoute-based external access (alternative to NodePort/LoadBalancer).',
      '  # The chart creates a bootstrap TLSRoute plus one per-broker TLSRoute, routed by SNI',
      '  # through a Gateway you manage. Opt individual listeners in by setting their type:',
      '  # `listeners.<service>.external.<name>.type: tlsroute` (see listeners.kafka.external below).',
      '  # The Gateway itself is NOT created by the chart; reference it via parentRefs.',
      '  # gateway:',
      '  #   # Activates Gateway API TLSRoute mode. Takes precedence over external.type.',
      '  #   enabled: false',
      '  #   # Gateway(s) that handle the TLSRoutes. Passed directly into each TLSRoute\'s',
      '  #   # spec.parentRefs. At least one entry is required when enabled.',
      '  #   parentRefs:',
      '  #     - name: redpanda-gateway      # required: name of the Gateway',
      '  #       sectionName: kafka          # optional: Gateway listener section to attach to',
      '  #       # namespace: rp-gw          # optional: defaults to the TLSRoute\'s namespace',
      '  #       # kind: Gateway             # optional: defaults to \"Gateway\"',
      '  #       # group: gateway.networking.k8s.io  # optional: default API group',
      '  #   # Port advertised to clients in broker metadata. Defaults to 443. The actual',
      '  #   # listening port is configured on the Gateway, not on the TLSRoute.',
      '  #   advertisedPort: 9094',
      '',
  ].join('\n')

  // redpanda-operator main: the same block with `@doc` markers on the
  // siblings.
  const mainExternal = [
      'external:',
      '  # -- Service allows you to manage the creation of an external kubernetes service object',
      '  service:',
      '    # -- Enabled if set to false will not create the external service type',
      '    # You can still set your cluster with external access but not create the supporting service (NodePort/LoadBalander).',
      '    # Set this to false if you rather manage your own service.',
      '    enabled: true',
      '  # -- Enable external access for each Service.',
      '  # You can toggle external access for each listener in',
      '  # `listeners.<service name>.external.<listener-name>.enabled`.',
      '  enabled: true',
      '  # -- External access type. Only `NodePort` and `LoadBalancer` are supported.',
      '  # If undefined, then advertised listeners will be configured in Redpanda,',
      '  # but the helm chart will not create a Service.',
      '  # You must create a Service manually.',
      '  # Warning: If you use LoadBalancers, you will likely experience higher latency and increased packet loss.',
      '  # NodePort is recommended in cases where latency is a priority.',
      '  type: NodePort',
      '  # Optional source range for external access. Only applicable when external.type is LoadBalancer',
      '  # @doc external.sourceRanges -- Optional source IP ranges for external access. Only applicable when `external.type` is `LoadBalancer`.',
      '  # sourceRanges: []',
      '  # -- Optional domain advertised to external clients',
      '  # If specified, then it will be appended to the `external.addresses` values as each broker\'s advertised address',
      '  # domain: local',
      '  # Optional list of addresses that the Redpanda brokers advertise.',
      '  # Provide one entry for each broker in order of StatefulSet replicas.',
      '  # The number of brokers is defined in statefulset.replicas.',
      '  # The values can be IP addresses or DNS names.',
      '  # If external.domain is set, the domain is appended to these values.',
      '  # There is an option to define a single external address for all brokers and leverage',
      '  # prefixTemplate as it will be calculated during initContainer execution.',
      '  # @doc external.addresses -- Optional list of addresses that the Redpanda brokers advertise, with one entry for each broker in order of StatefulSet replicas. The number of brokers is defined in `statefulset.replicas`. The values can be IP addresses or DNS names. If `external.domain` is set, the domain is appended to these values. To use a single external address for all brokers, define one entry and use `external.prefixTemplate` so that each broker\'s address is calculated during initContainer execution.',
      '  # addresses:',
      '  # - redpanda-0',
      '  # - redpanda-1',
      '  # - redpanda-2',
      '  #',
      '  # @doc external.annotations -- Optional annotations to add to the external Service instances, for example `cloud.google.com/load-balancer-type: \"Internal\"` or `service.beta.kubernetes.io/aws-load-balancer-type: nlb`.',
      '  # annotations:',
      '    # For example:',
      '    # cloud.google.com/load-balancer-type: \"Internal\"',
      '    # service.beta.kubernetes.io/aws-load-balancer-type: nlb',
      '  # If you enable externalDns, each LoadBalancer service instance',
      '  # will be annotated with external-dns hostname',
      '  # matching external.addresses + external.domain',
      '  # @doc external.externalDns.enabled -- If you enable externalDns, each LoadBalancer Service instance is annotated with the external-dns hostname, matching `external.addresses` plus `external.domain`.',
      '  # externalDns:',
      '  #   enabled: true',
      '  # @doc external.prefixTemplate -- Optional Go template for the prefix of each broker\'s advertised address. The result is prepended to `external.domain` during initContainer execution. Only used when `external.addresses` contains a single entry that serves all brokers.',
      '  # @default -- `\"\"`',
      '  # prefixTemplate: \"\"',
      '  # -- Gateway API TLSRoute-based external access (alternative to NodePort/LoadBalancer).',
      '  # The chart creates a bootstrap TLSRoute plus one per-broker TLSRoute, routed by SNI',
      '  # through a Gateway you manage. Opt individual listeners in by setting their type:',
      '  # `listeners.<service>.external.<name>.type: tlsroute` (see listeners.kafka.external below).',
      '  # The Gateway itself is NOT created by the chart; reference it via parentRefs.',
      '  # gateway:',
      '  #   # Activates Gateway API TLSRoute mode. Takes precedence over external.type.',
      '  #   enabled: false',
      '  #   # Gateway(s) that handle the TLSRoutes. Passed directly into each TLSRoute\'s',
      '  #   # spec.parentRefs. At least one entry is required when enabled.',
      '  #   parentRefs:',
      '  #     - name: redpanda-gateway      # required: name of the Gateway',
      '  #       sectionName: kafka          # optional: Gateway listener section to attach to',
      '  #       # namespace: rp-gw          # optional: defaults to the TLSRoute\'s namespace',
      '  #       # kind: Gateway             # optional: defaults to \"Gateway\"',
      '  #       # group: gateway.networking.k8s.io  # optional: default API group',
      '  #   # Port advertised to clients in broker metadata. Defaults to 443. The actual',
      '  #   # listening port is configured on the Gateway, not on the TLSRoute.',
      '  #   advertisedPort: 9094',
      '',
  ].join('\n')

  const byPath = (yaml) => new Map(extractCommentedValueDocs(yaml).map((e) => [e.path, e]))

  test('the marker documents the key directly below it, not the last key in the run (v26.2.4 chart)', () => {
    const entries = byPath(v2624External)
    expect(entries.get('external.domain').description).toBe([
      'Optional domain advertised to external clients',
      'If specified, then it will be appended to the `external.addresses` values as each broker\'s advertised address',
    ].join('\n'))
    // The domain description used to land here, on the last key of the run.
    expect(entries.has('external.prefixTemplate')).toBe(false)
  })

  test('later siblings in the run are documented by their own plain comments (v26.2.4 chart)', () => {
    const entries = byPath(v2624External)
    expect([...entries.keys()]).toEqual([
      'external.domain',
      'external.addresses',
      'external.externalDns',
      'external.gateway',
    ])
    const addresses = entries.get('external.addresses').description
    expect(addresses.startsWith('Optional list of addresses that the Redpanda brokers advertise.')).toBe(true)
    expect(addresses).toContain('prefixTemplate as it will be calculated during initContainer execution.')
    // The list items under `addresses` are its example, not prose.
    expect(addresses).not.toContain('redpanda-0')
    expect(entries.get('external.externalDns').description.startsWith('If you enable externalDns')).toBe(true)
    // `annotations` and `prefixTemplate` have no comment of their own, and
    // the `For example:` lines nested under `annotations` stay its example.
    for (const e of entries.values()) expect(e.description).not.toContain('For example:')
  })

  test('@doc markers still render on the chart that carries them (operator main)', () => {
    const entries = byPath(mainExternal)
    expect([...entries.keys()].sort()).toEqual([
      'external.addresses',
      'external.annotations',
      'external.domain',
      'external.externalDns.enabled',
      'external.gateway',
      'external.prefixTemplate',
      'external.sourceRanges',
    ])
    expect(entries.get('external.domain').description.startsWith('Optional domain advertised to external clients')).toBe(true)
    expect(entries.get('external.addresses').description.startsWith('Optional list of addresses that the Redpanda brokers advertise, with one entry')).toBe(true)
    expect(entries.get('external.prefixTemplate').description.startsWith('Optional Go template')).toBe(true)
    expect(entries.get('external.prefixTemplate').default).toBe('`""`')
    // The plain comments the @doc lines replaced are not published.
    for (const e of entries.values()) expect(e.description).not.toContain('There is an option to define')
  })

  test('a plain comment after the documented key with no key below it is neither documented nor a dead marker', () => {
    const yaml = [
      'external:',
      '  # -- Optional domain.',
      '  # domain: local',
      '  # Trailing note about the domain.',
      'logging: {}',
    ].join('\n')

    const records = parseValuesFile(yaml)
    expect(records.map((r) => [r.kind, r.path])).toEqual([['key', 'external.domain']])
    expect(records[0].descLines).toEqual(['Optional domain.'])
  })

  test('without a marker above the run, plain-commented keys stay undocumented', () => {
    const yaml = [
      'external:',
      '  type: NodePort',
      '  # Optional source range for external access.',
      '  # sourceRanges: []',
      '  # -- Optional domain.',
      '  # domain: local',
    ].join('\n')

    expect(extractCommentedValueDocs(yaml).map((e) => e.path)).toEqual(['external.domain'])
  })

  test('in helm-docs mode, a plain comment directly above a real key does not attach to it', () => {
    const yaml = [
      'parent:',
      '  # -- Doc for child.',
      '  # child: x',
      '  # Plain comment.',
      '  real: 1',
    ].join('\n')

    const records = parseValuesFile(yaml, { attachRealKeys: true })
    expect(records.filter((r) => !r.undocumented).map((r) => r.path)).toEqual(['parent.child'])
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
