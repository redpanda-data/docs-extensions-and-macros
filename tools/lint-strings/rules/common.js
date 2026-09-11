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
 * Blank out the spans of a description where a code-ish token is expected to
 * appear bare, so the inline-code rule only sees prose:
 *
 *   * backticked spans - already marked up, which is the whole point;
 *   * URLs and Markdown link targets - a path inside a link is part of the
 *     link, and backticking it would break the link;
 *   * anything the declaration is named after, which name-echo owns.
 *
 * Replaced with spaces rather than removed so match indices stay meaningful.
 */
function maskNonProse (text) {
  let out = text
  const blank = (m) => ' '.repeat(m.length)
  // Backticked spans first: a URL inside backticks is already marked up.
  out = out.replace(/`[^`]*`/g, blank)
  // Markdown links: mask the whole construct, target included.
  out = out.replace(/\[[^\]]*\]\([^)]*\)/g, blank)
  // Bare URLs, and AsciiDoc's url[text] form.
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, blank)
  return out
}

/**
 * Tokens that are code and read as code, so they belong in inline code.
 * Backticks are the portable choice: a single-backtick span is inline code in
 * both AsciiDoc and Markdown, so one rule covers every surface regardless of
 * which format the generator emits.
 *
 * Deliberately narrow. This rule posts inline suggestions on engineering PRs,
 * so a false positive costs more than a miss:
 *
 *   * snake_case with at least two segments - in this domain that is always an
 *     identifier (`default_topic_partitions`), never prose;
 *   * long flags (`--tolerate-data-loss`);
 *   * absolute paths with at least two segments (`/etc/redpanda/redpanda.yaml`,
 *     `/v1/topics`).
 *
 * Not included, on purpose: dotted keys (`segment.bytes`) collide with
 * sentence boundaries and abbreviations; bare `true`/`false` and numbers
 * appear in ordinary prose; single-segment lowercase words are unrecoverable
 * from prose without a symbol table.
 */
const CODE_TOKEN_PATTERNS = Object.freeze([
  { id: 'identifier', re: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g },
  { id: 'flag', re: /(?<![\w-])--[a-z][a-z0-9]*(?:-[a-z0-9]+)*\b/g },
  { id: 'path', re: /(?<![\w/])\/[a-z][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.{}-]+)+\/?/g }
])

/**
 * Code-ish tokens in a description that are not inside inline code.
 * Exported for tests and for the surfaces that scope the rule differently.
 */
function findBareCodeTokens (text, name = null) {
  const masked = maskNonProse(String(text || ''))
  const found = []
  const seen = new Set()
  for (const { id, re } of CODE_TOKEN_PATTERNS) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(masked)) !== null) {
      const token = match[0]
      // The declaration's own name restating itself is name-echo's finding,
      // not a markup one.
      if (name && token === name) continue
      if (seen.has(token)) continue
      seen.add(token)
      found.push({ token, kind: id })
    }
  }
  return found
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
  },
  {
    name: 'missing-inline-code',
    description: 'Code value or field name in prose without inline code',
    severity: 'warning',
    check: (decl) => {
      const bare = findBareCodeTokens(decl.string, decl.name)
      if (bare.length === 0) return []
      const list = bare.map((b) => `\`${b.token}\``).join(', ')
      return [{
        message: `Code values and field names belong in inline code: ${list}. Wrap each in backticks, which render as inline code in both AsciiDoc and Markdown.`
      }]
    }
  }
]

module.exports = { COMMON_RULES, JARGON_TERMS, isNameEcho, tokenize, findBareCodeTokens, maskNonProse }
