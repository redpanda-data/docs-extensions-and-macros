'use strict'

/**
 * Static (source-based) detection of Linux-only rpk commands.
 *
 * Works on any platform (including Linux CI runners, where the dynamic
 * "build on Linux and Darwin and diff the trees" approach is impossible
 * because a cross-compiled darwin rpk cannot be executed).
 *
 * How it works
 * ------------
 * rpk gates platform-specific commands with Go build constraints:
 *
 *   1. Whole-package gating: every file in a command's package carries a
 *      Linux constraint (explicit `//go:build linux` tag or a `_linux.go`
 *      filename suffix) and no darwin-buildable counterpart exists.
 *      Example: pkg/cli/iotune, pkg/cli/redpanda/tune.
 *
 *   2. Dual registration: a package provides two variants of the same
 *      command constructor, one per platform, registering different
 *      subcommand sets. Example: pkg/cli/redpanda/redpanda.go
 *      (`//go:build linux`, registers start/stop/check/mode/config/tune)
 *      vs pkg/cli/redpanda/redpanda_darwin.go (`//go:build darwin`,
 *      registers only the hidden admin command). Same pattern at the root:
 *      pkg/cli/root_linux.go vs pkg/cli/root_darwin.go.
 *
 * This module detects both patterns:
 *
 *   - For every scanned package, it computes which files build on linux
 *     and which build on darwin (from `//go:build` / `// +build` tags AND
 *     filename-implied constraints like `_linux.go`).
 *   - Packages whose files all fail to build on darwin (but build on
 *     linux) and that define a cobra command constructor are Linux-only.
 *   - Packages containing platform-differential files get a registration
 *     diff: subcommand constructors referenced from linux-buildable files
 *     but not from darwin-buildable files are Linux-only. Deprecated and
 *     hidden constructors are ignored because `rpk --print-tree` (the
 *     basis of the generated docs) excludes hidden commands.
 *
 * Scope: built-in commands only. Plugin commands (rpk connect, rpk ai, ...)
 * are not part of the rpk source tree, so their platform availability
 * cannot be derived here. Plugins keep whatever platform behavior the
 * caller's other detection paths provide (for example, dynamic detection
 * marks plugin-only commands when plugins are only installed in the Linux
 * build container).
 */

const fs = require('fs')
const path = require('path')

/** GOOS values recognized in filename suffixes and build tags */
const KNOWN_GOOS = new Set([
  'aix', 'android', 'darwin', 'dragonfly', 'freebsd', 'hurd', 'illumos',
  'ios', 'js', 'linux', 'nacl', 'netbsd', 'openbsd', 'plan9', 'solaris',
  'wasip1', 'windows', 'zos'
])

/** GOOS values that satisfy the `unix` build tag */
const UNIX_GOOS = new Set([
  'aix', 'android', 'darwin', 'dragonfly', 'freebsd', 'hurd', 'illumos',
  'ios', 'linux', 'netbsd', 'openbsd', 'solaris'
])

/** GOARCH values recognized in filename suffixes */
const KNOWN_GOARCH = new Set([
  '386', 'amd64', 'amd64p32', 'arm', 'arm64', 'arm64be', 'armbe', 'loong64',
  'mips', 'mips64', 'mips64le', 'mips64p32', 'mips64p32le', 'mipsle',
  'ppc', 'ppc64', 'ppc64le', 'riscv', 'riscv64', 's390', 's390x',
  'sparc', 'sparc64', 'wasm'
])

/**
 * Directories (relative to the rpk source root) scanned for command
 * implementations. Modern rpk keeps commands in pkg/cli/<command>/;
 * the other roots cover older source layouts.
 */
const SCAN_ROOTS = ['pkg/cli', 'pkg/cli/cmd', 'cmd/rpk']

/** Directory names that never correspond to a command path segment */
const NON_COMMAND_SEGMENTS = new Set(['internal', 'common', 'testdata'])

/**
 * Determine the GOOS constraint implied by a Go filename.
 * Follows Go's rules: *_GOOS.go, *_GOOS_GOARCH.go constrain the OS;
 * *_GOARCH.go alone does not.
 * @param {string} fileName - e.g. 'redpanda_darwin.go', 'bundle_k8s_linux.go'
 * @returns {string|null} GOOS name or null when unconstrained
 */
