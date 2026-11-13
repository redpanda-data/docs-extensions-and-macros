'use strict'

jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

// bloblval: against the Bloblang lists of the trimmed connect-4.115.1 data
// (__tests__/helpers/connect-links-catalog.js). Each expected value is the
// one the published Bloblang reference prints, from the partials of the
// connect v4.115.1 release asset.

const { DATA, catalogOf, convert } = require('../helpers/connect-links-catalog')
const bloblang = require('../../extension-utils/bloblang-values')
const { THROW_KINDS } = require('../../macros/bloblval')

const warnings = () => jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})
const spans = (html) => [...html.matchAll(/<span class="bloblang-value[^"]*"[^>]*>([\s\S]*?)<\/span>/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
const valueOf = (input, opts) => spans(convert(input, opts))[0]

describe('bloblval macro', () => {
  afterEach(() => jest.restoreAllMocks())

  test('renders a span naming the call and the field', () => {
    expect(convert('bloblval:[counter(min),default]')).toContain('<span class="bloblang-value" data-bloblang="counter(min)" data-field="default">1</span>')
  })

  test.each([
    // bloblang-functions/counter.adoc: "Default: `+1+`."
    ['a parameter default', 'bloblval:[counter(min),default]', '1'],
    ['the default field when none is named', 'bloblval:[counter(min)]', '1'],
    // bloblang-methods/format_timestamp.adoc
    ['a string default, in quotes as the reference prints it', 'bloblval:[.format_timestamp(format),default]', '"2006-01-02T15:04:05.999999999Z07:00"'],
    ['a parameter type', 'bloblval:[.replace_all(old),type]', 'string'],
    ['a query expression type', 'bloblval:[counter(min),type]', 'query expression'],
    ['a parameter description', 'bloblval:[.replace_all(old),description]', 'A string to match against.'],
    ['a parameter with a default is not required', 'bloblval:[counter(min),required]', 'no'],
    ['an optional parameter is not required', 'bloblval:[counter(set),required]', 'no'],
    ['a parameter with neither is required', 'bloblval:[.contains(value),required]', 'yes'],
    ['optional, inverted', 'bloblval:[.contains(value),optional]', 'no'],
    ['status', 'bloblval:[counter(),status]', 'experimental'],
    ['status of a method', 'bloblval:[.uppercase(),status]', 'stable'],
    ['deprecated', 'bloblval:[now(),deprecated]', 'no'],
    ['deprecated raw', 'bloblval:[now(),deprecated,format=raw]', 'false'],
    ['a function category', 'bloblval:[now(),category]', 'Environment'],
    ['the categories of a method in two', 'bloblval:[.contains(),category]', 'Object & Array Manipulation, String Manipulation'],
    ['categories raw', 'bloblval:[.contains(),category,format=raw]', '["Object & Array Manipulation","String Manipulation"]'],
    ['introduced', 'bloblval:[counter(),introduced]', '4.22.0'],
    ['impure', 'bloblval:[env(),impure]', 'yes'],
    ['pure', 'bloblval:[now(),impure]', 'no'],
  ])('%s', (_name, input, expected) => {
    expect(valueOf(input)).toBe(expected)
  })

  test('a method description is its category copy\'s, as the methods page prints it', () => {
    // bloblang-methods/uppercase.adoc
    expect(valueOf('bloblval:[.uppercase(),description]')).toBe('Converts all letters in a string to uppercase. Use for case-insensitive comparisons or formatting output.')
  })

  test('a method in two categories reads the first copy on the page, or the one category= names', () => {
    // bloblang-methods/contains-object_array_manipulation.adoc and contains-string_manipulation.adoc
    expect(valueOf('bloblval:[.contains(),description]')).toMatch(/^Checks whether an array contains an element matching the argument/)
    expect(valueOf('bloblval:[.contains(),description,category=String Manipulation]')).toBe('Checks whether a string contains a substring and returns a boolean result.')
    expect(valueOf('bloblval:[.contains(),description,category=string_manipulation]')).toBe('Checks whether a string contains a substring and returns a boolean result.')
    // length lists String Manipulation first in the data; the page shows Object & Array first.
    expect(valueOf('bloblval:[.length(),description]')).toBe(DATA['bloblang-methods'].find((m) => m.name === 'length').categories.find((c) => c.Category === 'Object & Array Manipulation').Description)
  })

  describe('corrupt defaults render unverifiable, warn, and never fail the build', () => {
    test.each([
      ['counter(max)', '9223372036854776000', 'an integer larger than JavaScript represents exactly'],
      ['random_int(max)', '9223372036854776000', 'an integer larger than JavaScript represents exactly'],
      ['random_int(seed)', '{"Value":0}', 'an object the Bloblang reference does not print'],
    ])('%s', (call, data, why) => {
      const warn = warnings()
      expect(valueOf(`bloblval:[${call},default]`)).toBe('<unknown default>')
      expect(warn.mock.calls[0][0]).toContain(`is ${data} in connect-4.115.1.json`)
      expect(warn.mock.calls[0][0]).toContain(why)
      expect(() => convert(`bloblval:[${call},default]`, { attributes: { 'connect-validate': 'error' } })).not.toThrow()
    })
  })

  describe('text', () => {
    test('examples have no inline form: needs-block names the block form', () => {
      const warn = warnings()
      expect(valueOf('bloblval:[counter(),examples]')).toBe('<unknown examples>')
      expect(warn.mock.calls[0][0]).toContain('Use the block form on a line of its own: bloblval::[counter(),examples]')
      expect(THROW_KINDS).toContain('needs-block')
    })

    test('the block form renders the examples as the reference does: the summary, then a bloblang listing', () => {
      const html = convert('bloblval::[counter(),examples]')
      expect(html).toContain('<div class="openblock bloblang-value bloblang-value-examples">')
      expect(html).toContain('Generate sequential IDs for each message:')
      expect(html).toContain('<pre class="highlight"><code class="language-bloblang" data-lang="bloblang">root.id = counter()\n\n# In:  {}\n# Out: {"id":1}')
    })

    test('a summary with no closing period still leads in with a colon, as bloblang-functions/fake.adoc prints it', () => {
      expect(convert('bloblval::[fake(),examples]')).toContain('<p>Generate fake user profile data for testing:</p>')
    })

    test('a mapping that starts with a newline opens its listing on the mapping, as bloblang-methods/abs.adoc prints it', () => {
      const abs = DATA['bloblang-methods'].find((e) => e.name === 'abs')
      expect(abs.examples[0].mapping.startsWith('\n')).toBe(true)
      expect(bloblang.entryValue('method', abs, 'examples').text).toContain('[,bloblang]\n----\nroot.outs = this.ins.map_each(ele -> ele.abs())\n\n# In:  {"ins":[9,-18,1.23,-4.56]}')
    })

    test('a Markdown heading in a summary is a heading, as bloblang-methods/explode.adoc prints it', () => {
      const html = convert('bloblval::[.explode(),examples]')
      expect(html).toMatch(/<h3 id="[^"]*" class="discrete">On arrays<\/h3>/)
      expect(html).not.toContain('#####')
    })

    test('a method\'s examples are its category copy\'s', () => {
      const html = convert('bloblval::[.contains(),examples,category=String Manipulation]')
      expect(html).toContain('# In:  {"thing":"this foo that"}')
      expect(html).not.toContain('contains(20)')
    })

    test('bloblval:: in a sentence is block-form-inline', () => {
      const warn = warnings()
      expect(valueOf('Its examples: bloblval::[counter(),examples].')).toBe('<unknown examples>')
      expect(warn.mock.calls[0][0]).toContain('bloblval:: is the block form, which renders only on a line of its own')
    })

    test('off the methods page, a description\'s <<round>> links the methods page anchor', () => {
      // bloblang-methods int64: "... use <<round, `.round()`>> first."
      const streaming = convert('bloblval::[.int64(),description]', { component: 'streaming', module: 'manage' })
      expect(streaming).toContain('href="connect:guides:bloblang/methods.html#round"')
      expect(streaming).not.toContain('href="#round"')
      expect(convert('bloblval::[.int64(),description]', { relative: 'bloblang/functions.adoc' })).toContain('href="guides:bloblang/methods.html#round"')
    })

    test('on the methods page, <<round>> is left as written', () => {
      expect(convert('bloblval::[.int64(),description]', { relative: 'bloblang/methods.adoc' })).toContain('href="#round"')
    })

    test('a connect-relative xref is qualified with connect: on another component\'s page', () => {
      const html = convert('bloblval:[.get(),description]', { component: 'streaming', module: 'manage' })
      expect(html).toContain('href="connect:configuration:field_paths.html"')
    })

    test('a short value in the block form is a paragraph', () => {
      expect(convert('bloblval::[counter(),status]')).toContain('<div class="paragraph">\n<p><span class="bloblang-value" data-bloblang="counter()" data-field="status">experimental</span></p>')
    })
  })

  describe('Cloud', () => {
    const onCloud = (input) => convert(input, { component: 'cloud-data-platform' })

    test('an impure function is unavailable: the Cloud reference leaves it out', () => {
      const warn = warnings()
      expect(spans(onCloud('bloblval:[env(name),type]'))[0]).toBe('<unknown type>')
      expect(warn.mock.calls[0][0]).toContain('the function env() is impure, and the Cloud Bloblang reference leaves impure functions out')
    })

    test('introduced is cloud-hidden', () => {
      const warn = warnings()
      expect(spans(onCloud('bloblval:[counter(),introduced]'))[0]).toBe('<unknown introduced>')
      expect(warn.mock.calls[0][0]).toContain('Put the sentence in an ifndef::env-cloud[] block')
    })

    test('everything else renders', () => {
      expect(spans(onCloud('bloblval:[counter(min),default]'))[0]).toBe('1')
    })
  })

  describe('failures', () => {
    test.each([
      ['bloblval:[counter(min),colour]', 'unsupported-field', "'colour' is not a field bloblval: supports. Supported fields: default, type, description, required, examples, introduced, deprecated, status, category, impure."],
      ['bloblval:[counter(),default]', 'unsupported-field', 'default is not a field of a function. Name a parameter in the parentheses'],
      ['bloblval:[counter(min),status]', 'unsupported-field', 'status is not a field of a parameter. Name the function alone, as in bloblval:[counter(),status]'],
      ['bloblval:[counter(start),default]', 'unknown-parameter', "'start' is not a parameter of counter()"],
      ['bloblval:[.concat(x),type]', 'unknown-method', "'concat' is not a Bloblang method"],
      ['bloblval:[bytes,status]', 'ambiguous-name', "'bytes' is both a function and a method"],
      ['bloblval:[var(),status]', 'hidden', "the function 'var' is hidden"],
      ['bloblval:[now(),introduced]', 'missing-field', 'now() has no introduced version recorded'],
      ['bloblval:[.contains(),description,category=Parsing]', 'unknown-category', "'contains' is not in the category 'Parsing'"],
    ])('%s', (input, kind, text) => {
      const warn = warnings()
      expect(valueOf(input)).toMatch(/^<unknown /)
      expect(warn.mock.calls[0][0]).toContain(text)
      expect(THROW_KINDS).toContain(kind)
      expect(() => convert(input, { attributes: { 'connect-validate': 'error' } })).toThrow(text)
    })

    test('no Connect data renders a placeholder', () => {
      const warn = warnings()
      expect(valueOf('bloblval:[counter(min),default]', { catalog: catalogOf({ data: false }) })).toBe('<unknown default>')
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain('this page has no Connect data')
    })
  })
})

describe('bloblang-values', () => {
  test.each([
    ['now()', { kind: 'function', name: 'now', param: undefined, parens: true }],
    ['.uppercase()', { kind: 'method', name: 'uppercase', param: undefined, parens: true }],
    ['counter(min)', { kind: 'function', name: 'counter', param: 'min', parens: true }],
    ['.replace_all( old )', { kind: 'method', name: 'replace_all', param: 'old', parens: true }],
    ['now', { kind: undefined, name: 'now', parens: false }],
    ['.fold', { kind: 'method', name: 'fold', parens: false }],
  ])('parseCall(%s)', (text, expected) => {
    expect(bloblang.parseCall(text)).toMatchObject({ ok: true, ...expected })
  })

  test.each(['now(a, b)', 'root.foo', 'x = now()', ''])('parseCall(%s) is not a call', (text) => {
    expect(bloblang.parseCall(text).ok).toBe(false)
  })

  test('the data has the five impure functions the Cloud page leaves out, and no others', () => {
    expect(DATA['bloblang-functions'].filter((e) => bloblang.cloudHiddenEntry('function', e)).map((e) => e.name).sort()).toEqual(['count', 'env', 'file', 'file_rel', 'hostname'])
  })
})
