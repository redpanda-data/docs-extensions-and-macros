'use strict'

const { runRules } = require('../../../tools/lint-strings/engine')
const { COMMON_RULES, isNameEcho } = require('../../../tools/lint-strings/rules/common')
const { VERBATIM_ASCIIDOC_RULES, CONDITIONAL_RULE } = require('../../../tools/lint-strings/rules/verbatim-asciidoc')

function decl (overrides = {}) {
  return {
    surface: 'properties',
    name: 'example_property',
    file: 'src/v/config/configuration.cc',
    line_start: 10,
    line_end: 15,
    string: 'A perfectly reasonable description of the property behavior.',
    declaration_text: 'example_property(...)',
    convention: {},
    meta: {},
    ...overrides
  }
}

function ruleByName (rules, name) {
  const rule = rules.find((r) => r.name === name)
  if (!rule) throw new Error(`No rule named ${name}`)
  return rule
}

describe('common rules', () => {
  test('empty-description flags null, empty, and whitespace-only strings', () => {
    const rule = ruleByName(COMMON_RULES, 'empty-description')
    expect(rule.severity).toBe('error')
    expect(rule.check(decl({ string: null }))).toHaveLength(1)
    expect(rule.check(decl({ string: '' }))).toHaveLength(1)
    expect(rule.check(decl({ string: '   ' }))).toHaveLength(1)
    expect(rule.check(decl())).toHaveLength(0)
  })

  test('starts-lowercase flags lowercase prose but not backtick-led or digit-led strings', () => {
    const rule = ruleByName(COMMON_RULES, 'starts-lowercase')
    expect(rule.check(decl({ string: 'proportional coefficient for upload PID controller' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Proportional coefficient.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: '`true` enables the thing.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: '2 hours between runs.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: null }))).toHaveLength(0)
  })

  test('name-echo detects tautologies with normalization, prefixes, and reordering', () => {
    expect(isNameEcho('cluster_id', 'Cluster identifier.')).toBe(true)
    expect(isNameEcho('start_offset', 'start offset')).toBe(true)
    expect(isNameEcho('start_offset', 'Offset start')).toBe(true)
    expect(isNameEcho('start-offset', 'Start offset.')).toBe(true)
    // Real descriptions are not echoes
    expect(isNameEcho('cluster_id', 'Unique identifier for this cluster, assigned at bootstrap.')).toBe(false)
    // Same token count but unrelated words
    expect(isNameEcho('start_offset', 'first record')).toBe(false)
    // Different token counts
    expect(isNameEcho('cloud_storage_upload_ctrl_p_coeff', 'proportional coefficient for upload PID controller')).toBe(false)

    const rule = ruleByName(COMMON_RULES, 'name-echo')
    expect(rule.check(decl({ name: 'cluster_id', string: 'Cluster identifier.' }))).toHaveLength(1)
    expect(rule.check(decl({ name: null, string: 'Cluster identifier.' }))).toHaveLength(0)
  })

  test('too-short flags under 20 characters but leaves empty to empty-description', () => {
    const rule = ruleByName(COMMON_RULES, 'too-short')
    expect(rule.check(decl({ string: '1234567890123456789' }))).toHaveLength(1) // 19
    expect(rule.check(decl({ string: '12345678901234567890' }))).toHaveLength(0) // 20
    expect(rule.check(decl({ string: '' }))).toHaveLength(0)
    expect(rule.check(decl({ string: null }))).toHaveLength(0)
  })

  test('unexpanded-jargon matches on word boundaries only', () => {
    const rule = ruleByName(COMMON_RULES, 'unexpanded-jargon')
    expect(rule.check(decl({ string: 'Timeout for each NTP to recover.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Uses the seastar reactor for scheduling.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Set to nullopt to disable.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Snapshot size of the stm state.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'One instance per smp core.' }))).toHaveLength(1)
    // Word characters (including _) around the term must not match
    expect(rule.check(decl({ string: 'Size of the archival_meta_stm snapshot in bytes plus more words.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'A stable stream of records.' }))).toHaveLength(0)
  })

  test('em-dash flags em dashes and counts them, and leaves hyphens alone', () => {
    const rule = ruleByName(COMMON_RULES, 'em-dash')
    expect(rule.severity).toBe('warning')
    expect(rule.check(decl({ string: 'Upgraded on first write \u2014 irreversibly \u2014 unless copy-on-write is set.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Upgraded on first write \u2014 irreversibly \u2014 unless set.' }))[0].message)
      .toMatch(/2 em dashes/)
    expect(rule.check(decl({ string: 'Upgraded on first write, irreversibly, unless copy-on-write is set.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'Use the copy-on-write merge strategy for version 1 tables.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: null }))).toHaveLength(0)
  })

  test('latin-abbreviation flags e.g. and i.e. but not words that merely contain them', () => {
    const rule = ruleByName(COMMON_RULES, 'latin-abbreviation')
    expect(rule.severity).toBe('warning')
    expect(rule.check(decl({ string: 'Set a prefix (e.g. `s3://my-bucket/`) since Glue assigns no location.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Set a prefix (E.g., `s3://my-bucket/`).' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'The signal table, i.e. the table used for signals.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Both forms, e.g. this and i.e. that, are flagged.' }))).toHaveLength(2)
    expect(rule.check(decl({ string: 'Set a prefix, for example `s3://my-bucket/`.' }))).toHaveLength(0)
    // Not a Latin abbreviation: part of a longer token.
    expect(rule.check(decl({ string: 'Fetch from https://example.g.co/path for the manifest.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'The page.g.field selector is resolved at startup.' }))).toHaveLength(0)
    // A host or identifier that contains the abbreviation is not one.
    expect(rule.check(decl({ string: 'Point the endpoint at https://e.g.example/path for the manifest.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'Set `i.e.identifier` to the resolved name.' }))).toHaveLength(0)
  })

  test('long-sentence flags sentences over the ceiling across line wraps', () => {
    const rule = ruleByName(COMMON_RULES, 'long-sentence')
    expect(rule.severity).toBe('warning')
    // The rpk ai Long text that prompted the rule, wrapped as in source.
    const wrapped = [
      'On AWS the trust can be one MCP server\'s: name the server (one that exists, or',
      'the name you will create it with) and it prints the Workload Identity Federation',
      'setup and the binding that lets that server, and no other on the gateway, mint',
      'as the account. On Google Cloud the gateway has one identity, so the binding',
      'trusts every MCP server on it.'
    ].join('\n')
    const issues = rule.check(decl({ string: wrapped }))
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toMatch(/^Sentence has 48 words/)
    // Split into short sentences, the same facts pass.
    expect(rule.check(decl({
      string: 'On AWS, you can trust a single MCP server. Pass the server\'s name, even if you haven\'t created it yet.\n' +
        'The command prints the Workload Identity Federation setup and the binding.'
    }))).toHaveLength(0)
    expect(rule.check(decl({ string: null }))).toHaveLength(0)
  })

  test('long-sentence counts code spans and URLs as one word and skips code blocks and list items', () => {
    const rule = ruleByName(COMMON_RULES, 'long-sentence')
    const words = (n) => Array.from({ length: n }, () => 'word').join(' ')
    expect(rule.check(decl({ string: `${words(29)} \`rpk ai mcp-server create --name my-server --gate iap\`.` }))).toHaveLength(0)
    expect(rule.check(decl({ string: `${words(29)} https://docs.redpanda.com/a/very/long/path?with=query.` }))).toHaveLength(0)
    expect(rule.check(decl({ string: `${words(31)}.` }))).toHaveLength(1)
    // A URL keeps the punctuation after it, so its sentence still ends there.
    expect(rule.check(decl({ string: `${words(20)} (anything starting with http:// or https://). ${words(20)}.` }))).toHaveLength(0)
    // Indented lines become code blocks in rpk docs.
    expect(rule.check(decl({ string: `Run this command.\n\n  ${words(40)}` }))).toHaveLength(0)
    // Each list item is its own segment.
    expect(rule.check(decl({ string: `Choose one:\n- ${words(20)}\n- ${words(20)}` }))).toHaveLength(0)
    // An unindented shell transcript, as in rpk cluster brokers decommission-status.
    expect(rule.check(decl({ string: `Reports progress as follows.\n\n$ rpk cluster brokers decommission-status 4\nDECOMMISSION PROGRESS\n${words(40)}` }))).toHaveLength(0)
  })

  test('unbalanced-backticks flags odd counts', () => {
    const rule = ruleByName(COMMON_RULES, 'unbalanced-backticks')
    expect(rule.check(decl({ string: 'Accepted values: `config_file`, `sts, `other`.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Accepted values: `config_file`, `sts`.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'No backticks at all.' }))).toHaveLength(0)
  })
})

describe('verbatim-asciidoc rules', () => {
  test('raw-pipe flags unescaped | outside backticks', () => {
    const rule = ruleByName(VERBATIM_ASCIIDOC_RULES, 'raw-pipe')
    expect(rule.check(decl({ string: 'Use a | to separate values.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'Use `a | b` syntax.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'Use a \\| to separate values.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'No pipes here.' }))).toHaveLength(0)
  })

  test('unknown-attribute flags {attr} that is not a known product attribute', () => {
    const rule = ruleByName(VERBATIM_ASCIIDOC_RULES, 'unknown-attribute')
    expect(rule.check(decl({ string: 'Path template {namespace}/{topic}/{partition_id}.' }))).toHaveLength(3)
    expect(rule.check(decl({ string: 'Requires {latest-redpanda-version} or newer.' }))).toHaveLength(0)
    // Not attribute-shaped: empty braces, digits, uppercase
    expect(rule.check(decl({ string: 'Uses {} and {0} and {FOO} placeholders.' }))).toHaveLength(0)
  })

  test('broken-macro flags xref/glossterm/config_ref with unbalanced brackets', () => {
    const rule = ruleByName(VERBATIM_ASCIIDOC_RULES, 'broken-macro')
    expect(rule.check(decl({ string: 'See xref:manage:cluster.adoc[Cluster guide] for details.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'See glossterm:partition[] for details.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'See config_ref:write_caching,true,properties/cluster-properties[] too.' }))).toHaveLength(0)
    expect(rule.check(decl({ string: 'See xref:manage:cluster.adoc[Cluster guide for details.' }))).toHaveLength(1)
    expect(rule.check(decl({ string: 'See glossterm:partition for details.' }))).toHaveLength(1)
  })
})

describe('conditional rule (env-cloud blocks in connect spec strings)', () => {
  const WHY = 'The Cloud docs and the Cloud binaries set env-cloud, and the text inside must read as a whole paragraph in both outputs. See docs/README.md in the connect repo.'
  const connectDecl = (string, meta = { kind: 'description' }) => decl({
    surface: 'connect',
    name: 'fixture_input',
    file: 'internal/impl/fixture/lint_connect.go',
    string,
    convention: { case: 'sentence', terminal_period: true, verbatim_asciidoc: true },
    meta
  })
  const messages = (string, meta) => CONDITIONAL_RULE.check(connectDecl(string, meta)).map((i) => i.message)

  test('is registered under the name the connect surface enables, as a warning', () => {
    expect(CONDITIONAL_RULE.name).toBe('conditional')
    expect(CONDITIONAL_RULE.severity).toBe('warning')
    expect(VERBATIM_ASCIIDOC_RULES.find((r) => r.name === 'conditional')).toBeUndefined()
  })

  test('a well-formed env-cloud block passes: ifdef and ifndef, mid-string, at the start, at the end', () => {
    expect(messages('Reads records.\n\nifndef::env-cloud[]\nSet the broker list yourself.\nendif::[]\n\nMore prose.')).toEqual([])
    expect(messages('Reads records.\n\nifdef::env-cloud[]\nThe broker list is managed for you.\nendif::[]\n\nMore prose.')).toEqual([])
    expect(messages('ifdef::env-cloud[]\nOpens the string.\nendif::[]\n\nMore prose.')).toEqual([])
    expect(messages('Prose first.\n\nifndef::env-cloud[]\nCloses the string.\nendif::[]')).toEqual([])
    // A multi-line paragraph and a blank line inside the block are fine.
    expect(messages('Prose.\n\nifndef::env-cloud[]\nLine one of the paragraph\ncontinues here.\n\nSecond paragraph.\nendif::[]\n\nAfter.')).toEqual([])
  })

  test('strings with no conditional, and CLI help, are left alone', () => {
    expect(messages('Nothing conditional here, not even an xref:components:about.adoc[link].')).toEqual([])
    const cli = connectDecl('ifdef::env-cloud[]\nx\nendif::[]')
    cli.convention = { verbatim_asciidoc: false }
    expect(CONDITIONAL_RULE.check(cli)).toEqual([])
  })

  test('unbalanced directives are errors', () => {
    const unclosed = CONDITIONAL_RULE.check(connectDecl('Prose.\n\nifndef::env-cloud[]\nHidden forever.'))
    expect(unclosed).toHaveLength(1)
    expect(unclosed[0].severity).toBe('error')
    expect(unclosed[0].message).toContain('never closed with endif::[]')

    const stray = CONDITIONAL_RULE.check(connectDecl('Prose.\n\nendif::[]\n\nAfter.'))
    expect(stray).toHaveLength(1)
    expect(stray[0].severity).toBe('error')
    expect(stray[0].message).toContain('no matching ifdef::env-cloud[] or ifndef::env-cloud[]')
  })

  test('env-cloud is the only attribute', () => {
    expect(messages('Prose.\n\nifdef::env-kubernetes[]\nText.\nendif::[]\n\nAfter.')).toEqual([
      expect.stringContaining('tests "env-kubernetes". env-cloud is the only attribute')
    ])
    expect(messages('Prose.\n\nifndef::env-cloud,env-k8s[]\nText.\nendif::[]\n\nAfter.')).toHaveLength(1)
    expect(messages('Prose.\n\nifdef::[]\nText.\nendif::[]\n\nAfter.')).toHaveLength(1)
    expect(messages('Prose.\n\nifeval::["{x}" == "y"]\nText.\nendif::[]\n\nAfter.')).toEqual([
      expect.stringContaining('uses ifeval')
    ])
    // endif may be bare, or name env-cloud, but nothing else
    expect(messages('Prose.\n\nifdef::env-cloud[]\nText.\nendif::env-cloud[]\n\nAfter.')).toEqual([])
    expect(messages('Prose.\n\nifdef::env-cloud[]\nText.\nendif::other[]\n\nAfter.')).toEqual([
      expect.stringContaining('names "other"')
    ])
  })

  test('directives must sit on a line of their own', () => {
    expect(messages('Prose. ifdef::env-cloud[]\nText.\nendif::[]')).toEqual([
      expect.stringContaining('not a directive on a line of its own at column 0'),
      expect.stringContaining('no matching ifdef::env-cloud[] or ifndef::env-cloud[]')
    ])
  })

  test('an indented directive is text: it neither opens nor closes a block, so the imbalance is an error', () => {
    // Indented endif: Asciidoctor hides everything after the opener on
    // self-managed, so the opener is reported as never closed.
    const indentedEnd = CONDITIONAL_RULE.check(connectDecl('A.\n\nifdef::env-cloud[]\nB.\n  endif::[]\n\nC after.'))
    expect(indentedEnd.map((i) => [i.severity, i.message])).toEqual([
      [undefined, expect.stringContaining('endif::[] is indented')],
      ['error', expect.stringContaining('ifdef::env-cloud[] is never closed with endif::[]')]
    ])
    // Indented opener before a column-0 endif: the endif has no opener.
    const indentedOpen = CONDITIONAL_RULE.check(connectDecl('Prose.\n\n  ifdef::env-cloud[]\nText.\nendif::[]\n\nAfter.'))
    expect(indentedOpen.map((i) => [i.severity, i.message])).toEqual([
      [undefined, expect.stringContaining('ifdef::env-cloud[] is indented')],
      ['error', expect.stringContaining('endif::[] has no matching ifdef::env-cloud[] or ifndef::env-cloud[]')]
    ])
    // A tab counts as indent too
    expect(messages('Prose.\n\nifdef::env-cloud[]\nText.\n\tendif::[]\n\nAfter.')).toEqual([
      expect.stringContaining('is indented'),
      expect.stringContaining('is never closed')
    ])
  })

  test('trailing whitespace after a directive is an error', () => {
    const opener = CONDITIONAL_RULE.check(connectDecl('A.\n\nifdef::env-cloud[]   \nB.\nendif::[]\n\nC.'))
    expect(opener).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('ifdef::env-cloud[] has trailing whitespace after the closing bracket') })])
    const closer = CONDITIONAL_RULE.check(connectDecl('A.\n\nifndef::env-cloud[]\nB.\nendif::[]\t\n\nC.'))
    expect(closer).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('endif::[] has trailing whitespace') })])
    // The directive still balances, so no unclosed or unmatched errors pile on
    expect(closer).toHaveLength(1)
  })

  test('whitespace inside the brackets of a directive is an error: Asciidoctor reads it as the single-line form', () => {
    for (const kind of ['ifdef', 'ifndef']) {
      const issues = CONDITIONAL_RULE.check(connectDecl(`A.\n\n${kind}::env-cloud[ ]\nB.\nendif::[]\n\nC.`))
      expect(issues).toEqual([
        expect.objectContaining({ severity: 'error', message: expect.stringContaining(`${kind}::env-cloud[ ] has whitespace inside its brackets`) }),
        expect.objectContaining({ severity: 'error', message: expect.stringContaining('has no matching') })
      ])
    }
    // Asciidoctor rejects an endif with anything in its brackets and leaves
    // the block open, so the rule reports the block as never closed too.
    for (const [bracket, what] of [['\t', 'whitespace'], [' ', 'whitespace'], ['x', 'text']]) {
      const closer = CONDITIONAL_RULE.check(connectDecl(`A.\n\nifndef::env-cloud[]\nB.\nendif::[${bracket}]\n\nC.`))
      expect(closer).toEqual([
        expect.objectContaining({ severity: 'error', message: expect.stringContaining(`has ${what} inside its brackets. Asciidoctor rejects it and leaves the block open`) }),
        expect.objectContaining({ severity: 'error', message: expect.stringContaining('ifndef::env-cloud[] is never closed') })
      ])
    }
    // Negative controls: the block form with empty brackets, and a named endif, pass
    expect(messages('A.\n\nifndef::env-cloud[]\nB.\nendif::[]\n\nC.')).toEqual([])
    expect(messages('A.\n\nifdef::env-cloud[]\nB.\nendif::env-cloud[]\n\nC.')).toEqual([])
  })

  test('contradictory nesting is reported: the inner text renders for neither audience', () => {
    expect(messages('A.\n\nifdef::env-cloud[]\nCloud.\n\nifndef::env-cloud[]\nNever.\nendif::[]\n\nendif::[]\n\nB.')).toEqual([
      expect.stringContaining('ifndef::env-cloud[] is inside ifdef::env-cloud[], so the text between them renders for neither audience')
    ])
    expect(messages('A.\n\nifndef::env-cloud[]\nSelf.\n\nifdef::env-cloud[]\nNever.\nendif::[]\n\nendif::[]\n\nB.')).toEqual([
      expect.stringContaining('ifdef::env-cloud[] is inside ifndef::env-cloud[]')
    ])
    // Sequential opposite blocks are fine
    expect(messages('A.\n\nifdef::env-cloud[]\nCloud.\nendif::[]\n\nifndef::env-cloud[]\nSelf.\nendif::[]\n\nB.')).toEqual([])
  })

  test('a blank line is required before the opening directive and after the closing one', () => {
    expect(messages('Prose.\nifdef::env-cloud[]\nText.\nendif::[]\n\nAfter.')).toEqual([
      expect.stringContaining('needs a blank line before it')
    ])
    expect(messages('Prose.\n\nifdef::env-cloud[]\nText.\nendif::[]\nAfter.')).toEqual([
      expect.stringContaining('needs a blank line after it')
    ])
    // Two blocks back to back need a blank line between them
    expect(messages('ifdef::env-cloud[]\nA.\nendif::[]\nifndef::env-cloud[]\nB.\nendif::[]')).toHaveLength(2)
  })

  test('the single-line form is rejected and does not open a block', () => {
    const found = messages('Prose.\n\nifndef::env-cloud[Only on self-managed.]\n\nAfter.')
    expect(found).toEqual([expect.stringContaining('is the single-line form')])
    // Text in an endif's brackets leaves the block open in Asciidoctor
    expect(messages('Prose.\n\nifdef::env-cloud[]\nText.\nendif::[extra]\n\nAfter.')).toEqual([
      expect.stringContaining('has text inside its brackets'),
      expect.stringContaining('is never closed')
    ])
  })

  test('a conditional inside a code fence is reported, for every fence style', () => {
    for (const fence of ['----', '....', '```']) {
      const found = messages(`Prose.\n\n${fence}\nifdef::env-cloud[]\nkey: value\nendif::[]\n${fence}\n\nAfter.`)
      expect(found).toEqual([
        expect.stringContaining('ifdef::env-cloud[] is inside a code fence'),
        expect.stringContaining('endif::[] is inside a code fence')
      ])
    }
    // A fence that closes before the block is not a fence any more
    expect(messages('----\nyaml: here\n----\n\nifdef::env-cloud[]\nText.\nendif::[]')).toEqual([])
  })

  test('a Markdown fence with a language tag opens a block, and its bare closing fence closes it', () => {
    // Before: the closing ``` opened a block and inverted tracking.
    expect(messages('Example:\n\n```yaml\nkey: value\n```\n\nifdef::env-cloud[]\nText.\nendif::[]\n\nAfter.')).toEqual([])
    expect(messages('Example:\n\n```yaml\nifdef::env-cloud[]\nkey: value\nendif::[]\n```\n\nAfter.')).toEqual([
      expect.stringContaining('ifdef::env-cloud[] is inside a code fence'),
      expect.stringContaining('endif::[] is inside a code fence')
    ])
    // A fence with a tag inside an open Markdown fence does not close it
    expect(messages('```\n```go\nifdef::env-cloud[]\nendif::[]\n```')).toHaveLength(2)
  })

  test('an AsciiDoc listing or literal block closes only on a delimiter of the same length', () => {
    expect(messages('Prose.\n\n------\n----\nifdef::env-cloud[]\nkey: value\nendif::[]\n------\n\nAfter.')).toEqual([
      expect.stringContaining('ifdef::env-cloud[] is inside a code fence'),
      expect.stringContaining('endif::[] is inside a code fence')
    ])
    expect(messages('Prose.\n\n.....\n....\n.....\n\nifdef::env-cloud[]\nText.\nendif::[]\n\nAfter.')).toEqual([])
  })

  test('any conditional in a Summary is reported once, with the Summary reason', () => {
    const found = messages('Reads records.\n\nifdef::env-cloud[]\nFrom a managed cluster.\nendif::[]', { kind: 'summary' })
    expect(found).toEqual([expect.stringContaining('in a Summary')])
    expect(messages('ifndef::env-cloud[Self-managed only.]', { kind: 'summary' })).toHaveLength(1)
    expect(messages('ifdef::env-cloud[]\nx\nendif::[]', { kind: 'bloblang', part: 'summary' })).toHaveLength(1)
    // Example summaries: Example() and Bloblang Example()/ExampleNotTested()
    for (const meta of [{ kind: 'example-summary' }, { kind: 'bloblang-example' }]) {
      expect(messages('Copies a field.\n\nifdef::env-cloud[]\nOn Cloud.\nendif::[]', meta)).toEqual([
        expect.stringContaining('in an example summary')
      ])
    }
    // An example title is not a summary
    expect(messages('ifdef::env-cloud[]\nx\nendif::[]', { kind: 'example-title' })).toEqual([])
    // The same text in a Description is judged on form alone
    expect(messages('Reads records.\n\nifdef::env-cloud[]\nFrom a managed cluster.\nendif::[]', { kind: 'description' })).toEqual([])
  })

  test('every message carries the why sentence and points to the connect README', () => {
    const all = [
      ...messages('Prose.\nifdef::env-kubernetes[]\n  Text.\n  endif::[extra]\nAfter.'),
      ...messages('x', { kind: 'summary' }).concat(messages('ifdef::env-cloud[y]', { kind: 'summary' })),
      ...messages('Prose.\n\nendif::[]')
    ]
    expect(all.length).toBeGreaterThan(4)
    for (const message of all) expect(message.endsWith(WHY)).toBe(true)
  })
})

describe('engine', () => {
  test('a declaration skips the rules its meta.skip_rules names', () => {
    const rule = { name: 'always', severity: 'warning', check: () => [{ message: 'hit' }] }
    const decl = (meta) => ({ surface: 'connect', name: 'x', file: 'f.go', line_start: 1, line_end: 1, string: 'x', meta })
    expect(runRules([decl({})], [rule]).findings).toHaveLength(1)
    expect(runRules([decl({ skip_rules: ['always'] })], [rule]).findings).toHaveLength(0)
  })

  test('collates findings per declaration with byRule and bySurface summary', () => {
    const declarations = [
      decl({ name: 'empty_prop', string: null }),
      decl({ name: 'fine_prop' })
    ]
    const { findings, summary } = runRules(declarations, COMMON_RULES)

    expect(findings).toHaveLength(1)
    expect(findings[0].name).toBe('empty_prop')
    expect(findings[0].rules.map((r) => r.id)).toEqual(['empty-description'])
    expect(findings[0].rules[0].severity).toBe('error')
    // Full JSON contract fields present
    for (const key of ['surface', 'name', 'file', 'line_start', 'line_end', 'string', 'declaration_text', 'rules', 'convention', 'in_pr_diff']) {
      expect(findings[0]).toHaveProperty(key)
    }

    expect(summary.totalDeclarations).toBe(2)
    expect(summary.flaggedDeclarations).toBe(1)
    expect(summary.errors).toBe(1)
    expect(summary.byRule['empty-description'].errors).toBe(1)
    expect(summary.bySurface.properties.declarations).toBe(2)
    expect(summary.bySurface.properties.flagged).toBe(1)
  })

  test('skipRules and onlyRules filter which rules run', () => {
    const bad = decl({ string: 'short and lowercase' }) // 19 chars, lowercase
    const all = runRules([bad], COMMON_RULES)
    expect(all.findings[0].rules.map((r) => r.id).sort()).toEqual(['starts-lowercase', 'too-short'])

    const skipped = runRules([bad], COMMON_RULES, { skipRules: ['too-short'] })
    expect(skipped.findings[0].rules.map((r) => r.id)).toEqual(['starts-lowercase'])

    const only = runRules([bad], COMMON_RULES, { onlyRules: ['too-short'] })
    expect(only.findings[0].rules.map((r) => r.id)).toEqual(['too-short'])
  })

  test('unverifiable declarations only run opt-in rules and never error', () => {
    const infoRule = {
      name: 'unverifiable-description',
      severity: 'info',
      runOnUnverifiable: true,
      check: (d) => (d.meta.unverifiable ? [{ message: 'cannot verify' }] : [])
    }
    const unverifiable = decl({ string: null, meta: { unverifiable: true } })
    const { findings, summary } = runRules([unverifiable], [...COMMON_RULES, infoRule])

    expect(findings).toHaveLength(1)
    expect(findings[0].rules.map((r) => r.id)).toEqual(['unverifiable-description'])
    expect(summary.errors).toBe(0)
    expect(summary.info).toBe(1)
  })

  test('a crashing rule becomes an error finding instead of aborting the run', () => {
    const crashing = { name: 'boom', severity: 'warning', check: () => { throw new Error('kaboom') } }
    const { findings } = runRules([decl()], [crashing])
    expect(findings[0].rules[0]).toMatchObject({ id: 'boom', severity: 'error' })
    expect(findings[0].rules[0].message).toContain('kaboom')
  })
})
