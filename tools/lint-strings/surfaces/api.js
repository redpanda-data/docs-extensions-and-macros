'use strict'

const fs = require('fs')
const path = require('path')

const { SourceCache } = require('../source-text')
const { isNameEcho } = require('../rules/common')

/**
 * API surface: doc strings in the API protos, which reach readers as OpenAPI
 * descriptions in the bundled specs in api-docs -> the published API
 * reference.
 *
 * TWO GENERATORS, which is why this surface is the only one that has to know
 * which tree a file came from. They derive the operation's summary and
 * description from completely different places, so one contract cannot cover
 * both and applying the wrong one produces nothing but false positives:
 *
 *   * `openapiv2` - protoc-gen-openapiv2 (buf.build/grpc-ecosystem/openapiv2).
 *     Used by console (`proto/redpanda/api/**`) and cloudv2
 *     (`proto/public/<area>/redpanda/api/**`). The operation strings are written
 *     out explicitly in an option block.
 *
 *   * `connect-openapi` - protoc-gen-connect-openapi (buf.build/community/
 *     sudorandom-connect-openapi). Used by Admin API v2 in the
 *     redpanda/streaming-enterprise repo. The operation strings come from the
 *     rpc's own leading comment.
 *
 * THREE STRING FORMS.
 *
 *   1. Leading `//` comments on messages, enums and fields. Both generators
 *      copy these into the schema's `description`. Prose, sentence case,
 *      terminal period - the same shape as the crd surface.
 *
 *   2. `summary:` and `description:` inside an openapiv2 option block
 *      (`openapiv2` only):
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
 *      An `openapiv2_field` block carries the same `description` key inside a
 *      field's `[...]` option list, and it OVERRIDES the field's leading
 *      comment. Verified by generating: `MCPServer.resources` has both, and
 *      the option's text is what ships.
 *
 *   3. An rpc's leading comment (`connect-openapi` only). The FIRST line
 *      becomes the operation summary; everything after the first blank
 *      comment line becomes the description:
 *
 *        // GetShadowLink
 *        //
 *        // Gets information about a specific shadow link.
 *        rpc GetShadowLink(GetShadowLinkRequest) returns (GetShadowLinkResponse) {
 *
 *      The blank line is load-bearing. Without it the generator uses the whole
 *      comment as BOTH summary and description, which ships a paragraph as the
 *      reference's nav item - see `api-rpc-summary-not-separated`.
 *
 *      By convention the summary is the rpc's own name (28 of the 29 rpcs in
 *      admin/v2), so `name-echo` is replaced by a kind-scoped `api-name-echo`
 *      that leaves rpc summaries alone. Punishing the documented convention on
 *      every operation would make the surface unusable on those PRs.
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
 *   * A leading comment on an `openapiv2` rpc. 159 of console's 271 rpcs
 *     carry one, but they are Go-style code comments ("GetRole retrieves the
 *     specific role.") and 23 of them are the only string the operation has.
 *     grpc-gateway splits those on the first PARAGRAPH rather than the first
 *     line, so they need their own contract; extracting them under form 3
 *     would report all 159 against a rule none of them were written for.
 *
 * Known gap: comments on individual enum VALUES (`API_KAFKA = 1;`) are not
 * extracted, only the comment on the enum itself. This is generator-specific
 * and only worth adding for `openapiv2`: protoc-gen-openapiv2 surfaces value
 * descriptions, but protoc-gen-connect-openapi verifiably discards them
 * (`ScramMechanism`'s two per-value comments do not appear in its spec), which
 * is why the Admin v2 process doc tells authors to describe the values on the
 * enum itself instead.
 */

const CONVENTION = {
  case: 'sentence',
  terminal_period: true,
  verbatim_asciidoc: false
}

