'use strict'

const extension = require('../../extensions/convert-sitemap-to-markdown')

// Runs the beforePublish handler against an in-memory site and content
// catalog and returns the Markdown sitemap it writes.
async function run (sitemapXml, pages) {
  const handlers = {}
  const noop = () => {}
  const context = {
    getLogger: () => ({ info: noop, warn: noop, debug: noop, error: noop }),
    on: (event, fn) => { handlers[event] = fn },
  }
  extension.register.call(context, { config: {} })

  const files = [{ out: { path: 'sitemap-test.xml' }, contents: Buffer.from(sitemapXml) }]
  const siteCatalog = {
    getFiles: () => files,
    addFile: (file) => files.push(file),
  }
  const contentCatalog = { getPages: (filter) => pages.filter(filter) }
  await handlers.beforePublish({ playbook: {}, siteCatalog, contentCatalog })
  return files.find((f) => f.out.path === 'sitemap-test.md').contents.toString('utf8')
}

const sitemap = (...locs) =>
  `<?xml version="1.0"?><urlset>${locs
    .map((loc) => `<url><loc>${loc}</loc><lastmod>2026-10-19</lastmod></url>`)
    .join('')}</urlset>`

const page = (url, doctitle, description) => ({
  pub: { url },
  out: { path: url },
  asciidoc: { doctitle, attributes: description ? { description } : {} },
})

describe('convert-sitemap-to-markdown', () => {
  it('uses the page title and description for HTML and Markdown URLs', async () => {
    const markdown = await run(
      sitemap(
        'https://docs.example.com/adp/reference/rpk-ai-trigger-delete/',
        'https://docs.example.com/adp/reference/rpk-ai-trigger-delete.md'
      ),
      [page('/adp/reference/rpk-ai-trigger-delete/', 'rpk ai trigger delete', 'Delete one trigger. &lt;name&gt; is the <code>full</code> resource name.')]
    )
    const line = '[rpk ai trigger delete](https://docs.example.com/adp/reference/rpk-ai-trigger-delete%s): Delete one trigger. <name> is the full resource name. (modified: 2026-10-19)'
    expect(markdown).toContain(`- ${line.replace('%s', '/')}`)
    expect(markdown).toContain(`- ${line.replace('%s', '.md')}`)
  })

  it('escapes brackets in titles so the link parses', async () => {
    const markdown = await run(sitemap('https://docs.example.com/adp/k8s/'), [page('/adp/k8s/', 'Deploy on [K8s]')])
    expect(markdown).toContain('- [Deploy on \\[K8s\\]](https://docs.example.com/adp/k8s/) (modified: 2026-10-19)')
  })

  it('falls back to a title from the URL for pages not in the content catalog', async () => {
    const markdown = await run(sitemap('https://docs.example.com/adp/some-other-page/'), [])
    expect(markdown).toContain('- [Some Other Page](https://docs.example.com/adp/some-other-page/) (modified: 2026-10-19)')
  })
})
