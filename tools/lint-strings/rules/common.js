'use strict'

/**
 * Rules that apply to every doc-string surface.
 *
 * Rule shape follows tools/rpk-docs/validate-output.js VALIDATION_RULES:
 * { name, description, severity, check(decl) -> issues[] }.
 * `decl` is the declaration object documented in ../engine.js.
 */

/**
 * Jargon that ships verbatim to docs.redpanda.com but means nothing to users
 * unless expanded. Matched on word boundaries (underscores count as word
 * characters, so `archival_meta_stm` does not trip the `stm` entry).
 */
const JARGON_TERMS = ['NTP', 'seastar', 'nullopt', 'stm', 'smp']

/**
 * Tokenize a name or description for tautology comparison: strip `_`/`-`,
 * case-fold, split on non-alphanumerics.
 */
function tokenize (text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * Two tokens "match" when one is a prefix of the other (so `id` matches
 * `identifier`), with a 2-character minimum to avoid single-letter noise.
 */
function tokensMatch (a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 2 && long.startsWith(short)
}

/**
 * True when the normalized description is just the normalized name:
 * same token count, and every description token pairs with a distinct name
 * token (any order, prefix-tolerant).
 */
function isNameEcho (name, description) {
  const nameTokens = tokenize(name)
  const descTokens = tokenize(description.replace(/[.!?]\s*$/, ''))
  if (nameTokens.length === 0 || descTokens.length !== nameTokens.length) return false

  const used = new Array(nameTokens.length).fill(false)
  for (const descToken of descTokens) {
    const idx = nameTokens.findIndex((nameToken, i) => !used[i] && tokensMatch(descToken, nameToken))
    if (idx === -1) return false
    used[idx] = true
  }
  return true
}

/**
 * A short window of `text` around the first occurrence of `needle`, for use in
 * rule messages so the writer can see the offending phrase in context.
 */
function excerpt (text, needle, width = 60) {
  const at = text.toLowerCase().indexOf(needle.toLowerCase())
  if (at === -1) return text.slice(0, width)
  const start = Math.max(0, at - Math.floor(width / 2))
  const slice = text.slice(start, start + width)
  return `${start > 0 ? '...' : ''}${slice}${start + width < text.length ? '...' : ''}`
}

const COMMON_RULES = [
  {
    name: 'empty-description',
    description: 'Declaration ships with no doc string at all',
    severity: 'error',
    check: (decl) => {
      if (decl.string == null || decl.string.trim() === '') {
        return [{ message: 'Description is empty or missing. This ships as a blank entry on docs.redpanda.com.' }]
      }
      return []
    }
  },
  {
    name: 'starts-lowercase',
    description: 'Description starts with a lowercase letter',
    severity: 'warning',
    check: (decl) => {
      const text = (decl.string || '').trim()
      if (!text) return []
      // A description may legitimately open with a backticked literal
      // (for example, "`true` means ..."); only flag bare prose.
      if (text.startsWith('`')) return []
      const firstAlpha = text.match(/[A-Za-z]/)
      if (firstAlpha && firstAlpha.index === 0 && /[a-z]/.test(firstAlpha[0])) {
        // Mixed-case product spellings (gRPC, iOS, jsonPath) are correct as
        // written; only all-lowercase first words are capitalization drift.
        const firstWord = text.split(/\s/, 1)[0]
        if (/[A-Z]/.test(firstWord)) return []
        return [{ message: `Description starts with a lowercase letter: "${text.slice(0, 60)}"` }]
      }
      return []
    }
  },
  {
    name: 'name-echo',
    description: 'Description merely restates the declared name (tautology)',
    severity: 'warning',
    check: (decl) => {
      const text = (decl.string || '').trim()
      if (!text || !decl.name) return []
      if (isNameEcho(decl.name, text)) {
        return [{ message: `Description just restates the name "${decl.name}": "${text}". Say what it does, why, or what happens when it changes.` }]
      }
      return []
    }
  },
  {
    name: 'too-short',
    description: 'Description is under 20 characters',
    severity: 'warning',
    check: (decl) => {
      const text = (decl.string || '').trim()
      if (!text) return [] // empty-description owns the empty case
      if (text.length < 20) {
        return [{ message: `Description is only ${text.length} characters: "${text}". Too short to explain behavior, units, or impact.` }]
      }
      return []
    }
  },
  {
    name: 'unexpanded-jargon',
    description: 'Internal jargon that ships to users unexpanded',
    severity: 'warning',
    check: (decl) => {
      const text = decl.string || ''
      if (!text) return []
      const issues = []
      for (const term of JARGON_TERMS) {
        const pattern = new RegExp(`\\b${term}\\b`, 'i')
        if (pattern.test(text)) {
          issues.push({ message: `Contains internal jargon "${term}". Expand or replace it; users do not know this term.` })
        }
      }
      return issues
    }
  },
  {
    name: 'em-dash',
    description: 'Em dash in prose that ships to docs.redpanda.com',
    severity: 'warning',
    check: (decl) => {
      const text = decl.string || ''
      if (!text.includes('\u2014')) return []
      // The docs style guide takes commas, parentheses or a sentence break
      // instead of em dashes. Reference docs generated from these strings pass
      // prose through unchanged, so an em dash here is published verbatim, and
      // correcting it in the generated partial is undone by the next
      // regeneration.
      const count = (text.match(/\u2014/g) || []).length
      return [{
        message: `Contains ${count} em dash${count === 1 ? '' : 'es'}. Use a comma, parentheses, or a separate sentence: "${excerpt(text, '\u2014')}"`
      }]
    }
  },
  {
    name: 'latin-abbreviation',
    description: 'Latin abbreviation instead of plain English',
    severity: 'warning',
    check: (decl) => {
      const text = decl.string || ''
      if (!text) return []
      const issues = []
      // "e.g." and "i.e." are both ruled out by the style guide's terminology
      // list. Match the abbreviation only, so "e.g" inside a longer token such
      // as a URL or an identifier is left alone.
      for (const [abbr, replacement] of [['e.g.', '"for example"'], ['i.e.', '"that is"']]) {
        const pattern = new RegExp(`(^|[^\\w.])${abbr.replace(/\./g, '\\.')}`, 'i')
        if (pattern.test(text)) {
          issues.push({
            message: `Uses "${abbr}". Write ${replacement} instead: "${excerpt(text, abbr)}"`
          })
        }
      }
      return issues
    }
  },
  {
    name: 'unbalanced-backticks',
    description: 'Odd number of backticks ships broken markup',
    severity: 'error',
    check: (decl) => {
      const text = decl.string || ''
      const count = (text.match(/`/g) || []).length
      if (count % 2 !== 0) {
        return [{ message: `Unbalanced backticks (${count} found). The rendered page ships broken monospace markup.` }]
      }
      return []
    }
  }
]

module.exports = { COMMON_RULES, JARGON_TERMS, isNameEcho, tokenize }
