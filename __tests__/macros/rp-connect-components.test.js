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

// Antora hands AsciiDoc extensions the page as context.file and puts the page's
// path back to the site root on it as file.pub.rootPath. '../..' is what a page
// two levels down gets (for example /preview/component-catalog/); the real
// /connect/components/about/ page is one level deeper. Passing an absolute path
// here would hide any depth bug, so the default is a genuine Antora value.
function renderComponentTable ({ attributes = { all: 'all' }, docAttributes, csv = CSV_FIXTURE, rootPath = '../..', file, csvData: data } = {}) {
  jest.resetModules()
  const macro = require('../../macros/rp-connect-components.js')
  const { registry, processors } = createCapturingRegistry()
  const csvData = data || Papa.parse(csv, { header: true, skipEmptyLines: true })
  const context = {
    config: { attributes: { csvData, commercialNamesMap: {} } },
    file: file === undefined ? { pub: { rootPath } } : file
  }
  macro.register(registry, context)
  const parent = {
    getDocument: () => ({
      getAttributes: () => (docAttributes || {})
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
    expect(html).toContain('<img src="../../_/img/logos/apache-kafka.svg" alt="" />')
    // elasticsearch_v8 resolves to the shared elasticsearch.svg
    expect(html).toContain('<img src="../../_/img/logos/elasticsearch.svg" alt="" />')
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
    // The surviving block is the one with the legend's z-index (below tippy's
    // 9999, so legend badge tooltips show over it) and dark theme rules
    expect(html).toContain('z-index: 9000 !important;')
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
    // Escape also closes an open filter dropdown, whether or not the modal is open
    expect(html).toMatch(/if \(event\.key !== 'Escape'\) return;\s*\n\s*document\.querySelectorAll\('\.dropdown-checkbox-menu\.show'\)/)
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
    expect(card).toContain(`<img src="../../_/img/logos/${file}" alt="" />`)
    expect(card).not.toContain('card-icon-emoji')
  })
})

describe('escaping of every CSV-derived value', () => {
  // Hostile values in the columns the first escaping pass missed: the CSV `type`
  // (type badge text, title and filter checkbox value), `support_level` (support
  // badge class, text and filter value), the SQL driver `commercial_name`
  // (driver badge title and text), and `redpandaConnectUrl` (the type badge href
  // and the card title link href, both built from the same URL value).
  const HOSTILE_CSV = [
    'connector,commercial_name,type,support_level,is_cloud_supported,is_licensed,redpandaConnectUrl,redpandaCloudUrl,description',
    'sql_insert,SQL,output,certified,n,No,/connect/components/outputs/sql_insert/,,Inserts rows into SQL databases',
    'sql_driver_evil,"Drv<img src=x onerror=alert(1)> & ""co""",sql_driver,community,n,No,,,',
    'hostile,Hostile,in<b>put</b>,cert<script>x</script>,n,No,"/connect/components/inputs/hostile/"" onmouseover=""alert(1)"" x=""",,A component'
  ].join('\n')

  let html

  beforeAll(() => {
    html = renderComponentTable({ csv: HOSTILE_CSV })
  })

  test('no CSV value reaches the page as live markup', () => {
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('in<b>put</b>')
    expect(html).not.toContain('In<b>put</b>')
    expect(html).not.toContain('<script>x</script>')
  })

  test('escapes the SQL driver commercial name in the badge tooltip and the driver list', () => {
    const card = cardFor(html, 'sql_insert')
    expect(card).toContain('data-tooltip="Community-supported. Community drivers: Drv&lt;img src=x onerror=alert(1)&gt; &amp; &quot;co&quot;"')
    expect(card).toContain('<span class="catalog-drivers-list">Drv&lt;img src=x onerror=alert(1)&gt; &amp; &quot;co&quot;</span>')
  })

  test('escapes the CSV type in the badge text and tooltip', () => {
    const card = cardFor(html, 'hostile')
    expect(card).toContain('data-tooltip="Component type: In&lt;b&gt;put&lt;/b&gt;."')
    expect(card).toContain('>In&lt;b&gt;put&lt;/b&gt;</a>')
  })

  test('escapes the CSV support level in the badge text, and never puts it in a class', () => {
    const card = cardFor(html, 'hostile')
    // An unknown level is neutral: only certified and community have a meaning class
    expect(card).toContain('<span class="rp-badge rp-badge--sm rp-badge--neutral" data-tooltip="Support level: Cert&lt;script&gt;x&lt;/script&gt;.">Cert&lt;script&gt;x&lt;/script&gt;</span>')
    expect(card).not.toContain('rp-badge--cert&lt;')
  })

  test('escapes filter checkbox values built from CSV columns', () => {
    expect(html).toContain('value="in&lt;b&gt;put&lt;/b&gt;"')
    expect(html).toContain('value="cert&lt;script&gt;x&lt;/script&gt;"')
  })

  test('escapes the connector URL in the type badge href', () => {
    const card = cardFor(html, 'hostile')
    expect(card).not.toMatch(/href="[^"]*" onmouseover="alert\(1\)"/)
    expect(card).toContain('<a class="rp-badge rp-badge--sm rp-badge--neutral" href="/connect/components/inputs/hostile/&quot; onmouseover=&quot;alert(1)&quot; x=&quot;" data-tooltip="Component type: In&lt;b&gt;put&lt;/b&gt;."')
  })

  test('escapes the connector URL in the card title link href', () => {
    const card = cardFor(html, 'hostile')
    expect(card).toContain('<a href="/connect/components/inputs/hostile/&quot; onmouseover=&quot;alert(1)&quot; x=&quot;" class="card-title-link">')
  })
})

