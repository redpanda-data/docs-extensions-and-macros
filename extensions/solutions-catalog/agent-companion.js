'use strict'

/**
 * The agent companion: one Markdown file per solution that tells a coding agent
 * how to apply the solution's design to someone else's codebase.
 *
 * A pure function over the solution's AsciiDoc sources and its verify script,
 * so it runs the same inside the solutions-catalog extension (from the content
 * catalog) and from the monorepo's local runner (from disk). Nothing in the
 * companion is authored twice; every section is read from a place the solution
 * writer already fills in:
 *
 *   index.adoc   intro before the outcomes list   -> The problem
 *                "After completing ... able to:"  -> What the system must do
 *                == What you build                 -> System map
 *                == Architecture (+ === Why Redpanda) -> Data flow, platform capabilities
 *                == Production considerations table -> Production gaps
 *                :page-solution-related-docs:      -> Canonical docs
 *   <step>.adoc  :page-solution-rule:              -> Rules, Design contract, Acceptance
 *                :page-solution-adapt:             -> Adapt, Design contract
 *                == Why / == Why Redpanda / == In production -> Design contract
 *                == Verify, prose after the expected output -> Reference build: failure modes
 *   scripts/verify.sh  "# N." comments             -> Reference build: acceptance checks
 *
 * A step with neither a rule nor an adapt line is reference-build detail: its
 * judgment is about the demo stack, so it is reported under Reference build
 * instead of the Design contract.
 *
 * Code, commands, expected output, images, and collapsible sources are dropped.
 * Cross references become live URLs only for the URL shapes the site really
 * serves (see resourceUrl); anything else stays a resource ID in backticks.
 */

const DEFAULT_SITE_URL = 'https://docs.redpanda.com'
const FILE_NAME = 'agent-companion.md'
const OUTCOMES_RX = /^After completing this solution, you will be able to:$/m

/**
 * Antora resource ID -> published URL on the live site. Only three component
 * shapes exist there and all are handled; anything else returns null so the
 * caller keeps the ID rather than guessing a link.
 *
 *   streaming  -> <site>/streaming/current/<module>/<path>/
 *   connect    -> <site>/connect/<module>/<path>/
 *   solutions  -> <site>/solutions/<module>/<path>/   (a bare page is in this solution)
 *
 * The ROOT module has no segment, and an index page drops its trailing `index`.
 */
