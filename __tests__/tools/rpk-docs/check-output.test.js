'use strict'

const { checkDescription, checkTree, reportLines } = require('../../../tools/rpk-docs/check-output')

const invariants = (violations) => violations.map(v => v.invariant)

describe('checkDescription: the four DOC-2686 bugs', () => {
  // Each case is the real output for a real help string from the rpk ai
  // 0.2.100 tree in redpanda-data/docs#2319: broken is what main's generator
  // published, fixed is what it publishes after redpanda-data/docs-extensions-and-macros#447.

  test('--help text leaked into the previous flag', () => {
    const source = 'print the request that would be sent (with the computed update mask) and exit without calling the server'
    const broken = 'print the request that would be sent (with the computed update mask) and exit without calling the server help for create.'
    const fixed = 'print the request that would be sent (with the computed update mask) and exit without calling the server.'
    const found = checkDescription(source, broken)
    expect(invariants(found)).toEqual(['text-preserved'])
    expect(found[0].reason).toContain('help for create')
    expect(checkDescription(source, fixed)).toEqual([])
  })

  test('backticks around only part of a dotted flag', () => {
    const source = 'Turns this check on or off independently. (true when set; pass --local-config.grounding-policy.relevance.enabled=false to disable)'
    const broken = 'Turns this check on or off independently. (true when set; pass `--local-config`.grounding-policy.relevance.enabled=false to disable).'
    const fixed = 'Turns this check on or off independently. (true when set; pass `--local-config.grounding-policy.relevance.enabled=false` to disable).'
    const found = checkDescription(source, broken)
    expect(invariants(found)).toEqual(['whole-token-spans'])
    expect(found[0].reason).toContain('`--local-config` ends mid-token before ".g"')
    expect(checkDescription(source, fixed)).toEqual([])
  })

  test('JSON quotes turned into code spans', () => {
    const source = 'JSON object of string arguments, for example \'{"topic":"oncall"}\''
    const broken = "JSON object of string arguments, for example '{`topic`:`oncall`}'."
    const fixed = 'JSON object of string arguments, for example `+\'{"topic":"oncall"}\'+`.'
    const found = checkDescription(source, broken)
    // `oncall` is not even rendered: Asciidoctor prints its backticks.
    expect(found.map(v => v.reason)).toEqual([
      'unrendered code span: "\'{topic:`oncall`}\'."',
      'code span `topic` ends mid-token before ":`"'
    ])
    expect(checkDescription(source, fixed)).toEqual([])
  })

  test('placeholders leaked and text was lost', () => {
    const source = "trace link, which also supplies the start time. --start-time (the trace's\n" +
      "start, from 'trace list -o json') makes the read faster.\n" +
      '-o json and -o yaml print the GetTraceResponse.'
    const broken = "trace link, which also supplies the start time. `--start-time` (the trace's\n" +
      'start, from `trace list `-o` json`__INLINE_CODE_3__-o json__INLINE_CODE_4__-o yaml` print the GetTraceResponse.'
    const fixed = "trace link, which also supplies the start time. `--start-time` (the trace's\n" +
      'start, from `trace list -o json`) makes the read faster.\n' +
      '`-o json` and `-o yaml` print the GetTraceResponse.'
    const found = checkDescription(source, broken)
    expect(found[0]).toEqual({ invariant: 'text-preserved', reason: 'internal placeholder __INLINE_CODE_3__ in the output' })
    expect(checkDescription(source, fixed)).toEqual([])
  })
})