describe('card descriptions come only from the component pages', () => {
  const CSV = [
    'connector,commercial_name,type,support_level,is_cloud_supported,is_licensed,redpandaConnectUrl,redpandaCloudUrl,description',
    'kafka,Apache Kafka,input,certified,n,No,/connect/components/inputs/kafka/,,Connects to Kafka brokers and consumes one or more topics.',
    'gateway,N/A,input,certified,y,No,,,'
  ].join('\n')

  let html

  beforeAll(() => {
    html = renderComponentTable({ csv: CSV })
  })

  test('renders the description the extension extracted from the page', () => {
    expect(cardFor(html, 'kafka')).toContain('<p class="card-description">Connects to Kafka brokers and consumes one or more topics.</p>')
  })

  test('takes the description from the first type that has one', () => {
    const csv = [
      'connector,commercial_name,type,support_level,is_cloud_supported,is_licensed,redpandaConnectUrl,redpandaCloudUrl,description',
      'http_server,HTTP,input,certified,n,No,/connect/components/inputs/http_server/,,',
      'http_server,HTTP,output,certified,n,No,/connect/components/outputs/http_server/,,Sets up an HTTP server.'
    ].join('\n')
    expect(cardFor(renderComponentTable({ csv }), 'http_server')).toContain('<p class="card-description">Sets up an HTTP server.</p>')
  })

  test('invents nothing when a component page has no description', () => {
    // The old hardcoded registry answered 'Stream messages to and from Apache
    // Kafka topics' for kafka (already drifted from upstream) and
    // 'Receive data from external sources' for anything it did not know.
    const card = cardFor(html, 'gateway')
    expect(card).not.toContain('card-description')
    expect(html).not.toContain('Stream messages to and from Apache Kafka topics')
    expect(html).not.toContain('Receive data from external sources')
    expect(html).not.toContain('component for data pipelines')
  })
})

describe('cards a reader can actually reach', () => {
  const CSV = [
    'connector,commercial_name,type,support_level,is_cloud_supported,is_licensed,redpandaConnectUrl,redpandaCloudUrl,description',
    'sql_insert,SQL,output,certified,n,No,/connect/components/outputs/sql_insert/,,Inserts rows into SQL databases',
    'sql_driver_postgres,PostgreSQL,sql_driver,certified,n,No,,,',
    'sql_driver_trino,Trino,sql_driver,community,n,No,,,',
    'a2a_message,N/A,processor,certified,y,No,,,Sends messages to an agent'
  ].join('\n')

  let html

  beforeAll(() => {
    html = renderComponentTable({ csv: CSV })
  })

  test('emits no card for a sql_driver row', () => {
    // The type filter has no sql_driver option by design, so such a card could
    // never be shown: 2 driver rows + sql_insert + a2a_message -> 2 cards.
    expect(html.match(/id="component-\d+"/g)).toHaveLength(2)
    expect(html).not.toContain('data-types="sql_driver"')
    expect(cardFor(html, 'sql_driver_postgres')).toBe('')
    expect(cardFor(html, 'sql_driver_trino')).toBe('')
  })

  test('still lists the drivers on the sql_ component card, after the level badge', () => {
    const card = cardFor(html, 'sql_insert')
    expect(card).toContain('<span class="rp-badge rp-badge--sm rp-badge--certified" data-tooltip="Supported and tested by Redpanda. Certified drivers: PostgreSQL">Certified</span> <span class="catalog-drivers-list">PostgreSQL</span>')
    expect(card).toContain('<span class="rp-badge rp-badge--sm rp-badge--community" data-tooltip="Community-supported. Community drivers: Trino">Community</span> <span class="catalog-drivers-list">Trino</span>')
  })

  test('the type filter offers no sql_driver option', () => {
    expect(html).not.toContain('value="sql_driver"')
  })

  test('a connector with no page renders its title as text, not a link to nowhere', () => {
    const card = cardFor(html, 'a2a_message')
    expect(card).not.toContain('href=""')
    expect(card).not.toContain('card-title-link')
    expect(card).toContain('<h3 class="card-title"><code>a2a_<wbr>message</code></h3>')
  })

  test('a connector with a page still links its title', () => {
    const card = cardFor(html, 'sql_insert')
    expect(card).toContain('<a href="/connect/components/outputs/sql_insert/" class="card-title-link">')
  })
})

describe('UI bundle path resolution', () => {
  // Logos live in the docs-ui bundle at <site root>/_/img/logos. Antora gives
  // AsciiDoc extensions the page's path back to the site root as
  // context.file.pub.rootPath, so the src has to track the page's own depth.
  // A hardcoded '../../_' works only for pages exactly two levels deep and 404s
  // on /connect/components/about/, which is where this macro actually ships.
  test.each([
    ['.', '_/img/logos/apache-kafka.svg'],
    ['..', '../_/img/logos/apache-kafka.svg'],
    ['../..', '../../_/img/logos/apache-kafka.svg'],
    ['../../..', '../../../_/img/logos/apache-kafka.svg'],
    ['../../../..', '../../../../_/img/logos/apache-kafka.svg']
  ])('a page whose rootPath is %s links its logos as %s', (rootPath, expected) => {
    const html = renderComponentTable({ rootPath })
    expect(html).toContain(`<img src="${expected}" alt="" />`)
  })

  test('a top-level page renders a logo, not an emoji, for its relative path', () => {
    // Guards the <img> vs emoji decision: '_/img/...' starts with neither '/'
    // nor '..', which an earlier startsWith() sniff treated as an emoji.
    const card = cardFor(renderComponentTable({ rootPath: '.' }), 'kafka')
    expect(card).toContain('<img src="_/img/logos/apache-kafka.svg"')
    expect(card).not.toContain('card-icon-emoji')
  })

  test('falls back to a site-root-relative path when there is no Antora file', () => {
    const html = renderComponentTable({ file: null })
    expect(html).toContain('<img src="/_/img/logos/apache-kafka.svg" alt="" />')
  })

  test('does not read the UI path from a page attribute Antora never sets', () => {
    const html = renderComponentTable({ rootPath: '../../..', docAttributes: { 'page-ui-root-path': '/somewhere-else' } })
    expect(html).toContain('<img src="../../../_/img/logos/apache-kafka.svg" alt="" />')
    expect(html).not.toContain('/somewhere-else')
  })
})

