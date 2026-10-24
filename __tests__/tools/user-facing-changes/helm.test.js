'use strict'

const { detect, kinds } = require('./helpers')

const FILE = 'charts/redpanda/chart/values.yaml'

// Synthetic values.yaml with helm-docs comments, nesting and a list.
const SOURCE = `# -- Override the chart name.
nameOverride: ""

image:
  # -- The container image repository.
  repository: docker.redpanda.com/redpandadata/redpanda
  tag: ""

statefulset:
  # -- Number of brokers.
  replicas: 3
  podTemplate:
    labels: {}
  additionalRedpandaCmdFlags: []

listeners:
  kafka:
    port: 9093
    tls:
      enabled: true
`

const base = { [FILE]: SOURCE }
const edit = (from, to) => ({ [FILE]: SOURCE.replace(from, to) })

describe('helm detector', () => {
  test('a changed value is a default change (high), named by its dotted path', () => {
    const r = detect(base, edit('  replicas: 3', '  replicas: 5'))
    expect(kinds(r)).toEqual([['default-changed', 'statefulset.replicas']])
    expect(r.findings[0]).toMatchObject({ surface: 'helm', severity: 'high', file: FILE, line: 11 })
    expect(r.findings[0].summary).toMatch(/from `3` to `5`/)
    expect(r.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/streaming/current/reference/k-redpanda-helm-spec/'])
    expect(r.findings[0].evidence).toMatch(/^\+  replicas: 5$/m)
  })

  test('a new key is added once at its top-most new path, not once per leaf', () => {
    const r = detect(base, edit('  additionalRedpandaCmdFlags: []', '  additionalRedpandaCmdFlags: []\n  sideCars:\n    enabled: true\n    image:\n      tag: v1'))
    expect(kinds(r)).toEqual([['added', 'statefulset.sideCars']])
    expect(r.findings[0].severity).toBe('medium')
  })

  test('a new leaf under an existing map carries its default', () => {
    const r = detect(base, edit('    port: 9093', '    port: 9093\n    advertisedPort: 9094'))
    expect(kinds(r)).toEqual([['added', 'listeners.kafka.advertisedPort']])
    expect(r.findings[0].summary).toMatch(/default `9094`/)
  })

  test('a removed key is high, reported once at its top-most removed path', () => {
    const r = detect(base, edit('  podTemplate:\n    labels: {}\n', ''))
    expect(kinds(r)).toEqual([['removed', 'statefulset.podTemplate']])
    expect(r.findings[0].severity).toBe('high')
  })

  test('a list value change is a default change', () => {
    const r = detect(base, edit('additionalRedpandaCmdFlags: []', 'additionalRedpandaCmdFlags: ["--abort-on-seastar-bad-alloc"]'))
    expect(kinds(r)).toEqual([['default-changed', 'statefulset.additionalRedpandaCmdFlags']])
  })

  test('the console and connectors charts route to their own pages; both chart layouts are routed', () => {
    const C = 'charts/console/chart/values.yaml'
    const r = detect({ [C]: 'replicaCount: 1\n' }, { [C]: 'replicaCount: 2\n' })
    expect(r.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/streaming/current/reference/k-console-helm-spec/'])
    const K = 'charts/connectors/values.yaml'
    const r2 = detect({ [K]: 'replicaCount: 1\n' }, { [K]: 'replicaCount: 2\n' })
    expect(r2.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/streaming/current/reference/k-connector-helm-spec/'])
  })
})

describe('helm detector: negative controls', () => {
  test('a helm-docs comment change is the lint\'s and yields nothing', () => {
    expect(detect(base, edit('# -- Number of brokers.', '# -- The number of brokers to run.')).findings).toEqual([])
  })

  test('reordering keys and reformatting yield nothing', () => {
    expect(detect(base, edit('  tag: ""\n', '')).findings).not.toEqual([]) // sanity: removal is seen
    const reordered = SOURCE.replace('  # -- The container image repository.\n  repository: docker.redpanda.com/redpandadata/redpanda\n  tag: ""', '  tag: ""\n  # -- The container image repository.\n  repository: docker.redpanda.com/redpandadata/redpanda')
    expect(detect(base, { [FILE]: reordered }).findings).toEqual([])
    expect(detect(base, edit('nameOverride: ""', "nameOverride: ''")).findings).toEqual([])
  })

  test('a values file outside charts/ and a non-values yaml are not routed', () => {
    const O = 'operator/config/values.yaml'
    expect(detect({ [O]: SOURCE }, { [O]: SOURCE.replace('replicas: 3', 'replicas: 4') }).findings).toEqual([])
    const T = 'charts/redpanda/chart/templates/x.yaml'
    expect(detect({ [T]: SOURCE }, { [T]: SOURCE.replace('replicas: 3', 'replicas: 4') }).findings).toEqual([])
  })

  test('without whole files, values.yaml is a note rather than a guess', () => {
    const r = detect(base, edit('  replicas: 3', '  replicas: 5'), { whole: false })
    expect(r.findings).toEqual([])
    expect(r.notes).toEqual([expect.objectContaining({ detector: 'helm', message: expect.stringMatching(/needs both sides of the file/) })])
  })
})

describe('helm detector: values compared as Helm parses them', () => {
  test('quoting, 1 to 1.0 and YAML 1.1 booleans (yes, on) keep the value and yield nothing', () => {
    expect(detect(base, edit('  replicas: 3', '  replicas: 3.0')).findings).toEqual([])
    expect(detect(base, edit('      enabled: true', '      enabled: yes')).findings).toEqual([])
    expect(detect(base, edit('      enabled: true', '      enabled: On')).findings).toEqual([])
    expect(detect(base, edit('  tag: ""', "  tag: ''")).findings).toEqual([])
    expect(detect(base, edit('    port: 9093', '    port: "9093"')).findings).not.toEqual([])
  })

  test('yes to no is a default change, reported as the booleans Helm reads', () => {
    const yes = edit('      enabled: true', '      enabled: yes')
    const r = detect(yes, { [FILE]: yes[FILE].replace('      enabled: yes', '      enabled: no') })
    expect(kinds(r)).toEqual([['default-changed', 'listeners.kafka.tls.enabled']])
    expect(r.findings[0].summary).toMatch(/from `true` to `false`/)
  })

  test('the evidence is the changed key\'s lines, not the whole hunk', () => {
    const head = SOURCE
      .replace('# -- Override the chart name.\nnameOverride: ""\n', '')
      .replace('  tag: ""', '  tag: v1')
      .replace('      enabled: true', '      enabled: false')
    const r = detect(base, { [FILE]: head }, { context: 20 })
    const tls = r.findings.find((f) => f.name === 'listeners.kafka.tls.enabled')
    const lines = tls.evidence.split('\n')
    expect(lines.slice(1)).toEqual(['-      enabled: true', '+      enabled: false'])
  })
})