describe('checkDescription: ordinary output passes', () => {
  test.each([
    ['sentence period after a span', 'Lists topics. See rpk topic describe.', 'Lists topics. See `rpk topic describe`.'],
    ['span at sentence start', '--brokers sets the seed brokers', '`--brokers` sets the seed brokers.'],
    ['span in parentheses', 'Output format (defaults to --format text)', 'Output format (defaults to `--format text`).'],
    ['span before a comma', 'Use -X, then retry', 'Use `-X`, then retry.'],
    ['comma-separated spans', 'One of (json,yaml,text)', 'One of (`json`,`yaml`,`text`).'],
    ['flag alternatives', 'Use --wait/-w', 'Use `--wait`/`-w`.'],
    ['e.g. rewrite', 'A filter, e.g. foo', 'A filter, for example, foo.'],
    ['product capitalization', 'when redpanda starts', 'when Redpanda starts.'],
    ['typographic apostrophe', "the trace's start", "the trace's start."]
  ])('%s', (_, source, output) => {
    expect(checkDescription(source, output)).toEqual([])
  })

  test('override text is AsciiDoc, so its markup is rendered before comparing', () => {
    const source = 'See xref:reference:rpk/rpk-topic.adoc[rpk topic] for *all* options.'
    expect(checkDescription(source, source, { sourceIsAsciiDoc: true })).toEqual([])
  })

  test('raw help text is compared as written, so accidental markup is caught', () => {
    const source = 'list of *data* directories'
    const found = checkDescription(source, 'list of *data* directories.')
    expect(invariants(found)).toEqual(['text-preserved'])
  })

  test('override replacement rules count as intended rewrites', () => {
    const textTransformations = { replacements: [{ pattern: '\\brpai\\b', replacement: 'rpk ai', applyToCode: true }] }
    expect(checkDescription('Run rpai auth login', 'Run `rpk ai auth login`.', { textTransformations })).toEqual([])
  })
})

describe('checkDescription: other span breakage', () => {
  test('a span joined to the word before it', () => {
    expect(invariants(checkDescription('display_name="prod"', 'display_name=`prod`.'))).toEqual(['whole-token-spans'])
  })

  test('a span Asciidoctor cannot render prints its backticks', () => {
    const found = checkDescription('name:"web"', 'name:`web`.')
    expect(found).toEqual([{ invariant: 'whole-token-spans', reason: 'unrendered code span: "name:`web`."' }])
  })

  test('text added to the output', () => {
    expect(invariants(checkDescription('Run rpk topic list', 'Run `rpk topic list` now.'))).toEqual(['text-preserved'])
  })
})

describe('checkTree', () => {
  const tree = {
    name: 'rpk',
    commands: [{
      name: 'demo',
      description: 'Demo command for rpk topic.',
      flags: [
        { name: 'dirs', description: 'list of *data* directories' },
        { name: 'brokers', description: 'seed brokers' }
      ]
    }],
    global_flags: [{ name: 'verbose', description: 'Enable verbose logging' }]
  }

  test('checks every command and flag description, including global flags', () => {
    const result = checkTree(tree, null)
    expect(result.checked).toBe(4)
    expect(result.violations.map(v => `${v.command} ${v.flag}`)).toEqual(['rpk demo --dirs'])
  })

  test('uses the override description as the source when the overrides replace it', () => {
    const overrides = { commands: { 'rpk demo': { flags: { dirs: { description: 'Data directories, for example /var/lib/redpanda/data' } } } } }
    const result = checkTree(tree, overrides)
    expect(result.violations).toEqual([])
  })

  test('an exception suppresses its violation and is listed with its reason', () => {
    const overrides = {
      outputCheckExceptions: [{ command: 'rpk demo', flag: '--dirs', invariant: 'text-preserved', reason: 'help text emphasis renders as bold' }]
    }
    const result = checkTree(tree, overrides)
    expect(result.violations).toEqual([])
    expect(result.excepted.map(e => e.exceptionReason)).toEqual(['help text emphasis renders as bold'])
    expect(reportLines(result)).toEqual([])
  })

  test('an exception that matches nothing is reported, so the list cannot go stale', () => {
    const overrides = { outputCheckExceptions: [{ command: 'rpk demo', flag: '--brokers', reason: 'old' }] }
    const lines = reportLines(checkTree(tree, overrides))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^rpk demo --dirs \| text-preserved \| /)
    expect(lines[1]).toMatch(/^rpk demo --brokers \| unused-exception \| /)
  })
})
