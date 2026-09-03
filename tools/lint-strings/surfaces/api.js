'use strict'

const fs = require('fs')
const path = require('path')

const { SourceCache } = require('../source-text')

/**
 * API surface: doc strings in the API protos, which reach readers through
 * `buf.gen.openapi.yaml` -> OpenAPI -> the bundled specs in api-docs
 * (cloud-dataplane, cloud-controlplane, admin, http-proxy, schema-registry)
 * -> the published API reference.
 *
 * Unlike the other six surfaces this one carries TWO string forms with
 * different contracts, because the generator treats them differently:
 *
 *   1. Leading `//` comments on messages and fields. protoc-gen-openapiv2
 *      copies these into the schema's `description`. Prose, sentence case,
 *      terminal period - the same shape as the crd surface.
 *
 *   2. `summary:` and `description:` inside openapiv2 option blocks:
 *
 *        option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
 *          summary: "Create topic"
 *          description: "Create a [topic](https://docs.redpanda.com/...)."
 *        };
 *
 *      `summary` is the operation's one-line label and behaves like a cobra
 *      Short: one line, capitalized, no terminal period. `description` is
 *      prose and takes one.
 *
 * The output format is Markdown, not AsciiDoc, so `verbatim_asciidoc` is
 * false and none of the AsciiDoc rules (raw pipe, `{attr}`, broken macros)
 * apply. Markdown links to docs.redpanda.com are the existing convention in
 * these files and are deliberately NOT flagged: a link that resolves in the
 * output format is not the same thing as an `xref:` stranded in a C++ string.
 *
 * Out of scope, deliberately:
 *
 *   * `description` inside a `responses:` block ("OK", "Topic created").
 *     That is HTTP status prose, not user-facing feature prose, and holding
 *     two-word status labels to the quality bar would bury the real findings.
 *   * Every other openapiv2 key (`title`, `example`, `tags`, ...).
 *   * `google.api.http` bindings and `buf.validate` options, which are
 *     behavior rather than prose.
 *   * Fields inside an `extend` block: protobuf extension fields are wire
 *     metadata, never published schema.
 *
 * Known gap: comments on individual enum VALUES (`API_KAFKA = 1;`) are not
 * extracted, only the comment on the enum itself. protoc-gen-openapiv2 does
 * surface value descriptions, so this is worth adding once the surface has
 * run against real PRs and the noise level is known.
 */

const CONVENTION = {
  case: 'sentence',
  terminal_period: true,
  verbatim_asciidoc: false
}

/**
 * Path -> in-scope roots. Kept here as well as in diff.js's routing table
 * because full-repo mode has no diff to route: `extract` without a file set
 * walks these.
 *
 * console holds the data plane and Console APIs; cloudv2's proto/public tree
 * holds the control plane. A repo that has neither yields no declarations.
 */
const API_ROOTS = [
  path.join('proto', 'redpanda', 'api'),
  path.join('proto', 'public')
]

/** Recursively collect .proto files under a directory. */
function collectProtoFiles (dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectProtoFiles(full))
    else if (entry.name.endsWith('.proto')) out.push(full)
  }
  return out
}

/**
 * Field declarations look like:
 *
 *   string name = 1;
 *   optional string value = 3;
 *   repeated ConfigSynonym config_synonyms = 7;
 *   map<string, string> labels = 4;
 *   string name = 1 [(buf.validate.field).string.min_len = 1];
 *
 * The type may be qualified (`redpanda.api.common.v1.ErrorStatus`) or a map.
 * Captures the field name and whether an option list follows.
 */
