'use strict'

const { literalValue } = require('./source')

/**
 * Value normalization for default expressions, so a rewrite that keeps the
 * value (`std::chrono::milliseconds(150)` to `150ms`, `128_MiB` to
 * `134217728`, `1'000` to `1000`) is not reported as a changed default.
 *
 * `canonicalValue(text, lang)` returns a canonical string such as
 * `dur:150000000` (nanoseconds), `num:134217728`, `bool:true` or
 * `str:"abc"`, or null when the expression is anything it does not
 * understand. Callers compare canonical values only when both sides have
 * one, and fall back to comparing text otherwise, so an unknown form keeps
 * the old behaviour (reported when the text changes) instead of being
 * silently dropped.
 *
 * Understood, C++ (`lang: 'cpp'`):
 *   - integer literals: decimal, hex, octal, binary, `'` digit separators,
 *     `u`/`l`/`ul`/`ull`/`z` suffixes; floating literals with `f`/`l`
 *   - size literals from redpanda's units.h: `_KiB`, `_MiB`, `_GiB`, `_TiB`
 *   - chrono: `std::chrono::<unit>(n)` and `{n}`, the literals `ns`, `us`,
 *     `ms`, `s`, `min`, `h`, and `std::chrono::duration_cast<unit>(x)`
 *     (truncating, as the cast does)
 *   - `*` between those (`5min * 2`, `128 * 1024 * 1024`), and parentheses
 *   - `true`, `false`
 *   - string literals, adjacent literals, the `s`/`sv` suffixes and
 *     `ss::sstring(...)`, `std::string(...)`, `std::string_view(...)`
 * Understood, Go (`lang: 'go'`): integer and float literals with `_`
 * separators, `true`, `false`, interpreted and raw strings, and
 * `time.<Unit>` durations with `*`.
 */

const CPP_UNITS = {
  nanoseconds: 1n,
  microseconds: 1000n,
  milliseconds: 1000000n,
  seconds: 1000000000n,
  minutes: 60000000000n,
  hours: 3600000000000n,
  days: 86400000000000n,
  weeks: 604800000000000n
}
const CPP_DURATION_LITERALS = { ns: 1n, us: 1000n, ms: 1000000n, s: 1000000000n, min: 60000000000n, h: 3600000000000n }
const CPP_SIZE_LITERALS = { _KiB: 1024n, _MiB: 1024n ** 2n, _GiB: 1024n ** 3n, _TiB: 1024n ** 4n }
const GO_UNITS = {
  Nanosecond: 1n,
  Microsecond: 1000n,
  Millisecond: 1000000n,
  Second: 1000000000n,
  Minute: 60000000000n,
  Hour: 3600000000000n
}

const STRING_WRAPPERS = /^(?:(?:ss|seastar)::sstring|std::string(?:_view)?|(?:ss|seastar)::sstring_view)\s*[({]([\s\S]*)[)}]$/

