'use strict'

const extension = require('../../extensions/convert-llms-to-txt')

// Drives the extension's own listeners with a minimal content and site
// catalog, so the test covers the beforePublish control flow rather than the
// helpers alone.
function run ({ components, pages }) {
  const handlers = {}
  const noop = () => {}
  const context = {
    getLogger: () => ({ info: noop, warn: noop, debug: noop, error: noop }),
    on: (event, fn) => { handlers[event] = fn },
  }
  extension.register.call(context)
  handlers.playbookBuilt({ playbook: { site: { url: 'https://docs.example.com' } } })
  const files = []
  const contentCatalog = {
    getComponents: () => components,
    getPages: (filter) => pages.filter(filter),
    findBy: () => [],
  }
  const siteCatalog = { addFile: (file) => files.push(file), getFiles: () => files }
  handlers.beforePublish({ contentCatalog, siteCatalog })
  return files.map((f) => f.out.path)
}

const page = (version, url, relative) => ({
  src: { component: 'streaming', version, module: 'manage', relative, stem: relative.replace(/\.adoc$/, '') },
  pub: { url },
  out: { path: url },
  markdownContents: Buffer.from('# Page'),
  asciidoc: { doctitle: 'Page', attributes: {} },
})

const components = [{
  name: 'streaming',
  title: 'Redpanda Streaming',
  latest: { version: '26.2' },
  versions: [{ version: '26.2' }, { version: '26.1' }],
}]

describe('convert-llms-to-txt beforePublish', () => {
  it('still writes page indexes for older versions when the latest version has no markdown', () => {
    const paths = run({ components, pages: [page('26.1', '/streaming/26.1/manage/tiered-storage/', 'tiered-storage.adoc')] })
    expect(paths).toContain('streaming/26.1/llms.txt')
    expect(paths).not.toContain('llms-full.txt')
  })

  it('writes the full exports and the indexes when the latest version has markdown', () => {
    const paths = run({
      components,
      pages: [
        page('26.2', '/streaming/current/manage/tiered-storage/', 'tiered-storage.adoc'),
        page('26.1', '/streaming/26.1/manage/tiered-storage/', 'tiered-storage.adoc'),
      ],
    })
    expect(paths).toEqual(expect.arrayContaining(['llms-full.txt', 'streaming-full.txt', 'streaming/current/llms.txt', 'streaming/26.1/llms.txt']))
  })
})