const FIELD_RE = /^\s*(?:(?:optional|repeated|required)\s+)?(?:map\s*<[^>]*>|[A-Za-z_][A-Za-z0-9_.]*)\s+([a-z_][a-zA-Z0-9_]*)\s*=\s*\d+\s*(\[|;)/

/** `message Foo {`, `enum Foo {`. Services carry no schema description. */
const BLOCK_RE = /^\s*(message|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/

/**
 * `rpc CreateTopic(Req) returns (Res) {`. The rpc name is what an openapiv2
 * operation string is about, so findings are named after it. Without this the
 * name fell back to the file's basename and every summary in a file reported
 * under the same name, which is useless in a review comment.
 */
const RPC_RE = /^\s*rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/

/**
 * `extend google.protobuf.MethodOptions {` declares protobuf extension fields
 * (Console's per-RPC `auth` option, for example). Those are wire metadata, not
 * published schema, so the generator never documents them and neither do we.
 */
const EXTEND_RE = /^\s*extend\s+[A-Za-z_][A-Za-z0-9_.]*\s*\{/

/** An openapiv2 option block opening. Captures which one. */
const OPENAPI_OPTION_RE = /^\s*option\s*\(\s*grpc\.gateway\.protoc_gen_openapiv2\.options\.(openapiv2_[a-z_]+)\s*\)\s*=\s*\{/

/** `summary: "..."` / `description: "..."` inside an option block. */
const OPENAPI_STRING_RE = /^\s*(summary|description)\s*:\s*"((?:[^"\\]|\\.)*)"\s*$/

/** A line that is only a quoted string: proto concatenates these like C++. */
const CONTINUATION_RE = /^\s*"((?:[^"\\]|\\.)*)"\s*$/

/** Unescape a proto string literal's body. */
function unescape (raw) {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

/**
 * Count braces outside string literals. Counting them raw made a `{` inside
 * a description ("use `{prefix}`") close the option block early, which
 * dropped every declaration after it in the file.
 */
function braceDelta (line) {
  let delta = 0
  let inString = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') delta++
    else if (ch === '}') delta--
  }
  return delta
}

/**
 * Find the line index where a field statement ends (its terminating `;`),
 * starting from its first line. An option list can wrap over several lines,
 * and the declaration span has to cover all of them so a suggestion block
 * can replace the whole thing.
 */
function findStatementEnd (lines, start) {
  for (let i = start; i < lines.length; i++) {
    if (/;\s*(?:\/\/.*)?$/.test(lines[i])) return i
  }
  return start
}

/**
 * Parse one proto file. Exported for tests.
 *
 * @param {string} content - File content
 * @param {string} file - Repo-relative path
 * @returns {Array} declarations (without declaration_text)
 */
