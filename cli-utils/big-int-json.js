'use strict'

/**
 * JSON parse and stringify that do not destroy integers a JS number cannot hold.
 *
 * Redpanda's property data carries the uint64 and int64 limits as the maximum and
 * minimum of numeric properties: 18446744073709551615, 9223372036854775807 and
 * -9223372036854775808. The Python extractor writes them exactly, because Python
 * integers are arbitrary precision. Every stage after that is JavaScript, where
 * the largest exactly-representable integer is 2^53 - 1, so a plain
 * `JSON.parse` silently rounds all three -- 18446744073709551615 becomes
 * 18446744073709552000, which is not the uint64 limit and is not a value the
 * server accepts.
 *
 * That had been happening on every published dataset since April: the reference
 * pages, the tooltip attachment and the Connect catalog all showed rounded
 * values, and none of them agreed with the source data.
 *
 * `parse` returns those integers as BigInt, so they print exactly and can be
 * written back unchanged by `stringify`. BigInt rather than a string because it
 * is unambiguous: a value that was a number in the source can be told apart from
 * a string that was authored as one, which is what makes the round trip safe.
 *
 * Numbers inside the safe range are untouched and stay plain numbers.
 *
 * The integers are found by scanning the text the way a JSON parser does,
 * tracking strings and escapes, so a digit run inside a string is never
 * touched. That matters for Connect data, whose example values carry escaped
 * JSON-looking text such as `"{\"delay_for_ns\":110839937000000000}"`.
 */

// Printable ASCII: a control character is not legal inside a JSON string, so a
// sentinel containing one produces JSON that will not parse.
const SENTINEL = '@@bigint:'
const SENTINEL_RX = new RegExp(`"${SENTINEL}(-?\\d+)"`, 'g')

/** True if the literal needs BigInt to survive a round trip. */
function isUnsafeInteger (digits) {
  return !Number.isSafeInteger(Number(digits))
}

/**
 * Parse JSON, returning integers outside the safe range as BigInt.
 *
 * @param {string} text - JSON text.
 * @returns {*} The parsed value.
 */
// The text with every unsafe integer literal outside a string replaced by a
// quoted sentinel. Outside strings, JSON has digits only in numbers.
function shield (text) {
  let out = ''
  let last = 0
  let i = 0
  const n = text.length
  const isDigit = (c) => c >= '0' && c <= '9'
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      i++
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      i++
      continue
    }
    if (c === '-' || isDigit(c)) {
      let j = c === '-' ? i + 1 : i
      while (j < n && isDigit(text[j])) j++
      if (text[j] === '.' || text[j] === 'e' || text[j] === 'E') {
        // A fraction or exponent: not an integer, leave it to JSON.parse.
        j++
        while (j < n && (isDigit(text[j]) || '+-eE.'.includes(text[j]))) j++
      } else if (isUnsafeInteger(text.slice(i, j))) {
        out += `${text.slice(last, i)}"${SENTINEL}${text.slice(i, j)}"`
        last = j
      }
      i = j
      continue
    }
    i++
  }
  return out + text.slice(last)
}

function parse (text) {
  const shielded = shield(String(text))
  return JSON.parse(shielded, (key, value) =>
    typeof value === 'string' && value.startsWith(SENTINEL) ? BigInt(value.slice(SENTINEL.length)) : value
  )
}

/**
 * Stringify JSON, writing BigInt values back as bare integer literals.
 *
 * @param {*} value - Value to serialize.
 * @param {number|string} [space] - Indentation, as JSON.stringify takes it.
 * @returns {string} JSON text.
 */
function stringify (value, space) {
  const json = JSON.stringify(value, (key, entry) =>
    typeof entry === 'bigint' ? `${SENTINEL}${entry.toString()}` : entry, space
  )
  return json === undefined ? json : json.replace(SENTINEL_RX, '$1')
}

module.exports = { parse, stringify, isUnsafeInteger }
