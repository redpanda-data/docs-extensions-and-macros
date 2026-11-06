/**
 * @jest-environment node
 */

const TurndownService = require('turndown')
const turndownPluginGfm = require('turndown-plugin-gfm')
const { gfm } = turndownPluginGfm
const path = require('path')

// --- Minimal reproduction of the link conversion rule from the extension
function createTurndownForPage({ siteUrl, page, playbook }) {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    linkReferenceStyle: 'full',
  })
  td.remove('script')
  td.use(gfm)

  // Compute base URL for relative → absolute links
  let pageBase = null
  if (siteUrl && page?.out?.path) {
    try {
      let pubUrl = page?.pub?.url
      if (pubUrl && !pubUrl.endsWith('/')) pubUrl += '/'
      const siteBase = siteUrl.endsWith('/') ? siteUrl : siteUrl + '/'
      pageBase = new URL(pubUrl || '', siteBase)
    } catch {
      pageBase = null
    }
  }

  td.addRule('absolute-links', {
    filter: 'a',
    replacement: function (content, node) {
      const href = node.getAttribute('href') || ''
      const text = content || node.textContent || ''
      if (!href) return `[${text}]()`

      // Anchors and full URLs unchanged
      if (href.startsWith('#') || /^(?:[a-z]+:)?\/\//i.test(href))
        return `[${text}](${href})`

      // /api/ links → prepend siteUrl
      if (/^\/api\//i.test(href)) {
        const base = siteUrl
          ? siteUrl.endsWith('/')
            ? siteUrl.slice(0, -1)
            : siteUrl
          : ''
        const fullApiUrl = base + href
        return `[${text}](${fullApiUrl})`
      }

      if (!siteUrl || !pageBase) return `[${text}](${href})`

      try {
        const urlObj = new URL(href, pageBase)
        const htmlStyle = playbook?.urls?.htmlExtensionStyle
        const isIndexify = htmlStyle === 'indexify'
        const pathname = urlObj.pathname

        if (isIndexify) {
          const looksLikeDir =
            pathname.endsWith('/') ||
            !path.basename(pathname).includes('.')

          if (looksLikeDir) {
            urlObj.pathname = pathname.replace(/\/?$/, '/index.md')
          } else {
            urlObj.pathname = pathname.replace(/\.html$/, '.md')
          }
        } else {
          urlObj.pathname = pathname.replace(/\.html$/, '.md')
        }

        return `[${text}](${urlObj.toString()})`
      } catch {
        return `[${text}](${href})`
      }
    },
  })

  return td
}

// --- TESTS ---
describe('absolute-links rule (from extension)', () => {
  const siteUrl = 'https://example.com/'
  const page = { out: { path: 'docs/guide.html' }, pub: { url: 'docs/guide/' } }

  test('converts relative .html to .md', () => {
    const html = `<a href="../intro.html">Intro</a>`
    const td = createTurndownForPage({ siteUrl, page })
    const result = td.turndown(html)
    expect(result).toBe('[Intro](https://example.com/docs/intro.md)')
  })

  test('converts .html#anchor → .md#anchor', () => {
    const html = `<a href="../overview.html#details">Overview</a>`
    const td = createTurndownForPage({ siteUrl, page })
    const result = td.turndown(html)
    expect(result).toBe('[Overview](https://example.com/docs/overview.md#details)')
  })

  test('converts .html?query=1#anchor → .md?query=1#anchor', () => {
    const html = `<a href="../overview.html?lang=en#intro">Overview</a>`
    const td = createTurndownForPage({ siteUrl, page })
    const result = td.turndown(html)
    expect(result).toBe('[Overview](https://example.com/docs/overview.md?lang=en#intro)')
  })

  test('converts folder → index.md (indexify=true)', () => {
    const html = `<a href="../getting-started/">Get Started</a>`
    const td = createTurndownForPage({
      siteUrl,
      page,
      playbook: { urls: { htmlExtensionStyle: 'indexify' } },
    })
    const result = td.turndown(html)
    expect(result).toBe('[Get Started](https://example.com/docs/getting-started/index.md)')
  })

  test('replaces .html → .md (indexify=false)', () => {
    const html = `<a href="../install.html">Install</a>`
    const td = createTurndownForPage({
      siteUrl,
      page,
      playbook: { urls: { htmlExtensionStyle: 'default' } },
    })
    const result = td.turndown(html)
    expect(result).toBe('[Install](https://example.com/docs/install.md)')
  })

  test('prefixes /api/ links with siteUrl', () => {
    const html = `<a href="/api/doc/schema-registry/">Schema Registry</a>`
    const td = createTurndownForPage({ siteUrl, page })
    const result = td.turndown(html)
    expect(result).toBe('[Schema Registry](https://example.com/api/doc/schema-registry/)')
  })

  test('keeps anchor-only links', () => {
    const html = `<a href="#section-2">Jump</a>`
    const td = createTurndownForPage({ siteUrl, page })
    const result = td.turndown(html)
    expect(result).toBe('[Jump](#section-2)')
  })

  test('keeps external URLs untouched', () => {
    const html = `<a href="https://github.com/redpanda-data">GitHub</a>`
    const td = createTurndownForPage({ siteUrl, page })
    const result = td.turndown(html)
    expect(result).toBe('[GitHub](https://github.com/redpanda-data)')
  })
})

