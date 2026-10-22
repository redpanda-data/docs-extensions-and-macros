/**
 * @jest-environment node
 */

const TurndownService = require('turndown')
const {
  convertPageHtml,
  escapeText,
  flattenCell,
  resolveTarget,
  createEnterpriseFeatureRules,
  formatStatusMarker,
  ENTERPRISE_MARKER,
} = require('../../extensions/convert-to-markdown')

const siteUrl = 'https://docs.example.com'

/** Wrap body HTML in the article element the extension extracts. */
function article (body) {
  return `<html><body><nav>chrome</nav><article class="doc">${body}</article><footer>f</footer></body></html>`
}

function makePage (overrides = {}) {
  return {
    asciidoc: {
      doctitle: 'Tiered Storage',
      attributes: { description: 'Store data in object storage.', 'page-component-name': 'streaming' },
    },
    pub: { url: '/streaming/current/manage/tiered-storage/' },
    src: { component: 'streaming', version: 'current', path: 'modules/manage/pages/tiered-storage.adoc' },
    out: { path: 'streaming/current/manage/tiered-storage/index.html' },
    ...overrides,
  }
}

function convert (body, pageOverrides) {
  return convertPageHtml({ html: article(body), page: makePage(pageOverrides), siteUrl })
}

/** The body after the front matter, H1, directive and source comment. */
function bodyOf (markdown) {
  return markdown.split('-->\n\n')[1]
}

