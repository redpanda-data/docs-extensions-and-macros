'use strict'

// rpkcmd: through Antora's own AsciiDoc loader and HTML converter, which turn
// the macro's xref node into a link exactly as they do for xref:[] in the
// source. No logger mock here: the loader needs the real one.

const fs = require('fs')
const path = require('path')
const loadAsciiDoc = require('@antora/asciidoc-loader')

const SAMPLE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'rpkval', 'rpk-v26.2.2-sample.json'))

test('Antora resolves the rpkcmd: link to the page\'s published URL, relative to the page', () => {
  const page = {
    src: { component: 'streaming', version: '26.2', module: 'reference', family: 'page', relative: 'rpk/rpk-topic/rpk-topic-create.adoc' },
    pub: { url: '/streaming/reference/rpk/rpk-topic/rpk-topic-create/' },
  }
  const files = [{ src: { component: 'streaming', version: '26.2', module: 'reference', family: 'attachment', relative: 'rpk-v26.2.2.json' }, contents: SAMPLE }, page]
  const asked = []
  const catalog = {
    findBy: (query) => files.filter((file) => Object.entries(query).every(([key, value]) => file.src[key] === value)),
    getComponent: (name) => (name === 'streaming' ? { name, versions: [{ version: '26.2', asciidoc: { attributes: {} } }], latest: { version: '26.2', asciidoc: { attributes: {} } } } : undefined),
    resolveResource: (spec) => {
      asked.push(spec)
      return spec === '26.2@streaming:reference:rpk/rpk-topic/rpk-topic-create.adoc' ? page : undefined
    },
  }
  const file = {
    contents: Buffer.from('= Example\n\nRun rpkcmd:[rpk topic create].'),
    src: { component: 'streaming', version: '26.2', module: 'manage', family: 'page', relative: 'example.adoc', path: 'modules/manage/pages/example.adoc' },
    pub: { url: '/streaming/manage/example/', moduleRootPath: '..' },
  }
  const html = loadAsciiDoc(file, catalog, { extensions: [require('../../macros/prop')] }).convert()
  expect(asked).toEqual(['26.2@streaming:reference:rpk/rpk-topic/rpk-topic-create.adoc'])
  expect(html).toContain('<a href="../../reference/rpk/rpk-topic/rpk-topic-create/" class="xref page"><code class="rpk-command" data-rpk-command="rpk topic create">rpk topic create</code></a>')
})