describe('H1 and frontmatter placement', () => {
  function processMarkdownWithFrontmatter(markdown, frontmatter) {
    // Simulate the logic from convert-to-markdown.js lines 493-513
    const h1Match = markdown.match(/^(#\s+.+?)(\n|$)/)
    let h1Heading = ''
    let restOfMarkdown = markdown

    if (h1Match) {
      h1Heading = h1Match[0]
      restOfMarkdown = markdown.substring(h1Match[0].length).trimStart()
    }

    // Simplified: just frontmatter placement (matches line 513 logic)
    let result
    if (frontmatter) {
      result = `${h1Heading}\n${frontmatter}${restOfMarkdown}`
    } else {
      result = markdown
    }

    // Apply cleanup logic (lines 517-523)
    if (result) {
      result = result.replace(/\n{3,}/g, '\n\n')
      result = result.replace(/[ \t]+$/gm, '')
      result = result.trim()
    }

    return result
  }

  const frontmatter = '---\ntitle: Test\n---\n'

  test('places frontmatter after H1 at document start', () => {
    const markdown = '# Heading\n\nSome content'
    const result = processMarkdownWithFrontmatter(markdown, frontmatter)
    expect(result).toBe('# Heading\n\n---\ntitle: Test\n---\nSome content')
  })

  test('places frontmatter at top when no H1', () => {
    const markdown = 'Some content without heading'
    const result = processMarkdownWithFrontmatter(markdown, frontmatter)
    expect(result).toBe('---\ntitle: Test\n---\nSome content without heading')
  })

  test('does not match H1 later in document (bug fix)', () => {
    const markdown = 'Intro text\n\n# Heading Later\n\nMore content'
    const result = processMarkdownWithFrontmatter(markdown, frontmatter)
    // Should place frontmatter at top since H1 is not at document start
    expect(result).toBe('---\ntitle: Test\n---\nIntro text\n\n# Heading Later\n\nMore content')
  })

  test('handles H1 with double newline separator', () => {
    const markdown = '# Heading\n\nParagraph one\n\nParagraph two'
    const result = processMarkdownWithFrontmatter(markdown, frontmatter)
    expect(result).toBe('# Heading\n\n---\ntitle: Test\n---\nParagraph one\n\nParagraph two')
  })
})

// The enterprise signal is CSS-only in HTML: the badge comes from the span's
// class and the explanation from a title tooltip, and Turndown keeps neither.
// These tests use the rule the extension actually registers, not a local
// reproduction, so they fail if the real rule regresses.
describe('enterprise feature marker in Markdown', () => {
  const {
    createEnterpriseFeatureRules,
  } = require('../../extensions/convert-to-markdown')

  function convert(html) {
    const td = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    })
    td.use(gfm)
    const rules = createEnterpriseFeatureRules()
    td.addRule('enterprise-feature', rules.enterpriseFeature)
    td.addRule('beta-badge', rules.betaBadge)
    return td.turndown(html)
  }

  test('marks a linked enterprise feature and keeps the link', () => {
    const html =
      '<p>Enable <span class="enterprise-feature" title="Iceberg Topics requires an Enterprise Edition license.">' +
      '<a href="../iceberg/about/">Iceberg Topics</a></span> to write to tables.</p>'
    expect(convert(html)).toBe(
      'Enable [Iceberg Topics](../iceberg/about/) (enterprise) to write to tables.'
    )
  })

  test('marks an unlinked enterprise feature', () => {
    const html =
      '<p>Enable <span class="enterprise-feature" title="Tiered Storage requires an Enterprise Edition license.">' +
      'Tiered Storage</span> first.</p>'
    expect(convert(html)).toBe('Enable Tiered Storage (enterprise) first.')
  })

  test('honors a custom enterprise-feature-role class', () => {
    // The macro allows overriding the class via enterprise-feature-role, so a
    // substring match keeps the marker working for renamed roles.
    const html =
      '<p>Uses <span class="rp-enterprise-feature-badge">Audit Logs</span>.</p>'
    expect(convert(html)).toBe('Uses Audit Logs (enterprise).')
  })

  test('does not double-mark content that already ends with the marker', () => {
    const html =
      '<p><span class="enterprise-feature">' +
      '<span class="enterprise-feature">Tiered Storage</span></span></p>'
    expect(convert(html)).toBe('Tiered Storage (enterprise)')
  })

  test('drops an empty enterprise span instead of emitting a bare marker', () => {
    const html = '<p>Nothing here <span class="enterprise-feature"></span>.</p>'
    expect(convert(html)).toBe('Nothing here .')
  })

  test('leaves ordinary spans untouched', () => {
    const html = '<p>Just <span class="other">text</span> here.</p>'
    expect(convert(html)).toBe('Just text here.')
  })
})

