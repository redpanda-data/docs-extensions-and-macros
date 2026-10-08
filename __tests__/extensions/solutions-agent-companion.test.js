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
  partialResolver,
  selectTagged,
  MAX_INCLUDE_DEPTH,
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

  test('old content: the overview table still yields Production gaps rows', () => {
    const gaps = sectionOf(md, '## Production gaps')
    expect(gaps).toMatch(/^\| Area \| In this solution \| In production \|$/m)
    expect(gaps).toContain('|---|---|---|')
    expect(gaps.split('\n').filter((l) => /^\| /.test(l)).length).toBeGreaterThan(5)
  })

  test('old content: the .Files for this step list is dropped, the In production note is kept', () => {
    const entry = sectionOf(md, '### 4. Build the live leaderboard')
    expect(entry).toContain('**In production:** The board on `game.leaderboard` is the source of truth')
    expect(md).not.toContain('services/dashboard/static/index.html')
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

describe('agent companion: single-sourced production content', () => {
  // The current layout: each step's In production note is an include of a
  // partial's summary region, and the last step carries the complete section
  // assembled from the same partials' detail regions.
  const index = [
    '= Tiny',
    ':page-layout: solution',
    ':page-solution-steps: one, verify-end-to-end',
    '',
    'A problem worth solving.',
    '',
    '== Prerequisites',
    '',
    'This reference runs on one broker. The last step, xref:verify-end-to-end.adoc#production-considerations[], lists what changes for production.',
  ].join('\n')
  const one = [
    '= Compact the board',
    ':page-layout: solution-step',
    ':page-solution-rule: Publish absolute state.',
    '',
    '== Why',
    '',
    'Totals survive compaction.',
    '',
    '== Verify',
    '',
    '[,bash]',
    '----',
    'include::example$steps/one/commands.sh[tag=check]',
    '----',
    '',
    '== Files for this step',
    '',
    '* link:{attachmentsdir}/services/board.go[services/board.go]',
    '',
    '== In production',
    '',
    '[.production-note]',
    '.In production',
    '--',
    'include::partial$production/compaction.adoc[tag=summary]',
    'For the full picture, see xref:verify-end-to-end.adoc#prod-compaction[Production considerations: compaction].',
    '--',
  ].join('\n')
  const last = [
    '= Verify the system end to end',
    ':page-layout: solution-step',
    '',
    '== Why',
    '',
    'One check proves it.',
    '',
    '== Files for this step',
    '',
    '* link:{attachmentsdir}/verify.sh[verify.sh]',
    '',
    '== Production considerations',
    '',
    'include::partial$production/_all.adoc[]',
    '',
    '== Clean up',
    '',
    'Stop the stack.',
  ].join('\n')
  const partials = {
    'production/_all.adoc': [
      'This solution runs on a single broker with no authentication.',
      '',
      '[#prod-compaction]',
      '=== Compaction',
      '',
      'include::partial$production/compaction.adoc[tag=detail]',
      '',
      '[#prod-security]',
      '=== Security',
      '',
      'include::partial$production/security.adoc[tag=detail]',
    ].join('\n'),
    'production/compaction.adoc': [
      '// tag::summary[]',
      'Size segment.ms for your write rate, because compaction only runs on closed segments.',
      '// end::summary[]',
      '// tag::detail[]',
      'In this solution, segments roll every minute.',
      '',
      'In production, tune segment.ms and see xref:streaming:manage:cluster-maintenance/compaction-settings.adoc[compaction settings].',
      '// end::detail[]',
    ].join('\n'),
    'production/security.adoc': [
      '// tag::summary[]',
      'Turn on SASL.',
      '// end::summary[]',
      '// tag::detail[]',
      'In this solution, nothing authenticates.',
      '',
      'In production, enable SASL and TLS.',
      '// end::detail[]',
    ].join('\n'),
  }
  const pages = { index, one, 'verify-end-to-end': last }
  const generate = (over = {}) => generateAgentCompanion({
    slug: 'tiny',
    pages,
    resolveInclude: partialResolver(partials, { module: 'tiny' }),
    ...over,
  })

  test('a step whose In production is only an include still yields **In production:** with the summary', () => {
    const r = generate()
    expect(r.leaks).toEqual([])
    const entry = sectionOf(r.markdown, '### 1. Compact the board')
    expect(entry).toContain(
      '**In production:** Size segment.ms for your write rate, because compaction only runs on closed segments.\n' +
      'For the full picture, see [Production considerations: compaction](https://docs.redpanda.com/solutions/tiny/verify-end-to-end/#prod-compaction).'
    )
    // Only the summary region: the detail belongs to the last step.
    expect(entry).not.toContain('segments roll every minute')
  })

  test('the last step\'s Production considerations become Production gaps, one h3 per topic', () => {
    const r = generate()
    const gaps = sectionOf(r.markdown, '## Production gaps')
    expect(gaps.trim().startsWith('This solution runs on a single broker with no authentication.')).toBe(true)
    expect(headings(r.markdown).filter((h) => /^### /.test(h) && ['### Compaction', '### Security'].includes(h))).toEqual(['### Compaction', '### Security'])
    expect(r.markdown).toContain(
      '### Compaction\n\nIn this solution, segments roll every minute.\n\n' +
      'In production, tune segment.ms and see [compaction settings](https://docs.redpanda.com/streaming/current/manage/cluster-maintenance/compaction-settings/).'
    )
    expect(r.markdown).toContain('### Security\n\nIn this solution, nothing authenticates.\n\nIn production, enable SASL and TLS.')
    // Production gaps keeps its place between Acceptance and Reference build.
    const top = headings(r.markdown).filter((h) => /^## /.test(h))
    expect(top.indexOf('## Production gaps')).toBe(top.indexOf('## Acceptance') + 1)
  })

  test('tag markers, anchors, and the Files for this step section never reach the Markdown', () => {
    const r = generate()
    expect(r.markdown).not.toMatch(/tag::|end::|\[#prod-|include::|attachmentsdir/)
    expect(r.markdown).not.toContain('board.go')
    expect(r.markdown).not.toContain('verify.sh')
    expect(r.markdown).not.toContain('Stop the stack.')
  })

  test('a missing partial is reported in leaks', () => {
    const broken = one.replace('production/compaction.adoc', 'production/missing.adoc')
    const r = generate({ pages: { ...pages, one: broken } })
    expect(r.leaks).toEqual(['unresolved include: partial$production/missing.adoc (in one)'])
  })

  test('a tag the partial does not have is reported in leaks', () => {
    const broken = one.replace('[tag=summary]', '[tag=summry]')
    const r = generate({ pages: { ...pages, one: broken } })
    expect(r.leaks).toEqual(['include tag not found: summry in partial$production/compaction.adoc (in one)'])
  })

  test('without a resolver, every partial include is reported rather than silently dropped', () => {
    const r = generate({ resolveInclude: undefined })
    expect(r.leaks).toEqual([
      'unresolved include: partial$production/compaction.adoc (in one)',
      'unresolved include: partial$production/_all.adoc (in verify-end-to-end)',
    ])
  })

  test('nested includes stop at the depth limit', () => {
    const loop = { 'loop.adoc': 'Again.\ninclude::partial$loop.adoc[]' }
    const r = generateAgentCompanion({
      slug: 'tiny',
      pages: { index: index + '\n\ninclude::partial$loop.adoc[]' },
      resolveInclude: partialResolver(loop, { module: 'tiny' }),
    })
    expect(r.leaks).toEqual([`include nested deeper than ${MAX_INCLUDE_DEPTH}: partial$loop.adoc (in index)`])
  })

  test('a plain relative include inside a partial resolves as a sibling partial', () => {
    const nested = {
      'production/_all.adoc': '=== Compaction\ninclude::compaction.adoc[tag=detail]\n\n=== Security\ninclude::../shared/security.adoc[]',
      'production/compaction.adoc': '// tag::detail[]\nCompact it.\n// end::detail[]',
      'shared/security.adoc': 'Lock it.',
    }
    const r = generateAgentCompanion({
      slug: 'tiny',
      pages: { index: index + '\n\n== Production considerations\n\ninclude::partial$production/_all.adoc[]' },
      resolveInclude: partialResolver(nested, { module: 'tiny' }),
    })
    expect(r.leaks).toEqual([])
    expect(r.markdown).toContain('### Compaction\n\nCompact it.\n\n### Security\n\nLock it.')
  })

  test('a relative include inside a partial that does not exist is reported, not dropped', () => {
    const r = generateAgentCompanion({
      slug: 'tiny',
      pages: { index: index + '\n\n== Production considerations\n\ninclude::partial$production/_all.adoc[]' },
      resolveInclude: partialResolver({ 'production/_all.adoc': 'include::gone.adoc[]' }, { module: 'tiny' }),
    })
    expect(r.leaks).toEqual(['unresolved include: partial$production/gone.adoc (in index)'])
  })

  test('example$ and attachment$ includes are still dropped and never resolved', () => {
    const seen = []
    generate({ resolveInclude: (t) => { seen.push(t); return partialResolver(partials, { module: 'tiny' })(t) } })
    expect(seen.every((t) => t.includes('partial$'))).toBe(true)
  })

  test('old content: with no production section on the last step, the overview table is used', () => {
    const oldIndex = index + '\n\n== Production considerations\n\nOne broker.\n\n|===\n| Area | In this solution | In production\n\n| Security\n| None\n| SASL\n|===\n'
    const oldLast = last.replace(/== Production considerations[\s\S]*?(?=== Clean up)/, '')
    const r = generate({ pages: { index: oldIndex, one, 'verify-end-to-end': oldLast } })
    expect(sectionOf(r.markdown, '## Production gaps')).toContain('One broker.\n\n| Area | In this solution | In production |\n|---|---|---|\n| Security | None | SASL |')
  })
})

describe('agent companion: include helpers', () => {
  const text = [
    'untagged',
    '// tag::a[]',
    'in a',
    '// tag::b[]',
    'in a and b',
    '// end::b[]',
    '// end::a[]',
    '# tag::c[]',
    'in c',
    '# end::c[]',
  ].join('\n')

  test.each([
    [{}, ['untagged', 'in a', 'in a and b', 'in c']],
    [{ tag: 'a' }, ['in a', 'in a and b']],
    [{ tag: 'b' }, ['in a and b']],
    [{ tags: 'b;c' }, ['in a and b', 'in c']],
    [{ tags: 'a;!b' }, ['in a']],
    [{ tags: '!a' }, ['untagged', 'in c']],
    [{ tags: '*' }, ['in a', 'in a and b', 'in c']],
    [{ tags: '**' }, ['untagged', 'in a', 'in a and b', 'in c']],
  ])('selectTagged %j', (attrs, expected) => {
    expect(selectTagged(text, attrs)).toEqual({ lines: expected, missing: [] })
  })

  test('selectTagged names the tags it could not find', () => {
    expect(selectTagged(text, { tags: 'a;zz' }).missing).toEqual(['zz'])
  })

  test('partialResolver resolves only this solution module\'s partials', () => {
    const resolve = partialResolver({ 'production/x.adoc': 'X' }, { module: 'tiny' })
    expect(resolve('partial$production/x.adoc')).toBe('X')
    expect(resolve('tiny:partial$production/x.adoc')).toBe('X')
    expect(resolve('solutions:tiny:partial$production/x.adoc')).toBe('X')
    expect(resolve('other:partial$production/x.adoc')).toBeUndefined()
    expect(resolve('streaming:tiny:partial$production/x.adoc')).toBeUndefined()
    expect(resolve('partial$production/y.adoc')).toBeUndefined()
    expect(resolve('example$production/x.adoc')).toBeUndefined()
  })
})