describe('the cloud view', () => {
  // The cloud variant (env-cloud, without the `all` attribute) is what
  // cloud-docs renders, and nothing covered it.
  const CSV = [
    'connector,commercial_name,type,support_level,is_cloud_supported,is_licensed,redpandaConnectUrl,redpandaCloudUrl,description',
    'kafka,Apache Kafka,input,certified,y,No,/connect/components/inputs/kafka/,/cloud/connect/components/inputs/kafka/,Consumes messages from Kafka topics',
    'selfmanaged_only,Self Managed,output,community,n,Yes,/connect/components/outputs/selfmanaged_only/,,Writes somewhere on-prem'
  ].join('\n')

  let html

  beforeAll(() => {
    html = renderComponentTable({ csv: CSV, attributes: {}, docAttributes: { 'env-cloud': '' } })
  })

  test('drops connectors that do not support cloud', () => {
    expect(html.match(/id="component-\d+"/g)).toHaveLength(1)
    expect(cardFor(html, 'kafka')).not.toBe('')
    expect(cardFor(html, 'selfmanaged_only')).toBe('')
  })

  test('links type badges to the cloud page, not the self-managed one', () => {
    const card = cardFor(html, 'kafka')
    expect(card).toContain('href="/cloud/connect/components/inputs/kafka/"')
    expect(card).not.toContain('href="/connect/components/inputs/kafka/"')
  })

  test('leaves the cloud and enterprise badges off the cards, where they mean nothing', () => {
    // The legend modal and the stylesheet still mention both classes; the cards
    // are what must not carry them in the cloud view.
    const card = cardFor(html, 'kafka')
    expect(card).not.toContain('rp-badge--cloud')
    expect(card).not.toContain('rp-badge--enterprise')
    expect(card).toContain('rp-badge--certified')
  })

  test('lists only the types available in Cloud, in the badges and the type filter', () => {
    const csv = [
      'connector,commercial_name,type,support_level,is_cloud_supported,is_licensed,redpandaConnectUrl,redpandaCloudUrl,description',
      'http_server,HTTP,input,certified,y,No,/connect/components/inputs/http_server/,/cloud/connect/components/inputs/http_server/,Receive messages',
      'http_server,HTTP,output,certified,n,No,/connect/components/outputs/http_server/,,Sets up an HTTP server'
    ].join('\n')
    const cloud = cardFor(renderComponentTable({ csv, attributes: {}, docAttributes: { 'env-cloud': '' } }), 'http_server')
    expect(cloud).toContain('data-types="input"')
    expect(cloud).toContain('>Input</a>')
    expect(cloud.split('badge-group-label">Support')[0]).not.toContain('Output')
    // Negative control: the self-managed view still lists both types
    const all = cardFor(renderComponentTable({ csv }), 'http_server')
    expect(all).toContain('data-types="input,output"')
    expect(all).toContain('>Output</a>')
  })

  test('still resolves logos at the page depth', () => {
    expect(html).toContain('<img src="../../_/img/logos/apache-kafka.svg" alt="" />')
  })
})

describe('emitted inline scripts', () => {
  // ~50KB of behaviour is serialized into the page as inline script. A syntax
  // error there is silent in a unit test but breaks every filter on the page,
  // so parse every block the macro emits.
  const vm = require('vm')

  test('every inline script block parses', () => {
    const html = renderComponentTable()
    const blocks = [...html.matchAll(/<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/g)]
      .filter(match => !/type\s*=\s*"application\/ld\+json"/.test(match.groups.attrs))
      .map(match => match.groups.body)

    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(() => new vm.Script(block)).not.toThrow()
    }
  })

  test('the handlers the inline markup calls are defined on window', () => {
    const html = renderComponentTable()
    for (const fn of ['filterComponentTable', 'getQueryParams', 'updateURLParameters', 'toggleDropdownCheckbox', 'updateDropdownText']) {
      expect(html).toContain(`window.${fn} =`)
      expect(html).toContain(`${fn}(`)
    }
  })
})