// A beta enterprise feature carries two markers in HTML. Emitting them
// separately read as "Stretch Clusters (enterprise) (beta)", so they collapse
// into one parenthetical.
describe('combined status markers in Markdown', () => {
  const {
    createEnterpriseFeatureRules,
    formatStatusMarker,
  } = require('../../extensions/convert-to-markdown')

  function convert(html) {
    const td = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    })
    td.use(gfm)
    const rules = createEnterpriseFeatureRules()
    td.addRule('enterprise-feature', rules.enterpriseFeature)
    td.addRule('beta-badge', rules.betaBadge)
    return td.turndown(html)
  }

  const betaBadge = '<span class="badge badge--beta ">(beta)</span>'

  test('merges an enterprise feature and a following beta badge', () => {
    const html =
      '<p>Enable <span class="enterprise-feature" title="x">' +
      '<a href="../stretch/">Stretch Clusters</a></span> ' + betaBadge + ' today.</p>'
    expect(convert(html)).toBe(
      'Enable [Stretch Clusters](../stretch/) (enterprise, beta) today.'
    )
  })

  test('leaves exactly one space around the merged marker', () => {
    const html =
      '<p>Enable <span class="enterprise-feature">Stretch Clusters</span> ' +
      betaBadge + ' today.</p>'
    // Suppressing the badge and marking the span instead left a doubled space.
    expect(convert(html)).not.toMatch(/ {2}/)
  })

  test('marks a beta badge that stands alone', () => {
    expect(convert('<p>Feature ' + betaBadge + ' here.</p>')).toBe(
      'Feature (beta) here.'
    )
  })

  test('does not merge a badge that is not adjacent to the feature', () => {
    const html =
      '<p><span class="enterprise-feature">Tiered Storage</span> and other text ' +
      betaBadge + '.</p>'
    expect(convert(html)).toBe(
      'Tiered Storage (enterprise) and other text (beta).'
    )
  })

  test('formatStatusMarker joins statuses and drops empties', () => {
    expect(formatStatusMarker(['enterprise', 'beta'])).toBe('(enterprise, beta)')
    expect(formatStatusMarker(['enterprise'])).toBe('(enterprise)')
    expect(formatStatusMarker([])).toBe('')
    expect(formatStatusMarker([null, 'beta'])).toBe('(beta)')
  })
})

