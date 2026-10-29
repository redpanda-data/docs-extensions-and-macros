'use strict'

jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

// The connect: and blobl: link macros, against the trimmed connect-4.115.1
// data and the real page paths and page-aliases of rp-connect-docs and the
// cloud-docs stubs (__tests__/helpers/connect-links-catalog.js). The anchors
// they link are tested in __tests__/extension-utils/connect-links.test.js
// and through Antora's converter in connect-link-antora.test.js.

const { catalogOf, convert } = require('../helpers/connect-links-catalog')
const connectMacro = require('../../macros/connect')
const bloblMacro = require('../../macros/blobl')

const warnings = () => jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})

// The xref target and inner HTML of the first link, or the plain output.
function linkOf (html) {
  const link = html.match(/<a href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
  if (link) return { target: link[1], inner: link[2] }
  const p = html.match(/<p>([\s\S]*?)<\/p>/)
  return p ? { plain: p[1] } : undefined
}

describe('connect: macro', () => {
  afterEach(() => jest.restoreAllMocks())

  test('links a component page from the connect component, its name as code and its type', () => {
    expect(linkOf(convert('connect:[inputs/kafka_franz]'))).toEqual({
      target: 'connect:components:inputs/kafka_franz.adoc',
      inner: '<code class="connect-component" data-connect-component="inputs/kafka_franz">kafka_franz</code> input',
    })
  })

  test.each([
    ['input/kafka_franz', 'inputs/kafka_franz', 'input'],
    ['rate_limits/local', 'rate_limits/local', 'rate limit'],
    ['rate-limits/redis', 'rate_limits/redis', 'rate limit'],
    ['caches/redis', 'caches/redis', 'cache'],
  ])('%s: the type is written as the paths write it, or singular, or hyphenated', (written, component, words) => {
    const link = linkOf(convert(`connect:[${written}]`))
    expect(link.target).toBe(`connect:components:${component}.adoc`)
    expect(link.inner).toContain(`data-connect-component="${component}"`)
    expect(link.inner).toMatch(new RegExp(`</code> ${words}$`))
  })

  test('a field links its component page, with the field path as code', () => {
    expect(linkOf(convert('connect:[inputs/kafka_franz.sasl.mechanism]'))).toEqual({
      target: 'connect:components:inputs/kafka_franz.adoc',
      inner: '<code class="connect-component" data-connect-component="inputs/kafka_franz" data-connect-field="sasl.mechanism">sasl.mechanism</code>',
    })
  })

  test('from streaming, the link goes to the connect component', () => {
    expect(linkOf(convert('connect:[inputs/kafka_franz]', { component: 'streaming' })).target).toBe('connect:components:inputs/kafka_franz.adoc')
  })

  test('from Cloud, the link goes to the Cloud stub, which aliases the connect path', () => {
    expect(linkOf(convert('connect:[inputs/kafka_franz]', { component: 'cloud-data-platform' })).target).toBe('cloud-data-platform:develop:connect/components/inputs/kafka_franz.adoc')
  })

  test('from Cloud, a component with no stub renders plain code and warns, never a self-managed link', () => {
    const warn = warnings()
    const html = convert('connect:[outputs/amqp_1]', { component: 'cloud-data-platform' })
    expect(linkOf(html)).toEqual({ plain: '<code>amqp_1</code> output' })
    expect(html).not.toContain('<a ')
    expect(warn.mock.calls[0][0]).toContain('cloud-data-platform@unversioned has no page for the output \'amqp_1\' (components:outputs/amqp_1.adoc), and a Cloud page links only Cloud pages')
  })

  test('a deprecated name links the page that declares it as a page alias', () => {
    expect(linkOf(convert('connect:[inputs/pg_stream]')).target).toBe('connect:components:inputs/postgres_cdc.adoc')
  })

  test('the next attribute, or text=, replaces the link text', () => {
    expect(linkOf(convert('connect:[inputs/generate,`generate`]')).inner).toBe('<code>generate</code>')
    expect(linkOf(convert('connect:[inputs/generate,text=the generator]')).inner).toBe('the generator')
  })

  test('xref:connect:components:...[] is still an xref: the macro has no long form to match inside it', () => {
    const html = convert('See xref:connect:components:inputs/kafka_franz.adoc[the input].')
    expect(html).toContain('the input</a>')
    expect(html).not.toContain('connect-component')
  })

  describe('failures', () => {
    test.each([
      ['connect:[kafka_franz]', 'unknown-component', "'kafka_franz' is not <type>/<name>"],
      ['connect:[sources/kafka_franz]', 'unknown-type', "'sources' is not a component type"],
      ['connect:[inputs/kafka_frans]', 'unknown-component', 'Did you mean: kafka_franz'],
      ['connect:[inputs/kafka_franz.consumer_grp]', 'unknown-field', 'Did you mean: consumer_group'],
      ['connect:[config.pipeline.threads]', 'unknown-component', 'the root config fields have no reference page'],
    ])('%s renders plain code, warns, and fails in error mode', (input, kind, text) => {
      const warn = warnings()
      expect(linkOf(convert(input)).plain).toMatch(/^<code>/)
      expect(warn.mock.calls[0][0]).toContain(text)
      expect(connectMacro.THROW_KINDS).toContain(kind)
      expect(() => convert(input, { attributes: { 'connect-validate': 'error' } })).toThrow(text)
    })

    test('no page in the build never fails the build', () => {
      warnings()
      expect(() => convert('connect:[outputs/amqp_1]', { component: 'cloud-data-platform', attributes: { 'connect-validate': 'error' } })).not.toThrow()
    })

    test('no Connect data renders plain code and says so', () => {
      const warn = warnings()
      expect(linkOf(convert('connect:[inputs/kafka_franz]', { catalog: catalogOf({ data: false }) }))).toEqual({ plain: '<code>kafka_franz</code> input' })
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain('this build has no Connect data')
    })

    test('a deprecated field links its page with no anchor, and says the reference does not list it', () => {
      const warn = warnings()
      expect(linkOf(convert('connect:[inputs/kafka_franz.regexp_topics]')).target).toBe('connect:components:inputs/kafka_franz.adoc')
      expect(warn.mock.calls[0][0]).toContain("the Connect reference does not list 'regexp_topics'")
    })

    test('connect-validate=off is silent', () => {
      const warn = warnings()
      convert('connect:[inputs/nope]', { attributes: { 'connect-validate': 'off' } })
      expect(warn).not.toHaveBeenCalled()
    })
  })
})

describe('blobl: macro', () => {
  afterEach(() => jest.restoreAllMocks())

  test.each([
    ['blobl:[now()]', 'connect:guides:bloblang/functions.adoc', '<code class="bloblang-call" data-bloblang-function="now">now()</code>'],
    ['blobl:[.uppercase()]', 'connect:guides:bloblang/methods.adoc', '<code class="bloblang-call" data-bloblang-method="uppercase">.uppercase()</code>'],
    ['blobl:[counter(min)]', 'connect:guides:bloblang/functions.adoc', '<code class="bloblang-call" data-bloblang-function="counter">counter(min)</code>'],
    ['blobl:[.replace_all(old)]', 'connect:guides:bloblang/methods.adoc', '<code class="bloblang-call" data-bloblang-method="replace_all">.replace_all(old)</code>'],
    ['blobl:[now]', 'connect:guides:bloblang/functions.adoc', '<code class="bloblang-call" data-bloblang-function="now">now</code>'],
  ])('%s links its page, the call as written', (input, target, inner) => {
    expect(linkOf(convert(input))).toEqual({ target, inner })
  })

  test('the next attribute replaces the text', () => {
    expect(linkOf(convert('blobl:[.fold(),`fold` method]')).inner).toBe('<code>fold</code> method')
  })

  test('from Cloud, the link goes to the Cloud stub of the page', () => {
    expect(linkOf(convert('blobl:[now()]', { component: 'cloud-data-platform' })).target).toBe('cloud-data-platform:develop:connect/guides/bloblang/functions.adoc')
  })

  test.each(['count', 'env', 'file', 'file_rel', 'hostname'])('from Cloud, the impure function %s() renders plain code: the Cloud page leaves it out', (name) => {
    const warn = warnings()
    expect(linkOf(convert(`blobl:[${name}()]`, { component: 'cloud-data-platform' }))).toEqual({ plain: `<code>${name}()</code>` })
    expect(warn.mock.calls[0][0]).toContain('is impure, and the Cloud Bloblang reference leaves impure functions out')
    expect(linkOf(convert(`blobl:[${name}()]`)).target).toBe('connect:guides:bloblang/functions.adoc')
  })

  describe('failures', () => {
    test.each([
      ['blobl:[bytes]', 'ambiguous-name', "'bytes' is both a function and a method"],
      ['blobl:[uppercase()]', 'unknown-function', "'uppercase' is not a Bloblang function but a method; write .uppercase()"],
      ['blobl:[.now()]', 'unknown-method', "'now' is not a Bloblang method but a function; write now()"],
      ['blobl:[nothing()]', 'hidden', "the function 'nothing' is hidden"],
      ['blobl:[var()]', 'hidden', "the function 'var' is hidden"],
      ['blobl:[counter(start)]', 'unknown-parameter', "'start' is not a parameter of counter()"],
      ['blobl:[.uppercase(x)]', 'unknown-parameter', '.uppercase() has no parameters'],
      ['blobl:[.contains(),category=Parsing]', 'unknown-category', "'contains' is not in the category 'Parsing'"],
      ['blobl:[noww()]', 'unknown-function', 'Did you mean: now'],
    ])('%s renders plain code, warns, and fails in error mode', (input, kind, text) => {
      const warn = warnings()
      expect(linkOf(convert(input)).plain).toMatch(/^<code>/)
      expect(warn.mock.calls[0][0]).toContain(text)
      expect(bloblMacro.THROW_KINDS).toContain(kind)
      expect(() => convert(input, { attributes: { 'connect-validate': 'error' } })).toThrow(text)
    })

    test('an impure function on Cloud never fails the build', () => {
      warnings()
      expect(() => convert('blobl:[env()]', { component: 'cloud-data-platform', attributes: { 'connect-validate': 'error' } })).not.toThrow()
    })
  })
})
