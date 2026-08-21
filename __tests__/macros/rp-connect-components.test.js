'use strict'

const { posix: path } = require('path')
const Papa = require('papaparse')

/**
 * Builds a mock Asciidoctor registry that captures each registered block
 * macro's process() callback so tests can invoke it directly.
 */
function createCapturingRegistry () {
  const processors = {}
  const registry = {
    blockMacro (fn) {
      const dsl = {
        macroName: null,
        named (name) { this.macroName = name },
        positionalAttributes () {},
        process (callback) { processors[this.macroName] = callback },
        createBlock (parent, context, source) { return { context, source } }
      }
      fn.call(dsl)
    }
  }
  return { registry, processors }
}

// 4-row CSV fixture: kafka appears as both input and output and must merge
// into a single card; one row exercises HTML-escaping of names/descriptions.
const CSV_FIXTURE = [
  'connector,commercial_name,type,support_level,is_cloud_supported,is_licensed,redpandaConnectUrl,redpandaCloudUrl,description',
  'kafka,Apache Kafka,input,certified,y,No,/connect/components/inputs/kafka/,/cloud/connect/components/inputs/kafka/,Stream messages to and from Kafka topics',
  'kafka,Apache Kafka,output,certified,y,No,/connect/components/outputs/kafka/,/cloud/connect/components/outputs/kafka/,Stream messages to and from Kafka topics',
  'elasticsearch_v8,Elasticsearch,output,certified,n,No,/connect/components/outputs/elasticsearch_v8/,,Index documents in Elasticsearch',
  'evil<script>,"Bad<Name> & ""Co""",input,community,n,Yes,/connect/components/inputs/evil/,,"Injects <b>markup</b> & ""quotes"" into cards"'
].join('\n')

function renderComponentTable ({ attributes = { all: 'all' }, docAttributes, csv = CSV_FIXTURE } = {}) {
  jest.resetModules()
  const macro = require('../../macros/rp-connect-components.js')
  const { registry, processors } = createCapturingRegistry()
  const csvData = Papa.parse(csv, { header: true, skipEmptyLines: true })
  const context = { config: { attributes: { csvData, commercialNamesMap: {} } } }
  macro.register(registry, context)
  const parent = {
    getDocument: () => ({
      getAttributes: () => (docAttributes || { 'page-ui-root-path': '/_' })
    })
  }
  const block = processors.component_table(parent, '', attributes)
  return block.source
}

/** Returns just the card whose data-name starts with the given connector name. */
function cardFor (html, connector) {
  const start = html.indexOf(`data-name="${connector} `) === -1
    ? html.indexOf(`data-name="${connector}"`)
    : html.indexOf(`data-name="${connector} `)
  if (start === -1) return ''
  const cardStart = html.lastIndexOf('<div class="component-card"', start)
  const next = html.indexOf('<div class="component-card"', start)
  return html.slice(cardStart, next === -1 ? html.length : next)
}