function goosFromFileName(fileName) {
  const base = fileName.replace(/\.go$/, '')
  const parts = base.split('_')
  if (parts.length < 2) return null

  const last = parts[parts.length - 1]
  if (KNOWN_GOOS.has(last)) return last
  if (KNOWN_GOARCH.has(last) && parts.length >= 3) {
    const secondLast = parts[parts.length - 2]
    if (KNOWN_GOOS.has(secondLast)) return secondLast
  }
  return null
}

/**
 * Evaluate a `//go:build` constraint expression for a target GOOS.
 * Supports identifiers, !, &&, || and parentheses.
 * Unknown identifiers (custom build tags) evaluate to false, matching a
 * default `go build` with no -tags flag. GOARCH identifiers evaluate to
 * true because we only care about OS-level availability.
 * @param {string} expr - Expression after `//go:build`
 * @param {string} goos - Target GOOS ('linux' or 'darwin')
 * @returns {boolean}
 */
function evaluateBuildExpr(expr, goos) {
  const tokens = expr.match(/[A-Za-z0-9_.]+|&&|\|\||!|\(|\)/g) || []
  let pos = 0

  const peek = () => tokens[pos]
  const next = () => tokens[pos++]

  function evalIdent(ident) {
    if (KNOWN_GOOS.has(ident)) return ident === goos
    if (ident === 'unix') return UNIX_GOOS.has(goos)
    if (KNOWN_GOARCH.has(ident)) return true
    if (ident === 'cgo') return true
    // Custom build tags (e.g. withasan, integration) are unset by default
    return false
  }

  function parsePrimary() {
    const tok = next()
    if (tok === '(') {
      const val = parseOr()
      if (peek() === ')') next()
      return val
    }
    if (tok === '!') return !parsePrimary()
    if (tok === undefined) return false
    return evalIdent(tok)
  }

  function parseAnd() {
    let val = parsePrimary()
    while (peek() === '&&') {
      next()
      val = parsePrimary() && val
    }
    return val
  }

  function parseOr() {
    let val = parseAnd()
    while (peek() === '||') {
      next()
      val = parseAnd() || val
    }
    return val
  }

  return parseOr()
}

/**
 * Evaluate legacy `// +build` lines for a target GOOS.
 * Multiple lines AND together; within a line, space-separated options OR
 * and comma-separated terms AND.
 * @param {string[]} lines - Contents after `// +build` (one per line)
 * @param {string} goos - Target GOOS
 * @returns {boolean}
 */
function evaluatePlusBuildLines(lines, goos) {
  const evalTerm = (term) => {
    let negate = false
    while (term.startsWith('!')) {
      negate = !negate
      term = term.slice(1)
    }
    let val
    if (KNOWN_GOOS.has(term)) val = term === goos
    else if (term === 'unix') val = UNIX_GOOS.has(goos)
    else if (KNOWN_GOARCH.has(term) || term === 'cgo') val = true
    else val = false
    return negate ? !val : val
  }

  return lines.every(line => {
    const options = line.trim().split(/\s+/).filter(Boolean)
    if (options.length === 0) return true
    return options.some(opt => opt.split(',').every(evalTerm))
  })
}

/**
 * Extract the build constraint (if any) from a Go file's header.
 * Only lines before the `package` declaration are considered.
 * @param {string} content - Go file content
 * @returns {{goBuildExpr: string|null, plusBuildLines: string[]}}
 */
function extractBuildConstraint(content) {
  const header = content.split(/^package\s/m)[0]
  const goBuildMatch = header.match(/^\/\/go:build\s+(.+)$/m)
  const plusBuildLines = []
  const plusBuildRe = /^\/\/\s*\+build\s+(.+)$/gm
  let m
  while ((m = plusBuildRe.exec(header)) !== null) {
    plusBuildLines.push(m[1])
  }
  return {
    goBuildExpr: goBuildMatch ? goBuildMatch[1].trim() : null,
    plusBuildLines
  }
}

/**
 * Determine whether a Go file builds for a target GOOS, taking both the
 * filename-implied constraint and explicit build tags into account.
 * @param {string} fileName - Base name of the file
 * @param {string} content - File content
 * @param {string} goos - Target GOOS ('linux' or 'darwin')
 * @returns {boolean}
 */