function stringValue (text, lang) {
  let s = String(text || '').trim()
  if (lang === 'go') {
    const raw = /^`([^`]*)`$/.exec(s)
    if (raw) return raw[1]
    return literalValue(s)
  }
  const wrapped = STRING_WRAPPERS.exec(s)
  if (wrapped) s = wrapped[1].trim()
  const suffixed = /^("(?:[^"\\]|\\.)*")(?:s|sv)$/.exec(s)
  if (suffixed) s = suffixed[1]
  return literalValue(s)
}

function parseIntLiteral (tok, lang) {
  const sep = lang === 'go' ? /_/g : /'/g
  let t = tok.replace(sep, '')
  if (lang === 'cpp') t = t.replace(/(?:[uU](?:ll|LL|l|L|z|Z)?|(?:ll|LL|l|L|z|Z)[uU]?)$/, '')
  if (/^0[xX][0-9a-fA-F]+$/.test(t)) return BigInt(t)
  if (/^0[bB][01]+$/.test(t)) return BigInt(t)
  if (lang === 'go' && /^0[oO][0-7]+$/.test(t)) return BigInt(t)
  if (/^0[0-7]+$/.test(t)) return BigInt('0o' + t.slice(1))
  if (/^(?:0|[1-9][0-9]*)$/.test(t)) return BigInt(t)
  return null
}

function parseFloatLiteral (tok, lang) {
  const sep = lang === 'go' ? /_/g : /'/g
  let t = tok.replace(sep, '')
  if (lang === 'cpp') t = t.replace(/[fFlL]$/, '')
  if (!/^(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+(?=[eE]))(?:[eE][+-]?[0-9]+)?$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse an arithmetic default into a typed value: { t: 'num', v: BigInt|number },
 * { t: 'dur', v: BigInt nanoseconds } or { t: 'bool', v }. Null when the text
 * has any form not listed above.
 */
function parseExpr (text, lang) {
  const s = String(text || '').replace(/\s+/g, '')
  let i = 0
  const peek = (re) => {
    re.lastIndex = i
    const m = re.exec(s)
    return m && m.index === i ? m : null
  }
  const eat = (re) => {
    const m = peek(re)
    if (m) i += m[0].length
    return m
  }
  const product = () => {
    let left = term()
    if (!left) return null
    while (s[i] === '*') {
      i++
      const right = term()
      if (!right) return null
      left = multiply(left, right)
      if (!left) return null
    }
    return left
  }
  const parenthesised = (open, close) => {
    if (s[i] !== open) return null
    i++
    const inner = product()
    if (!inner || s[i] !== close) return null
    i++
    return inner
  }
  const toDuration = (inner, unit, truncate) => {
    if (inner.t === 'num') {
      if (typeof inner.v !== 'bigint') return null
      return { t: 'dur', v: inner.v * unit }
    }
    if (inner.t === 'dur') {
      // A chrono conversion to a coarser unit truncates toward zero
      // (duration_cast); an implicit one only compiles when lossless.
      if (!truncate && inner.v % unit !== 0n) return null
      return { t: 'dur', v: (inner.v / unit) * unit }
    }
    return null
  }
  const term = () => {
    if (s[i] === '(') return parenthesised('(', ')')
    if (lang === 'cpp') {
      let m = eat(/(?:std::)?(?:chrono::)?duration_cast<(?:std::)?(?:chrono::)?([a-z]+)>/y)
      if (m) {
        const unit = CPP_UNITS[m[1]]
        if (!unit) return null
        const inner = parenthesised('(', ')')
        return inner ? toDuration(inner, unit, true) : null
      }
      m = eat(/(?:std::)?(?:chrono::)?(nanoseconds|microseconds|milliseconds|seconds|minutes|hours|days|weeks)(?=[({])/y)
      if (m) {
        const inner = s[i] === '(' ? parenthesised('(', ')') : parenthesised('{', '}')
        return inner ? toDuration(inner, CPP_UNITS[m[1]], false) : null
      }
      m = eat(/(true|false)(?![A-Za-z0-9_])/y)
      if (m) return { t: 'bool', v: m[1] === 'true' }
      m = eat(/([0-9][0-9a-fA-FxXbB'.]*(?:[eE][+-]?[0-9]+)?)(_KiB|_MiB|_GiB|_TiB|ns|us|ms|min|s|h|[uUlLzZfF]{0,3})(?![A-Za-z0-9_])/y)
      if (m) {
        const [, digits, suffix] = m
        if (CPP_SIZE_LITERALS[suffix]) {
          const n = parseIntLiteral(digits, lang)
          return n === null ? null : { t: 'num', v: n * CPP_SIZE_LITERALS[suffix] }
        }
        if (CPP_DURATION_LITERALS[suffix]) {
          const n = parseIntLiteral(digits, lang)
          return n === null ? null : { t: 'dur', v: n * CPP_DURATION_LITERALS[suffix] }
        }
        const n = parseIntLiteral(digits + suffix, lang)
        if (n !== null) return { t: 'num', v: n }
        const f = parseFloatLiteral(digits + suffix, lang)
        return f === null ? null : { t: 'num', v: f }
      }
      return null
    }
    // Go.
    let m = eat(/time\.(Nanosecond|Microsecond|Millisecond|Second|Minute|Hour)(?![A-Za-z0-9_])/y)
    if (m) return { t: 'dur', v: GO_UNITS[m[1]] }
    m = eat(/(true|false)(?![A-Za-z0-9_])/y)
    if (m) return { t: 'bool', v: m[1] === 'true' }
    m = eat(/([0-9][0-9a-fA-FxXbBoO_.]*(?:[eE][+-]?[0-9]+)?)(?![A-Za-z0-9_])/y)
    if (m) {
      const n = parseIntLiteral(m[1], lang)
      if (n !== null) return { t: 'num', v: n }
      const f = parseFloatLiteral(m[1], lang)
      return f === null ? null : { t: 'num', v: f }
    }
    return null
  }
  const result = product()
  return result && i === s.length ? result : null
}

function multiply (a, b) {
  if (a.t === 'num' && b.t === 'num') {
    if (typeof a.v === 'bigint' && typeof b.v === 'bigint') return { t: 'num', v: a.v * b.v }
    return { t: 'num', v: Number(a.v) * Number(b.v) }
  }
  const [dur, num] = a.t === 'dur' ? [a, b] : [b, a]
  if (dur.t !== 'dur' || num.t !== 'num' || typeof num.v !== 'bigint') return null
  return { t: 'dur', v: dur.v * num.v }
}

function canonicalNumber (v) {
  if (typeof v === 'bigint') return v.toString()
  return Number.isInteger(v) ? BigInt(v).toString() : String(v)
}

/**
 * Canonical form of a default expression, or null when it cannot be
 * normalized. See the module comment for what is understood.
 * @param {string} text
 * @param {'cpp'|'go'} [lang]
 */
function canonicalValue (text, lang = 'cpp') {
  if (text == null) return null
  const str = stringValue(text, lang)
  if (str !== null) return `str:${JSON.stringify(str)}`
  const v = parseExpr(text, lang)
  if (!v) return null
  if (v.t === 'bool') return `bool:${v.v}`
  if (v.t === 'dur') return `dur:${v.v.toString()}`
  return `num:${canonicalNumber(v.v)}`
}

/**
 * Whether two default expressions hold the same value: by canonical value
 * when both normalize, by whitespace-collapsed text otherwise.
 */
function sameValue (a, b, lang = 'cpp') {
  const ca = canonicalValue(a, lang)
  const cb = canonicalValue(b, lang)
  if (ca !== null && cb !== null) return ca === cb
  return String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim()
}

module.exports = { canonicalValue, sameValue }