function resourceUrl (id, { slug, siteUrl = DEFAULT_SITE_URL } = {}) {
  const m = String(id).match(/^(?:[^@:\s]+@)?([^#\s[\]]+?)\.adoc(#[\w-]+)?$/)
  if (!m) return null
  const [, spec, frag = ''] = m
  const parts = spec.split(':')
  if (parts.length > 3) return null
  const [comp, mod, path] = parts.length === 3 ? parts : parts.length === 2 ? [null, ...parts] : [null, null, parts[0]]
  const page = path.replace(/(^|\/)index$/, '')
  const pagePart = page ? `${page}/` : ''
  const modSegment = (m) => (!m || m === 'ROOT' ? '' : `${m}/`)
  if (!comp || comp === 'solutions') {
    // Within the solutions component a page with no module is in this solution.
    const module = mod || (comp ? 'ROOT' : slug)
    return `${siteUrl}/solutions/${modSegment(module)}${pagePart}${frag}`
  }
  if (comp === 'streaming') return `${siteUrl}/streaming/current/${modSegment(mod)}${pagePart}${frag}`
  if (comp === 'connect') return `${siteUrl}/connect/${modSegment(mod)}${pagePart}${frag}`
  return null
}

/** AsciiDoc inline markup -> Markdown, for the constructs solution pages use. */
function inline (s, ctx) {
  const titles = (ctx && ctx.titles) || {}
  return String(s)
    .replace(/xref:([^[\s]+)\[([^\]]*)\]/g, (_, id, text) => {
      const url = resourceUrl(id, ctx)
      const stem = id.replace(/\.adoc.*$/, '')
      // An xref with no text is labeled with the target page's title: this
      // solution's own pages from their source, any other page through
      // ctx.titleOf (the content catalog, in the extension). Only a target
      // nobody can name falls back to a label made from its path.
      const own = /^[^:@]+$/.test(stem) ? titles[stem] : undefined
      const resolved = !text && !own && ctx && typeof ctx.titleOf === 'function' ? ctx.titleOf(id.replace(/#.*$/, '')) : undefined
      const parts = stem.split(/[:/]/)
      const last = parts.pop()
      const label = text || own || resolved || (last === 'index' && parts.length ? parts.pop() : last).replace(/-/g, ' ')
      return url ? `[${label}](${url})` : `${label} (\`${id}\`)`
    })
    .replace(/<<([^,>]+),([^>]+)>>/g, '$2')
    .replace(/<<([^>]+)>>/g, (_, a) => a.replace(/^_/, '').replace(/[_-]/g, ' '))
    .replace(/link:\{attachmentsdir\}\/([^[]+)\[([^\]]*)\]/g, (_, p, t) => `\`${t || p}\` (reference code)`)
    .replace(/(?:link:)?(https?:\/\/[^\s[]+)\[([^\]]*)\]/g, (_, u, t) => `[${t.replace(/\^$/, '') || u}](${u})`)
    .replace(/`\+([^`]*)\+`/g, '`$1`')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s.,:;)]|$)/g, '$1**$2**')
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s.,:;)]|$)/g, '$1*$2*')
    .replace(/\{nbsp\}/g, ' ')
}

/**
 * Split a page into its title, header attributes, and level-2 sections. The
 * header is the title and the attribute lines up to the first blank line;
 * comment lines inside it are skipped and a trailing backslash continues an
 * attribute value onto the next line.
 */
function parsePage (source) {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n')
  const attrs = {}
  const sections = []
  let title = ''
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i < lines.length && /^= /.test(lines[i])) {
    title = lines[i].slice(2).trim()
    i++
    for (; i < lines.length && lines[i].trim(); i++) {
      if (/^\/\//.test(lines[i])) continue
      const a = lines[i].match(/^:([\w-]+):\s*(.*)$/)
      if (!a) continue
      let value = a[2]
      while (/\\$/.test(value) && i + 1 < lines.length) value = value.replace(/\s*\\$/, ' ') + lines[++i].trim()
      attrs[a[1]] = value.trim()
    }
  }
  let cur = { title: '', lines: [] }
  let delim = null
  for (; i < lines.length; i++) {
    const line = lines[i]
    // A heading-like line inside a listing block is code, not a section.
    if (delim) { if (line === delim) delim = null; cur.lines.push(line); continue }
    if (isDelimiter(line)) { delim = line; cur.lines.push(line); continue }
    const h = line.match(/^== (.*)$/)
    if (h) { sections.push(cur); cur = { title: h[1].trim(), lines: [] }; continue }
    cur.lines.push(line)
  }
  sections.push(cur)
  return { title, attrs, sections }
}

// Delimited blocks whose contents never reach the companion: listings,
// literals, examples, sidebars, tables, passthroughs, comments, quotes.
function isDelimiter (line) {
  return /^(-{4,}|={4,}|\.{4,}|\*{4,}|_{4,}|\+{4,}|\/{4,}|\|={3,})$/.test(line)
}

/**
 * Prose paragraphs and lists of a section. Blocks, includes, images, block
 * titles, attribute lists, comments, conditionals, and list continuations are
 * dropped, and so is a sentence that only introduces a dropped block.
 */
function prose (lines, ctx) {
  const out = []
  let skip = null
  // The build-along file list is for a reader saving files, not for an agent.
  const files = lines.findIndex((l) => /^\.Files for this step/.test(l))
  if (files >= 0) lines = lines.slice(0, files)
  const dropLeadIn = () => {
    let k = out.length - 1
    while (k >= 0 && !out[k].trim()) k--
    if (k >= 0 && /:$/.test(out[k]) && !/^[-*.\d]/.test(out[k])) {
      // Drop only the introducing sentence ("The Go side is one small
      // package:"); the sentences before it in the paragraph stay.
      const kept = out[k].match(/^(.*[.!?])\s+[^.!?]*:$/)
      if (kept) out[k] = kept[1]
      else out.splice(k)
    }
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (skip) { if (line === skip) skip = null; continue }
    if (isDelimiter(line)) { dropLeadIn(); skip = line; continue }
    if (/^(image|video|include)::/.test(line)) { dropLeadIn(); continue }
    if (/^(ifn?def|endif|ifeval)::/.test(line)) continue
    if (/^\[.*\]$/.test(line) || /^\.\S/.test(line) || /^\/\//.test(line) || line === '+' || line === '--') continue
    if (/^:[\w-]+:/.test(line) || /^={3,} /.test(line)) continue
    out.push(line.replace(/^(NOTE|TIP|IMPORTANT|WARNING|CAUTION): /, (_, k) => `**${k[0]}${k.slice(1).toLowerCase()}:** `))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().split('\n').map((l) => inline(l, ctx)).join('\n')
    .replace(/^\* \[[ x]\] /gm, '- ').replace(/^\*+ /gm, '- ').replace(/^\.+ /gm, '1. ')
}

function section (page, name) {
  return page.sections.find((s) => s.title === name)
}

/** Level-3 subsection inside a level-2 section's lines. */
function subsection (lines, name) {
  const i = lines.findIndex((l) => l === `=== ${name}`)
  if (i < 0) return []
  const j = lines.findIndex((l, k) => k > i && /^===? /.test(l))
  return lines.slice(i + 1, j < 0 ? undefined : j)
}

/** The prose after the expected-output block of == Verify: likely failures and how to tell them apart. */
function failureModes (lines, ctx) {
  const i = lines.findIndex((l) => l.startsWith('include::') && l.includes('/expected/'))
  if (i < 0) return ''
  const close = lines.findIndex((l, k) => k > i && isDelimiter(l))
  return close < 0 ? '' : prose(lines.slice(close + 1), ctx)
}

/** A three-column AsciiDoc table -> Markdown. */
function table (lines, ctx) {
  const i = lines.findIndex((l) => /^\|={3,}$/.test(l))
  const j = lines.findIndex((l, k) => k > i && /^\|={3,}$/.test(l))
  if (i < 0 || j < 0) return ''
  const cells = []
  for (const l of lines.slice(i + 1, j)) {
    // A line holds one cell or several ("| Area | In this solution | In production").
    if (l.startsWith('|')) cells.push(...l.slice(1).split(/\s\|\s/).map((c) => c.trim()))
    else if (l.trim() && cells.length) cells[cells.length - 1] += ' ' + l.trim()
  }
  const rows = []
  for (let k = 0; k + 2 < cells.length; k += 3) rows.push(cells.slice(k, k + 3).map((c) => inline(c, ctx).replace(/\|/g, '\\|')))
  if (!rows.length) return ''
  const [head, ...body] = rows
  return [`| ${head.join(' | ')} |`, '|---|---|---|', ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

/** The numbered "# N. claim" comments of a verify script, continuation lines folded in. */
function verifyChecks (script) {
  if (!script) return []
  const found = []
  let open = false
  for (const l of String(script).split('\n')) {
    const start = l.match(/^# (\d+)\. (.*)$/)
    if (start) { found.push(start[2].trim()); open = true; continue }
    const cont = l.match(/^#\s{2,}(\S.*)$/)
    if (cont && open) { found[found.length - 1] += ' ' + cont[1].trim(); continue }
    open = false
  }
  return found
}

/** One-line attribute text -> a Markdown sentence. */
function sentence (value, ctx) {
  return inline(String(value || '').replace(/\s+/g, ' ').trim(), ctx)
}

/**
 * Patterns that mean AsciiDoc leaked into the Markdown. Returned so callers can
 * warn (the extension) or fail (tests, the local runner).
 */
const LEAK_PATTERNS = [
  ['xref macro', /xref:/],
  ['include directive', /include::/],
  ['attachmentsdir reference', /\{attachmentsdir\}/],
  ['listing delimiter', /^----$/m],
  ['block attribute line', /^\[(source|tabs|\.[\w-]+)[^\]]*\]$/m],
  ['attribute reference', /\{(?!\s)[a-z][\w-]*\}/],
]

function findLeaks (markdown) {
  return LEAK_PATTERNS.filter(([, rx]) => rx.test(markdown)).map(([name]) => name)
}

/**
 * Generate the companion.
 *
 * @param {Object} input
 * @param {string} input.slug - the solution id (its module name)
 * @param {Object<string,string>} input.pages - AsciiDoc source by page stem: `index` and every step id
 * @param {string} [input.verifyScript] - scripts/verify.sh source
 * @param {string} [input.siteUrl] - origin of the live links (default https://docs.redpanda.com)
 * @param {(resourceId: string) => string|undefined} [input.titleOf] - title of a page outside this
 *   solution, for labeling an xref written with empty text
 * @returns {{ markdown: string, rules: Array<{step, title, rule, adapt}>, referenceSteps: string[], missingSteps: string[], leaks: string[] }}
 */
function generateAgentCompanion ({ slug, pages, verifyScript, siteUrl = DEFAULT_SITE_URL, titleOf }) {
  if (!slug) throw new Error('agent-companion: slug is required')
  if (!pages || !pages.index) throw new Error(`agent-companion: ${slug} has no index page`)
  siteUrl = String(siteUrl || DEFAULT_SITE_URL).replace(/\/+$/, '')
  const index = parsePage(pages.index)
  const stepIds = String(index.attrs['page-solution-steps'] || '').split(',').map((s) => s.trim()).filter(Boolean)
  const steps = []
  const missingSteps = []
  for (const id of stepIds) {
    if (!pages[id]) { missingSteps.push(id); continue }
    steps.push({ id, page: parsePage(pages[id]) })
  }
  const titles = Object.fromEntries(steps.map((s) => [s.id, s.page.title]))
  const ctx = { slug, siteUrl, titles, titleOf }
  const solutionUrl = `${siteUrl}/solutions/${slug}/`
  const stepUrl = (id) => `${solutionUrl}${id}/`

  const rules = []
  const referenceSteps = []
  for (const s of steps) {
    const rule = s.page.attrs['page-solution-rule']
    const adapt = s.page.attrs['page-solution-adapt']
    if (rule || adapt) {
      s.number = rule ? rules.filter((r) => r.rule).length + 1 : null
      s.rule = rule ? sentence(rule, ctx) : ''
      s.adapt = adapt ? sentence(adapt, ctx) : ''
      rules.push({ step: s.id, title: s.page.title, number: s.number, rule: s.rule, adapt: s.adapt })
    } else {
      referenceSteps.push(s.id)
    }
  }
  const numbered = rules.filter((r) => r.rule)
  const link = (s) => `[${s.title || s.page.title}](${stepUrl(s.step || s.id)})`

  const pre = prose((index.sections[0] || { lines: [] }).lines, ctx)
  const [problem, outcomes] = pre.split(OUTCOMES_RX)
  const build = section(index, 'What you build')
  const arch = section(index, 'Architecture')
  const prod = section(index, 'Production considerations')

  const adapts = rules.filter((r) => r.adapt)
  const contract = steps.filter((s) => s.rule || s.adapt)
  const checks = verifyChecks(verifyScript)
  const failures = steps.map((s) => [s, failureModes((section(s.page, 'Verify') || { lines: [] }).lines, ctx)]).filter(([, f]) => f)
  const detail = steps.filter((s) => referenceSteps.includes(s.id))
  const hasReference = Boolean(checks.length || failures.length || detail.length)

  const md = []
  md.push(`# Agent companion: ${index.title}`, '')
  md.push(`Generated from the ${slug} solution (${index.attrs['page-solution-version'] || 'unversioned'}). Human guide: ${solutionUrl}`, '')
  md.push('## How to use this', '')
  // The intro names only the sections this companion has: telling an agent
  // to start with Rules that do not exist sends it looking for nothing.
  const intro = ['This file is for a coding agent applying this design to an existing codebase. Do not copy the reference system.']
  if (numbered.length) {
    intro.push('Start with the Rules: each is an invariant the design depends on, stated so that it holds in any codebase.')
  } else {
    intro.push('This solution states no rules yet, so there is no list of invariants to check. Work from the problem, what the system must do, and the architecture.')
  }
  if (adapts.length) {
    intro.push(numbered.length
      ? 'Work through Adapt to find where each rule lands in the target repository.'
      : 'Work through Adapt to find what to inspect in the target repository.')
  }
  if (contract.length) intro.push('Read the Design contract for why each entry exists and what it relies on.')
  if (numbered.length) {
    intro.push('Where the target differs from the reference, keep the reason for a rule, not its literal form.')
    intro.push('Acceptance is the finish line.')
  }
  if (hasReference) intro.push('Reference build describes how the reference system proves itself: its numbers and failure modes belong to that system, not to the target.')
  md.push(intro.join(' '), '')
  if (problem && problem.trim()) md.push('## The problem', '', problem.trim(), '')
  if (outcomes && outcomes.trim()) md.push('## What the system must do', '', outcomes.trim(), '')

  if (numbered.length) {
    md.push('## Rules', '', 'Every rule must hold in the target system.', '')
    for (const r of numbered) md.push(`${r.number}. ${r.rule} (from ${link(r)})`)
    md.push('')
  }
  if (adapts.length) {
    md.push('## Adapt', '', 'Inspect the target repository before changing it. Answer each item with what you found there.', '')
    for (const r of adapts) md.push(`- [ ] ${r.number ? `Rule ${r.number}: ` : ''}${r.adapt}`)
    md.push('')
  }

  if (build) md.push('## System map', '', 'The reference system, to map against what the target already has.', '', prose(build.lines, ctx), '')
  if (arch) {
    const sub = arch.lines.findIndex((l) => l.startsWith('=== '))
    const walk = prose(sub < 0 ? arch.lines : arch.lines.slice(0, sub), ctx)
    if (walk) md.push('### Data flow', '', walk, '')
    const why = prose(subsection(arch.lines, 'Why Redpanda'), ctx)
    if (why) md.push('### Platform capabilities the design depends on', '', why, '')
  }

  if (contract.length) {
    md.push('## Design contract', '', 'One entry per rule, in build order: the rule, where to look in the target, why the problem requires it, and what it depends on.', '')
    for (const s of contract) {
      md.push(`### ${s.number ? `${s.number}. ` : ''}${s.page.title}`, '')
      if (s.rule) md.push(`**Rule:** ${s.rule}`, '')
      if (s.adapt) md.push(`**Adapt:** ${s.adapt}`, '')
      pushJudgment(md, s.page, ctx)
    }
  }

  if (numbered.length) {
    md.push('## Acceptance', '')
    md.push('The target is done when every rule holds and you can cite the evidence from the target itself: a configuration value, a code path, a test, or a measured result. The reference build\'s numbers do not transfer.', '')
    for (const r of numbered) md.push(`- [ ] Rule ${r.number} holds (${r.title}).`)
    if (adapts.length) md.push('- [ ] Every Adapt item is answered, and any rule that does not apply to the target is recorded with the reason.')
    md.push('')
  }

  if (prod) {
    const tableStart = prod.lines.findIndex((l) => /^\|={3,}$/.test(l))
    const intro = prose(tableStart < 0 ? prod.lines : prod.lines.slice(0, tableStart), ctx)
    const rows = table(prod.lines, ctx)
    md.push('## Production gaps', '')
    if (intro) md.push(intro, '')
    if (rows) md.push(rows, '')
  }
  const related = String(index.attrs['page-solution-related-docs'] || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (related.length) {
    md.push('## Canonical docs', '')
    for (const id of related) { const u = resourceUrl(id, ctx); md.push(`- ${u ? `<${u}>` : `\`${id}\``}`) }
    md.push('')
  }

  // Reference build: how the reference proves itself. Demo-specific by design.
  if (hasReference) {
    md.push('## Reference build', '')
    md.push('How the reference system proves itself. Everything in this section belongs to that system (its seeded data, fixed counts, and local stack): use it to see what each rule protects, not as checks to copy into the target.', '')
    if (detail.length) {
      md.push('### Reference-only steps', '', 'These steps set up the reference stack and carry no rule for the target.', '')
      for (const s of detail) {
        md.push(`#### ${s.page.title}`, '')
        pushJudgment(md, s.page, ctx)
      }
    }
    if (checks.length) {
      md.push('### Acceptance checks of the reference', '', 'The assertions `make verify` makes against the running reference system.', '')
      checks.forEach((c, n) => md.push(`${n + 1}. ${inline(c, ctx)}`))
      md.push('')
    }
    if (failures.length) {
      md.push('### Failure modes of the reference', '')
      for (const [s, f] of failures) md.push(`#### ${s.page.title}`, '', f, '')
    }
  }

  const markdown = md.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*—\s*/g, ', ').trim() + '\n'
  return { markdown, rules, referenceSteps, missingSteps, leaks: findLeaks(markdown) }
}

function pushJudgment (md, page, ctx) {
  const why = section(page, 'Why')
  const whyRp = section(page, 'Why Redpanda')
  const inProd = section(page, 'In production')
  const w = why && prose(why.lines, ctx)
  if (w) md.push(w, '')
  const d = whyRp && prose(whyRp.lines, ctx)
  if (d) md.push(`**Depends on:** ${d}`, '')
  const p = inProd && prose(inProd.lines, ctx)
  if (p) md.push(`**In production:** ${p.replace(/^In production, (\w)/, (_, c) => c.toUpperCase())}`, '')
}

module.exports = {
  DEFAULT_SITE_URL,
  FILE_NAME,
  LEAK_PATTERNS,
  generateAgentCompanion,
  resourceUrl,
  inline,
  parsePage,
  prose,
  table,
  verifyChecks,
  failureModes,
  findLeaks,
}
