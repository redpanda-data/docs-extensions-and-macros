'use strict'

const fs = require('fs')
const path = require('path')

const {
  generateAgentCompanion,
  resourceUrl,
  parsePage,
  prose,
  verifyChecks,
  findLeaks,
} = require('../../extensions/solutions-catalog/agent-companion')

// The flagship solution's real pages and verify script, copied verbatim from
// redpanda-solutions (feat/multiplayer-gaming). Refresh them by copying
// docs/modules/multiplayer-gaming/pages/*.adoc and
// solutions/multiplayer-gaming/scripts/verify.sh again.
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'solutions', 'multiplayer-gaming')

function loadFlagship () {
  const dir = path.join(FIXTURE, 'pages')
  const pages = {}
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.adoc')) pages[f.replace(/\.adoc$/, '')] = fs.readFileSync(path.join(dir, f), 'utf8')
  }
  return { pages, verifyScript: fs.readFileSync(path.join(FIXTURE, 'verify.sh'), 'utf8') }
}

const headings = (md) => md.split('\n').filter((l) => /^#{1,4} /.test(l))
const sectionOf = (md, heading) => {
  const lines = md.split('\n')
  const i = lines.indexOf(heading)
  if (i < 0) return ''
  const level = heading.match(/^#+/)[0].length
  const j = lines.findIndex((l, k) => k > i && new RegExp(`^#{1,${level}} `).test(l))
  return lines.slice(i + 1, j < 0 ? undefined : j).join('\n')
}

describe('agent companion: the flagship solution', () => {
  const { pages, verifyScript } = loadFlagship()
  const result = generateAgentCompanion({ slug: 'multiplayer-gaming', pages, verifyScript })
  const md = result.markdown

  test('every authored rule and adapt line reaches the companion, numbered in step order', () => {
    const steps = parsePage(pages.index).attrs['page-solution-steps'].split(',').map((s) => s.trim())
    const authored = steps.filter((id) => parsePage(pages[id]).attrs['page-solution-rule'])
    expect(authored.length).toBeGreaterThan(0)
    expect(result.rules.map((r) => r.step)).toEqual(authored)
    expect(result.rules.map((r) => r.number)).toEqual(authored.map((_, i) => i + 1))

    const rules = sectionOf(md, '## Rules')
    const adapt = sectionOf(md, '## Adapt')
    authored.forEach((id, i) => {
      const attrs = parsePage(pages[id]).attrs
      // The rule's text is the attribute's text: nothing reworded.
      expect(rules).toContain(`${i + 1}. ${attrs['page-solution-rule']}`)
      expect(adapt).toContain(`- [ ] Rule ${i + 1}: ${attrs['page-solution-adapt']}`)
    })
  })

  test('the rule for publishing state is rule 4 and leads its Design contract entry', () => {
    const entry = sectionOf(md, '### 4. Build the live leaderboard')
    expect(entry.trim().startsWith('**Rule:** Publish absolute state, never deltas')).toBe(true)
    expect(entry).toContain('**Adapt:** Find consumers that aggregate')
    // Judgment from == Why follows the rule.
    expect(entry).toContain('It then publishes the total, never the delta.')
  })

  test('a step with no rule is reference-build detail, not a Design contract entry', () => {
    expect(result.referenceSteps).toEqual(['start-environment'])
    expect(sectionOf(md, '## Design contract')).not.toContain('Start the environment\n')
    expect(sectionOf(md, '### Reference-only steps')).toContain('#### Start the environment')
  })

  test('sections come in the documented order', () => {
    const top = headings(md).filter((h) => /^## /.test(h))
    expect(top).toEqual([
      '## How to use this',
      '## The problem',
      '## What the system must do',
      '## Rules',
      '## Adapt',
      '## System map',
      '## Design contract',
      '## Acceptance',
      '## Production gaps',
      '## Canonical docs',
      '## Reference build',
    ])
  })

  test('the portable Acceptance section is built from the rules, and demo checks live under Reference build', () => {
    const acceptance = sectionOf(md, '## Acceptance')
    for (const r of result.rules) expect(acceptance).toContain(`- [ ] Rule ${r.number} holds (${r.title}).`)
    // verify.sh's claims are about the seeded reference and must not be presented as portable.
    expect(acceptance).not.toContain('SIM_EVENTS_MAX')
    const reference = sectionOf(md, '## Reference build')
    expect(reference).toContain('### Acceptance checks of the reference')
    expect(reference).toContain('Before any burst the total is exactly SIM_EVENTS_MAX.')
    expect(reference).toContain('### Failure modes of the reference')
    expect(reference).toContain('#### Build the live leaderboard')
  })

  test('no AsciiDoc leaks into the Markdown', () => {
    expect(result.leaks).toEqual([])
    expect(md).not.toMatch(/xref:|include::|\{attachmentsdir\}|^----$/m)
    expect(md).not.toMatch(/^\[(source|tabs|\.[\w-]+)/m)
    expect(md).not.toContain('—')
  })

  test('every docs link uses a URL shape the live site serves', () => {
    // localhost URLs are the reference stack's own endpoints, and only the
    // Reference build section may carry them.
    const beforeReference = md.slice(0, md.indexOf('## Reference build'))
    expect(beforeReference).not.toMatch(/localhost/)
    const urls = [...md.matchAll(/https?:\/\/[^\s)>\]`]+/g)].map((m) => m[0]).filter((u) => !/^http:\/\/localhost[:/]/.test(u))
    expect(urls.length).toBeGreaterThan(20)
    const live = [
      /^https:\/\/docs\.redpanda\.com\/streaming\/current\/[\w/.-]+\/(#[\w-]+)?$/,
      /^https:\/\/docs\.redpanda\.com\/connect\/[\w/.-]+\/(#[\w-]+)?$/,
      /^https:\/\/docs\.redpanda\.com\/solutions\/multiplayer-gaming\/([\w-]+\/)?(#[\w-]+)?$/,
    ]
    const bad = urls.filter((u) => !live.some((rx) => rx.test(u)))
    expect(bad).toEqual([])
    expect(md).not.toMatch(/\/index\/|\.adoc/)
  })

  test('is deterministic', () => {
    expect(generateAgentCompanion({ slug: 'multiplayer-gaming', pages, verifyScript }).markdown).toBe(md)
  })
})

describe('agent companion: resourceUrl', () => {
  const ctx = { slug: 'gaming', siteUrl: 'https://docs.redpanda.com' }
  test.each([
    ['streaming:develop:consume-data/consumer-offsets.adoc', 'https://docs.redpanda.com/streaming/current/develop/consume-data/consumer-offsets/'],
    ['streaming:manage:schema-reg/index.adoc', 'https://docs.redpanda.com/streaming/current/manage/schema-reg/'],
    ['streaming:ROOT:index.adoc', 'https://docs.redpanda.com/streaming/current/'],
    ['26.1@streaming:develop:transactions.adoc', 'https://docs.redpanda.com/streaming/current/develop/transactions/'],
    ['connect:components:outputs/sql_insert.adoc', 'https://docs.redpanda.com/connect/components/outputs/sql_insert/'],
    ['connect:ROOT:about.adoc', 'https://docs.redpanda.com/connect/about/'],
    ['solutions:sports-data-fanout:index.adoc', 'https://docs.redpanda.com/solutions/sports-data-fanout/'],
    ['solutions:ROOT:index.adoc', 'https://docs.redpanda.com/solutions/'],
    ['create-topics.adoc', 'https://docs.redpanda.com/solutions/gaming/create-topics/'],
    ['index.adoc#_production_considerations', 'https://docs.redpanda.com/solutions/gaming/#_production_considerations'],
  ])('%s', (id, url) => {
    expect(resourceUrl(id, ctx)).toBe(url)
  })

  test('a component the site has no known URL shape for stays unlinked', () => {
    expect(resourceUrl('cloud-data-platform:get-started:cluster-types/serverless.adoc', ctx)).toBeNull()
    expect(resourceUrl('not a resource id', ctx)).toBeNull()
  })

  test('unlinked xrefs keep the resource ID instead of a guessed URL', () => {
    const out = prose(['See xref:cloud-data-platform:security:authorization/acl.adoc[].'], ctx)
    expect(out).toBe('See acl (`cloud-data-platform:security:authorization/acl.adoc`).')
  })
})

describe('agent companion: parsing', () => {
  test('header attributes survive comment lines and backslash continuations', () => {
    const page = parsePage([
      '= Title',
      '// a comment inside the header',
      ':page-layout: solution-step',
      ':page-solution-rule: One rule \\',
      '  that wraps.',
      '',
      '== Why',
      '',
      'Because.',
    ].join('\n'))
    expect(page.title).toBe('Title')
    expect(page.attrs['page-solution-rule']).toBe('One rule that wraps.')
    expect(page.sections.map((s) => s.title)).toEqual(['', 'Why'])
  })

  test('a heading-like line inside a listing block is not a section', () => {
    const page = parsePage(['= T', '', '== Why', '', '----', '== not a heading', '----', '', 'Text.'].join('\n'))
    expect(page.sections.map((s) => s.title)).toEqual(['', 'Why'])
    expect(prose(page.sections[1].lines, {})).toBe('Text.')
  })

  test('a sentence that only introduces a dropped block goes with it', () => {
    const out = prose(['The stack is small. The Go side is one package:', '', '[source,go]', '----', 'include::example$x.go[]', '----', 'After.'], {})
    expect(out).toBe('The stack is small.\n\nAfter.')
  })

  test('verify script claims fold their continuation lines and stop at the next non-comment', () => {
    const script = ['# 1. First claim', '#    continues here.', 'check_one', '# 2. Second claim.', '#   (tail)', '', '# not a claim'].join('\n')
    expect(verifyChecks(script)).toEqual(['First claim continues here.', 'Second claim. (tail)'])
  })

  test('findLeaks names each kind of AsciiDoc residue', () => {
    expect(findLeaks('see xref:a.adoc[]\n----\ninclude::x[]\n{attachmentsdir}')).toEqual(
      expect.arrayContaining(['xref macro', 'include directive', 'attachmentsdir reference', 'listing delimiter'])
    )
    expect(findLeaks('plain `code` and [a link](https://x/)')).toEqual([])
  })
})

describe('agent companion: solutions without rules', () => {
  const index = [
    '= Tiny',
    ':page-layout: solution',
    ':page-solution-version: v0.1.0',
    ':page-solution-steps: one, two',
    '',
    'A problem worth solving.',
    '',
    'After completing this solution, you will be able to:',
    '',
    '* Do one thing',
  ].join('\n')
  const step = (title, extra = '') => `= ${title}\n:page-layout: solution-step\n${extra}\n== Why\n\nReason for ${title}.\n`

  test('no rules: no Rules, Adapt, Design contract or Acceptance, and every step is reference detail', () => {
    const r = generateAgentCompanion({ slug: 'tiny', pages: { index, one: step('One'), two: step('Two') } })
    expect(r.rules).toEqual([])
    expect(r.referenceSteps).toEqual(['one', 'two'])
    expect(r.markdown).not.toMatch(/^## (Rules|Adapt|Design contract|Acceptance)$/m)
    expect(r.markdown).toContain('#### One')
    expect(r.markdown).toContain('## What the system must do\n\n- Do one thing')
  })

  test('no rules: the intro does not send the agent to sections that are not there', () => {
    const r = generateAgentCompanion({ slug: 'tiny', pages: { index, one: step('One'), two: step('Two') } })
    const intro = sectionOf(r.markdown, '## How to use this')
    expect(intro).not.toMatch(/Start with the Rules|Work through Adapt|Design contract|Acceptance is the finish line/)
    expect(intro).toContain('This solution states no rules yet')
    expect(intro).toContain('Reference build describes')
  })

  test('an xref with empty text takes the title titleOf gives, else a label from its path', () => {
    const one = step('One', '') + '\nSee xref:streaming:develop:consumer-offsets.adoc[] and xref:connect:guides:other.adoc[].\n'
    const titleOf = (id) => (id === 'streaming:develop:consumer-offsets.adoc' ? 'Consumer offsets' : undefined)
    const r = generateAgentCompanion({ slug: 'tiny', pages: { index, one, two: step('Two') }, titleOf })
    expect(r.markdown).toContain('[Consumer offsets](https://docs.redpanda.com/streaming/current/develop/consumer-offsets/)')
    expect(r.markdown).toContain('[other](https://docs.redpanda.com/connect/guides/other/)')
  })

  test('an adapt line without a rule is kept but not numbered', () => {
    const r = generateAgentCompanion({
      slug: 'tiny',
      pages: { index, one: step('One', ':page-solution-rule: Rule one.\n'), two: step('Two', ':page-solution-adapt: Look at two.\n') },
    })
    expect(r.rules.map((x) => x.number)).toEqual([1, null])
    expect(r.markdown).toContain('- [ ] Look at two.')
    expect(r.markdown).toContain('### Two\n\n**Adapt:** Look at two.')
    expect(r.markdown).not.toContain('Rule 2')
  })

  test('a listed step with no page is reported, not fatal', () => {
    const r = generateAgentCompanion({ slug: 'tiny', pages: { index, one: step('One') } })
    expect(r.missingSteps).toEqual(['two'])
  })

  test('no index page is an error', () => {
    expect(() => generateAgentCompanion({ slug: 'tiny', pages: {} })).toThrow(/no index page/)
  })
})
