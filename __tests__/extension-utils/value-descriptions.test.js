'use strict'

const fs = require('fs')
const path = require('path')
const {
  isSingleParagraph,
  markdownToAsciidoc,
  markdownInline,
  plainSegments,
  discreteHeadings,
} = require('../../extension-utils/value-descriptions')

// Real strings from the trimmed fixtures (see _source in each file).
const FIXTURES = path.join(__dirname, '..', 'fixtures')
const PROPS = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'propval', 'redpanda-properties-v26.2.4-sample.json'), 'utf8')).properties
const CONNECT = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'connectval', 'connect-4.114.0-sample.json'), 'utf8'))
const RPK = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'rpkval', 'rpk-v26.2.2-sample.json'), 'utf8'))
const field = (type, name, fieldName) => CONNECT[type].find((c) => c.name === name).config.children.find((f) => f.name === fieldName)
const command = (...names) => names.reduce((node, name) => node.commands.find((c) => c.name === name), RPK.tree)

describe('isSingleParagraph', () => {
  test.each([
    ['a one-paragraph property description', PROPS.log_segment_ms.description, true],
    ['a property description with a list', PROPS['cleanup.policy'].description, false],
    ['a one-line property example', PROPS.enable_transactions.example, true],
    ['a Connect summary', field('inputs', 'kafka_franz', 'consumer_group').short_description, true],
    ['a Connect description with a list', field('inputs', 'kafka_franz', 'consumer_group').description, false],
    ['a Connect description with two paragraphs', field('inputs', 'postgres_cdc', 'unchanged_toast_value').description, false],
  ])('%s', (_name, text, expected) => {
    expect(isSingleParagraph(text, 'asciidoc')).toBe(expected)
  })

  test.each([
    ['NOTE: an admonition'],
    ['ifndef::env-cloud[]\nself-managed only\nendif::[]'],
    ['[source,yaml]\n----\na: 1\n----'],
    ['== A heading'],
    ['term:: definition'],
    ['* a list item'],
    ['  an indented literal line'],
  ])('AsciiDoc block syntax is not a paragraph: %j', (text) => {
    expect(isSingleParagraph(text, 'asciidoc')).toBe(false)
  })

  test('a wrapped paragraph with an xref is one paragraph', () => {
    expect(isSingleParagraph('Set this to use the\nxref:components:inputs/broker.adoc[`broker` input].', 'asciidoc')).toBe(true)
  })

  test('rpk help text: a flag description is one paragraph, examples are not', () => {
    const create = command('topic', 'create')
    expect(isSingleParagraph(create.flags.find((f) => f.name === 'partitions').description, 'plain')).toBe(true)
    expect(isSingleParagraph(create.description, 'plain')).toBe(false)
    expect(isSingleParagraph(command('security', 'acl', 'list').examples, 'plain')).toBe(false)
  })

  test.each([
    ['one paragraph with `code` and a [link](https://docs.redpanda.com)', true],
    ['- a list item', false],
    ['## A heading', false],
    ['```yaml\na: 1\n```', false],
    ['| a | b |\n|---|---|', false],
    ['first\n\nsecond', false],
  ])('Markdown: %j', (text, expected) => {
    expect(isSingleParagraph(text, 'markdown')).toBe(expected)
  })
})

describe('markdownToAsciidoc', () => {
  test('inline markup', () => {
    expect(markdownInline('Use **bold**, *emphasis*, _emphasis_, `code_with_underscores`, and [the docs](https://docs.redpanda.com/x).'))
      .toBe('Use *bold*, _emphasis_, _emphasis_, `+code_with_underscores+`, and https://docs.redpanda.com/x[the docs].')
  })

  test('braces are escaped outside code, so they are not attribute references', () => {
    expect(markdownInline('Paths like /inputs/{id} and `/inputs/{id}`')).toBe('Paths like /inputs/\\{id} and `+/inputs/{id}+`')
  })

  test('lists, fences, headings and tables', () => {
    const markdown = [
      'An optional consumer group. When you specify this value:',
      '- The partitions are distributed.',
      '  - Nested.',
      '1. First.',
      '',
      '## Examples',
      '```yaml',
      'topics: [ foo ]',
      '```',
      '| Option | Summary |',
      '|---|---|',
      '| `a` | Uses a \\| pipe. |',
    ].join('\n')
    expect(markdownToAsciidoc(markdown)).toBe([
      'An optional consumer group. When you specify this value:',
      '',
      '* The partitions are distributed.',
      '** Nested.',
      '. First.',
      '',
      '[discrete]',
      '=== Examples',
      '',
      '[source,yaml]',
      '----',
      'topics: [ foo ]',
      '----',
      '',
      '[%header]',
      '|===',
      '| Option | Summary',
      '',
      '| `+a+` | Uses a \\| pipe.',
      '|===',
    ].join('\n'))
  })
})

describe('plainSegments', () => {
  test('cobra examples: prose paragraphs and dedented command runs', () => {
    const segments = plainSegments(command('security', 'acl', 'list').examples)
    expect(segments[0]).toEqual({ kind: 'paragraph', lines: ['List all ACLs:'] })
    expect(segments[1]).toEqual({ kind: 'literal', lines: ['rpk security acl list'] })
    expect(segments.every((s) => s.kind === 'literal' || !/^\s/.test(s.lines[0]))).toBe(true)
  })

  test('a blank line inside an indented run stays in one literal block', () => {
    expect(plainSegments('Run:\n\n  a\n\n  b\n\nDone.')).toEqual([
      { kind: 'paragraph', lines: ['Run:'] },
      { kind: 'literal', lines: ['a', '', 'b'] },
      { kind: 'paragraph', lines: ['Done.'] },
    ])
  })

  test('a ---- listing is a literal block, without its delimiters and [,bash] line', () => {
    // docs 83f6be4d docs-data/rpk-v26.2.2.json, rpk connect echo
    const text = "Parse a config file and echo back a normalized version.\n\nExamples:\n\n[,bash]\n----\nrpk connect echo ./config.yaml | less\nrpk connect echo --set 'input.generate.mapping=root.id = uuid_v4()'\n----"
    expect(plainSegments(text)).toEqual([
      { kind: 'paragraph', lines: ['Parse a config file and echo back a normalized version.'] },
      { kind: 'paragraph', lines: ['Examples:'] },
      { kind: 'literal', lines: ['rpk connect echo ./config.yaml | less', "rpk connect echo --set 'input.generate.mapping=root.id = uuid_v4()'"] },
    ])
  })

  test('a ---- line with no closing one is text', () => {
    expect(plainSegments('Before\n----\nafter')).toEqual([{ kind: 'paragraph', lines: ['Before', '----', 'after'] }])
  })
})

describe('discreteHeadings', () => {
  test('headings outside listings become discrete, with a blank line before', () => {
    expect(discreteHeadings('Intro.\n== Metadata\n\n----\n== not a heading\n----')).toBe('Intro.\n\n[discrete]\n== Metadata\n\n----\n== not a heading\n----')
  })
})