describe('export structure', () => {
  const markdown = convert('<h1 class="page">Tiered Storage</h1><p>Intro.</p>')

  test('starts with the front matter block', () => {
    expect(markdown.startsWith('---\ntitle: Tiered Storage\n')).toBe(true)
    expect(markdown).toMatch(/^---\n[\s\S]*?\n---\n\n# Tiered Storage\n/)
  })

  test('puts the H1, the llms.txt directive and the source comment after the front matter', () => {
    expect(markdown).toBe(
      '---\n' +
      'title: Tiered Storage\n' +
      'description: Store data in object storage.\n' +
      'page-component-name: streaming\n' +
      '---\n\n' +
      '# Tiered Storage\n\n' +
      '> For the complete documentation index, see [llms.txt](https://docs.example.com/llms.txt). ' +
      'Component-specific: [streaming-full.txt](https://docs.example.com/streaming-full.txt)\n\n' +
      '<!-- Source: https://docs.example.com/streaming/current/manage/tiered-storage.md -->\n\n' +
      'Intro.'
    )
  })

  test('keeps a page without an opening H1 intact', () => {
    const md = convert('<p>Intro text</p><h1>Later</h1><p>More</p>')
    expect(bodyOf(md)).toBe('Intro text\n\n# Later\n\nMore')
  })

  test('decodes HTML entities in front matter values', () => {
    const md = convert('<h1>x</h1>', {
      asciidoc: { doctitle: 'rpk ai trigger get', attributes: { description: 'Get one trigger. &lt;name&gt; is the resource name.' } },
    })
    expect(md).toContain('description: Get one trigger. <name> is the resource name.')
  })

  test('gives field-only pages the body alone', () => {
    const md = convert('<h2 id="f"><a class="anchor" href="#f"></a>Fields</h2><p>Body</p>', { isFieldOnlyPage: true })
    expect(md).toBe('## Fields\n\nBody')
  })

  test('returns an empty string when the page has no article', () => {
    expect(convertPageHtml({ html: '<html><body><p>x</p></body></html>', page: makePage(), siteUrl })).toBe('')
  })

  test('drops site chrome and tracking pixels', () => {
    const md = convert(
      '<h1>T</h1><p>Body</p><img src="https://static.scarf.sh/a.png" alt="Image for tracking purposes only" style="display:none">' +
      '<div class="feedback-section">Was this helpful?</div>'
    )
    expect(bodyOf(md)).toBe('Body')
  })
})

describe('headings', () => {
  test('removes the empty anchor link Antora puts in every heading', () => {
    const md = convert('<h1>T</h1><h2 id="discovery"><a class="anchor" href="#discovery"></a>Discovery</h2>')
    expect(bodyOf(md)).toBe('## Discovery')
  })

  test('keeps a heading with an underscore in a name readable', () => {
    const md = convert('<h1>T</h1><h2 id="x"><a class="anchor" href="#x"></a>invoke_agent spans</h2>')
    expect(bodyOf(md)).toBe('## invoke_agent spans')
  })
})

describe('tables', () => {
  test('converts cell content as Markdown instead of flattening it to text', () => {
    const md = convert(
      '<h1>T</h1>' +
      '<table class="tableblock"><thead><tr><th>Your role</th><th>Start here</th></tr></thead><tbody>' +
      '<tr><td><p class="tableblock">Administrator</p></td>' +
      '<td><div class="content"><div class="ulist"><ul>' +
      '<li><p><a href="#level-1">Level 1</a></p></li>' +
      '<li><p>Run <code>rpk ai agent create --ttl</code> with <strong>Existing</strong> or <strong>New</strong></p></li>' +
      '</ul></div></div></td></tr></tbody></table>'
    )
    expect(bodyOf(md)).toBe(
      '| Your role | Start here |\n' +
      '| --- | --- |\n' +
      '| Administrator | - [Level 1](#level-1)<br>- Run `rpk ai agent create --ttl` with **Existing** or **New** |'
    )
  })

  test('separates paragraphs in a cell so text does not run into a URL', () => {
    const md = convert(
      '<h1>T</h1><table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody><tr><td>URL</td>' +
      '<td><p class="tableblock"><code>https://aigw.clusters.rdpa.co</code></p><p class="tableblock">Replace <code>&lt;cluster-id&gt;</code> with yours.</p></td></tr></tbody></table>'
    )
    expect(bodyOf(md)).toContain('| URL | `https://aigw.clusters.rdpa.co`<br>Replace `<cluster-id>` with yours. |')
  })

  test('keeps a cron value in a cell as code', () => {
    const md = convert('<h1>T</h1><table><thead><tr><th>Field</th><th>Example</th></tr></thead><tbody><tr><td>Cron</td><td><p><code>0 0 * * *</code></p></td></tr></tbody></table>')
    expect(bodyOf(md)).toContain('| Cron | `0 0 * * *` |')
  })

  test('leaves the header row empty when the table declares none', () => {
    const md = convert('<h1>T</h1><table><tbody><tr><td>key</td><td>value</td></tr><tr><td>k2</td><td>v2</td></tr></tbody></table>')
    expect(bodyOf(md)).toBe('|  |  |\n| --- | --- |\n| key | value |\n| k2 | v2 |')
  })

  test('escapes pipes and turns code blocks in a cell into code spans', () => {
    const md = convert(
      '<h1>T</h1><table><thead><tr><th>Option</th><th>Example</th></tr></thead><tbody><tr><td>a | b</td>' +
      '<td><div class="listingblock"><div class="content"><pre class="highlightjs highlight"><code class="language-yaml" data-lang="yaml">a: 1\nb: 2</code></pre></div></div></td></tr></tbody></table>'
    )
    expect(bodyOf(md)).toContain('| a \\| b | `a: 1`<br>`b: 2` |')
  })

  test('renders a callout list as a numbered list, not a table', () => {
    const md = convert(
      '<h1>T</h1><div class="colist arabic"><table><tbody>' +
      '<tr><td><i class="conum" data-value="1"></i><b>1</b></td><td>Required. The signing key.</td></tr>' +
      '<tr><td><i class="conum" data-value="2"></i><b>2</b></td><td>Marks cookies as secure.</td></tr>' +
      '</tbody></table></div>'
    )
    expect(bodyOf(md)).toBe('1. Required. The signing key.\n2. Marks cookies as secure.')
  })

  test('keeps a table whose cell holds an admonition', () => {
    const md = convert(
      '<h1>T</h1><table><thead><tr><th>Setting</th><th>Notes</th></tr></thead><tbody>' +
      '<tr><td>a</td><td>plain</td></tr>' +
      '<tr><td>b</td><td><div class="admonitionblock note"><table><tr><td class="icon"><i class="fa icon-note"></i></td><td class="content"><p>careful</p></td></tr></table></div></td></tr>' +
      '<tr><td>c</td><td>also plain</td></tr></tbody></table><p>after</p>'
    )
    expect(bodyOf(md)).toBe(
      '| Setting | Notes |\n| --- | --- |\n| a | plain |\n| b | > 📝 **NOTE**<br>><br>> careful |\n| c | also plain |\n\nafter'
    )
  })

  test('renders a table nested in a cell as text rows', () => {
    const md = convert('<h1>T</h1><table><thead><tr><th>N</th><th>Inner</th></tr></thead><tbody><tr><td>1</td><td><table><tr><td>x</td><td>y</td></tr></table></td></tr></tbody></table>')
    expect(bodyOf(md)).toBe('| N | Inner |\n| --- | --- |\n| 1 | x / y |')
  })

  test('still renders admonitions as blockquotes', () => {
    const md = convert(
      '<h1>T</h1><div class="admonitionblock note"><table><tr><td class="icon"><i class="fa icon-note" title="Note"></i></td>' +
      '<td class="content">Use <code>rpk</code>.</td></tr></table></div>'
    )
    expect(bodyOf(md)).toBe('> 📝 **NOTE**\n>\n> Use `rpk`.')
  })
})

describe('escaping', () => {
  test('does not escape a hyphen that continues a line after an inline element', () => {
    const md = convert('<h1>T</h1><p>Built on <a href="https://raft.github.io/">Raft</a>-based consensus.</p>')
    expect(bodyOf(md)).toBe('Built on [Raft](https://raft.github.io/)-based consensus.')
  })

  test('keeps a line-start escape when only an invisible sibling precedes the text', () => {
    const md = convert('<h1>T</h1><p><a id="z"></a># not a heading</p><p><a id="y"></a>1. not a list</p><div><!-- c -->- after comment</div>')
    expect(bodyOf(md)).toBe('\\# not a heading\n\n1\\. not a list\n\n\\- after comment')
  })

  test('still escapes a hyphen that starts a paragraph', () => {
    const md = convert('<h1>T</h1><p>- not a list</p>')
    expect(bodyOf(md)).toBe('\\- not a list')
  })

  test('escapes a delimiter that opens the text as a list marker or thematic break', () => {
    expect(escapeText('* Indicates a required field')).toBe('\\* Indicates a required field')
    expect(escapeText('***')).toBe('\\*\\*\\*')
    expect(escapeText('* * *')).toBe('\\* \\* \\*')
    expect(escapeText('___')).toBe('\\_\\_\\_')
  })

  test('escapes a delimiter run that ends the text node', () => {
    const md = convert('<h1>T</h1><p>Press *<kbd>Ctrl</kbd>* and RPK_<em>NAME</em>; 10* faster, marked with * <b>x</b></p>')
    expect(bodyOf(md)).toBe('Press \\*Ctrl\\* and RPK\\__NAME_; 10* faster, marked with * **x**')
  })

  test('leaves underscores inside identifiers alone', () => {
    expect(escapeText('Use get_orders and the RPK_ environment variable.')).toBe('Use get_orders and the RPK_ environment variable.')
    expect(escapeText('conversation_id joins a run')).toBe('conversation_id joins a run')
  })

  test('escapes an underscore or asterisk that could open emphasis', () => {
    expect(escapeText('_emphasis_ here')).toBe('\\_emphasis_ here')
    expect(escapeText('say *loud* words')).toBe('say \\*loud* words')
    expect(escapeText('a *b')).toBe('a \\*b')
  })

  test('leaves an asterisk that cannot open emphasis alone', () => {
    expect(escapeText('fields marked with * are required')).toBe('fields marked with * are required')
    expect(escapeText('the --teams-* flags')).toBe('the --teams-* flags')
  })

  test('keeps the rest of the escape list', () => {
    expect(escapeText('a [link] and `code` and \\ backslash')).toBe('a \\[link\\] and \\`code\\` and \\\\ backslash')
    expect(escapeText('# not a heading')).toBe('\\# not a heading')
    expect(escapeText('1. not a list')).toBe('1\\. not a list')
  })

  test('fences a literal block so its underscores are not escaped', () => {
    const md = convert('<h1>T</h1><div class="literalblock"><div class="content"><pre>invoke_agent (6.65 seconds)\n├── execute_tool get_quote</pre></div></div>')
    expect(bodyOf(md)).toBe('```\ninvoke_agent (6.65 seconds)\n├── execute_tool get_quote\n```')
  })

  test('keeps blank lines and trailing spaces inside a code block', () => {
    const md = convert('<h1>T</h1><pre><code>def a():\n    pass\n\n\n\ndef b():  \n    pass</code></pre><p>x</p>')
    expect(bodyOf(md)).toBe('```\ndef a():\n    pass\n\n\n\ndef b():  \n    pass\n```\n\nx')
  })

  test('keeps a two-space hard break', () => {
    const md = convert('<h1>T</h1><p>Street 1<br>City</p>')
    expect(bodyOf(md)).toBe('Street 1  \nCity')
  })

  test('keeps a source block fenced with its language', () => {
    const md = convert('<h1>T</h1><pre class="highlightjs highlight"><code class="language-bash hljs" data-lang="bash">rpk topic list</code></pre>')
    expect(bodyOf(md)).toBe('```bash\nrpk topic list\n```')
  })
})

describe('inline code', () => {
  test('emits the text of a code span even when Asciidoctor auto-linked a URL inside it', () => {
    const md = convert('<h1>T</h1><p>Assume <code><a href="https://aigw.<id>.clusters.rdpa.co/mcp">https://aigw.&lt;id&gt;.clusters.rdpa.co/mcp</a></code> is yours.</p>')
    expect(bodyOf(md)).toBe('Assume `https://aigw.<id>.clusters.rdpa.co/mcp` is yours.')
  })

  test('widens the delimiter when the code contains a backtick', () => {
    const md = convert('<h1>T</h1><p>Type <code>a ` b</code>.</p>')
    expect(bodyOf(md)).toBe('Type ``a ` b``.')
  })
})

describe('links and images', () => {
  test('resolves relative, parent-relative and root-relative links against the page URL', () => {
    const md = convert(
      '<h1>T</h1><p><a href="kubernetes/">K8s</a> <a href="../deploy/index.html">Deploy</a> <a href="/home/glossary/#tool">tool</a> ' +
      '<a href="#local">anchor</a> <a href="https://example.org/x">ext</a> <a href="mailto:a@b.c">mail</a></p>'
    )
    expect(bodyOf(md)).toBe(
      '[K8s](https://docs.example.com/streaming/current/manage/tiered-storage/kubernetes/) ' +
      '[Deploy](https://docs.example.com/streaming/current/manage/deploy/index.html) ' +
      '[tool](https://docs.example.com/home/glossary/#tool) ' +
      '[anchor](#local) [ext](https://example.org/x) [mail](mailto:a@b.c)'
    )
  })

  test('keeps the destination of a link that has no text, as an autolink', () => {
    const md = convert('<h1>T</h1><p><a href="https://x.com"><i class="fa fa-github"></i></a> text <a href="#top"></a></p>')
    // Turndown drops the space after an element that renders no text.
    expect(bodyOf(md)).toBe('<https://x.com>text')
  })

  test('resolves image sources and keeps alt text', () => {
    const md = convert('<h1>T</h1><div class="imageblock"><div class="content"><img src="../_images/arch.png" alt="Tiered Storage architecture"></div></div>')
    expect(bodyOf(md)).toBe('![Tiered Storage architecture](https://docs.example.com/streaming/current/manage/_images/arch.png)')
  })

  test('resolveTarget leaves targets it cannot or should not resolve alone', () => {
    const pageUrl = new URL('https://docs.example.com/a/b/')
    expect(resolveTarget('#x', pageUrl)).toBe('#x')
    expect(resolveTarget('//cdn.example.com/x.png', pageUrl)).toBe('//cdn.example.com/x.png')
    expect(resolveTarget('c/', null)).toBe('c/')
    expect(resolveTarget('c/', pageUrl)).toBe('https://docs.example.com/a/b/c/')
  })
})

describe('tabs', () => {
  const tabs = (id, title, body) =>
    `<div class="openblock tabs"><div class="content"><ul class="tablist"><li class="tab" id="${id}" aria-controls="${id}--panel"><p>${title}</p></li></ul>` +
    `<div class="tabpanel" id="${id}--panel">${body}</div></div></div>`

  test('keeps a nested tab group inside an admonition', () => {
    const inner = tabs('in', 'Inner', '<p>inner text</p>')
    const outer = tabs('out', 'Outer', `<p>outer text</p>${inner}`)
    const md = convert(`<h1>T</h1><div class="admonitionblock note"><table><tr><td class="icon"><i class="fa icon-note"></i></td><td class="content">${outer}</td></tr></table></div>`)
    expect(bodyOf(md)).toBe('> 📝 **NOTE**\n>\n> ### Outer\n>\n> outer text\n>\n> #### Inner\n>\n> inner text')
  })

  test('renders three nested levels once each', () => {
    const l3 = tabs('c', 'L3', '<p>three</p>')
    const l2 = tabs('b', 'L2', `<p>two</p>${l3}`)
    const l1 = tabs('a', 'L1', `<p>one</p>${l2}`)
    const md = convert(`<h1>T</h1><h2>Section</h2>${l1}`)
    expect(bodyOf(md)).toBe('## Section\n\n### L1\n\none\n\n#### L2\n\ntwo\n\n##### L3\n\nthree')
  })
})

describe('description lists', () => {
  test('bolds the term so it reads as a label', () => {
    const md = convert('<h1>T</h1><div class="dlist"><dl><dt class="hdlist1">term</dt><dd><p>its description</p></dd></dl></div>')
    expect(bodyOf(md)).toBe('**term**\n\nits description')
  })
})

describe('flattenCell', () => {
  test('joins lines with <br>, tightens list markers and escapes pipes', () => {
    expect(flattenCell('-   one\n    \n-   two | three\n')).toBe('- one<br>- two \\| three')
  })

  test('drops line-start escapes, which mean nothing inside a cell', () => {
    expect(flattenCell('Use these instead:\n\n\\- `rpk a`\n\n\\- `rpk b`\n\n1\\. step')).toBe('Use these instead:<br>- `rpk a`<br>- `rpk b`<br>1. step')
  })
})

// The enterprise signal is CSS-only in HTML: the badge comes from the span's
// class and the explanation from a title tooltip, and Turndown keeps neither.
// These tests use the rule the extension actually registers, not a local
// reproduction, so they fail if the real rule regresses.
describe('enterprise feature marker in Markdown', () => {
  function createTurndown () {
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
    const rules = createEnterpriseFeatureRules()
    td.addRule('enterprise-feature', rules.enterpriseFeature)
    td.addRule('beta-badge', rules.betaBadge)
    return td
  }

  test('appends the marker to a plain feature name', () => {
    const html = '<p>Use <span class="enterprise-feature" title="Enterprise feature">Tiered Storage</span> today.</p>'
    expect(createTurndown().turndown(html)).toBe(`Use Tiered Storage ${ENTERPRISE_MARKER} today.`)
  })

  test('keeps the link when the feature is linked', () => {
    const html = '<p>See <span class="enterprise-feature"><a href="../manage/tiered-storage.html">Tiered Storage</a></span>.</p>'
    expect(createTurndown().turndown(html)).toBe(`See [Tiered Storage](../manage/tiered-storage.html) ${ENTERPRISE_MARKER}.`)
  })

  test('matches when the class is one of several', () => {
    const html = '<p><span class="foo enterprise-feature bar">Audit Logging</span></p>'
    expect(createTurndown().turndown(html)).toBe(`Audit Logging ${ENTERPRISE_MARKER}`)
  })

  test('does not add a second marker when the content already carries one', () => {
    const html = `<p><span class="enterprise-feature"><span class="enterprise-feature">Nested</span></span></p>`
    expect(createTurndown().turndown(html)).toBe(`Nested ${ENTERPRISE_MARKER}`)
  })

  test('emits nothing for an empty span', () => {
    expect(createTurndown().turndown('<p>a <span class="enterprise-feature"></span> b</p>')).toBe('a b')
  })

  test('leaves unrelated spans alone', () => {
    expect(createTurndown().turndown('<p><span class="other">Plain</span></p>')).toBe('Plain')
  })

  test('survives the full page conversion', () => {
    const md = convert('<h1>T</h1><p>Use <span class="enterprise-feature">Tiered Storage</span>.</p>')
    expect(bodyOf(md)).toBe(`Use Tiered Storage ${ENTERPRISE_MARKER}.`)
  })
})

describe('combined status markers in Markdown', () => {
  function createTurndown () {
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
    const rules = createEnterpriseFeatureRules()
    td.addRule('enterprise-feature', rules.enterpriseFeature)
    td.addRule('beta-badge', rules.betaBadge)
    return td
  }

  test('formatStatusMarker joins the statuses into one parenthetical', () => {
    expect(formatStatusMarker(['enterprise', 'beta'])).toBe('(enterprise, beta)')
    expect(formatStatusMarker(['beta'])).toBe('(beta)')
    expect(formatStatusMarker([])).toBe('')
  })

  test('a beta enterprise feature gets one combined marker', () => {
    const html = '<p><span class="enterprise-feature">Stretch Clusters</span> <span class="badge badge--beta">beta</span></p>'
    expect(createTurndown().turndown(html)).toBe('Stretch Clusters (enterprise, beta)')
  })

  test('a beta badge on its own becomes (beta)', () => {
    const html = '<p>Shadowing <span class="badge badge--beta">beta</span></p>'
    expect(createTurndown().turndown(html)).toBe('Shadowing (beta)')
  })

  test('an enterprise feature followed by other text keeps its own marker', () => {
    const html = '<p><span class="enterprise-feature">Tiered Storage</span> <em>note</em></p>'
    expect(createTurndown().turndown(html)).toBe(`Tiered Storage ${ENTERPRISE_MARKER} _note_`)
  })
})