describe('generated content provenance', () => {
  const {
    readGeneratedMarker,
    findIncludeTargets,
    collectGeneratedProvenance,
  } = require('../../extensions/convert-to-markdown')

  const STANDARD = '// This content is autogenerated. Do not edit manually. Generated by doc-tools (property-docs) from the configuration property definitions in redpanda-data/streaming-enterprise. To change a description, edit docs-data/property-overrides.json and regenerate.\n// tag::category-redpanda[]\n=== admin\n'
  const LEGACY = '= rpk check install\n:description: x\n\n// This content is autogenerated. Do not edit manually. To customize content, see the writer\'s guide.\n'
  const HAND_WRITTEN = '= A page\n\nSome prose.\n\n// a plain comment\n'

  test('reads the standard marker with generator and source', () => {
    expect(readGeneratedMarker(Buffer.from(STANDARD))).toEqual({
      note: expect.stringContaining('Generated by doc-tools (property-docs)'),
      generator: 'property-docs',
      version: null,
      source: 'the configuration property definitions in redpanda-data/streaming-enterprise',
    })
  })

  test('reads the version from a marker written before the version was dropped', () => {
    const versioned = '// This content is autogenerated. Do not edit manually. Generated by doc-tools 5.55.0 (rpk-docs) from the rpk command help in redpanda-data/streaming-enterprise. See the guide.\n'
    expect(readGeneratedMarker(versioned)).toEqual({
      note: expect.stringContaining('doc-tools 5.55.0 (rpk-docs)'),
      generator: 'rpk-docs',
      version: '5.55.0',
      source: 'the rpk command help in redpanda-data/streaming-enterprise',
    })
  })

  test('reads a legacy marker below the header, with no generator or source', () => {
    expect(readGeneratedMarker(LEGACY)).toEqual({
      note: expect.stringContaining('This content is autogenerated'),
      generator: null,
      version: null,
      source: null,
    })
  })

  test("reads connect's own docs_gen banner: source, no generator", () => {
    const connect = '// This content is autogenerated from the component specs in https://github.com/redpanda-data/connect. Do not edit manually.\n// tag::meta[]\n'
    expect(readGeneratedMarker(connect)).toEqual({
      note: expect.stringContaining('autogenerated from the component specs'),
      generator: null,
      version: null,
      source: 'the component specs in https://github.com/redpanda-data/connect',
    })
  })

  test('reads the other marker forms the docs repos carry', () => {
    for (const line of [
      '// AUTO-GENERATED FILE. DO NOT EDIT.',
      '// Autogenerated documentation. Do not edit this page See https://github.com/redpanda-data/docs/blob/main/.github/workflows/generate-crd.yml.',
      '// Generated by `doc-tools validate enterprise-features --write-mapping`. Do not edit.',
    ]) {
      expect(readGeneratedMarker(line + '\n')).not.toBeNull()
    }
  })

  test('ignores a prose comment that only mentions generation', () => {
    expect(readGeneratedMarker('= A page\n\n// Table generated by the build\n')).toBeNull()
    expect(readGeneratedMarker('// The anchor: macros preserve the auto-generated IDs\n')).toBeNull()
  })

  test('ignores files with no marker in their first lines', () => {
    expect(readGeneratedMarker(HAND_WRITTEN)).toBeNull()
    expect(readGeneratedMarker('')).toBeNull()
    expect(readGeneratedMarker(null)).toBeNull()
    // Past the scan window: a marker deep in the file is not a file marker
    expect(readGeneratedMarker('a\n'.repeat(40) + STANDARD)).toBeNull()
  })

  test('finds include targets once each and skips attribute references', () => {
    const src = [
      '= Page',
      'include::partial$a.adoc[tag=x]',
      'include::connect:components:partial$descriptions/inputs/postgres_cdc.adoc[tag=meta]',
      'include::partial$a.adoc[tag=y]',
      'include::{attachmentsdir}/foo.yaml[]',
      'text that mentions include::not-at-line-start.adoc[]',
    ].join('\n')
    expect(findIncludeTargets(src)).toEqual([
      'partial$a.adoc',
      'connect:components:partial$descriptions/inputs/postgres_cdc.adoc',
    ])
  })

  test('collects the page marker and the markers of generated includes', () => {
    const page = {
      src: { component: 'connect', version: 'master', module: 'components', family: 'page', relative: 'inputs/x.adoc' },
      contents: Buffer.from('= x\ninclude::connect:components:partial$descriptions/inputs/x.adoc[tag=meta]\ninclude::partial$hand.adoc[]\ninclude::partial$missing.adoc[]\n'),
    }
    const resources = {
      'connect:components:partial$descriptions/inputs/x.adoc': { contents: Buffer.from('// This content is autogenerated. Do not edit manually. Generated by doc-tools (rpcn-connector-docs) from the component spec in redpanda-data/connect. More.\n') },
      'partial$hand.adoc': { contents: Buffer.from('Hand-written partial.\n') },
    }
    const contentCatalog = {
      resolveResource: (spec, ctx, family, permitted) => {
        expect(ctx).toBe(page.src)
        expect(family).toBe('partial')
        expect(permitted).toEqual(['partial', 'page', 'example'])
        return resources[spec]
      },
    }
    const provenance = collectGeneratedProvenance(page, contentCatalog)
    expect(provenance.page).toBeNull()
    expect(provenance.includes).toEqual([
      {
        include: 'connect:components:partial$descriptions/inputs/x.adoc',
        generator: 'rpcn-connector-docs',
        version: null,
        source: 'the component spec in redpanda-data/connect',
        note: expect.stringContaining('Generated by doc-tools (rpcn-connector-docs)'),
      },
    ])
  })

  test('survives a catalog that throws on an unresolvable include', () => {
    const page = { src: {}, contents: 'include::bogus::spec[]\n' }
    const contentCatalog = { resolveResource: () => { throw new Error('bad spec') } }
    expect(collectGeneratedProvenance(page, contentCatalog)).toEqual({ page: null, includes: [] })
  })

  test("a legacy banner's prose is not read as its source", () => {
    // The old Connect description partial banner says "come from" later on.
    const old = "// This content is autogenerated. Do not edit manually. The summary and description come from the connector's definition in the Connect source.\n"
    expect(readGeneratedMarker(old)).toMatchObject({ generator: null, source: null })
    // A "from" after the hint is not the source either
    const hinted = '// This content is autogenerated. Do not edit manually. Generated by doc-tools (rpk-docs) from the rpk command help. Text that comes from elsewhere.\n'
    expect(readGeneratedMarker(hinted).source).toBe('the rpk command help')
  })

  test('a non-version token after doc-tools still yields the generator', () => {
    const unknown = '// This content is autogenerated. Do not edit manually. Generated by doc-tools unknown (rpk-docs) from the rpk command help.\n'
    expect(readGeneratedMarker(unknown)).toMatchObject({ generator: 'rpk-docs', version: null, source: 'the rpk command help' })
    const v = '// Generated by doc-tools v5.55.0 (metrics-docs) from the metrics.\n'
    expect(readGeneratedMarker(v)).toMatchObject({ generator: 'metrics-docs', version: '5.55.0' })
  })

  test('a hand-written comment that starts with "Generated by" is not a marker', () => {
    expect(readGeneratedMarker('// Generated by running rpk cluster info, then edited\n')).toBeNull()
    expect(readGeneratedMarker('// Generated by doc-tools (helm-docs) from the chart.\n')).not.toBeNull()
  })

  describe('page attributes from the provenance', () => {
    const run = (provenance) => {
      const handlers = {}
      const noop = () => {}
      const context = { on: (event, fn) => { handlers[event] = fn }, getLogger: () => ({ info: noop, debug: noop, warn: noop, error: noop }) }
      require('../../extensions/convert-to-markdown').register.call(context)
      const page = { generatedProvenance: provenance, asciidoc: { attributes: {} } }
      handlers.documentsConverted({ contentCatalog: { findBy: () => [page] } })
      return page.asciidoc.attributes
    }

    test('a marker with a source sets page-generated-from to it', () => {
      const attrs = run({ page: { generator: 'rpk-docs', version: null, source: 'the rpk command help', note: 'x' }, includes: [] })
      expect(attrs).toMatchObject({ 'page-generated-content': 'all', 'page-generated-by': 'doc-tools (rpk-docs)', 'page-generated-from': 'the rpk command help' })
    })

    test('a legacy marker with no source leaves page-generated-from out, not the banner text', () => {
      const attrs = run({ page: { generator: null, version: null, source: null, note: 'This content is autogenerated. Do not edit manually.' }, includes: [] })
      expect(attrs['page-generated-content']).toBe('all')
      expect(attrs['page-autogenerated']).toBe('true')
      expect(attrs).not.toHaveProperty('page-generated-from')
      expect(attrs).not.toHaveProperty('page-generated-by')
    })
  })
})