function fileBuildsOn(fileName, content, goos) {
  const fileGoos = goosFromFileName(fileName)
  if (fileGoos && fileGoos !== goos) return false

  const { goBuildExpr, plusBuildLines } = extractBuildConstraint(content)
  if (goBuildExpr) return evaluateBuildExpr(goBuildExpr, goos)
  if (plusBuildLines.length > 0) return evaluatePlusBuildLines(plusBuildLines, goos)
  return true
}

/**
 * Derive a command name from a cobra constructor function name.
 * NewStartCommand -> start, newTuneCommand -> tune, NewCommand -> null.
 * @param {string} funcName
 * @returns {string|null}
 */
function commandNameFromConstructor(funcName) {
  const m = funcName.match(/^(?:New|new)(\w+?)(?:Command|Cmd)$/)
  if (m && m[1]) return m[1].toLowerCase()
  return null
}

/**
 * Parse cobra command constructors defined in a Go file.
 * A constructor is any `func XxxYyy(...) *cobra.Command`. For each one we
 * record the cobra `Use:` name (first token) and whether the command is
 * deprecated or hidden (such commands never appear in `rpk --print-tree`).
 * @param {string} content - Go file content
 * @returns {Object<string, {useName: string|null, excluded: boolean}>}
 */
function parseConstructors(content) {
  const constructors = {}
  const funcRe = /^func\s+(\w+)\s*\([^)]*\)\s*\*cobra\.Command\s*\{/gm
  const matches = []
  let m
  while ((m = funcRe.exec(content)) !== null) {
    matches.push({ name: m[1], start: m.index })
  }

  for (let i = 0; i < matches.length; i++) {
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].start : content.length
    const body = content.slice(matches[i].start, bodyEnd)

    const useMatch = body.match(/\bUse:\s*"([^"]+)"/)
    const useName = useMatch ? useMatch[1].trim().split(/\s+/)[0] : null

    // Deprecated or hidden commands are excluded from `rpk --print-tree`
    const excluded = /\bHidden:\s*true\b/.test(body) ||
                     /\bDeprecated:\s*"/.test(body) ||
                     /\bDeprecateCmd\s*\(/.test(body)

    constructors[matches[i].name] = { useName, excluded }
  }

  return constructors
}

/**
 * Extract constructor references from all AddCommand(...) calls in a file.
 * Handles both same-package (`NewStartCommand(...)`) and cross-package
 * (`tune.NewCommand(...)`) references. Only functions starting with
 * New/new are considered, which skips wrappers like cobraext.DeprecateCmd.
 * @param {string} content - Go file content
 * @returns {Array<{qualifier: string|null, funcName: string}>}
 */
function parseAddCommandRefs(content) {
  const refs = []
  const addRe = /\bAddCommand\s*\(/g
  let m
  while ((m = addRe.exec(content)) !== null) {
    // Find the span of this AddCommand(...) call by balancing parentheses
    let depth = 1
    let i = m.index + m[0].length
    while (i < content.length && depth > 0) {
      if (content[i] === '(') depth++
      else if (content[i] === ')') depth--
      i++
    }
    const span = content.slice(m.index + m[0].length, i - 1)

    const callRe = /(?:(\w+)\.)?((?:New|new)\w*)\s*\(/g
    let c
    while ((c = callRe.exec(span)) !== null) {
      refs.push({ qualifier: c[1] || null, funcName: c[2] })
    }
  }
  return refs
}

/**
 * Recursively collect non-test Go files under a directory.
 * @param {string} dir - Absolute directory path
 * @param {Array} out - Accumulator of {absPath, dir, name}
 */
function collectGoFiles(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'testdata' || entry.name === 'vendor') continue
      collectGoFiles(fullPath, out)
    } else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
      out.push({ absPath: fullPath, dir, name: entry.name })
    }
  }
}

/**
 * Build the command path prefix for a package directory.
 * pkg/cli -> 'rpk'; pkg/cli/redpanda -> 'rpk redpanda';
 * pkg/cli/cmd/redpanda (legacy) -> 'rpk redpanda'.
 * @param {string} scanRoot - Absolute path of the scan root
 * @param {string} dir - Absolute directory path
 * @returns {string|null} Command path prefix, or null for non-command dirs
 */