describe('component_table macro rendering', () => {
  let html

  beforeAll(() => {
    html = renderComponentTable()
  })

  test('renders cards, not a table', () => {
    expect(html).toContain('id="componentCardsContainer"')
    expect(html).toContain('class="component-card"')
    expect(html).not.toMatch(/<table[\s>]/)
  })

  test('merges duplicate input/output connectors into one card', () => {
    // 4 CSV rows -> 3 cards (kafka input + output merge)
    const cardIds = html.match(/id="component-\d+"/g) || []
    expect(cardIds).toHaveLength(3)

    const kafkaCardStart = html.indexOf('data-name="kafka ')
    expect(kafkaCardStart).toBeGreaterThan(-1)
    // Only one kafka card
    expect(html.indexOf('data-name="kafka ', kafkaCardStart + 1)).toBe(-1)

    // The merged kafka card carries both types
    const kafkaCard = html.slice(kafkaCardStart, html.indexOf('id="component-', kafkaCardStart + 1))
    expect(kafkaCard).toContain('data-types="input,output"')
    expect(kafkaCard).toContain('>Input</a>')
    expect(kafkaCard).toContain('>Output</a>')
  })

  test('cards expose the data-* attributes used by the filters', () => {
    const kafkaCard = html.slice(html.indexOf('data-name="kafka '), html.indexOf('data-name="elasticsearch_v8'))
    expect(kafkaCard).toContain('data-name="kafka apache kafka"')
    expect(kafkaCard).toContain('data-types="input,output"')
    expect(kafkaCard).toContain('data-support="certified"')
    expect(kafkaCard).toContain('data-licensed="no"')
    expect(kafkaCard).toContain('data-cloud="yes"')
  })

  test('resolves logos, including fallbacks, instead of generic emoji', () => {
    // kafka must resolve to the Apache Kafka SVG (not an emoji fallback)
    expect(html).toContain('<img src="/_/img/logos/apache-kafka.svg" alt="kafka logo" />')
    // elasticsearch_v8 resolves to the shared elasticsearch.svg
    expect(html).toContain('<img src="/_/img/logos/elasticsearch.svg" alt="elasticsearch_v8 logo" />')
  })

  test('HTML-escapes connector names, commercial names, and descriptions', () => {
    // The raw name must never appear as live markup
    expect(html).not.toContain('evil<script>')
    expect(html).not.toContain('<b>markup</b>')
    // Escaped in element content
    expect(html).toContain('<code>evil&lt;script&gt;</code>')
    expect(html).toContain('Injects &lt;b&gt;markup&lt;/b&gt; &amp; &quot;quotes&quot; into cards')
    // Escaped in the data-name attribute (includes the commercial name)
    expect(html).toContain('data-name="evil&lt;script&gt; bad&lt;name&gt; &amp; &quot;co&quot;"')
  })

  test('emits exactly one catalog style block', () => {
    expect(html.match(/<style>/g)).toHaveLength(1)
    expect(html.match(/<\/style>/g)).toHaveLength(1)
    // The surviving block is the one with the high-priority z-index and dark theme rules
    expect(html).toContain('z-index: 10000 !important;')
    expect(html).toContain('html[data-theme="dark"] .component-card')
    expect(html).not.toContain('z-index: 1000;')
  })

  test('emits no console.log in the scripts', () => {
    expect(html).not.toContain('console.log')
    // Error paths are kept
    expect(html).toContain('console.error')
  })

  test('emits live modal close handlers and focus trap', () => {
    // Backdrop click-to-close
    expect(html).toMatch(/^\s*if \(modal && modal\.classList\.contains\('show'\) && event\.target === modal\) \{/m)
    // Escape-to-close (live, not commented out)
    expect(html).toMatch(/^\s*if \(event\.key === 'Escape'\) \{/m)
    // Focus trap
    expect(html).toContain('getBadgeLegendFocusableElements')
    expect(html).toContain("if (event.key === 'Tab')")
    // Focus restore on close
    expect(html).toContain('window.badgeLegendTriggerElement')
    // Every close path restores page scrolling
    expect(html).toContain("document.body.style.overflow = '';")
    // Dropdown click-outside close is live
    expect(html).toContain('window.dropdownClickOutsideHandler = function(event)')
    expect(html).not.toContain('TEMPORARILY DISABLED')
  })
})

describe('connector logo lookup', () => {
  // Connectors whose logo can only be found by falling back to a vendor/family
  // token: a trailing token (ockam_kafka -> kafka), a leading token run
  // (aws_cloudwatch_logs -> aws_cloudwatch), a vendor alias (oracledb_cdc ->
  // oracle) and a single-token vendor (xml). All four shipped a generic emoji
  // before the three logo maps were merged into one table.
  const FAMILY_CSV = [
    'connector,commercial_name,type,support_level,is_cloud_supported,is_licensed,redpandaConnectUrl,redpandaCloudUrl,description',
    'ockam_kafka,Ockam,input,community,n,No,/connect/components/inputs/ockam_kafka/,,Reads through an Ockam portal',
    'aws_cloudwatch_logs,CloudWatch Logs,output,certified,n,No,/connect/components/outputs/aws_cloudwatch_logs/,,Writes log events',
    'oracledb_cdc,Oracle,input,certified,n,No,/connect/components/inputs/oracledb_cdc/,,Streams change events',
    'xml,XML,processor,community,n,No,/connect/components/processors/xml/,,Parses XML documents',
    'redis_script,Redis,processor,community,n,No,/connect/components/processors/redis_script/,,Runs a Lua script'
  ].join('\n')

  let html

  beforeAll(() => {
    html = renderComponentTable({ csv: FAMILY_CSV })
  })

  test.each([
    ['ockam_kafka', 'apache-kafka.svg'],
    ['aws_cloudwatch_logs', 'awscloud-watch.svg'],
    ['oracledb_cdc', 'oracle.svg'],
    ['xml', 'xml.svg'],
    ['redis_script', 'redis.svg']
  ])('%s inherits the %s vendor logo instead of a generic emoji', (connector, file) => {
    const card = cardFor(html, connector)
    expect(card).toContain(`<img src="/_/img/logos/${file}" alt="${connector} logo" />`)
    expect(card).not.toContain('card-icon-emoji')
  })
})

describe('rp-connect-components macro', () => {
  describe('content catalog URL resolution', () => {
    // Test the URL resolution logic used for removed connectors
    test('resolves relative URL from connector page to whats-new page', () => {
      // Simulate the path.relative calculation used in the macro (without path.dirname)
      const currentPageUrl = '/connect/components/inputs/salesforce/'
      const whatsNewPageUrl = '/connect/get-started/whats-new/'

      // For directory-style URLs, use the URL directly as the base
      const relativeUrl = path.relative(currentPageUrl, whatsNewPageUrl)

      // From /connect/components/inputs/salesforce/ to /connect/get-started/whats-new
      // Should go up 3 levels then down to get-started/whats-new
      expect(relativeUrl).toBe('../../../get-started/whats-new')
    })

    test('resolves relative URL for cloud context', () => {
      const currentPageUrl = '/cloud-data-platform/develop/connect/components/inputs/salesforce/'
      const whatsNewPageUrl = '/cloud-data-platform/get-started/whats-new-cloud/'

      const relativeUrl = path.relative(currentPageUrl, whatsNewPageUrl)

      expect(relativeUrl).toBe('../../../../../get-started/whats-new-cloud')
    })

    test('handles nested processor pages', () => {
      const currentPageUrl = '/connect/components/processors/salesforce/'
      const whatsNewPageUrl = '/connect/get-started/whats-new/'

      const relativeUrl = path.relative(currentPageUrl, whatsNewPageUrl)

      expect(relativeUrl).toBe('../../../get-started/whats-new')
    })
  })

  describe('macro registration', () => {
    let macro

    beforeEach(() => {
      jest.resetModules()
      macro = require('../../macros/rp-connect-components.js')
    })

    test('exports a register function', () => {
      expect(typeof macro.register).toBe('function')
    })

    test('registers macros without errors when given valid registry', () => {
      const mockRegistry = {
        blockMacro: jest.fn(() => {}),
        register: jest.fn(callback => callback.call(mockRegistry))
      }

      const mockContext = {
        config: {
          attributes: {}
        }
      }

      // Should not throw
      expect(() => macro.register(mockRegistry, mockContext)).not.toThrow()
    })
  })

  describe('removed connector notice', () => {
    test('generates correct page spec for self-managed context', () => {
      const isCloud = false
      const pageSpec = isCloud
        ? 'cloud-data-platform:get-started:whats-new-cloud.adoc'
        : 'connect:get-started:whats-new.adoc'

      expect(pageSpec).toBe('connect:get-started:whats-new.adoc')
    })

    test('generates correct page spec for cloud context', () => {
      const isCloud = true
      const pageSpec = isCloud
        ? 'cloud-data-platform:get-started:whats-new-cloud.adoc'
        : 'connect:get-started:whats-new.adoc'

      expect(pageSpec).toBe('cloud-data-platform:get-started:whats-new-cloud.adoc')
    })

    test('falls back to hardcoded URL when contentCatalog unavailable', () => {
      const context = {
        contentCatalog: null,
        file: null
      }
      const isCloud = false

      let whatsNewUrl = isCloud
        ? '/cloud-data-platform/get-started/whats-new-cloud/'
        : '/connect/get-started/whats-new/'

      // Simulate the fallback logic
      if (context.contentCatalog && context.file) {
        // This branch won't execute with null values
        whatsNewUrl = '/resolved/url/'
      }

      expect(whatsNewUrl).toBe('/connect/get-started/whats-new/')
    })

    test('uses resolved URL when contentCatalog available', () => {
      const mockPage = {
        pub: { url: '/connect/get-started/whats-new/' }
      }

      const context = {
        contentCatalog: {
          resolvePage: jest.fn(() => mockPage)
        },
        file: {
          src: { component: 'connect', module: 'components' },
          pub: { url: '/connect/components/processors/salesforce/' }
        }
      }

      const isCloud = false
      let whatsNewUrl = isCloud
        ? '/cloud-data-platform/get-started/whats-new-cloud/'
        : '/connect/get-started/whats-new/'

      // Simulate the resolution logic (using direct URL, not dirname)
      if (context.contentCatalog && context.file) {
        const pageSpec = isCloud
          ? 'cloud-data-platform:get-started:whats-new-cloud.adoc'
          : 'connect:get-started:whats-new.adoc'
        const page = context.contentCatalog.resolvePage(pageSpec, context.file.src)
        if (page) {
          whatsNewUrl = path.relative(context.file.pub.url, page.pub.url)
        }
      }

      expect(context.contentCatalog.resolvePage).toHaveBeenCalledWith(
        'connect:get-started:whats-new.adoc',
        { component: 'connect', module: 'components' }
      )
      expect(whatsNewUrl).toBe('../../../get-started/whats-new')
    })
  })
})
