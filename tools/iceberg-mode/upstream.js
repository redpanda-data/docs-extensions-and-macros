'use strict'

/**
 * Reads Redpanda's own C++ for redpanda.iceberg.mode and turns it into data.
 *
 * Pure functions only: no network, no file system. generate.js fetches the
 * sources at each release tag and calls these; the tests call them on small
 * synthetic sources.
 *
 * Three things come out of a release's sources:
 *
 * - The grammar (`extractGrammar`, from src/v/model/model.cc): which legacy
 *   names the parser compares against, whether it accepts value_schema_latest
 *   options and which, whether it hands anything else to the section parser,
 *   and the section, option and enum names that parser matches. Every value is
 *   a string literal the parser itself compares against.
 * - A fingerprint of the parser source (`parserFingerprint`). The port in
 *   extension-utils/iceberg-mode.js implements the grammar's structure (for
 *   example "subject requires mode=schema_latest") in code, and the literals
 *   above cannot describe a change to that structure. The fingerprint changes
 *   whenever any parser function changes, so such a release cannot slip in
 *   without someone reviewing the port against it.
 * - The test vectors (`extractVectors`, from
 *   src/v/model/tests/iceberg_mode_test.cc): the accept, reject, error-message,
 *   format and round-trip cases, read statement by statement.
 *
 * Everything here fails loudly on a shape it does not recognize. A silent
 * fallback would produce a plausible grammar or vector set that is wrong for
 * some release, which is worse than a red drift job.
 */

const crypto = require('crypto')