function scanFile (content, file) {
  const declarations = []
  const lines = content.split('\n')

  let comment = [] // pending comment lines: { line (0-indexed), text }
  // Enclosing message/enum names as { name, depth }: depth is the brace depth
  // BEFORE the block opened, so the block pops when depth returns to it. A
  // bare `}` test cannot do this - `oneof {`, an inline `option { ... }` and a
  // wrapped `[...]` option list all move the depth without opening a message,
  // and matching their closing brace popped the enclosing message, which
  // reported sibling messages as nested (Foo.Bar.Baz for three siblings).
  let blocks = []
  let depth = 0
  let extendDepth = null // brace depth an `extend` block opened at, else null
  let rpc = null // { name, depth } for the rpc whose body we are inside
  let option = null // { kind, depth, responsesDepth } while inside an option block

  const blockNames = () => blocks.map((b) => b.name)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // ---- inside an openapiv2 option block ----
    if (option) {
      const before = option.depth
      const delta = braceDelta(line)
      option.depth += delta
      depth += delta

      // `responses:` opens a sub-block whose descriptions are HTTP status
      // prose. Remember the depth it opened at so the skip ends with it.
      if (/^\s*responses\s*:\s*\{/.test(line)) {
        option.responsesDepth = before
      } else if (option.responsesDepth !== undefined && option.depth <= option.responsesDepth) {
        option.responsesDepth = undefined
      }

      const strMatch = OPENAPI_STRING_RE.exec(line)
      if (strMatch && option.responsesDepth === undefined) {
        const key = strMatch[1]
        let text = unescape(strMatch[2])
        let end = i
        // Adjacent string literals on following lines concatenate.
        while (end + 1 < lines.length && CONTINUATION_RE.test(lines[end + 1])) {
          end++
          text += unescape(CONTINUATION_RE.exec(lines[end])[1])
        }
        declarations.push({
          surface: 'api',
          name: option.operationId || blockNames()[blocks.length - 1] || path.basename(file, '.proto'),
          file,
          line_start: i + 1,
          line_end: end + 1,
          string: text || null,
          declaration_text: null,
          convention: CONVENTION,
          meta: {
            kind: key === 'summary' ? 'operation-summary' : `${option.kind.replace('openapiv2_', '')}-description`,
            option: option.kind,
            key
          }
        })
        i = end
      }

      if (option.depth <= 0) option = null
      comment = []
      continue
    }

    const optMatch = OPENAPI_OPTION_RE.exec(line)
    if (optMatch) {
      option = {
        kind: optMatch[1],
        depth: braceDelta(line),
        operationId: rpc ? rpc.name : blockNames()[blocks.length - 1] || null
      }
      comment = []
      continue
    }

    // ---- comments accumulate until something consumes them ----
    if (/^\s*\/\//.test(line)) {
      comment.push({ line: i, text: trimmed.replace(/^\/\/\s?/, '') })
      continue
    }

    // ---- rpc: names the openapiv2 operation strings in its body ----
    const rpcMatch = RPC_RE.exec(line)
    if (rpcMatch) {
      // A body-less `rpc Foo(A) returns (B);` opens nothing, so only remember
      // the name when the line actually opens a block.
      if (braceDelta(line) > 0) rpc = { name: rpcMatch[1], depth }
      depth += braceDelta(line)
      comment = []
      continue
    }

    // ---- extend block: wire metadata, not published schema ----
    if (EXTEND_RE.test(line)) {
      extendDepth = depth
      depth += braceDelta(line)
      comment = []
      continue
    }

    // ---- message / enum ----
    const blockMatch = BLOCK_RE.exec(line)
    if (blockMatch) {
      const [, keyword, name] = blockMatch
      const prose = comment.map((c) => c.text).join('\n').trim()
      if (prose) {
        declarations.push({
          surface: 'api',
          name,
          file,
          line_start: comment[0].line + 1,
          line_end: i + 1,
          string: prose,
          declaration_text: null,
          convention: CONVENTION,
          meta: { kind: keyword === 'enum' ? 'enum' : 'message', block: blockNames().join('.') || null }
        })
      }
      blocks.push({ name, depth })
      depth += braceDelta(line)
      comment = []
      continue
    }

    // ---- field ----
    const fieldMatch = FIELD_RE.exec(line)
    if (fieldMatch && extendDepth === null) {
      const name = fieldMatch[1]
      const prose = comment.map((c) => c.text).join('\n').trim()
      const end = fieldMatch[2] === '[' ? findStatementEnd(lines, i) : i
      declarations.push({
        surface: 'api',
        name,
        file,
        line_start: (comment.length > 0 ? comment[0].line : i) + 1,
        line_end: end + 1,
        string: prose || null,
        declaration_text: null,
        convention: CONVENTION,
        meta: {
          kind: 'field',
          message: blockNames()[blocks.length - 1] || null,
          path: blocks.length > 0 ? `${blockNames().join('.')}.${name}` : name
        }
      })
      comment = []
      for (let j = i; j <= end; j++) depth += braceDelta(lines[j])
      while (blocks.length > 0 && depth <= blocks[blocks.length - 1].depth) blocks.pop()
      i = end
      continue
    }

    // ---- every other line: track depth, close any block it ends ----
    depth += braceDelta(line)
    while (blocks.length > 0 && depth <= blocks[blocks.length - 1].depth) blocks.pop()
    if (extendDepth !== null && depth <= extendDepth) extendDepth = null
    if (rpc !== null && depth <= rpc.depth) rpc = null

    if (trimmed !== '') comment = []
  }

  return declarations
}

/**
 * Extract API doc-string declarations.
 *
 * @param {Object} options - { repo, files (Set of repo-relative paths in diff
 *   mode; when omitted, walks API_ROOTS) }
 */
