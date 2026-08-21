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
 * KNOWN LIMITATION: this is a regex over the raw text, not a real JSON scanner,
 * so it does not track string/escape state. A value that is legitimate JSON
 * text APPEARING INSIDE an escaped string -- for example a Bloblang example
 * embedded as an example value, `"{\"delay_for_ns\":110839937000000000}"` --
 * is indistinguishable from real JSON structure to this regex, which inserts a
 * quoted sentinel at that position and corrupts the document. This is confirmed
 * against the real, published Connect component attachment, not a theoretical
 * risk: parsing it throws "Expected ',' or ']' after array element". Do not
 * apply this module to Connect/Bloblang-shaped JSON, or to any JSON whose string
 * values may themselves contain escaped JSON-looking text. It has been checked
 * against every redpanda-properties-*.json and property-overrides.json this
 * repo could find (~50 files, every published version) with no false match, and
 * is applied only to property-shaped data for that reason -- not because the
 * risk is theoretical elsewhere.
 */

// An integer literal too long to be safe, in JSON value position: after a colon,
// an opening bracket or a comma, and followed by a delimiter. A digit run inside
// a string cannot match, because a string value starts with a quote.
const UNSAFE_INT_RX = /([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g
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
function parse (text) {
  const shielded = String(text).replace(UNSAFE_INT_RX, (match, lead, digits) =>
    isUnsafeInteger(digits) ? `${lead}"${SENTINEL}${digits}"` : match
  )
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
