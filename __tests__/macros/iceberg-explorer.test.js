'use strict'

// The macro logs through @antora/logger rather than console.warn (see
// macros/iceberg-explorer.js), so tests spy on this stable, mocked logger
// instead of console.
jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  // Antora's AsciiDoc loader, which converts property descriptions, adapts the
  // logger through unwrap().
  logger.unwrap = () => logger
  logger.level = 'info'
  logger.setFailOnExit = () => {}
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

const asciidoctor = require('@asciidoctor/core')()
const macro = require('../../macros/iceberg-explorer.js')

function convert (input, attributes = {}) {
  const registry = asciidoctor.Extensions.create()
  macro.register(registry, {})
  return asciidoctor.convert(input, {
    extension_registry: registry,
    attributes,
  })
}

describe('iceberg-explorer macro', () => {
  describe('registration', () => {
    test('exports a register function', () => {
      expect(typeof macro.register).toBe('function')
    })

    test('registers a block without errors given a valid registry', () => {
      const mockRegistry = {
        block: jest.fn(() => {}),
        register: jest.fn(callback => callback.call(mockRegistry)),
      }
      expect(() => macro.register(mockRegistry, {})).not.toThrow()
      expect(mockRegistry.block).toHaveBeenCalled()
    })

    test('supports the this-based calling convention (registry as this)', () => {
      // docs-ui preview calls register.call(Extensions) with no arguments.
      const mockRegistry = { block: jest.fn(() => {}) }
      expect(() => macro.register.call(mockRegistry)).not.toThrow()
      expect(mockRegistry.block).toHaveBeenCalled()
    })

    // The two branches in register() exist because the Extensions module and a
    // registry expose different APIs. Pin that shape against the real library
    // so the assumption cannot drift with an @asciidoctor/core upgrade.
    test('the real Extensions module exposes register() but not block()', () => {
      expect(typeof asciidoctor.Extensions.block).toBe('undefined')
      expect(typeof asciidoctor.Extensions.register).toBe('function')
    })

    test('registers through an Extensions-like module that has only register()', () => {
      // Shape of Asciidoctor.Extensions: no .block(), and the callback passed
      // to .register() runs with a real registry as `this`. Without the
      // register() branch this target is unusable and the call throws.
      const innerRegistry = { block: jest.fn(() => {}) }
      const extensionsModule = {
        register: jest.fn(function (callback) { callback.call(innerRegistry) }),
      }
      expect(() => macro.register.call(extensionsModule)).not.toThrow()
      expect(extensionsModule.register).toHaveBeenCalled()
      expect(innerRegistry.block).toHaveBeenCalled()
    })

    test('throws a named error when the target is neither a registry nor Extensions', () => {
      expect(() => macro.register({}, {})).toThrow(/iceberg-explorer/)
    })
  })

  describe('mount contract', () => {
    // Asciidoctor turns an unrecognized block style into a CSS class, so a site
    // whose playbook forgot this macro still renders a div named after the
    // block. If docs-ui hydrated on that class name, the accident would look
    // like a working explorer full of built-in sample data while the author's
    // JSON body was silently discarded. The mount contract therefore has to be
    // something only this macro can emit.
    test('an unregistered [iceberg-explorer] block cannot pass for a mount point', () => {
      const source = '[iceberg-explorer]\n--\n--'
      // No extension registry: this is what a consumer repo that added the
      // block but forgot the playbook entry actually publishes.
      const accidental = asciidoctor.convert(source)
      expect(accidental).toContain('class="openblock iceberg-explorer"')
      expect(accidental).not.toContain(macro.MOUNT_ATTRIBUTE)
      expect(accidental).not.toContain(macro.MOUNT_CLASS)

      const mounted = convert(source)
      expect(mounted).toContain(`${macro.MOUNT_ATTRIBUTE}="${macro.MOUNT_CONTRACT_VERSION}"`)
      expect(mounted).toContain(`class="${macro.MOUNT_CLASS}"`)
    })

    // Contract 2: docs-ui refuses a mount whose version it does not know, and
    // picks the property spec from data-property.
    test('emits contract 2 with the property it configures', () => {
      expect(macro.MOUNT_CONTRACT_VERSION).toBe('2')
      expect(macro.MOUNT_PROPERTY).toBe('redpanda.iceberg.mode')
      const html = convert('[iceberg-explorer]\n--\n--', { 'page-version': '26.2' })
      expect(html).toMatch(
        /<div class="iceberg-explorer-mount" data-iceberg-explorer="2" data-property="redpanda\.iceberg\.mode" data-version="26\.2">/
      )
    })

    // docs-ui never read data-defaults, so contract 2 does not emit it.
    test.each([
      ['an empty block', '--\n--'],
      ['a JSON body', '----\n{"config":"value:mode=schema_latest","schema":{}}\n----'],
    ])('never emits data-defaults for %s', (_label, body) => {
      expect(convert(`[iceberg-explorer]\n${body}`)).not.toContain('data-defaults')
    })

    test('the mount selector keys on an attribute, not on a class name', () => {
      expect(macro.MOUNT_SELECTOR).toBe(`[${macro.MOUNT_ATTRIBUTE}]`)
      expect(macro.MOUNT_ATTRIBUTE.startsWith('data-')).toBe(true)
    })
  })

  describe('rendering', () => {
    test('emits a hydration mount point for an empty open block', () => {
      const html = convert('[iceberg-explorer]\n--\n--')
      expect(html).toContain(`class="${macro.MOUNT_CLASS}"`)
      expect(html).toContain(`${macro.MOUNT_ATTRIBUTE}="2"`)
    })

    // The failure readers actually hit is JS running fine with the docs-ui
    // explorer module missing, which suppresses <noscript> and leaves a
    // zero-height void. The fallback has to be plain, visible markup.
    test('renders a visible fallback that does not depend on JavaScript', () => {
      const html = convert('[iceberg-explorer]\n--\n--')
      expect(html).not.toContain('<noscript>')
      expect(html).toContain('class="iceberg-explorer-fallback"')
      expect(html).toMatch(/docs-ui build that includes the explorer module/)
    })

    test('stamps the doc version onto the mount point', () => {
      const html = convert('[iceberg-explorer]\n--\n--', { 'page-version': '26.2' })
      expect(html).toContain('data-version="26.2"')
    })

    test('falls back to the component version attribute', () => {
      const html = convert('[iceberg-explorer]\n--\n--', { 'page-component-version': '25.3' })
      expect(html).toContain('data-version="25.3"')
    })

    test('omits data-version when no version attribute is set', () => {
      const html = convert('[iceberg-explorer]\n--\n--')
      expect(html).not.toContain('data-version=')
    })

    test('passes an initial config from a named attribute', () => {
      const html = convert('[iceberg-explorer,config="key:mode=binary;value:mode=binary"]\n--\n--')
      expect(html).toContain('data-config="key:mode=binary;value:mode=binary"')
    })

    test('passes the config from a JSON block body', () => {
      const body = JSON.stringify({ config: 'value:mode=schema_latest' })
      const html = convert(`[iceberg-explorer]\n----\n${body}\n----`)
      expect(html).toContain('data-config="value:mode=schema_latest"')
    })

    test('the config attribute wins over the block body', () => {
      const body = JSON.stringify({ config: 'value_schema_id_prefix' })
      const html = convert(`[iceberg-explorer,config=key_value]\n----\n${body}\n----`)
      expect(html).toContain('data-config="key_value"')
    })

    // Every string below is author-controlled and lands inside a double-quoted
    // HTML attribute, so each interpolation point needs its own assertion. The
    // JSON-body path was the only one covered.
    test('escapes a config attribute that tries to break out of the attribute', () => {
      const html = convert('[iceberg-explorer,config="a\\" onmouseover=\\"x"]\n--\n--')
      expect(html).toContain('data-config="a&quot; onmouseover=&quot;x"')
      expect(html).not.toContain('onmouseover="')
    })

    test('escapes a page version that tries to break out of the attribute', () => {
      const html = convert('[iceberg-explorer]\n--\n--', { 'page-version': '1" onload="x' })
      expect(html).toContain('data-version="1&quot; onload=&quot;x"')
      expect(html).not.toContain('onload="')
    })

    test('ignores an invalid JSON body but still renders the mount point', () => {
      const warn = jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})
      const html = convert('[iceberg-explorer]\n----\nnot json\n----')
      expect(html).toContain(`class="${macro.MOUNT_CLASS}"`)
      expect(html).not.toContain('data-config=')
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })

    test('emits data-engine-base when the author pins an engine location', () => {
      const html = convert('[iceberg-explorer,engine-base="/_/engine/26.2"]\n--\n--')
      expect(html).toContain('data-engine-base="/_/engine/26.2"')
    })
  })

  describe('input validation', () => {
    let warn

    beforeEach(() => {
      warn = jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warn.mockRestore()
    })

    const messages = () => warn.mock.calls.map((call) => call.join(' ')).join('\n')

    // JSON.parse accepts scalars and arrays, and docs-ui reads .config off the
    // parsed value, so anything that is not an object is as unusable as a
    // syntax error.
    test.each([
      ['a number', '123'],
      ['a string', '"hello"'],
      ['an array', '[1,2,3]'],
    ])('rejects a JSON body that is %s', (_label, body) => {
      const html = convert(`[iceberg-explorer]\n----\n${body}\n----`)
      expect(html).toContain(macro.MOUNT_ATTRIBUTE)
      expect(html).not.toContain('data-config=')
      expect(messages()).toMatch(/must be a JSON object/)
    })

    test('warns about block body keys other than config', () => {
      const html = convert('[iceberg-explorer]\n----\n{"config":"key_value","schema":{},"record":1}\n----')
      expect(html).toContain('data-config="key_value"')
      expect(messages()).toMatch(/"schema", "record" are not supported and are ignored/)
    })

    test('warns about a block body config that is not a string', () => {
      const html = convert('[iceberg-explorer]\n----\n{"config":42}\n----')
      expect(html).not.toContain('data-config=')
      expect(messages()).toMatch(/"config" must be a string, not a number/)
    })

    test('names the page in build warnings so they can be traced', () => {
      convert('[iceberg-explorer]\n----\nnot json\n----', {
        'page-relative-src-path': 'ROOT/pages/iceberg-mode.adoc',
      })
      expect(messages()).toContain('ROOT/pages/iceberg-mode.adoc')
    })

    test('adds px to a bare numeric height', () => {
      const html = convert('[iceberg-explorer,height=400]\n--\n--')
      expect(html).toContain('style="min-height:400px"')
      expect(warn).not.toHaveBeenCalled()
    })

    test.each(['400px', '30rem', '60vh', '50%'])('accepts the CSS length %s', (height) => {
      const html = convert(`[iceberg-explorer,height=${height}]\n--\n--`)
      expect(html).toContain(`style="min-height:${height}"`)
      expect(warn).not.toHaveBeenCalled()
    })

    // The value lands inside a style attribute, so a declaration list would
    // otherwise let a doc page paint a full-viewport overlay.
    test('rejects a height that smuggles extra CSS declarations', () => {
      const html = convert(
        '[iceberg-explorer,height="1px;position:fixed;inset:0;z-index:9999;background:red"]\n--\n--'
      )
      expect(html).not.toContain('position:fixed')
      expect(html).not.toContain('style=')
      expect(messages()).toMatch(/is not a CSS length/)
    })

    // docs-ui loads <engine-base>/iceberg-engine-<version>.js as a script, so
    // anything but a same-origin path would run another origin's JavaScript.
    test.each([
      ['an absolute URL', 'https://attacker.example'],
      ['a protocol-relative URL', '//attacker.example/engine'],
      ['a backslash path', '/\\attacker.example'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a relative path', 'engine/26.2'],
      ['an encoded newline', '/_/engine%0a/26.2'],
      ['an encoded backslash', '/%5cattacker.example'],
      ['a raw tab', '/_/en\tgine'],
    ])('rejects an engine-base that is %s', (_label, base) => {
      const html = convert(`[iceberg-explorer,engine-base="${base}"]\n--\n--`, {
        'page-relative-src-path': 'ROOT/pages/iceberg-mode.adoc',
      })
      expect(html).toContain(macro.MOUNT_ATTRIBUTE)
      expect(html).not.toContain('data-engine-base=')
      expect(messages()).toMatch(/is not a root-relative path/)
      expect(messages()).toContain('ROOT/pages/iceberg-mode.adoc')
    })

    test.each(['/_/engine/26.2', '/assets/iceberg/v1'])('accepts the root-relative engine-base %s', (base) => {
      const html = convert(`[iceberg-explorer,engine-base="${base}"]\n--\n--`)
      expect(html).toContain(`data-engine-base="${base}"`)
      expect(warn).not.toHaveBeenCalled()
    })
  })

  describe('config validation', () => {
    let warn
    const vectors = require('../fixtures/iceberg-mode/upstream-vectors')
    const page = { 'page-relative-src-path': 'ROOT/pages/iceberg-mode.adoc' }

    beforeEach(() => {
      warn = jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warn.mockRestore()
    })

    const messages = () => warn.mock.calls.map((call) => call.join(' ')).join('\n')
    const block = (config) => `[iceberg-explorer,config="${config}"]\n--\n--`

    // The cases the review found the explorer silently replaced with defaults.
    test.each([
      ['value:mode=schema_lastest', "unknown mode 'schema_lastest' in section 'value'"],
      ['value:mode=banana', "unknown mode 'banana' in section 'value'"],
      ['key:layout=nested', "layout is only valid in the value section, not 'key'"],
      ['key_value:subject=x', "unknown section 'key_value'"],
      ['value:mode=binary;value:mode=string', "duplicate section 'value'"],
      ['value_schema_latest:layout=nested', "unknown option 'layout' in value_schema_latest"],
    ])('warns on %s, names the page and the problem, and keeps the value', (config, problem) => {
      const html = convert(block(config), { ...page, 'page-version': '26.2' })
      expect(html).toContain(`data-config="${config}"`)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(messages()).toContain('ROOT/pages/iceberg-mode.adoc')
      expect(messages()).toContain(`config="${config}" is not a valid redpanda.iceberg.mode value for version 26.2`)
      expect(messages()).toContain(problem)
    })

    test('adds the specific reason when upstream reports malformed options', () => {
      convert(block('value:mode=binary,mode=string'), page)
      expect(messages()).toContain("malformed options in section 'value' (duplicate option 'mode')")
    })

    test('validates a config from the JSON block body', () => {
      const html = convert('[iceberg-explorer]\n----\n{"config":"headers:value_type=blob"}\n----', page)
      expect(html).toContain('data-config="headers:value_type=blob"')
      expect(messages()).toContain("unknown value_type 'blob' in section 'headers'")
    })

    test('disabled is a valid value', () => {
      convert(block('disabled'), page)
      expect(warn).not.toHaveBeenCalled()
    })

    test.each(vectors.accept.map((v) => v.input))('accepts the upstream vector %s', (config) => {
      convert(block(config), { 'page-version': '26.2' })
      expect(warn).not.toHaveBeenCalled()
    })

    test.each(vectors.reject.map((v) => v.input))('warns on the upstream vector %s', (config) => {
      convert(block(config), { 'page-version': '26.2' })
      expect(warn).toHaveBeenCalledTimes(1)
    })

    describe('version gating', () => {
      test('a 26.1 page warns on the section format, which needs v26.2.1', () => {
        const html = convert(block('key:mode=schema_id_prefix;value:mode=binary'), { ...page, 'page-version': '26.1' })
        expect(html).toContain('data-version="26.1"')
        expect(html).toContain('data-config="key:mode=schema_id_prefix;value:mode=binary"')
        expect(messages()).toContain('for version 26.1')
        expect(messages()).toMatch(/requires Redpanda v26\.2\.1 or later/)
      })

      test.each(['26.2', '26.3'])('a %s page accepts the same section-format value', (version) => {
        convert(block('key:mode=schema_id_prefix;value:mode=binary'), { 'page-version': version })
        expect(warn).not.toHaveBeenCalled()
      })

      test.each(['key_value', 'value_schema_id_prefix', 'value_schema_latest:subject=s', 'disabled'])(
        'a 25.3 page accepts the legacy value %s', (config) => {
          convert(block(config), { 'page-version': '25.3' })
          expect(warn).not.toHaveBeenCalled()
        }
      )

      test('an unversioned page uses the latest grammar', () => {
        convert(block('value:mode=string,layout=flat'))
        expect(warn).not.toHaveBeenCalled()
      })

      // From the generated release data: 24.3's parser has no value_schema_latest.
      test('a 24.3 page warns on value_schema_latest, which needs v25.1.1', () => {
        convert(block('value_schema_latest'), { 'page-version': '24.3' })
        expect(messages()).toMatch(/value_schema_latest requires Redpanda v25\.1\.1 or later/)
      })

      test('a version with no release data warns that the value was not checked', () => {
        const html = convert(block('key_value'), { 'page-version': '99.1' })
        expect(html).toContain('data-config="key_value"')
        expect(messages()).toMatch(/config="key_value" was not checked: .*no Redpanda release for version 99\.1/)
      })
    })
  })

  describe('property metadata', () => {
    let warn

    beforeEach(() => {
      warn = jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warn.mockRestore()
    })

    const messages = () => warn.mock.calls.map((call) => call.join(' ')).join('\n')

    const entry = (overrides = {}) => ({
      name: 'redpanda.iceberg.mode',
      type: 'string',
      config_scope: 'topic',
      description: 'Enable Iceberg. Set `key_value` or see xref:manage:iceberg/about.adoc[About Iceberg] -- or not.',
      default: null,
      is_enterprise: false,
      see_also: ['xref:manage:iceberg/specify-iceberg-schema.adoc#modes[Specify Iceberg Schema]'],
      ...overrides,
    })

    const attachment = (component, version, tag, properties) => ({
      src: { component, version, module: 'reference', family: 'attachment', relative: `redpanda-properties-${tag}.json` },
      contents: Buffer.from(JSON.stringify({ properties })),
    })

    // A catalog with real-enough resolution: Antora's own loader converts the
    // description and see_also xrefs, so a resolver that resolves nothing would
    // let a broken href pass.
    function catalog (attachments, { cloud = false, pages = ['manage:iceberg/specify-iceberg-schema', 'manage:iceberg/about'] } = {}) {
      const files = [...attachments]
      return {
        findBy: (query) => files.filter((f) => Object.entries(query).every(([k, v]) => f.src[k] === v)),
        getComponent: (name) => {
          const versions = [{ version: name === 'cloud' ? '' : '26.2', displayVersion: '26.2', asciidoc: { attributes: cloud && name === 'cloud' ? { 'env-cloud': '' } : {} } }]
          return { name, title: name, versions, latest: versions[0] }
        },
        getComponentVersion: () => undefined,
        // Pages exist only in streaming, so a Cloud page's unqualified xref
        // misses and the qualified retry is what resolves.
        resolveResource: (spec, context = {}) => {
          const match = /^(?:([\w.]+)@)?(?:([\w-]+):)?([\w-]+):(.+?)(?:\.adoc)?$/.exec(String(spec).split('#')[0])
          if (!match || !pages.includes(`${match[3]}:${match[4]}`)) return undefined
          if ((match[2] || context.component) !== 'streaming') return undefined
          return { pub: { url: `/streaming/26.2/${match[3]}/${match[4]}/` } }
        },
        getById: () => undefined,
      }
    }

    const pageFile = (component, version) => ({
      src: { component, version, module: 'ROOT', family: 'page', relative: 'iceberg.adoc', path: 'modules/ROOT/pages/iceberg.adoc' },
      pub: { url: `/${component}/${version}/iceberg/`, moduleRootPath: '.', rootPath: '../..' },
    })

    function convertWith (contentCatalog, file, input = '[iceberg-explorer]\n--\n--') {
      const registry = asciidoctor.Extensions.create()
      macro.register(registry, { file, contentCatalog, config: {} })
      return asciidoctor.convert(input, {
        extension_registry: registry,
        attributes: { 'page-relative-src-path': 'ROOT/pages/iceberg.adoc', 'page-version': file.src.version },
      })
    }

    const metaOf = (html) => {
      const m = /data-property-meta="([^"]*)"/.exec(html)
      if (!m) return undefined
      return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
    }

    test('emits the contract fields from the newest patch of the page\'s series', () => {
      const html = convertWith(catalog([
        attachment('streaming', '26.2', 'v26.2.1', { 'redpanda.iceberg.mode': entry({ description: 'Old text.' }) }),
        attachment('streaming', '26.2', 'v26.2.4', { 'redpanda.iceberg.mode': entry() }),
        attachment('streaming', '26.2', 'v26.1.14', { 'redpanda.iceberg.mode': entry({ description: 'Other series.' }) }),
      ]), pageFile('streaming', '26.2'))
      expect(metaOf(html)).toEqual({
        // Converted by Asciidoctor, then reduced to text: no backticks, the
        // xref is its label, and -- is the typographic dash it renders as.
        description: 'Enable Iceberg. Set key_value or see About Iceberg \u2014 or not.',
        default: null,
        is_enterprise: false,
        see_also: [{ href: '/streaming/26.2/manage/iceberg/specify-iceberg-schema/#modes', text: 'Specify Iceberg Schema' }],
        source: 'redpanda-properties-v26.2.4.json',
      })
      expect(warn).not.toHaveBeenCalled()
    })

    test('reads related_topics from datasets generated before see_also', () => {
      const e = entry()
      delete e.see_also
      e.related_topics = ['xref:manage:iceberg/about.adoc[About]']
      const meta = metaOf(convertWith(catalog([attachment('streaming', '26.2', 'v26.2.1', { 'redpanda.iceberg.mode': e })]), pageFile('streaming', '26.2')))
      expect(meta.see_also).toEqual([{ href: '/streaming/26.2/manage/iceberg/about/', text: 'About' }])
    })

    test('warns, naming page, version and property, when the version\'s data lacks the property', () => {
      const html = convertWith(catalog([attachment('streaming', '26.2', 'v26.2.4', { other: entry({ name: 'other' }) })]), pageFile('streaming', '26.2'))
      expect(html).toContain(macro.MOUNT_ATTRIBUTE)
      expect(html).not.toContain('data-property-meta')
      expect(messages()).toMatch(/^ROOT\/pages\/iceberg\.adoc: redpanda\.iceberg\.mode is not in redpanda-properties-v26\.2\.4\.json, the property data for streaming 26\.2/)
    })

    // Borrowing a neighbouring release's description would describe a grammar
    // this page's release does not have.
    test('warns and emits nothing when no dataset covers the page\'s series', () => {
      const html = convertWith(catalog([attachment('streaming', '26.2', 'v26.2.4', { 'redpanda.iceberg.mode': entry() })]), pageFile('streaming', '26.1'))
      expect(html).not.toContain('data-property-meta')
      expect(messages()).toMatch(/no redpanda-properties-<tag>\.json covers streaming 26\.1/)
    })

    test('warns once per page however many explorers it has', () => {
      convertWith(catalog([]), pageFile('streaming', '26.1'), '[iceberg-explorer]\n--\n--\n\n[iceberg-explorer]\n--\n--')
      expect(warn.mock.calls.filter((c) => /covers/.test(c.join(' ')))).toHaveLength(1)
    })

    test('a Cloud page uses the newest GA streaming data and carries cloud_supported', () => {
      const html = convertWith(catalog([
        attachment('streaming', '26.2', 'v26.2.4', { 'redpanda.iceberg.mode': entry() }),
        attachment('streaming', '26.2', 'v26.3.1-rc1', { 'redpanda.iceberg.mode': entry({ description: 'RC.' }) }),
      ], { cloud: true }), pageFile('cloud', ''))
      const meta = metaOf(html)
      expect(meta.source).toBe('redpanda-properties-v26.2.4.json')
      expect(meta.cloud_supported).toBeNull()
      // The xref is relative to the dataset's component, so a Cloud page that
      // lacks the target links to the self-managed page.
      expect(meta.see_also[0].href).toBe('/streaming/26.2/manage/iceberg/specify-iceberg-schema/#modes')
    })

    test('drops, and reports, a see_also entry that resolves to no page', () => {
      const html = convertWith(catalog([attachment('streaming', '26.2', 'v26.2.4', {
        'redpanda.iceberg.mode': entry({ see_also: ['xref:manage:gone.adoc[Gone]', 'https://example.com/x[Example]'] }),
      })]), pageFile('streaming', '26.2'))
      expect(metaOf(html).see_also).toEqual([{ href: 'https://example.com/x', text: 'Example' }])
      expect(messages()).toMatch(/see_also entry "xref:manage:gone\.adoc\[Gone\]" .* does not resolve to a page/)
    })

    test('emits no metadata outside Antora', () => {
      expect(convert('[iceberg-explorer]\n--\n--')).not.toContain('data-property-meta')
    })
  })

  describe('block contexts', () => {
    // The processor discards the block body, so the paragraph context made
    // `[iceberg-explorer]` above prose delete that prose from the page.
    test('leaves an ordinary paragraph alone', () => {
      const html = convert('[iceberg-explorer]\nSome important prose.')
      expect(html).toContain('Some important prose.')
      expect(html).not.toContain(macro.MOUNT_ATTRIBUTE)
    })

    test.each(['--\n--', '----\n{"config":"value:mode=binary"}\n----'])(
      'renders a mount point for the documented body form %#',
      (body) => {
        expect(convert(`[iceberg-explorer]\n${body}`)).toContain(macro.MOUNT_ATTRIBUTE)
      }
    )
  })
})