/**
 * In-scope roots and the generator each one is built with. Kept here as well
 * as in diff.js's routing table because full-repo mode has no diff to route:
 * `extract` without a file set walks these.
 *
 * console holds the data plane and Console APIs; cloudv2's proto/public tree
 * holds the control plane; streaming-enterprise's proto/redpanda/core tree
 * holds Admin API v2. A repo that has none of them yields no declarations.
 *
 * The Admin v2 roots are exactly the two directories the api-docs bundler
 * feeds into the published spec (see tools/bundle-openapi.js): `admin/v2` for
 * the services, and `common` for the shared messages they reference.
 * `admin/internal` and `core/testing` are excluded by the repo's own buf.yaml
 * and generate nothing; `core/rest` generates a fragment but is never
 * bundled, so none of them reach readers.
 */
const API_ROOTS = [
  { root: path.join('proto', 'redpanda', 'api'), generator: 'openapiv2' },
  { root: path.join('proto', 'public'), generator: 'openapiv2' },
  { root: path.join('proto', 'redpanda', 'core', 'admin', 'v2'), generator: 'connect-openapi' },
  { root: path.join('proto', 'redpanda', 'core', 'common'), generator: 'connect-openapi' }
]

/**
 * Which generator builds a given proto file's OpenAPI. Diff mode has no root
 * to hand down - it gets a bare path list - so the generator is recovered
 * from the path. Anything unrecognized falls back to `openapiv2`, whose form
 * is the explicit option block: a file that has none simply yields no
 * operation strings, whereas guessing `connect-openapi` would read every
 * rpc's code comment as a published summary.
 */
function generatorFor (file) {
  const normalized = String(file).split(path.sep).join('/')
  for (const { root, generator } of API_ROOTS) {
    const prefix = root.split(path.sep).join('/')
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return generator
  }
  return 'openapiv2'
}

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

/**
 * An `openapiv2_field` block opening inside a field's `[...]` option list.
 * Distinct from OPENAPI_OPTION_RE because a field-level option carries no
 * `option` keyword - it is just `(grpc.gateway...openapiv2_field) = {`, which
 * is exactly why these descriptions were invisible to the surface.
 */
const OPENAPI_FIELD_OPTION_RE = /\(\s*grpc\.gateway\.protoc_gen_openapiv2\.options\.openapiv2_field\s*\)\s*=\s*\{/

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
 * Scan one line's braces, ignoring anything inside a string literal. Counting
 * them raw made a `{` inside a description ("use `{prefix}`") close the option
 * block early, which dropped every declaration after it in the file.
 *
 * @returns {{delta: number, hasOpen: boolean}} Net depth change, and whether
 *   the line opens a block at all. The two differ on `{}`, so they are
 *   computed by one scanner rather than two.
 */
function scanBraces (line) {
  let delta = 0
  let hasOpen = false
  let inString = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') {
      delta++
      hasOpen = true
    } else if (ch === '}') delta--
  }
  return { delta, hasOpen }
}

/** Net brace depth change for a line, outside string literals. */
function braceDelta (line) {
  return scanBraces(line).delta
}