function commandPrefixForDir(scanRoot, dir) {
  const rel = path.relative(scanRoot, dir)
  let segments = rel === '' ? [] : rel.split(path.sep)
  // Legacy layouts nested commands under an extra cmd/ level
  if (segments[0] === 'cmd') segments = segments.slice(1)
  if (segments.some(s => NON_COMMAND_SEGMENTS.has(s))) return null
  return ['rpk', ...segments].join(' ')
}

/**
 * Analyze one scan root and add detected Linux-only command paths.
 * @param {string} scanRoot - Absolute path of the scan root
 * @param {Set<string>} linuxOnlyCommands - Accumulator
 */
function scanRootForLinuxOnly(scanRoot, linuxOnlyCommands) {
  const files = []
  collectGoFiles(scanRoot, files)
  if (files.length === 0) return

  // Group files (with parsed metadata) by directory
  const dirs = new Map()
  for (const file of files) {
    let content
    try {
      content = fs.readFileSync(file.absPath, 'utf8')
    } catch (err) {
      continue
    }
    const info = {
      name: file.name,
      content,
      buildsOnLinux: fileBuildsOn(file.name, content, 'linux'),
      buildsOnDarwin: fileBuildsOn(file.name, content, 'darwin')
    }
    if (!dirs.has(file.dir)) dirs.set(file.dir, [])
    dirs.get(file.dir).push(info)
  }

  // Per-directory constructor index: dir -> {funcName: {useName, excluded}}
  const constructorIndex = new Map()
  for (const [dir, dirFiles] of dirs) {
    const index = {}
    for (const f of dirFiles) {
      Object.assign(index, parseConstructors(f.content))
    }
    constructorIndex.set(dir, index)
  }

  /**
   * Resolve an AddCommand constructor reference to a visible command name.
   * Returns null for deprecated/hidden/unresolvable commands.
   */
  const resolveRef = (dir, ref) => {
    let target = null
    let fallback = commandNameFromConstructor(ref.funcName)

    if (ref.qualifier) {
      const subDir = path.join(dir, ref.qualifier)
      target = constructorIndex.get(subDir) || null
      if (!fallback) fallback = ref.qualifier
    } else {
      target = constructorIndex.get(dir) || null
    }

    if (target && target[ref.funcName]) {
      const ctor = target[ref.funcName]
      if (ctor.excluded) return null
      return ctor.useName || fallback
    }

    // Unresolvable reference: only trust it if the function name follows
    // the cobra constructor convention (New[Xxx]Command). This skips
    // helper arguments captured inside AddCommand spans, such as the
    // rp.NewLauncher() argument in redpanda.NewCommand(fs, p, rp.NewLauncher()).
    if (!/^(?:New|new)(?:\w*(?:Command|Cmd))?$/.test(ref.funcName)) return null
    return fallback
  }

  for (const [dir, dirFiles] of dirs) {
    const prefix = commandPrefixForDir(scanRoot, dir)
    if (!prefix) continue

    const hasDifferentialFile = dirFiles.some(f => f.buildsOnLinux !== f.buildsOnDarwin)

    // Pattern 1: whole package is Linux-gated (and defines a command)
    if (prefix !== 'rpk') {
      const anyLinux = dirFiles.some(f => f.buildsOnLinux)
      const anyDarwin = dirFiles.some(f => f.buildsOnDarwin)
      const definesCommand = Object.keys(constructorIndex.get(dir)).length > 0
      if (anyLinux && !anyDarwin && definesCommand) {
        linuxOnlyCommands.add(prefix)
        continue
      }
    }

    // Pattern 2: dual registration - diff subcommands registered from
    // linux-buildable files vs darwin-buildable files
    if (!hasDifferentialFile) continue

    const refsFor = (goos) => {
      const names = new Set()
      for (const f of dirFiles) {
        const buildable = goos === 'linux' ? f.buildsOnLinux : f.buildsOnDarwin
        if (!buildable) continue
        for (const ref of parseAddCommandRefs(f.content)) {
          const name = resolveRef(dir, ref)
          if (name) names.add(name)
        }
      }
      return names
    }

    const linuxRefs = refsFor('linux')
    const darwinRefs = refsFor('darwin')

    for (const name of linuxRefs) {
      if (!darwinRefs.has(name)) {
        linuxOnlyCommands.add(`${prefix} ${name}`)
      }
    }
  }
}