// The parser and formatter functions, in the order they are fingerprinted.
// Each pattern matches the start of a definition (not a call): the parameter
// list is followed by the opening brace.
const PARSER_FUNCTIONS = [
  ['operator>>', /std::istream&\s+operator>>\(\s*std::istream&\s+\w+,\s*iceberg_mode&\s+\w+\s*\)\s*\{/],
  ['parse_iceberg_mode', /\bparse_iceberg_mode\(\s*std::string_view\s+\w+\s*\)\s*\{/],
  ['parse_legacy_schema_latest', /\bparse_legacy_schema_latest\(\s*std::string_view\s+\w+\s*\)\s*\{/],
  ['parse_config_options', /\bparse_config_options\(\s*std::string_view\s+\w+\s*\)\s*\{/],
  ['parse_extended_iceberg_mode', /\bparse_extended_iceberg_mode\(\s*std::string_view\s+\w+\s*\)\s*\{/],
  ['parse_section_opts', /\bparse_section_opts\(\s*std::string_view\s+\w+\s*\)\s*\{/],
  ['format_to', /\biceberg_mode::format_to\(\s*fmt::iterator\s+\w+\s*\)\s*const\s*\{/],
  ['operator<<', /std::ostream&\s+operator<<\(\s*std::ostream&\s+\w+,\s*const\s+iceberg_mode&\s+\w+\s*\)\s*\{/],
  ['to_sv(schema_mode)', /\bto_sv\(\s*iceberg_mode::schema_mode\s+\w+\s*\)\s*\{/],
  ['to_sv(header_schema_mode)', /\bto_sv\(\s*iceberg_mode::header_schema_mode\s+\w+\s*\)\s*\{/],
  ['to_sv(value_layout)', /\bto_sv\(\s*iceberg_mode::value_layout\s+\w+\s*\)\s*\{/],
]

/** Remove // and block comments, leaving string and char literals intact. */
function stripComments (source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '"' || c === "'") {
      const end = literalEnd(source, i)
      out += source.slice(i, end)
      i = end
    } else if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      out += ' '
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Index just past the string or char literal that starts at `start`. */
function literalEnd (source, start) {
  const quote = source[start]
  let i = start + 1
  while (i < source.length && source[i] !== quote) {
    if (source[i] === '\\') i++
    i++
  }
  return i + 1
}

/**
 * The body of the brace block whose opening brace is at `open`, without the
 * braces. Comments must already be stripped.
 */
function braceBlock (source, open) {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    if (c === '"' || c === "'") {
      i = literalEnd(source, i) - 1
    } else if (c === '{') {
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error('unbalanced braces')
}

/** Merge adjacent C++ string literals ("a" "b" -> "ab") and collapse whitespace. */
function normalize (code) {
  let out = ''
  let i = 0
  while (i < code.length) {
    const c = code[i]
    if (c === '"' || c === "'") {
      const end = literalEnd(code, i)
      let literal = code.slice(i, end)
      i = end
      // Adjacent string literals are one literal in C++.
      while (c === '"') {
        let j = i
        while (j < code.length && /\s/.test(code[j])) j++
        if (code[j] !== '"') break
        const nextEnd = literalEnd(code, j)
        literal = literal.slice(0, -1) + code.slice(j + 1, nextEnd)
        i = nextEnd
      }
      out += literal
    } else if (/\s/.test(c)) {
      while (i < code.length && /\s/.test(code[i])) i++
      out += ' '
    } else {
      out += c
      i++
    }
  }
  return out.trim()
}

/**
 * The parser functions present in a model.cc, as {name: normalized body}.
 * @param {string} modelCc
 * @returns {Object<string,string>}
 */
function parserFunctions (modelCc) {
  const source = stripComments(modelCc)
  const found = {}
  for (const [name, rx] of PARSER_FUNCTIONS) {
    const match = rx.exec(source)
    if (!match) continue
    const open = match.index + match[0].length - 1
    found[name] = normalize(braceBlock(source, open))
  }
  return found
}

/**
 * sha256 over every parser function, so any change to how the release parses
 * or formats the value changes it. Whitespace and comments do not count.
 * @param {Object<string,string>} functions From parserFunctions.
 * @returns {string}
 */
function parserFingerprint (functions) {
  const hash = crypto.createHash('sha256')
  for (const [name] of PARSER_FUNCTIONS) {
    if (functions[name] === undefined) continue
    hash.update(`${name}\n${functions[name]}\n`)
  }
  return hash.digest('hex')
}

const unique = (list) => [...new Set(list)]
const literals = (code, rx) => unique([...code.matchAll(rx)].map((m) => m[1]))

/**
 * The grammar one release's parser accepts, read from the literals it
 * compares against. Returns null when the file has no iceberg_mode parser
 * (a release before Iceberg).
 *
 * @param {string} modelCc Contents of src/v/model/model.cc.
 * @returns {null|{
 *   legacyNames: string[],
 *   legacySchemaLatest: null|{prefix: string, options: string[]},
 *   sections: null|{names: string[], options: string[], schemaModes: string[], layouts: string[], headerValueTypes: string[]},
 *   messages: boolean,
 * }}
 *   `messages` is true when the parser reports why a value is invalid
 *   (std::expected with an error string). Before that, a bad value only set
 *   failbit and Redpanda gave no reason.
 */
function extractGrammar (modelCc) {
  const fns = parserFunctions(modelCc)
  const top = fns.parse_iceberg_mode || fns['operator>>']
  if (!top) return null

  // Legacy names are the exact strings the top-level parser compares the
  // whole value with: `s == "key_value"`, or string_switch `.match("x", ...)`.
  // The whole value is parse_iceberg_mode's parameter, or what operator>>
  // extracts from the stream (`is >> s`).
  const param = /\bparse_iceberg_mode\(\s*std::string_view\s+(\w+)\s*\)\s*\{/.exec(stripComments(modelCc))
  const valueVar = fns.parse_iceberg_mode
    ? param && param[1]
    : (/\w+\s*>>\s*(\w+)\s*;/.exec(top) || [])[1]
  if (!valueVar) throw new Error('cannot tell which variable holds the iceberg_mode value')
  const legacyNames = unique([
    ...literals(top, new RegExp(`\\b${valueVar}\\s*==\\s*"(\\w+)"`, 'g')),
    ...literals(top, /\.match\(\s*"(\w+)"/g),
  ])
  if (!legacyNames.length) throw new Error('iceberg_mode parser compares against no legacy names')

  let legacySchemaLatest = null
  const prefix = /\.starts_with\(\s*"(\w+)"\s*\)/.exec(top)
  if (prefix) {
    // The option loop lives in the top-level parser up to 26.1 and in
    // parse_legacy_schema_latest after it. Only `k`/`key` comparisons are
    // option names; `s ==` compares the whole value.
    const optionCode = fns.parse_legacy_schema_latest || top
    const options = literals(optionCode, /\b(?:k|key)\s*==\s*"(\w+)"/g)
    if (!options.length) throw new Error(`${prefix[1]} is accepted but no option names were found`)
    legacySchemaLatest = { prefix: prefix[1], options }
  }

  let sections = null
  if (/\bparse_extended_iceberg_mode\(/.test(top)) {
    const ext = fns.parse_extended_iceberg_mode
    if (!ext) throw new Error('parse_iceberg_mode calls parse_extended_iceberg_mode, which is not defined in model.cc')
    sections = {
      names: literals(ext, /\bsec_name\s*==\s*"(\w+)"/g),
      options: literals(ext, /\bk\s*==\s*"(\w+)"/g),
      schemaModes: literals(ext, /\.match\(\s*"(\w+)",\s*sm::/g),
      layouts: literals(ext, /\.match\(\s*"(\w+)",\s*vl::/g),
      headerValueTypes: literals(ext, /\.match\(\s*"(\w+)",\s*hsm::/g),
    }
    for (const [key, list] of Object.entries(sections)) {
      if (!list.length) throw new Error(`parse_extended_iceberg_mode: found no ${key}`)
    }
  } else if (fns.parse_iceberg_mode && !/\bparse_extended_iceberg_mode\(/.test(fns.parse_iceberg_mode)) {
    throw new Error('parse_iceberg_mode exists but does not delegate to parse_extended_iceberg_mode; the extractor needs updating')
  }

  return {
    legacyNames,
    legacySchemaLatest,
    sections,
    messages: /std::unexpected\(/.test(top + (fns.parse_extended_iceberg_mode || '')),
  }
}

/**
 * The cluster feature gate from src/v/kafka/server/handlers/configs/config_utils.h:
 * the release a cluster must be fully upgraded to before Redpanda accepts a
 * value that needs the extended format. Null when the file has no such gate.
 * @param {string} configUtilsH
 * @returns {string|null}
 */
function extractClusterGate (configUtilsH) {
  if (!configUtilsH) return null
  const source = normalize(stripComments(configUtilsH))
  if (!/needs_extended_cluster_feature\(\)/.test(source)) return null
  const match = /fully upgraded to at least (v\d+\.\d+\.\d+)/.exec(source)
  if (!match) throw new Error('config_utils.h gates on needs_extended_cluster_feature but names no release')
  return match[1]
}

// ---------------------------------------------------------------------------
// Test vectors
// ---------------------------------------------------------------------------

// Statements in a TEST body that exercise something other than the string
// grammar (the broker's wire format and cluster feature gate). They are
// skipped, and so is a TEST made only of them.
const IGNORED = /\bwire_roundtrip\(|\bwire_discriminant\(|\bneeds_extended_cluster_feature\(|\bwrite_nested\(|\bserde::/

const NAMED = { disabled: 'disabled', key_value: 'key_value', value_schema_id_prefix: 'value_schema_id_prefix' }

const STR = '"((?:[^"\\\\]|\\\\.)*)"'
const unescape = (s) => JSON.parse(`"${s}"`)

/** Fields set by model::iceberg_mode::value_schema_latest(protobuf_name, subject). */
function schemaLatestFields (protobufName, subject) {
  const fields = { 'value.mode': 'schema_latest' }
  if (protobufName) fields['value.protobuf_name'] = protobufName
  if (subject) fields['value.subject'] = subject
  return fields
}

/** Split a normalized body on top-level semicolons, outside string literals. */
function splitStatements (body) {
  const statements = []
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '"' || c === "'") i = literalEnd(body, i) - 1
    else if (c === ';') {
      statements.push(body.slice(start, i).trim())
      start = i + 1
    }
  }
  statements.push(body.slice(start).trim())
  return statements.filter(Boolean)
}

/**
 * The TEST(...) blocks of a gtest file, as {suite, name, statements}.
 * @param {string} testCc
 */
function testBlocks (testCc) {
  const source = stripComments(testCc)
  const blocks = []
  const rx = /\bTEST\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*\{/g
  let match
  while ((match = rx.exec(source))) {
    const open = match.index + match[0].length - 1
    const body = normalize(braceBlock(source, open))
    const statements = splitStatements(body)
    blocks.push({ suite: match[1], name: match[2], statements })
  }
  return blocks
}

/**
 * Read the accept, reject, error-message, format and round-trip cases from
 * iceberg_mode_test.cc, in the shape __tests__/fixtures/iceberg-mode/
 * upstream-vectors.js exports. Throws on any statement it cannot read, naming
 * the TEST, so a new kind of assertion upstream fails the drift job instead of
 * being dropped.
 *
 * @param {string} testCc
 */
function extractVectors (testCc) {
  const accept = []
  const reject = []
  const errorMessages = []
  const format = []
  const roundtrip = []

  for (const block of testBlocks(testCc)) {
    const test = `${block.suite}.${block.name}`
    const relevant = block.statements.filter((s) => !IGNORED.test(s))
    if (!relevant.length) continue
    // Variables: parse results (`auto m = parse(...)`), constructed modes
    // (`enabled e{}` ... `model::iceberg_mode m{std::move(e)}`), and parse_err
    // strings. Accept entries are created when the test asserts success.
    const parsed = {}
    const entries = {}
    const built = {}
    let enabled = null
    const errors = {}
    const unknown = (statement) => {
      throw new Error(`${test}: unrecognized statement: ${statement}`)
    }
    const modeOf = (expr) => {
      let m
      if ((m = /^model::iceberg_mode::(\w+)$/.exec(expr)) && NAMED[m[1]]) return { input: NAMED[m[1]] }
      if ((m = new RegExp(`^model::iceberg_mode::value_schema_latest\\(\\s*${STR}\\s*,\\s*${STR}\\s*\\)$`).exec(expr))) {
        return { fields: schemaLatestFields(unescape(m[1]), unescape(m[2])) }
      }
      if (/^model::iceberg_mode\s*\{\s*std::move\(e\)\s*\}$/.test(expr)) {
        if (!enabled) unknown(expr)
        return { fields: { ...enabled } }
      }
      if (built[expr]) return built[expr]
      if ((m = /^\*(\w+)$/.exec(expr)) && parsed[m[1]] !== undefined) return { input: parsed[m[1]] }
      return null
    }
    const entryFor = (v) => {
      if (parsed[v] === undefined) unknown(`${v} is not a parse() result`)
      if (!entries[v]) {
        entries[v] = { test, input: parsed[v], expect: {} }
        accept.push(entries[v])
      }
      return entries[v]
    }

    for (const s of relevant) {
      let m
      if ((m = new RegExp(`^auto (\\w+) = parse\\(\\s*${STR}\\s*\\)$`).exec(s))) {
        parsed[m[1]] = unescape(m[2])
      } else if ((m = /^ASSERT_TRUE\((\w+)\.has_value\(\)\)$/.exec(s))) {
        entryFor(m[1])
      } else if ((m = /^ASSERT_FALSE\((\w+)->is_disabled\(\)\)$/.exec(s))) {
        entryFor(m[1])
      } else if ((m = /^EXPECT_TRUE\((\w+)->is_disabled\(\)\)$/.exec(s))) {
        entryFor(m[1]).expect.disabled = true
      } else if ((m = /^EXPECT_EQ\(\*(\w+), model::iceberg_mode::(\w+)\)$/.exec(s)) && NAMED[m[2]]) {
        const entry = entryFor(m[1])
        if (entry.input !== NAMED[m[2]]) entry.equals = NAMED[m[2]]
      } else if ((m = /^EXPECT_EQ\(\*(\w+), \*(\w+)\)$/.exec(s))) {
        entryFor(m[2]).equals = parsed[m[1]]
        entryFor(m[1])
      } else if ((m = /^EXPECT_EQ\((\w+)->(key|value|headers)\(\)\.(\w+), (?:sm|hsm|vl)::(\w+)\)$/.exec(s))) {
        entryFor(m[1]).expect[`${m[2]}.${m[3]}`] = m[4]
      } else if ((m = new RegExp(`^EXPECT_EQ\\((\\w+)->(key|value|headers)\\(\\)\\.(\\w+), ${STR}\\)$`).exec(s))) {
        entryFor(m[1]).expect[`${m[2]}.${m[3]}`] = unescape(m[4])
      } else if ((m = /^EXPECT_TRUE\((\w+)->(key|value|headers)\(\)\.(\w+)\.empty\(\)\)$/.exec(s))) {
        entryFor(m[1]).expect[`${m[2]}.${m[3]}`] = ''
      } else if ((m = new RegExp(`^EXPECT_FALSE\\(\\s*parse\\(\\s*${STR}\\s*\\)\\s*\\.has_value\\(\\)\\)$`).exec(s))) {
        reject.push({ test, input: unescape(m[1]) })
      } else if ((m = new RegExp(`^auto (\\w+) = parse_err\\(\\s*${STR}\\s*\\)$`).exec(s))) {
        errors[m[1]] = { test, input: unescape(m[2]) }
        errorMessages.push(errors[m[1]])
      } else if ((m = new RegExp(`^EXPECT_THAT\\((\\w+), testing::HasSubstr\\(${STR}\\)\\)$`).exec(s)) && errors[m[1]]) {
        const e = errors[m[1]]
        ;(e.contains || (e.contains = [])).push(unescape(m[2]))
      } else if ((m = new RegExp(`^EXPECT_EQ\\(\\s*(\\w+), ${STR}\\)$`).exec(s)) && errors[m[1]]) {
        errors[m[1]].exact = unescape(m[2])
      } else if (/^enabled e\s*\{\s*\}$/.test(s)) {
        enabled = {}
      } else if ((m = /^e\.(key|value|headers)\.(\w+) = (?:sm|hsm|vl)::(\w+)$/.exec(s)) && enabled) {
        enabled[`${m[1]}.${m[2]}`] = m[3]
      } else if ((m = new RegExp(`^e\\.(key|value|headers)\\.(\\w+) = ${STR}$`).exec(s)) && enabled) {
        enabled[`${m[1]}.${m[2]}`] = unescape(m[3])
      } else if ((m = /^model::iceberg_mode (\w+)\s*\{\s*std::move\(e\)\s*\}$/.exec(s)) && enabled) {
        built[m[1]] = { fields: { ...enabled } }
      } else if ((m = /^auto (\w+) = (model::iceberg_mode::value_schema_latest\(.*\))$/.exec(s))) {
        built[m[1]] = modeOf(m[2]) || unknown(s)
      } else if ((m = new RegExp(`^EXPECT_EQ\\(\\s*to_string\\((.+?)\\), ${STR}\\)$`).exec(s))) {
        const mode = modeOf(m[1].trim()) || unknown(s)
        format.push({ test, ...mode, expected: unescape(m[2]) })
      } else if ((m = /^check_stable\(\s*(.+)\)$/.exec(s))) {
        const mode = modeOf(m[1].trim()) || unknown(s)
        roundtrip.push({ test, ...mode })
      } else {
        unknown(s)
      }
    }
  }

  // parse_err asserts failure as well, so its inputs are rejections too.
  const rejected = new Set(reject.map((v) => v.input))
  for (const v of errorMessages) {
    if (!rejected.has(v.input)) {
      reject.push({ test: v.test, input: v.input })
      rejected.add(v.input)
    }
  }

  return { accept, reject, errorMessages, format, roundtrip }
}

module.exports = {
  PARSER_FUNCTIONS,
  stripComments,
  parserFunctions,
  parserFingerprint,
  extractGrammar,
  extractClusterGate,
  extractVectors,
}