describe('generateFrontmatter page-introduced-in', () => {
  const { generateFrontmatter } = require('../../extensions/convert-to-markdown')
  const page = (attributes) => ({ asciidoc: { doctitle: 'sap_hana', attributes } })

  test('includes the version a generated Connect page was introduced in', () => {
    expect(generateFrontmatter(page({ 'page-introduced-in': '4.113.1' })))
      .toContain('page-introduced-in: 4.113.1\n')
  })

  test('omits it when the page does not set it, as on Cloud pages', () => {
    expect(generateFrontmatter(page({ description: 'Reads rows.' })))
      .not.toContain('page-introduced-in')
  })

  test('omits an empty value instead of writing true', () => {
    const out = generateFrontmatter(page({ 'page-introduced-in': '', 'page-introduced-in-product': '' }))
    expect(out).not.toContain('page-introduced-in')
  })

  test('writes a bare version, like the UI badge, and the product', () => {
    const out = generateFrontmatter(page({ 'page-introduced-in': 'v4.113.1.', 'page-introduced-in-product': 'Redpanda Connect' }))
    expect(out).toContain('page-introduced-in: 4.113.1\n')
    expect(out).toContain('page-introduced-in-product: Redpanda Connect\n')
  })

  // Runs the registered pagesComposed listener, so the attribute must survive
  // the whole conversion into the Markdown twin, not just generateFrontmatter.
  test('reaches the Markdown twin through the extension listener', async () => {
    const handlers = {}
    const noop = () => {}
    const context = { on: (event, fn) => { handlers[event] = fn }, getLogger: () => ({ info: noop, debug: noop, warn: noop, error: noop }) }
    require('../../extensions/convert-to-markdown').register.call(context)
    const twin = {
      contents: Buffer.from('<html><body><article class="doc"><h1>sap_hana</h1><p>Reads rows.</p></article></body></html>'),
      asciidoc: { doctitle: 'sap_hana', attributes: { 'page-introduced-in': '4.113.1' } },
      src: { component: 'connect', version: 'master', path: 'modules/components/pages/inputs/sap_hana.adoc' },
      pub: { url: '/connect/components/inputs/sap_hana/' }
    }
    await handlers.pagesComposed({ playbook: { site: { url: 'https://docs.redpanda.com' } }, contentCatalog: { getPages: () => [twin] } })
    const markdown = twin.markdownContents.toString()
    expect(markdown).toContain('page-introduced-in: 4.113.1')
    expect(markdown).toContain('Reads rows.')
  })
})

