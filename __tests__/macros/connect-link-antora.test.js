'use strict'

// connect: and blobl: through Antora's own content catalog, AsciiDoc loader
// and HTML converter: page aliases resolve as Antora resolves them, and the
// macros' xref nodes become links, anchors included, exactly as xref:[] in
// the source does. No logger mock here: the loader needs the real one.

const ContentCatalog = require('@antora/content-classifier/content-catalog')
const loadAsciiDoc = require('@antora/asciidoc-loader')
const { SAMPLE, PAGES } = require('../helpers/connect-links-catalog')

function antoraCatalog () {
  // The site's URL style: docs.redpanda.com publishes /page/ URLs.
  const catalog = new ContentCatalog({ urls: { htmlExtensionStyle: 'indexify' } })
  catalog.registerComponentVersion('connect', '', { title: 'Connect' })
  catalog.registerComponentVersion('cloud-data-platform', '', { title: 'Cloud', asciidoc: { attributes: { 'env-cloud': '' } } })
  catalog.registerComponentVersion('streaming', '26.2', { title: 'Streaming' })
  const add = (src, contents) => catalog.addFile({ contents: Buffer.from(contents), src: { ...src, family: src.family || 'page', mediaType: 'text/asciidoc', path: `modules/${src.module}/pages/${src.relative}` } })
  catalog.addFile({ contents: SAMPLE, src: { component: 'connect', version: '', module: 'components', family: 'attachment', relative: 'connect-4.115.1.json', mediaType: 'application/json', path: 'modules/components/attachments/connect-4.115.1.json' } })
  for (const [relative, text] of Object.entries(PAGES.partials)) {
    catalog.addFile({ contents: Buffer.from(text), src: { component: 'connect', version: '', module: 'components', family: 'partial', relative, mediaType: 'text/asciidoc', path: `modules/components/partials/${relative}` } })
  }
  for (const component of ['connect', 'cloud-data-platform']) {
    for (const p of PAGES[component]) {
      const key = p.relative.replace(/\.adoc$/, '')
      const page = add({ component, version: '', module: p.module, relative: p.relative }, (component === 'connect' ? PAGES.sources[key] : PAGES['cloud-sources'][p.relative]) || `= ${p.relative}\n`)
      for (const alias of p.aliases) catalog.registerPageAlias(alias, page)
    }
  }
  return catalog
}

function render (line, component = 'streaming', version = component === 'streaming' ? '26.2' : '', catalog = antoraCatalog()) {
  const file = {
    contents: Buffer.from(`= Example\n\n${line}`),
    src: { component, version, module: 'manage', family: 'page', relative: 'example.adoc', path: 'modules/manage/pages/example.adoc' },
    pub: { url: `/${component}/manage/example/`, moduleRootPath: '..' },
  }
  return loadAsciiDoc(file, catalog, { extensions: [require('../../macros/prop')] }).convert()
}

const hrefs = (html) => [...html.matchAll(/<a href="([^"]+)" class="xref page">/g)].map((m) => m[1])

test('a component and its fields link the connect pages, with the anchors the reference generates', () => {
  const html = render([
    'connect:[inputs/kafka_franz]',
    'connect:[inputs/kafka_franz.consumer_group]',
    'connect:[inputs/kafka_franz.sasl.mechanism]',
    'connect:[outputs/amqp_1.metadata]',
    'connect:[inputs/jira.fields]',
    'connect:[inputs/pg_stream]',
    'connect:[processors/nats_request_reply.metadata]',
  ].join('\n'))
  expect(hrefs(html)).toEqual([
    '../../../connect/components/inputs/kafka_franz/',
    '../../../connect/components/inputs/kafka_franz/#consumer_group',
    '../../../connect/components/inputs/kafka_franz/#sasl-mechanism',
    '../../../connect/components/outputs/amqp_1/#metadata-2',
    '../../../connect/components/inputs/jira/#fields-2',
    '../../../connect/components/inputs/postgres_cdc/',
    '../../../connect/components/processors/nats_request_reply/#metadata-2',
  ])
})

test('from Cloud, a component whose removed stub now aliases the about page renders unlinked', () => {
  // cloud-docs d9be410 modules/develop/pages/connect/components/processors/about.adoc:2
  // declares components:processors/protobuf.adoc as an alias.
  const html = render('connect:[processors/protobuf] connect:[processors/protobuf.operator]', 'cloud-data-platform')
  expect(hrefs(html)).toEqual([])
  expect(html).toContain('<code>protobuf</code> processor')
  expect(html).not.toContain('processors/about/')
})

test('from Cloud, the links go to the Cloud stubs through their page aliases', () => {
  const html = render('connect:[inputs/kafka_franz.consumer_group] blobl:[now()]', 'cloud-data-platform')
  expect(hrefs(html)).toEqual([
    '../../develop/connect/components/inputs/kafka_franz/#consumer_group',
    '../../develop/connect/guides/bloblang/functions/#now',
  ])
})

test('Bloblang functions and methods link their anchors, the second category copy numbered', () => {
  const html = render('blobl:[now()] blobl:[.uppercase()] blobl:[.contains()] blobl:[.contains(),category=String Manipulation] blobl:[.length()] blobl:[counter(min)]')
  expect(hrefs(html)).toEqual([
    '../../../connect/guides/bloblang/functions/#now',
    '../../../connect/guides/bloblang/methods/#uppercase',
    '../../../connect/guides/bloblang/methods/#contains',
    '../../../connect/guides/bloblang/methods/#contains-2',
    '../../../connect/guides/bloblang/methods/#length',
    '../../../connect/guides/bloblang/functions/#counter',
  ])
})

test('from Cloud, a stub whose page-aliases has no components: path links by the connect page it includes, even once converted', () => {
  // cloud-docs d9be410 modules/develop/pages/connect/components/inputs/postgres_cdc.adoc
  // declares only develop:connect/components/inputs/pg_stream.adoc and
  // includes connect:components:inputs/postgres_cdc.adoc[tag=single-source].
  const catalog = antoraCatalog()
  const stub = catalog.getById({ component: 'cloud-data-platform', version: '', module: 'develop', family: 'page', relative: 'connect/components/inputs/postgres_cdc.adoc' })
  // Convert the stub first, as Antora's convertDocument may: load it with
  // the extensions, convert it, and replace its contents with the HTML.
  stub.path = stub.src.path
  stub.contents = Buffer.from(loadAsciiDoc(stub, catalog, { extensions: [require('../../macros/prop')] }).convert())
  expect(String(stub.contents)).not.toContain('include::')
  const html = render('connect:[inputs/postgres_cdc] connect:[inputs/pg_stream] connect:[inputs/redpanda]', 'cloud-data-platform', '', catalog)
  expect(hrefs(html)).toEqual([
    '../../develop/connect/components/inputs/postgres_cdc/',
    '../../develop/connect/components/inputs/postgres_cdc/',
    '../../develop/connect/components/inputs/redpanda/',
  ])
})
