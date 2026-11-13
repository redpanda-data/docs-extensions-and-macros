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

  test('escapes the SQL driver commercial name in the badge title and text', () => {
    const card = cardFor(html, 'sql_insert')
    expect(card).toContain('title="Community drivers: Drv&lt;img src=x onerror=alert(1)&gt; &amp; &quot;co&quot;"')
    expect(card).toContain('>Community: Drv&lt;img src=x onerror=alert(1)&gt; &amp; &quot;co&quot;<')
  })

  test('escapes the CSV type in the badge text and title', () => {
    const card = cardFor(html, 'hostile')
    expect(card).toContain('title="Component type: In&lt;b&gt;put&lt;/b&gt;"')
    expect(card).toContain('>In&lt;b&gt;put&lt;/b&gt;</a>')
  })

  test('escapes the CSV support level in the badge class attribute', () => {
    const card = cardFor(html, 'hostile')
    expect(card).toContain('badge-support badge-support-cert&lt;script&gt;x&lt;/script&gt;')
    expect(card).toContain('>Cert&lt;script&gt;x&lt;/script&gt;</span>')
  })

  test('escapes filter checkbox values built from CSV columns', () => {
    expect(html).toContain('value="in&lt;b&gt;put&lt;/b&gt;"')
    expect(html).toContain('value="cert&lt;script&gt;x&lt;/script&gt;"')
  })

  test('escapes the connector URL in the type badge href', () => {
    const card = cardFor(html, 'hostile')
    expect(card).not.toMatch(/<a href="[^"]*" onmouseover="alert\(1\)"/)
    expect(card).toContain('<a href="/connect/components/inputs/hostile/&quot; onmouseover=&quot;alert(1)&quot; x=&quot;" class="badge badge-type"')
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

  test('still lists the drivers as badges on the sql_ component card', () => {
    const card = cardFor(html, 'sql_insert')
    expect(card).toContain('>Certified: PostgreSQL<')
    expect(card).toContain('>Community: Trino<')
  })

  test('the type filter offers no sql_driver option', () => {
    expect(html).not.toContain('value="sql_driver"')
  })

  test('a connector with no page renders its title as text, not a link to nowhere', () => {
    const card = cardFor(html, 'a2a_message')
    expect(card).not.toContain('href=""')
    expect(card).not.toContain('card-title-link')
    expect(card).toContain('<h3 class="card-title"><code>a2a_message</code></h3>')
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
    expect(card).not.toContain('badge-cloud')
    expect(card).not.toContain('badge-enterprise')
    expect(card).toContain('badge-support')
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

describe('badge CSS scoping', () => {
  // A bare `.badge { ... }` rule collided with docs-ui's site-wide .badge
  // class (used by the unrelated badge:[] macro on the same page). It must
  // only ever be scoped to this macro's own two badge containers.
  test('the .badge rule is scoped, not a bare selector', () => {
    const html = renderComponentTable()
    const styleBlock = html.match(/<style>([\s\S]*?)<\/style>/)[1]
    // :where() keeps a bare .badge's specificity, so .badge-type and the
    // other badge rules after it still win by source order.
    expect(styleBlock).toContain(':where(.badge-group-badges, .badge-legend-item) .badge {')
    // A bare rule starts its line with only whitespace before ".badge {".
    expect(styleBlock).not.toMatch(/^[ \t]*\.badge[ \t]*\{/m)
  })

  test('the dark-mode .badge rule is scoped the same way', () => {
    const styleBlock = renderComponentTable().match(/<style>([\s\S]*?)<\/style>/)[1]
    expect(styleBlock).not.toMatch(/html\[data-theme="dark"\] \.badge[ \t]*[{,]/)
    expect(styleBlock).toContain('html[data-theme="dark"] :where(.badge-group-badges, .badge-legend-item) .badge {')
    // The Cloud and Enterprise dark colors come after it, at the same
    // specificity, so they still apply.
    const generic = styleBlock.indexOf('html[data-theme="dark"] :where(')
    expect(styleBlock.indexOf('html[data-theme="dark"] .badge-cloud {')).toBeGreaterThan(generic)
    expect(styleBlock.indexOf('html[data-theme="dark"] .badge-enterprise {')).toBeGreaterThan(generic)
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
  const { escapeHtml } = require('../../extension-utils/html-utils')
  const { matchSolutions, solutionsMarkup } = require('../../macros/rp-connect-components.js')

  // Translated rows as generate-rp-connect-info hands them over: use_cases is
  // an array of taxonomy IDs, and csvData.useCases labels the ones in use.
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
  const USE_CASES = [
    { id: 'change-data-capture', label: 'Change data capture' },
    { id: 'stream-processing', label: 'Stream processing' }
  ]
  const ROWS = [
    row('postgres_cdc', 'input', ['change-data-capture']),
    row('kafka', 'input', ['stream-processing']),
    row('kafka', 'output', ['change-data-capture']),
    row('stdout', 'output', [])
  ]

  test('renders a Use case filter with the taxonomy labels, nothing checked', () => {
    const html = renderComponentTable({ csvData: data(ROWS, USE_CASES) })
    expect(html).toContain('<label for="useCaseFilterToggle">Use case:</label>')
    expect(html).toMatch(/id="useCaseFilterToggle" aria-expanded="false" aria-haspopup="true" aria-controls="useCaseFilterMenu"/)
    expect(html).toContain('<span class="dropdown-text">All Use Cases</span>')
    const menu = html.slice(html.indexOf('id="useCaseFilterMenu"'), html.indexOf('</div>', html.indexOf('id="useCaseFilterMenu"')))
    expect(menu).toContain('<input type="checkbox" value="change-data-capture">')
    expect(menu).toContain('<span>Change data capture</span>')
    expect(menu).toContain('<span>Stream processing</span>')
    expect(menu).not.toContain('checked')
  })

  test('puts the union of a connector\'s use cases on its card, as data and chips', () => {
    const html = renderComponentTable({ csvData: data(ROWS, USE_CASES) })
    const kafka = cardFor(html, 'kafka')
    expect(kafka).toContain('data-use-cases="stream-processing,change-data-capture"')
    expect(kafka).toContain('<span class="badge-group-label">Use case</span>')
    expect(kafka).toContain('<span class="badge badge-use-case" title="Use case: Stream processing">Stream processing</span>')
    const stdout = cardFor(html, 'stdout')
    expect(stdout).not.toContain('data-use-cases')
    expect(stdout).not.toContain('Use case')
  })

  test('renders the solutions panel with the catalog URL from the site root', () => {
    const html = renderComponentTable({ csvData: data(ROWS, USE_CASES), rootPath: '../..' })
    expect(html).toContain('id="componentCatalogSolutions"')
    expect(html).toContain('data-solutions-url="../../assets/data/solutions.json"')
    expect(html).toContain('window.updateCatalogSolutions = function')
  })

  test('hides the filter and the panel when no component has a use case', () => {
    for (const csvData of [data(ROWS.map((r) => ({ ...r, use_cases: [] })), []), data(ROWS, undefined)]) {
      const html = renderComponentTable({ csvData })
      expect(html).not.toContain('id="useCaseFilterToggle"')
      expect(html).not.toContain('id="componentCatalogSolutions"')
      expect(html).not.toContain('class="badge badge-use-case"')
      expect(html).not.toContain('window.updateCatalogSolutions = function')
    }
  })

  test('offers only the use cases of cards shown in the Cloud view', () => {
    const rows = [row('postgres_cdc', 'input', ['change-data-capture']), row('local_only', 'input', ['stream-processing'], { is_cloud_supported: 'n' })]
    const html = renderComponentTable({ csvData: data(rows, USE_CASES), attributes: {}, docAttributes: { 'env-cloud': '' } })
    expect(html).toContain('value="change-data-capture"')
    expect(html).not.toContain('value="stream-processing"')
  })

  test('escapes hostile IDs and labels everywhere they appear', () => {
    const hostile = { id: 'x"><script>alert(1)</script>', label: '<img src=x onerror=alert(1)> & "Co"' }
    const html = renderComponentTable({ csvData: data([row('evil', 'input', [hostile.id])], [hostile]) })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain(`value="${escapeHtml(hostile.id)}"`)
    expect(html).toContain(`<span>${escapeHtml(hostile.label)}</span>`)
    expect(html).toContain(`data-use-cases="${escapeHtml(hostile.id)}"`)
    expect(html).toContain(`data-use-case-labels="${escapeHtml(JSON.stringify({ [hostile.id]: hostile.label }))}"`)
  })

  describe('solutions for a use case', () => {
    // Shaped like assets/data/solutions.json from the solutions-catalog extension
    const CATALOG = {
      solutions: [
        { id: 'cdc-to-lakehouse', title: 'CDC to lakehouse', url: '/solutions/cdc-to-lakehouse/', status: 'published', useCases: ['Change data capture'], concepts: { useCases: [{ value: 'Change data capture', id: 'change-data-capture', label: 'Change data capture' }] } },
        { id: 'authored-id', title: 'Authored by ID', url: '/solutions/authored-id/', status: 'published', useCases: ['change-data-capture'] },
        { id: 'label-only', title: 'Label only', url: '/solutions/label-only/', status: 'published', useCases: ['Change data capture'] },
        { id: 'old', title: 'Old', url: '/solutions/old/', status: 'deprecated', useCases: ['change-data-capture'] },
        { id: 'fanout', title: 'Fan-out', url: '/solutions/fanout/', status: 'published', concepts: { useCases: [{ id: 'data-fan-out' }] } }
      ]
    }

    test('matches on taxonomy IDs, not labels, and leaves out deprecated solutions', () => {
      expect(matchSolutions(CATALOG, ['change-data-capture']).map((s) => s.id)).toEqual(['cdc-to-lakehouse', 'authored-id'])
      expect(matchSolutions(CATALOG, ['stream-processing'])).toEqual([])
      expect(matchSolutions(CATALOG, [])).toEqual([])
    })

    test('has nothing to show without a catalog', () => {
      for (const catalog of [null, undefined, {}, { solutions: 'nope' }]) {
        expect(matchSolutions(catalog, ['change-data-capture'])).toEqual([])
      }
      expect(solutionsMarkup([], ['change-data-capture'], {}, escapeHtml)).toBe('')
    })

    test('renders a heading with the use case label and one link per solution', () => {
      const html = solutionsMarkup(matchSolutions(CATALOG, ['change-data-capture']), ['change-data-capture'], { 'change-data-capture': 'Change data capture' }, escapeHtml)
      expect(html).toBe(
        '<h3 class="catalog-solutions-title">Solutions for Change data capture</h3>' +
        '<ul class="catalog-solutions-list">' +
        '<li><a href="/solutions/cdc-to-lakehouse/">CDC to lakehouse</a></li>' +
        '<li><a href="/solutions/authored-id/">Authored by ID</a></li>' +
        '</ul>'
      )
    })

    test('escapes solution titles and URLs', () => {
      const html = solutionsMarkup([{ title: '<b>x</b>', url: '"><script>alert(1)</script>' }], ['a'], { a: '<i>A</i>' }, escapeHtml)
      expect(html).not.toMatch(/<script>|<b>|<i>/)
      expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
      expect(html).toContain('Solutions for &lt;i&gt;A&lt;/i&gt;')
    })
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
