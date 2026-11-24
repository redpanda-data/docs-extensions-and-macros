'use strict'

/**
 * Reads the user-facing change a PR author declares in the PR description.
 *
 * The doc-strings review finds published-content impact from the doc strings
 * a PR changes, so a change written in plain code (a limit, an enforcement
 * rule, a startup refusal) reaches no one. streaming-enterprise PR 928 added a
 * 50-core Community Edition limit that way and filed no doc-impact ticket,
 * although its description said exactly what changed. Engineering PR
 * templates already ask for that: a UX Changes section, an optional User
 * impact and why section, and Release Notes sub-sections. This module pulls
 * those out so the review can weigh them.
 *
 * A PR declares a user-facing change when UX Changes says anything other
 * than `none`, or when Release Notes has a sub-section other than Bug Fixes.
 * Bug-fix notes alone do not count: they are about half of all release notes
 * and seldom change what a page says. User impact and why is carried as
 * context but never declares a change on its own, because the template
 * marks it optional.
 *
 * The description is untrusted input. This module only selects and copies
 * text; the review prompt says how to treat it.
 */

const crypto = require('crypto')

// What the review reads. A description longer than this is cut, and the cut
// is marked, so a huge description cannot crowd out the diff.
const MAX_BYTES = 16 * 1024

const UX = 'ux changes'
const IMPACT = 'user impact and why'
const NOTES = 'release notes'

/** Level-2 sections of a Markdown body, keyed by lower-cased title. */
function sections (body) {
  const text = String(body || '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
  const out = new Map()
  let title = null
  let lines = []
  const flush = () => {
    if (title !== null && !out.has(title)) out.set(title, lines.join('\n').trim())
  }
  for (const line of text.split('\n')) {
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(line)
    if (m && !line.startsWith('###')) {
      flush()
      title = m[1].trim().toLowerCase()
      lines = []
    } else if (title !== null) {
      lines.push(line)
    }
  }
  flush()
  return out
}

// A line that says there is nothing: `none`, `* none`, `- N/A.`, or `none`
// followed by an explanation (`* none - internal refactor`).
const NONE_LINE = /^\s*(?:[*-]\s*)?(?:none|n\/a|na)\b.*$/i

/** True when text says something other than "none". */
function meaningful (text) {
  return String(text || '')
    .split('\n')
    .some((l) => l.trim() && !NONE_LINE.test(l))
}

/** Release Notes sub-sections ({ title, body }) that declare a change. */
function noteSubsections (text) {
  const subs = []
  let current = null
  for (const line of String(text || '').split('\n')) {
    const m = /^###\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) {
      current = { title: m[1].trim(), lines: [] }
      subs.push(current)
    } else if (current) {
      current.lines.push(line)
    }
  }
  return subs
    .map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }))
    .filter((s) => !/^bug\s*fix(es)?$/i.test(s.title) && meaningful(s.body))
}

/**
 * The declared change in a PR description.
 * @param {string} body - the PR description, as Markdown
 * @returns {{declared: boolean, sections: string[], text: string, hash: string|null}}
 *   text is the Markdown the review reads, empty when nothing is declared;
 *   hash is 16 hex characters of its SHA-256, so a run can tell whether an
 *   earlier push already reviewed the same declaration.
 */
function declaredChanges (body) {
  const all = sections(body)
  const ux = all.get(UX)
  const impact = all.get(IMPACT)
  const subs = noteSubsections(all.get(NOTES))
  const parts = []
  const names = []
  if (meaningful(ux)) {
    parts.push(`## UX Changes\n\n${ux}`)
    names.push('UX Changes')
  }
  const declared = names.length > 0 || subs.length > 0
  if (!declared) return { declared: false, sections: [], text: '', hash: null }
  if (meaningful(impact)) {
    parts.push(`## User impact and why\n\n${impact}`)
    names.push('User impact and why')
  }
  if (subs.length) {
    parts.push(['## Release Notes', ...subs.map((s) => `### ${s.title}\n\n${s.body}`)].join('\n\n'))
    names.push(...subs.map((s) => `Release Notes: ${s.title}`))
  }
  let text = parts.join('\n\n') + '\n'
  if (Buffer.byteLength(text) > MAX_BYTES) {
    text = Buffer.from(text).subarray(0, MAX_BYTES).toString('utf8').replace(/�+$/, '') +
      `\n\n(Cut at ${MAX_BYTES} bytes. The rest of the description is on the PR.)\n`
  }
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
  return { declared: true, sections: names, text, hash }
}

module.exports = { declaredChanges, sections, meaningful, noteSubsections, MAX_BYTES }