/**
 * Detect Linux-only rpk commands by statically analyzing Go source.
 * Works on any platform, including Linux CI runners.
 * @param {string} sourcePath - Path to the rpk Go source root (src/go/rpk)
 * @returns {Set<string>} Linux-only command paths (e.g. 'rpk iotune').
 *   Descendants of a returned path are implicitly Linux-only too.
 */
function detectLinuxOnlyFromSource(sourcePath) {
  const linuxOnlyCommands = new Set()

  const scannedRoots = new Set()
  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(sourcePath, root)
    if (!fs.existsSync(absRoot)) continue
    // pkg/cli/cmd is nested inside pkg/cli; avoid scanning it twice
    if ([...scannedRoots].some(r => absRoot.startsWith(r + path.sep))) continue
    scannedRoots.add(absRoot)
    scanRootForLinuxOnly(absRoot, linuxOnlyCommands)
  }

  // Drop any detected path that is a descendant of another detected path;
  // platform markers already propagate to descendants.
  for (const cmd of [...linuxOnlyCommands]) {
    if ([...linuxOnlyCommands].some(other => other !== cmd && cmd.startsWith(other + ' '))) {
      linuxOnlyCommands.delete(cmd)
    }
  }

  return linuxOnlyCommands
}

/**
 * List Go files under the scanned roots that carry a Linux-only build
 * constraint (explicit tag or filename suffix). Used as a tripwire: if
 * detection returns an empty set while this list is non-empty, the scan
 * is almost certainly broken (wrong directory layout, changed tag style).
 * @param {string} sourcePath - Path to the rpk Go source root
 * @returns {string[]} Relative paths of Linux-constrained files
 */
function findLinuxConstrainedFiles(sourcePath) {
  const results = []
  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(sourcePath, root)
    if (!fs.existsSync(absRoot)) continue
    const files = []
    collectGoFiles(absRoot, files)
    for (const file of files) {
      let content
      try {
        content = fs.readFileSync(file.absPath, 'utf8')
      } catch (err) {
        continue
      }
      if (fileBuildsOn(file.name, content, 'linux') && !fileBuildsOn(file.name, content, 'darwin')) {
        results.push(path.relative(sourcePath, file.absPath))
      }
    }
  }
  return [...new Set(results)]
}

/**
 * Emit a loud warning when platform detection came back empty even though
 * the source demonstrably contains Linux-gated files. Never let a scan
 * failure silently mark every command as cross-platform.
 * @param {string} sourcePath - Path to the rpk Go source root
 * @param {Set<string>} linuxOnlyCommands - Combined detection result
 * @returns {boolean} True when the tripwire fired
 */
function warnIfDetectionLooksBroken(sourcePath, linuxOnlyCommands) {
  if (linuxOnlyCommands.size > 0) return false

  const constrained = findLinuxConstrainedFiles(sourcePath)
  if (constrained.length === 0) return false

  console.warn('\n' + '!'.repeat(70))
  console.warn('⚠ PLATFORM DETECTION TRIPWIRE: no Linux-only commands were detected,')
  console.warn(`⚠ but the rpk source contains ${constrained.length} Linux-constrained file(s), e.g.:`)
  for (const file of constrained.slice(0, 5)) {
    console.warn(`⚠   - ${file}`)
  }
  console.warn('⚠ This usually means the static source scan failed (unexpected')
  console.warn('⚠ directory layout or build-tag style) and every command is about')
  console.warn('⚠ to be marked as available on both Linux and macOS, which is wrong.')
  console.warn('⚠ Fix tools/rpk-docs/detect-platform-commands.js before publishing')
  console.warn('⚠ these docs. See redpanda-data/docs#1831 for the impact of this.')
  console.warn('!'.repeat(70) + '\n')
  return true
}

module.exports = {
  detectLinuxOnlyFromSource,
  findLinuxConstrainedFiles,
  warnIfDetectionLooksBroken,
  // Exported for unit tests
  fileBuildsOn,
  goosFromFileName,
  evaluateBuildExpr,
  evaluatePlusBuildLines,
  parseConstructors,
  parseAddCommandRefs,
  commandNameFromConstructor
}