/** True when a line has a `{` outside a string literal. */
function hasOpenBrace (line) {
  return scanBraces(line).hasOpen
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
 * The `description` an `openapiv2_field` option sets for a field, or null.
 *
 * Scanned over the field's own statement span only. It overrides the field's
 * leading `//` comment, matching the generator: console has 81 fields with
 * both, and `MCPServer.resources` proves the option wins. 87 more are
 * documented ONLY this way, and every one of them used to be reported as an
 * undocumented field.
 *
 * @returns {{text: string, line_start: number, line_end: number}|null}
 *   Line numbers are 0-indexed into `lines`.
 */
function fieldOptionDescription (lines, start, end) {
  let depth = null
  for (let i = start; i <= end && i < lines.length; i++) {
    const line = lines[i]
    if (depth === null) {
      if (OPENAPI_FIELD_OPTION_RE.test(line)) depth = braceDelta(line)
      continue
    }
    const match = OPENAPI_STRING_RE.exec(line)
    if (match && match[1] === 'description') {
      let text = unescape(match[2])
      let last = i
      while (last + 1 <= end && CONTINUATION_RE.test(lines[last + 1])) {
        last++
        text += unescape(CONTINUATION_RE.exec(lines[last])[1])
      }
      return { text, line_start: i, line_end: last }
    }
    depth += braceDelta(line)
    if (depth <= 0) depth = null
  }
  return null
}

/**
 * The line index where an rpc's signature finishes opening: the line carrying
 * the `{` that opens its body, or the `;` that ends a body-less rpc.
 *
 * Needed because an rpc signature wraps. Admin v2 clang-formats to
 *
 *   rpc CreateShadowLink(CreateShadowLinkRequest)
 *       returns (CreateShadowLinkResponse) {
 *
 * so the `rpc` line's own brace delta is 0. Testing only that line left the
 * enclosing rpc unrecorded, which is how operation strings ended up named
 * after the file.
 */
function findRpcHeaderEnd (lines, start) {
  for (let i = start; i < lines.length && i < start + 8; i++) {
    // Tested on the presence of a `{`, not on a positive net delta: an inline
    // empty body (`rpc GetIdentity(A) returns (B) {}`, which console uses)
    // nets to zero, and treating that as "not the end" ran the scan on into
    // the following declarations and dropped them.
    if (hasOpenBrace(lines[i])) return i
    if (/;\s*(?:\/\/.*)?$/.test(lines[i])) return i
  }
  return start
}

/**
 * Split an rpc's leading comment into the summary and description that
 * protoc-gen-connect-openapi derives from it.
 *
 * @param {Array<{line: number, text: string}>} comment - Pending comment lines
 * @returns {{summary: object, description: object|null}|null}
 *   Each part is { text, line_start, line_end } with 0-indexed line numbers.
 *   `collapsed` on the summary means no blank line separated the two, so the
 *   generator uses the whole comment for both.
 */
function splitRpcComment (comment) {
  // Leading and trailing blank comment lines carry nothing.
  let first = 0
  let last = comment.length - 1
  while (first <= last && comment[first].text.trim() === '') first++
  while (last >= first && comment[last].text.trim() === '') last--
  if (first > last) return null

  const body = comment.slice(first, last + 1)
  const blank = body.findIndex((c) => c.text.trim() === '')
  const part = (slice) => ({
    text: slice.map((c) => c.text).join('\n').trim(),
    line_start: slice[0].line,
    line_end: slice[slice.length - 1].line
  })

  if (blank === -1) {
    return { summary: { ...part(body), collapsed: true }, description: null }
  }
  const description = body.slice(blank + 1)
  return {
    summary: part(body.slice(0, blank)),
    description: description.length > 0 ? part(description) : null
  }
}

/**
 * Parse one proto file. Exported for tests.
 *
 * @param {string} content - File content
 * @param {string} file - Repo-relative path
 * @param {string} [generator] - 'openapiv2' | 'connect-openapi'. Decides
 *   whether an rpc's leading comment is a published operation string or a
 *   code comment; defaults to whatever the path implies.
 * @returns {Array} declarations (without declaration_text)
 */
function scanFile (content, file, generator = generatorFor(file)) {
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

    // ---- rpc ----
    const rpcMatch = RPC_RE.exec(line)
    if (rpcMatch) {
      const name = rpcMatch[1]
      // Under connect-openapi the rpc's leading comment IS the published
      // operation summary and description. Under openapiv2 it is a code
      // comment that the option block overrides, so it stays unextracted.
      if (generator === 'connect-openapi' && comment.length > 0) {
        const split = splitRpcComment(comment)
        if (split) {
          declarations.push({
            surface: 'api',
            name,
            file,
            line_start: split.summary.line_start + 1,
            line_end: split.summary.line_end + 1,
            string: split.summary.text,
            declaration_text: null,
            convention: CONVENTION,
            meta: {
              kind: 'rpc-summary',
              generator,
              service: blockNames()[blocks.length - 1] || null,
              // No blank line split the comment, so this same text ships as
              // the description too. api-rpc-summary-not-separated owns it.
              collapsed: Boolean(split.summary.collapsed)
            }
          })
          if (split.description) {
            declarations.push({
              surface: 'api',
              name,
              file,
              line_start: split.description.line_start + 1,
              line_end: split.description.line_end + 1,
              string: split.description.text,
              declaration_text: null,
              convention: CONVENTION,
              meta: {
                kind: 'rpc-description',
                generator,
                service: blockNames()[blocks.length - 1] || null
              }
            })
          }
        }
      }
      // A body-less `rpc Foo(A) returns (B);` opens nothing, so only remember
      // the name when the signature actually opens a block. The signature can
      // wrap, so consume it to its `{` or `;` rather than testing one line.
      const headerEnd = findRpcHeaderEnd(lines, i)
      let headerDelta = 0
      for (let j = i; j <= headerEnd; j++) headerDelta += braceDelta(lines[j])
      if (headerDelta > 0) rpc = { name, depth }
      depth += headerDelta
      comment = []
      i = headerEnd
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
      // An openapiv2_field description wins over the comment, so lint the
      // string that actually ships.
      const option = fieldMatch[2] === '[' ? fieldOptionDescription(lines, i, end) : null
      declarations.push({
        surface: 'api',
        name,
        file,
        line_start: (comment.length > 0 ? comment[0].line : i) + 1,
        line_end: end + 1,
        string: (option ? option.text : prose) || null,
        declaration_text: null,
        convention: CONVENTION,
        meta: {
          kind: 'field',
          message: blockNames()[blocks.length - 1] || null,
          path: blocks.length > 0 ? `${blockNames().join('.')}.${name}` : name,
          // Which form supplied the string, so a suggestion edits the right
          // one. 'openapiv2_field' also means a leading comment, if any, is
          // dead text that never reaches readers.
          source: option ? 'openapiv2_field' : (prose ? 'comment' : null)
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
    for (const { root } of API_ROOTS) {
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
    for (const decl of scanFile(content, file, generatorFor(file))) {
      decl.declaration_text = cache.span(file, decl.line_start, decl.line_end)
      declarations.push(decl)
    }
  }
  return declarations
}

/**
 * Kinds whose string is a one-line LABEL rather than prose: the openapiv2
 * `summary` and, under connect-openapi, the first line of an rpc's comment.
 *
 * Every other kind is prose. Inverted deliberately: the previous allow-list of
 * prose kinds silently exempted any kind not on it from the prose rules, so a
 * newly extracted `*-description` would ship unchecked.
 */
const SUMMARY_KINDS = Object.freeze(['operation-summary', 'rpc-summary'])

/** True when a declaration's string is prose, not a label. */
function isProse (decl) {
  return !SUMMARY_KINDS.includes(decl.meta?.kind)
}

/** True when a declaration's string is a one-line operation label. */
function isSummary (decl) {
  return SUMMARY_KINDS.includes(decl.meta?.kind)
}

/** Surface-specific convention rules. */
const RULES = [
  {
    name: 'api-rpc-summary-not-separated',
    description: 'rpc comment has no blank line, so the whole comment becomes the summary',
    severity: 'error',
    check: (decl) => {
      if (decl.meta?.kind !== 'rpc-summary' || !decl.meta.collapsed) return []
      const text = (decl.string || '').replace(/\s+/g, ' ').trim()
      return [{
        message: `protoc-gen-connect-openapi takes the FIRST line of an rpc comment as the operation summary and everything after the first blank line as the description. This comment has no blank line, so all ${text.length} characters ship as both - the API reference's nav item for \`${decl.name}\` becomes a paragraph. Put a short label on the first line (the convention is the rpc's own name, \`${decl.name}\`), then \`//\` on its own, then the prose.`
      }]
    }
  },
  {
    name: 'api-summary-multiline',
    description: 'An operation summary must be a single line',
    severity: 'error',
    check: (decl) => {
      // api-rpc-summary-not-separated owns the collapsed case and gives the
      // actionable fix; reporting both just doubles up on one defect.
      if (!isSummary(decl) || decl.meta?.collapsed) return []
      if (/\n/.test(decl.string || '')) {
        return [{ message: 'The operation `summary` is the label in the API reference index. Keep it on one line and move detail to the description.' }]
      }
      return []
    }
  },
  {
    name: 'api-summary-terminal-period',
    description: 'An operation summary takes no terminal period',
    severity: 'error',
    check: (decl) => {
      if (!isSummary(decl) || decl.meta?.collapsed) return []
      if (/\.\s*$/.test(decl.string || '')) {
        return [{ message: 'The operation `summary` is a label, not a sentence. Drop the terminal period (same contract as an rpk `Short`).' }]
      }
      return []
    }
  },
  {
    name: 'api-name-echo',
    description: 'Description merely restates the declared name (tautology)',
    severity: 'warning',
    check: (decl) => {
      // Replaces the generic name-echo, which cannot be scoped per kind. An
      // rpc summary is SUPPOSED to be the rpc's name - that is the documented
      // convention and 28 of admin/v2's 29 rpcs follow it - so flagging it
      // would put a warning on every operation in the surface.
      if (decl.meta?.kind === 'rpc-summary') return []
      const text = (decl.string || '').trim()
      if (!text || !decl.name) return []
      if (isNameEcho(decl.name, text)) {
        return [{ message: `Description just restates the name "${decl.name}": "${text}". Say what it does, why, or what happens when it changes.` }]
      }
      return []
    }
  },
  {
    name: 'api-missing-terminal-period',
    description: 'Prose doc string with no terminal period',
    severity: 'warning',
    check: (decl) => {
      if (!isProse(decl)) return []
      const text = (decl.string || '').trim()
      if (!text) return []
      if (/[.!?)]$/.test(text) || /`$/.test(text)) return []
      // A string whose last line is a list item, or ends in a bare URL, is
      // not a sentence missing punctuation. Enum descriptions in particular
      // are written as bulleted value lists, which is what the Admin v2
      // process doc tells authors to do because the generator discards
      // per-value comments.
      const lastLine = text.split('\n').pop().trim()
      if (/^(?:[-*+]|\d+[.)])\s/.test(lastLine)) return []
      if (/\b[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(lastLine)) return []
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
      return [{ message: `\`${decl.name}\` has no comment and no \`openapiv2_field\` description, so it ships with a blank description in the API reference.` }]
    }
  },
  {
    name: 'api-description-too-short',
    description: 'Prose doc string too short to explain anything',
    severity: 'warning',
    check: (decl) => {
      // Scoped to prose kinds because an operation `summary` is a label and
      // is short by design: 151 of console's 216 summaries are under the
      // generic too-short threshold, and every one of them is correct.
      if (!isProse(decl)) return []
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
  SUMMARY_KINDS,
  generatorFor,
  splitRpcComment,
  // All three generic rules are replaced by kind-scoped equivalents above,
  // because this surface mixes prose with labels and a wholesale rule cannot
  // tell them apart:
  //   * empty-description is an ERROR, and 823 of console's 1736 fields carry
  //     no comment, so it would fail on nearly every proto PR. api-undocumented-field
  //     reports the same thing as a warning, which matches the suggest-only posture.
  //   * too-short fires on 70% of openapiv2 summaries, all correctly short.
  //     api-description-too-short applies it to prose kinds only.
  //   * name-echo fires on every connect-openapi rpc summary, where echoing
  //     the rpc name IS the convention. api-name-echo exempts that one kind
  //     and is otherwise identical.
  skipRules: ['empty-description', 'too-short', 'name-echo']
}
