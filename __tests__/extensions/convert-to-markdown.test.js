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

  test('decodes front matter entities once and keeps astral characters whole', () => {
    const md = convert('<h1>x</h1>', { asciidoc: { doctitle: '&amp;lt;literal&amp;gt; &#128512;', attributes: {} } })
    expect(md).toContain('title: "&lt;literal&gt; 😀"')
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

  test('keeps a content block whose id or class contains a chrome fragment', () => {
    const md = convert('<h1>T</h1><table id="footer-opts"><thead><tr><th>A</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>')
    expect(bodyOf(md)).toBe('| A |\n| --- |\n| b |')
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

  test('escapes a pipe in a nested table once, so the outer row keeps its cells', () => {
    const md = convert('<h1>T</h1><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><p>X</p><table><tr><td>a|b</td></tr></table></td><td>x</td></tr></tbody></table>')
    const row = bodyOf(md).split('\n')[2]
    expect(row).not.toContain('\\\\|')
    expect(row.split(/(?<!\\)\|/).length - 2).toBe(2)
  })

  test('turns a code block in a list in a cell into code spans', () => {
    const md = convert('<h1>T</h1><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><div class="ulist"><ul><li><p>Run:</p><div class="listingblock"><div class="content"><pre class="highlight"><code class="language-bash" data-lang="bash">rpk topic create a | tee x</code></pre></div></div></li></ul></div></td><td>x</td></tr></tbody></table>')
    expect(bodyOf(md).split('\n')[2]).toBe('| - Run:<br>`rpk topic create a \\| tee x` | x |')
  })

  test('keeps the indentation of code lines in a cell', () => {
    const md = convert('<h1>T</h1><table><thead><tr><th>A</th></tr></thead><tbody><tr><td><div class="listingblock"><div class="content"><pre class="highlight"><code class="language-yaml" data-lang="yaml">a:\n  b: 1</code></pre></div></div></td></tr></tbody></table>')
    expect(bodyOf(md).split('\n')[2]).toBe('| `a:`<br>`  b: 1` |')
  })

  test('does not promote a later row of th cells above the rows before it', () => {
    const md = convert('<h1>T</h1><table><tbody><tr><td>a</td><td>b</td></tr><tr><th>H1</th><th>H2</th></tr></tbody></table>')
    expect(bodyOf(md)).toBe('|  |  |\n| --- | --- |\n| a | b |\n| H1 | H2 |')
  })

  test('gives an admonition its own title, not that of a block nested in it', () => {
    const md = convert('<h1>T</h1><div class="admonitionblock note"><table><tr><td class="icon"><i class="fa icon-note" title="Note"></i></td><td class="content"><div class="paragraph"><p>Body</p></div><div class="listingblock"><div class="title">Example config</div><div class="content"><pre>a: 1</pre></div></div></td></tr></table></div>')
    expect(bodyOf(md).split('\n')[0]).toBe('> 📝 **NOTE**')
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

  test('escapes line starts after a hard break', () => {
    const md = convert('<h1>T</h1><p>Line one<br>- not a list<br>1. nope<br># nohead</p>')
    expect(bodyOf(md)).toBe('Line one  \n\\- not a list  \n1\\. nope  \n\\# nohead')
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

  test('treats a delimiter after a literal backslash as unescaped', () => {
    expect(escapeText('regex \\*foo* and a\\_b_ c')).toBe('regex \\\\\\*foo* and a\\\\\\_b_ c')
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