describe('badge CSS', () => {
  // Badge colors, shape, and dark mode come from docs-ui (.rp-badge and the
  // --meaning-* tokens). The catalog's stylesheet keeps only layout, so it
  // must not restyle a badge or the site-wide .badge class.
  test('the stylesheet sets no badge colors of its own', () => {
    const styleBlock = renderComponentTable().match(/<style>([\s\S]*?)<\/style>/)[1]
    expect(styleBlock).not.toMatch(/^[ \t]*\.badge[ \t]*\{/m)
    expect(styleBlock).not.toMatch(/\.badge-(type|support|cloud|enterprise|use-case)\b/)
    expect(styleBlock).not.toMatch(/html\[data-theme="dark"\][^{]*\.(rp-)?badge(?![\w-])/)
    const badgeRules = [...styleBlock.matchAll(/([^{}]*\.rp-badge[^{}]*)\{([^}]*)\}/g)]
    for (const [, , body] of badgeRules) expect(body).not.toMatch(/(^|[^-])(color|background|border)[a-z-]*:/)
  })

  test('icons are decorative to screen readers', () => {
    const html = renderComponentTable()
    expect(html).toContain('<span class="card-icon-emoji" aria-hidden="true">')
    expect(html).not.toMatch(/<span class="card-icon-emoji">/)
    expect(html).not.toMatch(/alt="[^"]+ logo"/)
  })

  // These four classes were never emitted by the macro in either theme (the
  // type badges only ever carry class="badge badge-type"); the dark-mode
  // rules were dead code, not a real color-coding feature lost in dark mode.
  // Checked as CSS rules (selector + brace), not a bare substring, since the
  // removal comment mentions the class names in prose.
  test('dead dark-mode selectors for never-emitted classes are gone', () => {
    const html = renderComponentTable()
    for (const dead of ['badge-input', 'badge-output', 'badge-processor', 'badge-self-managed', 'badge-legend-overlay']) {
      expect(html).not.toMatch(new RegExp(`\\.${dead}[ \\t]*\\{`))
    }
  })

  // The legend title/section-titles/item labels are a real <h3 id="...">,
  // plain <h4>, and plain <p> -- not classes that were never emitted.
  test('dark-mode legend text selectors target the real elements', () => {
    const html = renderComponentTable()
    expect(html).toContain('html[data-theme="dark"] #badgeLegendTitle')
    expect(html).toContain('html[data-theme="dark"] .badge-legend-section h4')
    expect(html).toContain('html[data-theme="dark"] .badge-legend-item p')
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

describe('component_table use cases', () => {
  const vm = require('vm')
  const { escapeHtml } = require('../../extension-utils/html-utils')
  const { matchSolutions, solutionsMarkup, catalogStatusText, USE_CASE_MIN_CARDS } = require('../../macros/rp-connect-components.js')

  // Translated rows as generate-rp-connect-info hands them over: use_cases is
  // an array of taxonomy IDs, and csvData.useCases describes the ones in use.
  const row = (connector, type, useCases, extra = {}) => ({
    connector,
    commercial_name: connector,
    type,
    support_level: 'certified',
    is_cloud_supported: 'y',
    is_licensed: 'No',
    redpandaConnectUrl: `/connect/components/${type}s/${connector}/`,
    redpandaCloudUrl: '',
    description: '',
    use_cases: useCases,
    ...extra
  })
  const data = (rows, useCases) => ({ data: rows, useCases })
  const CDC = { id: 'change-data-capture', label: 'Change data capture', definition: 'Streaming row-level changes from a database.', altLabels: ['CDC'] }
  const STREAM = { id: 'stream-processing', label: 'Stream processing', definition: 'Transforming events as they flow.', altLabels: [] }
  const LAKE = { id: 'data-lakehouse', label: 'Data lakehouse', definition: 'Open table formats on object storage.', altLabels: [] }
  const USE_CASES = [CDC, LAKE, STREAM]
  // CDC on 3 cards and stream processing on 3 (offered); lakehouse on 1 (not offered)
  const ROWS = [
    row('postgres_cdc', 'input', ['change-data-capture', 'stream-processing']),
    row('mysql_cdc', 'input', ['change-data-capture']),
    row('kafka', 'input', ['stream-processing']),
    row('kafka', 'output', ['change-data-capture']),
    row('workflow', 'processor', ['stream-processing']),
    row('iceberg', 'output', ['data-lakehouse']),
    row('stdout', 'output', [])
  ]
  const render = (opts = {}) => renderComponentTable({ csvData: data(ROWS, USE_CASES), ...opts })
  const menuOf = (html, id) => {
    const at = html.indexOf(`id="${id}Menu"`)
    return html.slice(at, html.indexOf('</div>', at))
  }

  test('offers a use case only when at least 3 cards in the view have it', () => {
    expect(USE_CASE_MIN_CARDS).toBe(3)
    const menu = menuOf(render(), 'useCaseFilter')
    expect(menu).toContain('value="change-data-capture"')
    expect(menu).toContain('value="stream-processing"')
    expect(menu).not.toContain('value="data-lakehouse"')
  })

  test('renders the Use case filter as a labelled disclosure, with Any use case, Clear, and definitions', () => {
    const html = render()
    expect(html).toContain('<label for="useCaseFilterToggle" id="useCaseFilterLabel">Use case:</label>')
    expect(html).toContain('id="useCaseFilterToggle" aria-expanded="false" aria-controls="useCaseFilterMenu" aria-labelledby="useCaseFilterLabel useCaseFilterValue"')
    expect(html).toContain('<span class="dropdown-text" id="useCaseFilterValue">Any use case</span>')
    expect(html).toContain('<div class="dropdown-checkbox-menu" id="useCaseFilterMenu" role="group" aria-labelledby="useCaseFilterLabel">')
    const menu = menuOf(html, 'useCaseFilter')
    // Clear comes first, then the options, none checked
    expect(menu.indexOf('id="useCaseFilterClear"')).toBeLessThan(menu.indexOf('value="change-data-capture"'))
    expect(menu).toContain('<label class="dropdown-checkbox-option" title="Streaming row-level changes from a database.">')
    expect(menu).toContain('<span>Change data capture</span>')
    expect(menu).not.toContain('checked')
  })

  test('uses the disclosure pattern on every filter, with the arrow hidden from assistive tech', () => {
    const html = render()
    expect(html).not.toContain('role="menu"')
    expect(html).not.toContain('aria-haspopup')
    for (const id of ['typeFilter', 'supportFilter', 'cloudSupportFilter', 'enterpriseFilter', 'useCaseFilter']) {
      expect(html).toContain(`id="${id}Menu" role="group"`)
      expect(html).toMatch(new RegExp(`id="${id}Toggle"[^>]*aria-labelledby="[A-Za-z]+ ${id}Value"`))
    }
    expect(html).toContain('id="labelForSupportFilter"')
    expect(html.match(/<span class="dropdown-arrow">/g)).toBeNull()
    expect(html).toContain('<span class="dropdown-arrow" aria-hidden="true">')
  })

  test('puts the union of a connector\'s use cases on its card, as data, search terms, and chips', () => {
    const html = render()
    const kafka = cardFor(html, 'kafka')
    expect(kafka).toContain('data-use-cases="stream-processing,change-data-capture"')
    expect(kafka).toContain('<span class="badge-group-label">Use case</span>')
    // Definitions as tooltips; a merged input/output card says the use case is per type
    expect(kafka).toContain(`data-tooltip="Transforming events as they flow. Applies to at least one of this component&#39;s types."`.replace('&#39;', "'"))
    const postgres = cardFor(html, 'postgres_cdc')
    expect(postgres).toContain('data-search="postgres_cdc change data capture change-data-capture cdc stream processing stream-processing"')
    expect(postgres).toContain('<span class="rp-badge rp-badge--sm rp-badge--use-case" data-tooltip="Streaming row-level changes from a database.">Change data capture</span>')
    expect(postgres).not.toContain('Applies to at least one')
    const stdout = cardFor(html, 'stdout')
    expect(stdout).not.toContain('data-use-cases')
    expect(stdout).not.toContain('badge-group-label">Use case')
  })

  test('keeps a rare use case searchable but shows no chip for it', () => {
    const iceberg = cardFor(render(), 'iceberg')
    expect(iceberg).toContain('data-search="iceberg data lakehouse data-lakehouse"')
    expect(iceberg).not.toContain('rp-badge--use-case')
  })

  test('renders a status region, an empty state with Clear filters, and the solutions panel without aria-live', () => {
    const html = render({ rootPath: '../..' })
    expect(html).toContain('<div class="catalog-visually-hidden" id="componentCatalogStatus" role="status" aria-live="polite"></div>')
    expect(html).toContain('<div class="catalog-empty" id="componentCatalogEmpty" hidden>')
    expect(html).toContain('<p>No components match these filters.</p>')
    expect(html).toContain('<button type="button" class="catalog-empty-clear" id="componentCatalogClear">Clear filters</button>')
    const panel = html.slice(html.indexOf('id="componentCatalogSolutions"') - 40, html.indexOf('></div>', html.indexOf('id="componentCatalogSolutions"')))
    expect(panel).not.toContain('aria-live')
    expect(panel).toContain('data-solutions-url="../../assets/data/solutions.json"')
    expect(html).toContain('window.updateCatalogSolutions = function')
  })

  test('always renders the status region, even with no use-case data', () => {
    const html = renderComponentTable()
    expect(html).toContain('id="componentCatalogStatus" role="status"')
    expect(html).toContain('id="componentCatalogEmpty"')
  })

  test('adds a Use cases section with definitions to the badge legend', () => {
    const html = render()
    const legend = html.slice(html.indexOf('<h4>Use cases</h4>'), html.indexOf('</div>\n              </div>', html.indexOf('<h4>Use cases</h4>')))
    expect(legend).toContain('<span class="rp-badge rp-badge--sm rp-badge--use-case" data-tooltip="Streaming row-level changes from a database.">Change data capture</span>')
    expect(legend).toContain('<p>Streaming row-level changes from a database.</p>')
    expect(legend).not.toContain('Data lakehouse')
  })

  test('every inline script block parses with use-case data, including hostile definitions', () => {
    const hostile = { ...CDC, definition: 'Uses `backticks`, ${injection}, and \\ backslashes' }
    const html = renderComponentTable({ csvData: data(ROWS, [hostile, STREAM]) })
    const blocks = [...html.matchAll(/<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/g)].map((m) => m.groups.body)
    for (const block of blocks) expect(() => new vm.Script(block)).not.toThrow()
    // Inside the legend's template literal, the definition cannot interpolate
    expect(html).toContain('Uses &#96;backticks&#96;, &#36;{injection}, and &#92; backslashes')
  })

  test('hides the filter, panel, chips, and legend section when no component has a use case', () => {
    for (const csvData of [data(ROWS.map((r) => ({ ...r, use_cases: [] })), []), data(ROWS, undefined)]) {
      const html = renderComponentTable({ csvData })
      expect(html).not.toContain('id="useCaseFilterToggle"')
      expect(html).not.toContain('id="componentCatalogSolutions"')
      expect(html).not.toContain('rp-badge--use-case')
      expect(html).not.toContain('<h4>Use cases</h4>')
      expect(html).not.toContain('window.updateCatalogSolutions = function')
    }
  })

  test('counts only the cards shown in the Cloud view toward the threshold', () => {
    const rows = ROWS.map((r) => (r.connector === 'workflow' ? { ...r, is_cloud_supported: 'n' } : r))
    const html = renderComponentTable({ csvData: data(rows, USE_CASES), attributes: {}, docAttributes: { 'env-cloud': '' } })
    const menu = menuOf(html, 'useCaseFilter')
    expect(menu).toContain('value="change-data-capture"')
    expect(menu).not.toContain('value="stream-processing"')
  })

  test('escapes hostile IDs, labels, and definitions everywhere they appear', () => {
    const hostile = { id: 'x"><script>alert(1)</script>', label: '<img src=x onerror=alert(1)> & "Co"', definition: '"><b>def</b>', altLabels: ['<i>alt</i>'] }
    const rows = ['a', 'b', 'c'].map((n) => row(`evil_${n}`, 'input', [hostile.id]))
    const html = renderComponentTable({ csvData: data(rows, [hostile]) })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<b>def</b>')
    expect(html).not.toContain('<i>alt</i>')
    expect(html).toContain(`value="${escapeHtml(hostile.id)}"`)
    expect(html).toContain(`<span>${escapeHtml(hostile.label)}</span>`)
    expect(html).toContain(`data-use-cases="${escapeHtml(hostile.id)}"`)
    expect(html).toContain(`data-use-cases="${escapeHtml(JSON.stringify({ [hostile.id]: { label: hostile.label, altLabels: hostile.altLabels } }))}"`)
  })

  describe('status sentence', () => {
    test('says what matches and how many related solutions there are', () => {
      expect(catalogStatusText({ shown: 11, total: 40, search: '', useCases: ['Change data capture'], filtered: false, solutions: 1 }))
        .toBe('11 components match Change data capture. 1 related solution.')
      expect(catalogStatusText({ shown: 1, total: 40, search: 'kafka', useCases: ['Change data capture', 'Stream processing'], filtered: false, solutions: 2 }))
        .toBe('1 component matches "kafka" and Change data capture or Stream processing. 2 related solutions.')
      expect(catalogStatusText({ shown: 30, total: 40, search: '', useCases: [], filtered: true, solutions: null }))
        .toBe('30 components match these filters.')
      expect(catalogStatusText({ shown: 0, total: 40, search: 'zzz', useCases: [], filtered: false, solutions: null }))
        .toBe('No components match "zzz".')
      expect(catalogStatusText({ shown: 40, total: 40, search: '', useCases: [], filtered: false, solutions: null }))
        .toBe('Showing all 40 components.')
    })
  })

  describe('solutions for a use case', () => {
    const INFO = { 'change-data-capture': { label: 'Change data capture', altLabels: ['CDC'] } }
    // Shaped like assets/data/solutions.json from the solutions-catalog
    // extension: with the taxonomy (concepts) and without (DEM#320: labels only)
    const CATALOG = {
      solutions: [
        { id: 'cdc-to-lakehouse', title: 'CDC to lakehouse', url: '/solutions/cdc-to-lakehouse/', status: 'published', useCases: ['Change data capture'], concepts: { useCases: [{ value: 'Change data capture', id: 'change-data-capture', label: 'Change data capture' }] } },
        { id: 'authored-id', title: 'Authored by ID', url: '/solutions/authored-id/', status: 'published', useCases: ['change-data-capture'] },
        { id: 'label-only', title: 'Label only', url: '/solutions/label-only/', status: 'published', useCases: ['change DATA capture '] },
        { id: 'alt-label', title: 'Alt label', url: '/solutions/alt-label/', status: 'published', useCases: ['cdc'] },
        { id: 'old', title: 'Old', url: '/solutions/old/', status: 'deprecated', useCases: ['Change data capture'] },
        { id: 'fanout', title: 'Fan-out', url: '/solutions/fanout/', status: 'published', useCases: ['Data fan-out'], concepts: { useCases: [{ id: 'data-fan-out' }] } }
      ]
    }

    test('matches concept IDs, and authored labels, IDs, and altLabels ignoring case; leaves out deprecated solutions', () => {
      expect(matchSolutions(CATALOG, ['change-data-capture'], INFO).map((s) => s.id)).toEqual(['cdc-to-lakehouse', 'authored-id', 'label-only', 'alt-label'])
      expect(matchSolutions(CATALOG, ['stream-processing'], INFO)).toEqual([])
      expect(matchSolutions(CATALOG, [], INFO)).toEqual([])
    })

    test('without use-case details, matches concept IDs and authored IDs only', () => {
      expect(matchSolutions(CATALOG, ['change-data-capture']).map((s) => s.id)).toEqual(['cdc-to-lakehouse', 'authored-id'])
    })

    test('has nothing to show without a catalog', () => {
      for (const catalog of [null, undefined, {}, { solutions: 'nope' }]) {
        expect(matchSolutions(catalog, ['change-data-capture'], INFO)).toEqual([])
      }
      expect(solutionsMarkup([], ['change-data-capture'], INFO, escapeHtml)).toBe('')
    })

    test('one match: a quiet line that links the solution by title', () => {
      const html = solutionsMarkup(matchSolutions(CATALOG, ['change-data-capture'], INFO).slice(0, 1), ['change-data-capture'], INFO, escapeHtml)
      expect(html).toBe('<p class="catalog-solutions-hint">Redpanda Solution for Change data capture: <a href="/solutions/cdc-to-lakehouse/">CDC to lakehouse</a></p>')
    })

    test('several matches: one line that links the Solutions landing page filtered by use case', () => {
      const many = Array.from({ length: 8 }, (_, i) => ({ title: `S${i}`, url: `/solutions/s${i}/` }))
      const html = solutionsMarkup(many, ['change-data-capture'], INFO, escapeHtml)
      expect(html).toBe('<p class="catalog-solutions-hint"><a href="/solutions/?use-case=Change%20data%20capture">See 8 Redpanda Solutions for Change data capture</a></p>')
      expect(html).not.toMatch(/<h3|<ul|<li|badge/)
    })

    test('escapes solution titles, URLs, and labels', () => {
      const one = solutionsMarkup([{ title: '<b>x</b>', url: '"><script>alert(1)</script>' }], ['a'], { a: { label: '<i>A</i>' } }, escapeHtml)
      expect(one).not.toMatch(/<script>|<b>|<i>/)
      expect(one).toContain('&lt;b&gt;x&lt;/b&gt;')
      expect(one).toContain('Redpanda Solution for &lt;i&gt;A&lt;/i&gt;')
      const two = solutionsMarkup([{ title: 'a', url: '/solutions/a/' }, { title: 'b', url: '/solutions/b/' }], ['a'], { a: { label: '<i>A</i>' } }, escapeHtml)
      expect(two).not.toMatch(/<i>/)
      expect(two).toContain('for &lt;i&gt;A&lt;/i&gt;')
    })
  })

  describe('use cases on a connector page', () => {
    // component_type_dropdown, with the content catalog Antora passes to extensions
    function renderDropdown ({ name, docAttributes = {}, catalogPage = { pub: { url: '/connect/components/about/' } } } = {}) {
      jest.resetModules()
      const macro = require('../../macros/rp-connect-components.js')
      const { registry, processors } = createCapturingRegistry()
      const context = {
        config: { attributes: { csvData: data(ROWS, USE_CASES), commercialNamesMap: {} } },
        file: { src: {}, pub: { url: '/connect/components/inputs/kafka/' } },
        contentCatalog: { resolvePage: (spec) => (spec === 'connect:components:about.adoc' ? catalogPage : undefined) }
      }
      macro.register(registry, context)
      const parent = { getDocument: () => ({ getAttributes: () => ({ doctitle: name, type: 'input', ...docAttributes }) }) }
      return processors.component_type_dropdown(parent, '', {}).source
    }

    test('links each offered use case to the catalog filtered to it', () => {
      const html = renderDropdown({ name: 'kafka' })
      // A neutral notice when the component needs no license, styled by docs-ui with no inline CSS
      expect(html).toContain('<div class="rp-notice rp-notice--use-case connector-facts">')
      expect(html).toContain('<section class="rp-notice-section rp-notice--use-case connector-use-cases">')
      expect(html).toContain('<span class="rp-notice-icon" aria-hidden="true"></span>')
      expect(html).toContain('<div class="rp-notice-body" role="group" aria-labelledby="connectorUseCasesLabel">')
      expect(html).toContain('<span class="rp-notice-title" id="connectorUseCasesLabel">Use cases</span>')
      expect(html).toContain('<a class="rp-badge rp-badge--use-case" href="../../about/?usecase=stream-processing" data-tooltip="Transforming events as they flow. Applies to at least one of this component\'s types.">Stream processing</a>')
      expect(html).not.toContain('<style')
      expect(html).not.toContain(' title=')
      expect(html).toContain('href="../../about/?usecase=change-data-capture"')
    })

    test('shows nothing for a rare use case, on Cloud pages, or without the catalog page', () => {
      expect(renderDropdown({ name: 'iceberg' })).not.toContain('connector-use-cases')
      expect(renderDropdown({ name: 'kafka', docAttributes: { 'env-cloud': '' } })).not.toContain('connector-use-cases')
      expect(renderDropdown({ name: 'kafka', catalogPage: null })).not.toContain('connector-use-cases')
    })
  })
})

describe('meaning badges', () => {
  const { meaningBadge, typeLabel, breakableName } = require('../../macros/rp-connect-components.js')
  const row = (connector, type, extra = {}) => ({
    connector,
    commercial_name: connector,
    type,
    support_level: 'certified',
    is_cloud_supported: 'y',
    is_licensed: 'No',
    redpandaConnectUrl: `/connect/components/${type}s/${connector}/`,
    redpandaCloudUrl: `/cloud/connect/components/${type}s/${connector}/`,
    description: '',
    use_cases: ['change-data-capture'],
    ...extra
  })
  const CDC = { id: 'change-data-capture', label: 'Change data capture', definition: 'Streaming row-level changes from a database.', altLabels: [] }
  const ROWS = [
    row('postgres_cdc', 'input', { is_licensed: 'Yes' }),
    row('mysql_cdc', 'input', { support_level: 'community' }),
    row('local', 'rate_limit'),
    row('sql_insert', 'output'),
    row('sql_driver_trino', 'sql_driver', { commercial_name: 'Trino', support_level: 'community', use_cases: [] })
  ]
  const csvData = { data: ROWS, useCases: [CDC] }

  function renderDropdown (name) {
    jest.resetModules()
    const macro = require('../../macros/rp-connect-components.js')
    const { registry, processors } = createCapturingRegistry()
    macro.register(registry, {
      config: { attributes: { csvData, commercialNamesMap: {} } },
      file: { src: {}, pub: { url: '/connect/components/inputs/postgres_cdc/' } },
      contentCatalog: { resolvePage: () => ({ pub: { url: '/connect/components/about/' } }) }
    })
    const parent = { getDocument: () => ({ getAttributes: () => ({ doctitle: name, type: 'input', 'page-component-title': 'Connect' }) }) }
    return processors.component_type_dropdown(parent, '', {}).source
  }

  // Every element whose class marks a meaning: .rp-badge, .rp-notice and its parts, .rp-button
  const meaningElements = (html) => [...html.matchAll(/<[a-z]+\b[^>]*\bclass="[^"]*\brp-(badge|notice|button)[^"]*"[^>]*>/g)].map((m) => m[0])

  test('every badge has a non-empty data-tooltip, and no meaning element has a native title', () => {
    const pages = [
      renderComponentTable({ csvData }),
      renderComponentTable({ csvData, attributes: {}, docAttributes: { 'env-cloud': '' } }),
      renderDropdown('postgres_cdc'),
      renderDropdown('mysql_cdc')
    ]
    for (const html of pages) {
      const elements = meaningElements(html)
      expect(elements.length).toBeGreaterThan(0)
      for (const el of elements) expect(el).not.toMatch(/\stitle=/)
      const badges = elements.filter((el) => /\brp-badge\b/.test(el))
      expect(badges.length).toBeGreaterThan(0)
      for (const el of badges) expect(el).toMatch(/\sdata-tooltip="[^"]+"/)
    }
    // Negative control: the tooltip check fails on a badge without one
    expect('<span class="rp-badge rp-badge--neutral">Input</span>').not.toMatch(/\sdata-tooltip="[^"]+"/)
    // Negative control: the check finds a title when one is there
    expect(meaningElements('<span class="rp-badge rp-badge--cloud" title="x">Cloud</span>')[0]).toMatch(/\stitle=/)
  })

  test('cards mark each meaning with its rp-badge class, small size, and a tooltip', () => {
    const html = renderComponentTable({ csvData })
    const postgres = cardFor(html, 'postgres_cdc')
    expect(postgres).toContain('<a class="rp-badge rp-badge--sm rp-badge--neutral" href="/connect/components/inputs/postgres_cdc/" data-tooltip="Reads data into a pipeline.">Input</a>')
    expect(postgres).toContain('<span class="rp-badge rp-badge--sm rp-badge--certified" data-tooltip="Supported and tested by Redpanda.">Certified</span>')
    expect(postgres).toContain('<a class="rp-badge rp-badge--sm rp-badge--cloud" href="/cloud/connect/components/inputs/postgres_cdc/" data-tooltip="Available in Redpanda Cloud.">Cloud</a>')
    expect(postgres).toContain('<span class="rp-badge rp-badge--sm rp-badge--enterprise" data-tooltip="Requires an Enterprise Edition license.">Enterprise</span>')
    expect(postgres).toContain('<span class="rp-badge rp-badge--sm rp-badge--use-case" data-tooltip="Streaming row-level changes from a database.">Change data capture</span>')
    expect(cardFor(html, 'mysql_cdc')).toContain('<span class="rp-badge rp-badge--sm rp-badge--community" data-tooltip="Community-supported.">Community</span>')
    // No old catalog badge classes, and no label in parentheses
    const cards = html.slice(html.indexOf('id="componentCardsContainer"'), html.indexOf('<script', html.indexOf('id="componentCardsContainer"')))
    expect(cards).not.toMatch(/class="badge[ "]/)
    expect(cards).not.toMatch(/class="rp-badge[^"]*"[^>]*>[^<]*\(/)
  })

  test('a type reads the same on cards, in the filter, and in the legend', () => {
    expect(typeLabel('rate_limit')).toBe('Rate Limit')
    expect(typeLabel('input')).toBe('Input')
    const html = renderComponentTable({ csvData })
    expect(cardFor(html, 'local')).toContain('>Rate Limit</a>')
    expect(html).toContain('<span>Rate Limit</span>')
    expect(html).toContain('<span class="rp-badge rp-badge--sm rp-badge--neutral" data-tooltip="Limits how often components access a resource.">Rate Limit</span>')
    expect(html).not.toMatch(/Rate_limit|Rate limit/)
  })

  test('the legend uses the same badges and lists Enterprise where cards can show it', () => {
    const html = renderComponentTable({ csvData })
    const legend = html.slice(html.indexOf('id="badgeLegendModal"'))
    for (const badge of ['rp-badge--neutral">Input', 'rp-badge--certified">Certified', 'rp-badge--community">Community', 'rp-badge--use-case">Change data capture', 'rp-badge--cloud">Cloud', 'rp-badge--enterprise">Enterprise']) {
      expect(legend).toMatch(new RegExp(`<span class="rp-badge rp-badge--sm ${badge.replace('">', '" data-tooltip="[^"]+">')}</span>`))
    }
    expect(legend).toContain('<h4>Availability</h4>')
    // The Cloud view shows no Enterprise or Cloud badge on its cards, so its legend lists neither
    const cloud = renderComponentTable({ csvData, attributes: {}, docAttributes: { 'env-cloud': '' } })
    expect(cloud.slice(cloud.indexOf('id="badgeLegendModal"'))).not.toContain('rp-badge--enterprise')
  })

  test('long names wrap only after an underscore, and columns never outgrow the container', () => {
    expect(breakableName('gcp_vertex_ai_embeddings')).toBe('gcp_<wbr>vertex_<wbr>ai_<wbr>embeddings')
    expect(breakableName('<b>')).toBe('&lt;b&gt;')
    const html = renderComponentTable({ csvData })
    expect(html).toContain('<code>postgres_<wbr>cdc</code>')
    expect(html).toContain('grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));')
    expect(html).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(html).not.toMatch(/grid-template-columns: 1fr;/)
  })

  test('meaningBadge escapes its label, tooltip, and link', () => {
    expect(meaningBadge('cloud', '<i>', { tooltip: '"x"', href: '"><script>' }))
      .toBe('<a class="rp-badge rp-badge--sm rp-badge--cloud" href="&quot;&gt;&lt;script&gt;" data-tooltip="&quot;x&quot;">&lt;i&gt;</a>')
    // With no tooltip given, the label stands in: no badge goes without one
    expect(meaningBadge('use-case', 'A', { small: false })).toBe('<span class="rp-badge rp-badge--use-case" data-tooltip="A">A</span>')
  })

  test('each component type has its own tooltip, and an unknown type still gets one', () => {
    const { typeTooltip } = require('../../macros/rp-connect-components.js')
    expect(typeTooltip('input')).toBe('Reads data into a pipeline.')
    expect(typeTooltip('output')).toBe('Writes data out of a pipeline.')
    expect(typeTooltip('processor')).toBe('Transforms data in a pipeline.')
    for (const type of ['cache', 'buffer', 'metric', 'scanner', 'rate_limit', 'tracer']) expect(typeTooltip(type)).toMatch(/^[A-Z].+\.$/)
    expect(typeTooltip('new_kind')).toBe('Component type: New Kind.')
  })

  test('the connector card is an Enterprise notice with docs-ui buttons, and no inline CSS', () => {
    const html = renderDropdown('postgres_cdc')
    expect(html).toContain('<div class="rp-notice rp-notice--enterprise connector-facts">')
    expect(html).toContain('<section class="rp-notice-section" aria-labelledby="connectorLicenseTitle">')
    expect(html).toContain('<p class="rp-notice-title" id="connectorLicenseTitle">Enterprise license required</p>')
    expect(html).toContain('<p class="rp-notice-text">This component runs with a Redpanda Enterprise Edition license. Try it free for 30 days, or upgrade when you\'re ready.</p>')
    expect(html).toContain('<a class="rp-button rp-button--primary" href="http://redpanda.com/try-enterprise" target="_blank" rel="noopener">Get a 30-day trial key</a>')
    expect(html).toContain('<a class="rp-button" href="https://www.redpanda.com/upgrade" target="_blank" rel="noopener">Upgrade</a>')
    expect(html).toContain('<a class="rp-notice-link" href="https://docs.redpanda.com/redpanda-connect/get-started/licensing/" target="_blank" rel="noopener">About licensing</a>')
    // The use cases follow in their own section, as use-case badge links
    expect(html.indexOf('connectorLicenseTitle')).toBeLessThan(html.indexOf('connectorUseCasesLabel'))
    expect(html).toContain('<a class="rp-badge rp-badge--use-case" href="../../about/?usecase=change-data-capture" data-tooltip="Streaming row-level changes from a database.">Change data capture</a>')
    expect(html).not.toMatch(/<style|connector-fact-|metadata-block/)
    // Without a license, the card is not orange
    expect(renderDropdown('mysql_cdc')).toContain('<div class="rp-notice rp-notice--use-case connector-facts">')
  })
})

describe('component_table filter layout', () => {
  const { filterLayoutCss } = require('../../macros/rp-connect-components.js')
  // [container min-width, columns] per rule, in order
  const bands = (count) => filterLayoutCss(count).split('\n').map((rule) => {
    const width = Number(rule.match(/min-width: (\d+)px/)[1])
    const cols = rule.includes('flex-basis: 100%') ? 1 : Number(rule.match(/\/ (\d+) - 0\.1px/)[1])
    return [width, cols]
  })

  test('balances four filters as 1, then 2x2, then 4 across', () => {
    expect(bands(4)).toEqual([[0, 1], [376, 2], [572, 2], [768, 4]])
  })

  test('lays out three filters as 1 per row, then 2 with the third filling its row, then 3 across', () => {
    expect(bands(3)).toEqual([[0, 1], [376, 2], [572, 3]])
  })

  test('balances five filters as 3+2 where four do not fit', () => {
    expect(bands(5)).toEqual([[0, 1], [376, 2], [572, 3], [768, 3], [964, 5]])
  })

  test('puts search on its own row and the panel above the cards', () => {
    const html = renderComponentTable()
    expect(html).toContain('<div class="table-filters component-catalog-filters">')
    expect(html).toContain('<div class="table-filters-search">')
    expect(html).toMatch(/\.table-filters\.component-catalog-filters > \.table-filters-search \{[^}]*flex: 1 1 100%/)
    expect(html).toMatch(/\.table-filters\.component-catalog-filters \{[^}]*z-index: 2/)
  })
})