function extract ({ repo, files = null }) {
  let fileList
  if (files) {
    fileList = [...files].filter((f) => f.endsWith('.proto'))
  } else {
    fileList = []
    for (const root of API_ROOTS) {
      fileList.push(
        ...collectProtoFiles(path.join(repo, root)).map((f) => path.relative(repo, f))
      )
    }
  }

  const cache = new SourceCache(repo)
  const declarations = []
  for (const file of fileList) {
    const absPath = path.isAbsolute(file) ? file : path.join(repo, file)
    if (!fs.existsSync(absPath)) continue
    const content = fs.readFileSync(absPath, 'utf8')
    for (const decl of scanFile(content, file)) {
      decl.declaration_text = cache.span(file, decl.line_start, decl.line_end)
      declarations.push(decl)
    }
  }
  return declarations
}

/** Kinds whose string is prose and therefore takes a terminal period. */
const PROSE_KINDS = Object.freeze(['field', 'message', 'enum', 'operation-description', 'tag-description'])

/** Surface-specific convention rules. */
const RULES = [
  {
    name: 'api-summary-multiline',
    description: 'openapiv2 summary must be a single line',
    severity: 'error',
    check: (decl) => {
      if (decl.meta?.kind !== 'operation-summary') return []
      if (/\n/.test(decl.string || '')) {
        return [{ message: 'The openapiv2 `summary` is the operation label in the API reference index. Keep it on one line and move detail to `description`.' }]
      }
      return []
    }
  },
  {
    name: 'api-summary-terminal-period',
    description: 'openapiv2 summary takes no terminal period',
    severity: 'error',
    check: (decl) => {
      if (decl.meta?.kind !== 'operation-summary') return []
      if (/\.\s*$/.test(decl.string || '')) {
        return [{ message: 'The openapiv2 `summary` is a label, not a sentence. Drop the terminal period (same contract as an rpk `Short`).' }]
      }
      return []
    }
  },
  {
    name: 'api-missing-terminal-period',
    description: 'Prose doc string with no terminal period',
    severity: 'warning',
    check: (decl) => {
      if (!PROSE_KINDS.includes(decl.meta?.kind)) return []
      const text = (decl.string || '').trim()
      if (!text) return []
      // A string ending in a closing fence, list item, or bare URL is not a
      // sentence missing punctuation.
      if (/[.!?)]$/.test(text) || /`$/.test(text)) return []
      return [{ message: `Prose doc strings end in a full stop; this one does not: "${text.slice(-60)}"` }]
    }
  },
  {
    name: 'api-undocumented-field',
    description: 'Published field or message with no doc string',
    severity: 'warning',
    check: (decl) => {
      if (decl.meta?.kind !== 'field') return []
      if (decl.string && decl.string.trim() !== '') return []
      return [{ message: `\`${decl.name}\` has no comment, so it ships with a blank description in the API reference.` }]
    }
  },
  {
    name: 'api-description-too-short',
    description: 'Prose doc string too short to explain anything',
    severity: 'warning',
    check: (decl) => {
      // Scoped to prose kinds because an openapiv2 `summary` is a label and
      // is short by design: 151 of console's 216 summaries are under the
      // generic too-short threshold, and every one of them is correct.
      if (!PROSE_KINDS.includes(decl.meta?.kind)) return []
      const text = (decl.string || '').trim()
      if (!text) return [] // api-undocumented-field owns the empty case
      if (text.length < 20) {
        return [{ message: `Description is only ${text.length} characters: "${text}". Too short to explain behavior, units, or impact.` }]
      }
      return []
    }
  }
]

module.exports = {
  name: 'api',
  convention: CONVENTION,
  extract,
  scanFile,
  rules: RULES,
  API_ROOTS,
  PROSE_KINDS,
  // Both generic rules are replaced by kind-scoped equivalents above, because
  // this surface mixes prose with labels and a wholesale rule cannot tell them
  // apart:
  //   * empty-description is an ERROR, and 824 of console's 1736 fields carry
  //     no comment, so it would fail on nearly every proto PR. api-undocumented-field
  //     reports the same thing as a warning, which matches the suggest-only posture.
  //   * too-short fires on 70% of openapiv2 summaries, all correctly short.
  //     api-description-too-short applies it to prose kinds only.
  skipRules: ['empty-description', 'too-short']
}