// Platform blocks and tab groups carry their meaning in HTML classes and
// widgets, so the Markdown twin needs explicit markers for an agent to know
// which platform a passage applies to and where a tab group ends.
describe('platform blocks and tab groups in the Markdown twin', () => {
  const render = async (body) => {
    const handlers = {}
    const noop = () => {}
    const context = { on: (event, fn) => { handlers[event] = fn }, getLogger: () => ({ info: noop, debug: noop, warn: noop, error: noop }) }
    require('../../extensions/convert-to-markdown').register.call(context)
    const page = {
      contents: Buffer.from(`<html><body><article class="doc"><h1>Page</h1>${body}</article></body></html>`),
      asciidoc: { doctitle: 'Page', attributes: {} },
      src: { component: 'solutions', version: 'master', path: 'modules/demo/pages/page.adoc' },
      pub: { url: '/solutions/demo/page/' },
    }
    await handlers.pagesComposed({ playbook: { site: { url: 'https://docs.redpanda.com' } }, contentCatalog: { getPages: () => [page] } })
    return page.markdownContents.toString()
  }

  const platformBlock = (classes, title, inner) =>
    `<div class="openblock platform ${classes}">` +
    (title ? `<div class="title">${title}</div>` : '') +
    `<div class="content"><div class="paragraph"><p>${inner}</p></div></div></div>`

  test('wraps a platform block in markers and keeps its title as a label', async () => {
    const md = await render(platformBlock('platform-cloud', 'On Redpanda Cloud', 'Skip this command.'))
    expect(md).toContain('<!-- platform: cloud -->\n\n**On Redpanda Cloud:**\n\nSkip this command.\n\n<!-- /platform -->')
  })

  test('lists every platform a block applies to', async () => {
    const md = await render(platformBlock('platform-local platform-kubernetes', 'On the local broker or Kubernetes', 'Run <code>make up</code>.'))
    expect(md).toContain('<!-- platform: local kubernetes -->\n\n**On the local broker or Kubernetes:**\n\nRun `make up`.\n\n<!-- /platform -->')
  })

  test('omits the label when the block has no title', async () => {
    const md = await render(platformBlock('platform-local', '', 'Local only.'))
    expect(md).toContain('<!-- platform: local -->\n\nLocal only.\n\n<!-- /platform -->')
    expect(md).not.toContain('**')
  })

  test('indents a platform block nested in a list item', async () => {
    const md = await render(
      '<div class="olist arabic"><ol class="arabic"><li><p>Start the stack.</p>' +
      platformBlock('platform-kubernetes', 'On Kubernetes', 'It is already running.') +
      '</li></ol></div>'
    )
    expect(md).toMatch(/1\. +Start the stack\.\n\n {4}<!-- platform: kubernetes -->\n\n {4}\*\*On Kubernetes:\*\*\n\n {4}It is already running\.\n\n {4}<!-- \/platform -->/)
  })

  test('closes a tab group after its last tab', async () => {
    const md = await render(
      '<h2>Set up</h2>' +
      '<div class="openblock tabs"><div class="content"><div class="ulist tablist"><ul>' +
      '<li id="_tabs_1_local" class="tab"><p>Local</p></li>' +
      '<li id="_tabs_1_cloud" class="tab"><p>Cloud</p></li>' +
      '</ul></div>' +
      '<div id="_tabs_1_local--panel" class="tabpanel"><div class="paragraph"><p>Use Docker.</p></div></div>' +
      '<div id="_tabs_1_cloud--panel" class="tabpanel"><div class="paragraph"><p>Use a cluster.</p></div></div>' +
      '</div></div>' +
      '<div class="paragraph"><p>After the tabs.</p></div>'
    )
    expect(md).toContain('### Local\n\nUse Docker.\n\n<!-- tab: Cloud -->\n\n### Cloud\n\nUse a cluster.\n\n<!-- /tabs -->\n\nAfter the tabs.')
  })

  const tabGroup = (id, tabs) =>
    '<div class="openblock tabs"><div class="content"><div class="ulist tablist"><ul>' +
    tabs.map(([name]) => `<li id="_tabs_${id}_${name.toLowerCase()}" class="tab"><p>${name}</p></li>`).join('') +
    '</ul></div>' +
    tabs.map(([name, html]) => `<div id="_tabs_${id}_${name.toLowerCase()}--panel" class="tabpanel">${html}</div>`).join('') +
    '</div></div>'

  test('opens a tab group and names each tab before its heading', async () => {
    const md = await render(
      '<h2>Set up</h2>' +
      tabGroup(1, [['Local', '<div class="paragraph"><p>Use Docker.</p></div>'], ['Kubernetes', '<div class="paragraph"><p>Use kind.</p></div>']])
    )
    expect(md).toContain('<!-- tabs -->\n\n<!-- tab: Local -->\n\n### Local\n\nUse Docker.\n\n<!-- tab: Kubernetes -->\n\n### Kubernetes\n\nUse kind.\n\n<!-- /tabs -->')
  })

  test('marks a nested tab group inside its parent tab', async () => {
    const inner = tabGroup(2, [['AWS', '<div class="paragraph"><p>Use EKS.</p></div>'], ['GCP', '<div class="paragraph"><p>Use GKE.</p></div>']])
    const md = await render(
      '<h2>Set up</h2>' +
      tabGroup(1, [['Local', '<div class="paragraph"><p>Use Docker.</p></div>'], ['Cloud', '<div class="paragraph"><p>Pick a provider.</p></div>' + inner]])
    )
    expect(md).toContain('<!-- tab: Cloud -->\n\n### Cloud\n\nPick a provider.\n\n<!-- tabs -->\n\n<!-- tab: AWS -->\n\n#### AWS\n\nUse EKS.\n\n<!-- tab: GCP -->\n\n#### GCP\n\nUse GKE.\n\n<!-- /tabs -->\n\n<!-- /tabs -->')
    expect(md.match(/<!-- tabs -->/g)).toHaveLength(2)
    expect(md.match(/<!-- \/tabs -->/g)).toHaveLength(2)
  })
})

// Inline constructs whose meaning the HTML carries in markup a reader of the
// Markdown twin would otherwise lose.
describe('links, downloads, and videos in the Markdown twin', () => {
  const render = async (body) => {
    const handlers = {}
    const noop = () => {}
    const context = { on: (event, fn) => { handlers[event] = fn }, getLogger: () => ({ info: noop, debug: noop, warn: noop, error: noop }) }
    require('../../extensions/convert-to-markdown').register.call(context)
    const page = {
      contents: Buffer.from(`<html><body><article class="doc"><h1>Page</h1>${body}</article></body></html>`),
      asciidoc: { doctitle: 'Page', attributes: {} },
      src: { component: 'solutions', version: 'master', path: 'modules/demo/pages/page.adoc' },
      pub: { url: '/solutions/demo/page/' },
    }
    await handlers.pagesComposed({ playbook: { site: { url: 'https://docs.redpanda.com' } }, contentCatalog: { getPages: () => [page] } })
    return page.markdownContents.toString()
  }

  test('keeps an autolinked URL in inline code as literal text', async () => {
    const md = await render('<div class="paragraph"><p>Run <code>curl -s <a href="http://localhost:8090/healthz" class="bare">http://localhost:8090/healthz</a></code> and wait. See <a href="https://example.com">the site</a>.</p></div>')
    expect(md).toContain('Run `curl -s http://localhost:8090/healthz` and wait.')
    expect(md).toContain('[the site](https://example.com)')
  })

  test('says where a Solutions download comes from when the HTML has no link', async () => {
    const md = await render('<div class="paragraph"><p><span class="solution-download">Download the complete example</span> (sign in required). Unzip it.</p></div>')
    expect(md).toContain('Download the complete example (sign in required). Unzip it.\n\nThe files are available from the download control on this page: https://docs.redpanda.com/solutions/demo/page/.')
  })

  test('links a Solutions download when the HTML has an href', async () => {
    const md = await render('<div class="paragraph"><p><a class="solution-download" href="/solutions/demo/download.zip">Download the complete example</a>. Unzip it.</p></div>')
    expect(md).toContain('[Download the complete example](https://docs.redpanda.com/solutions/demo/download.zip)')
    expect(md).not.toContain('download control')
  })

  test('links a video to its source instead of the fallback text', async () => {
    const withTitle = await render('<div class="videoblock"><div class="title">The leaderboard during the burst</div><div class="content"><video src="../_images/burst.mp4" controls>Your browser does not support the video tag.</video></div></div>')
    expect(withTitle).toContain('[The leaderboard during the burst](https://docs.redpanda.com/solutions/demo/_images/burst.mp4)')
    expect(withTitle).not.toContain('does not support the video tag')
    const untitled = await render('<div class="videoblock"><div class="content"><video src="burst.mp4" controls>Your browser does not support the video tag.</video></div></div>')
    expect(untitled).toContain('[burst.mp4](https://docs.redpanda.com/solutions/demo/page/burst.mp4)')
  })
})
