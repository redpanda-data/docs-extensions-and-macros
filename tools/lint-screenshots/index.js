'use strict'

const fs = require('fs')
const path = require('path')

/**
 * doc-tools lint-screenshots: deterministic checks from the docs screenshot
 * standard that need no browser and no model - alt text and image macro
 * correctness, plus the image file facts (existence, size, format, capture
 * width) that a PR reviewer would otherwise measure by hand.
 *
 * Promoted from cloud-docs' tests/doc-detective/lint-screenshots.js so every
 * docs repo runs ONE implementation. The error-severity rules are exactly the
 * rules that script enforced (its findings were already blocking cloud-docs
 * PRs); the stricter items from the screenshot standard that no repo enforced
 * before are warnings, so adopting the command never turns a previously green
 * repo red on day one.
 *
 * This does NOT judge the "purpose test" (whether an image should exist at
 * all), annotation style, PII overlays, or alt-text accuracy. Those need a
 * human or a vision pass.
 */

const DEFAULTS = Object.freeze({
  maxAltLength: 125,
  maxBytes: 100 * 1024,
  targetBytes: 50 * 1024,
  maxWidth: 1920, // 2x capture of a <=960px display width
  bannedAltPrefixes: ['screenshot of', 'image of', 'picture of']
})

const IMAGE_EXT_RE = /\.(png|svg|jpe?g|gif|webp|avif)$/i

// Block macro: image::target[attrs]. Same shape the cloud-docs linter
// matched, so its existing findings carry over unchanged.
const BLOCK_MACRO_RE = /image::([^\[\]]+)\[([^\]]*)\]/g
// Inline macro: image:target[attrs] - single colon, not preceded by a word
// character (that would be another macro name) or a colon (the block form).
const INLINE_MACRO_RE = /(?<![\w:])image:(?!:)([^\[\]\s]+)\[([^\]]*)\]/g

// A comma after unquoted alt text is only legitimate when every segment that
// follows is itself a recognized image attribute (width=100, role=foo, or a
// bare numeric width/height). Any other trailing segment means the comma split
// real alt-text content, which Asciidoctor then reads as width/height.
const NAMED_ATTR_RE = /^[a-zA-Z_:][a-zA-Z0-9_-]*\s*=/
const BARE_DIMENSION_RE = /^\d+$/

// A named alt attribute, quoted: alt="..." or alt='...'. Asciidoctor reads a
// quoted value whole, commas included, and a named alt wins over the
// positional one.
const NAMED_QUOTED_ALT_RE = /(?:^|,)\s*alt\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/

function parseAltText (attrs) {
  const trimmed = attrs.trim()
  const named = trimmed.match(NAMED_QUOTED_ALT_RE)
  if (named) {
    const value = named[1] !== undefined ? named[1] : named[2]
    return { altText: value.replace(/\\(["'])/g, '$1'), hasUnquotedComma: false }
  }
  if (trimmed.startsWith('"')) {
    const closingIdx = trimmed.indexOf('"', 1)
    if (closingIdx !== -1) {
      return { altText: trimmed.slice(1, closingIdx), hasUnquotedComma: false }
    }
  }
  const segments = trimmed.split(',').map((s) => s.trim())
  // An unquoted named alt=: its value runs to the next comma, and any prose
  // after that comma is split off, the same as for a positional alt.
  const namedIdx = segments.findIndex((s) => /^alt\s*=/.test(s))
  if (namedIdx !== -1) {
    const altText = segments[namedIdx].replace(/^alt\s*=\s*/, '')
    const rest = segments.filter((s, i) => i !== namedIdx && (i !== 0 || NAMED_ATTR_RE.test(s)))
    const allRestAreAttrs = rest.every((s) => NAMED_ATTR_RE.test(s) || BARE_DIMENSION_RE.test(s))
    return { altText, hasUnquotedComma: rest.length > 0 && !allRestAreAttrs }
  }
  const [altText, ...rest] = segments
  const allRestAreAttrs = rest.every((s) => NAMED_ATTR_RE.test(s) || BARE_DIMENSION_RE.test(s))
  return { altText, hasUnquotedComma: rest.length > 0 && !allRestAreAttrs }
}

function findAdocFiles (dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) findAdocFiles(full, out)
    else if (entry.name.endsWith('.adoc')) out.push(full)
  }
  return out
}

/** Antora module a page belongs to, from its path under modules/. */
function moduleOf (modulesDir, filePath) {
  const rel = path.relative(modulesDir, filePath)
  if (rel.startsWith('..')) return null
  return rel.split(path.sep)[0]
}

/**
 * Resolve an image macro target to a file under modules/, the way Antora
 * does for the two forms that resolve inside one component:
 *   "shared:file.png"  -> modules/shared/images/file.png
 *   "file.png"         -> modules/<page's module>/images/file.png
 * Returns null when the target cannot be checked locally: remote URLs,
 * attribute references ({imagesdir}/x.png), and component-qualified IDs
 * (other-component:module:file.png).
 */
function resolveImage (target, adocFile, modulesDir) {
  const ref = target.trim()
  if (/^https?:\/\//.test(ref) || ref.includes('{')) return null
  const parts = ref.split(':')
  if (parts.length > 2) return null
  if (parts.length === 2 && /^[a-zA-Z0-9_.-]+$/.test(parts[0])) {
    return path.join(modulesDir, parts[0], 'images', parts[1])
  }
  const mod = moduleOf(modulesDir, adocFile)
  if (!mod) return null
  return path.join(modulesDir, mod, 'images', ref)
}

/** Intrinsic pixel width from the file header; null when unknown. */
function imageWidth (filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(32)
    const read = fs.readSync(fd, buf, 0, 32, 0)
    if (read >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
      return buf.readUInt32BE(16)
    }
    if (read >= 10 && buf.toString('ascii', 0, 4) === 'GIF8') {
      return buf.readUInt16LE(6)
    }
    return null
  } catch (err) {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function kb (bytes) {
  return `${Math.round(bytes / 1024)}KB`
}

/**
 * Parse a unified diff (`git diff`, or the PR files API patches joined with
 * their headers) into a map of repo-relative path -> Set of line numbers
 * added or changed on the new side. A file listed with no hunks (a binary
 * image, or a patch the files API left out because it is too large) maps to
 * 'all': every line counts as changed, which is the safe side for a gate.
 * A deleted file, and the old path of a rename, map to 'removed': the PR
 * changed that path, so a page that still references it is the PR's
 * problem, not one that was already on the base branch.
 */
function parseUnifiedDiff (text) {
  const changed = new Map()
  let current = null
  let oldPath = null
  let newLine = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/)
      current = m ? m[2] : null
      oldPath = m ? m[1] : null
      if (current) changed.set(current, 'all')
      continue
    }
    if (line.startsWith('rename from ')) {
      changed.set(line.slice('rename from '.length).trim(), 'removed')
      continue
    }
    if (line.startsWith('--- ')) {
      const source = line.slice(4).trim()
      if (source !== '/dev/null') oldPath = source.replace(/^a\//, '')
      continue
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim()
      if (target === '/dev/null') {
        if (current) changed.delete(current)
        if (oldPath) changed.set(oldPath, 'removed')
        current = null
      } else {
        current = target.replace(/^b\//, '')
        if (!changed.has(current)) changed.set(current, 'all')
      }
      continue
    }
    if (current === null) continue
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      if (changed.get(current) === 'all') changed.set(current, new Set())
      newLine = Number(hunk[1])
      continue
    }
    const lines = changed.get(current)
    if (!(lines instanceof Set)) continue
    if (line.startsWith('+')) { lines.add(newLine); newLine++ } else if (line.startsWith(' ')) newLine++
  }
  return changed
}

/**
 * Images that a Doc Detective spec uses as a screenshot comparison baseline,
 * read from every JSON spec under tests/. A baseline must not be quantized
 * or recompressed lossily to meet the size ceiling: that changes its pixels
 * and fails the next comparison. Read from the specs on every run, so a new
 * baseline needs no exemption list.
 */
function findBaselines (root) {
  const baselines = new Map()
  const testsDir = path.join(root, 'tests')
  if (!fs.existsSync(testsDir)) return baselines
  const specs = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.json')) specs.push(full)
    }
  }
  walk(testsDir)
  for (const spec of specs) {
    let json
    try { json = JSON.parse(fs.readFileSync(spec, 'utf8')) } catch (err) { continue }
    const visit = (node) => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!node || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) {
        const shot = key === 'screenshot' && (typeof value === 'string' ? value : value && typeof value.path === 'string' ? value.path : null)
        if (shot) {
          for (const base of [root, path.dirname(spec)]) {
            const abs = path.resolve(base, shot)
            if (fs.existsSync(abs)) { baselines.set(abs, path.relative(root, spec)); break }
          }
        }
        visit(value)
      }
    }
    visit(json)
  }
  return baselines
}

/**
 * Collect every image macro reference from one page. Comment lines and
 * comment blocks are skipped: a commented-out macro is not published.
 */
function collectReferences (adocFile, modulesDir, root) {
  const content = fs.readFileSync(adocFile, 'utf8')
  const relPath = path.relative(root, adocFile)
  const refs = []
  let inCommentBlock = false
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '////') { inCommentBlock = !inCommentBlock; continue }
    if (inCommentBlock || line.trimStart().startsWith('//')) continue
    for (const [re, form] of [[BLOCK_MACRO_RE, 'block'], [INLINE_MACRO_RE, 'inline']]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(line)) !== null) {
        const [, target, attrs] = m
        refs.push({
          adocFile,
          relPath,
          line: i + 1,
          form,
          target: target.trim(),
          attrs,
          resolved: resolveImage(target, adocFile, modulesDir)
        })
      }
    }
  }
  return refs
}

/**
 * Run the linter.
 *
 * @param {Object} options
 * @param {string} options.root - Docs repo root (the directory holding modules/)
 * @param {string[]} [options.files] - Changed-files scope (repo-relative paths, for
 *   example from `gh pr diff --name-only`). When set, only .adoc files in the
 *   list and .adoc files that reference an image in the list are linted, and
 *   listed images nothing references are reported. When omitted, every .adoc
 *   under modules/ is linted.
 * @param {number} [options.maxAltLength]
 * @param {number} [options.maxBytes]
 * @param {number} [options.targetBytes]
 * @param {number} [options.maxWidth]
 * @param {string[]} [options.bannedAltPrefixes]
 * @param {Map<string, Set<number>|'all'>} [options.changedLines] - From
 *   parseUnifiedDiff. When set, an error on a line the PR did not add or
 *   change (and not about an image file the PR changed) was already on the
 *   base branch: it is reported as a warning with `preexisting: true`, so a
 *   PR that edits one line of a page is not blocked by the page's old images.
 *   Without --files, the diff's files are the scope.
 * @returns {Object} { findings, summary, scope }
 */
function lintScreenshots (options) {
  // Explicit undefined wins a spread, and intOption() returns undefined for
  // an option nobody passed, so a plain `{ ...DEFAULTS, ...options }` lets a
  // programmatic caller silently erase a threshold: every `size > undefined`
  // is then false and the size rules vanish without a word. Drop undefined
  // keys so an omitted threshold means "the default", not "no limit".
  const provided = Object.fromEntries(
    Object.entries(options || {}).filter(([, value]) => value !== undefined))
  const opts = { ...DEFAULTS, ...provided }
  if (!opts.root) throw new Error('lint-screenshots requires a root directory')
  const root = path.resolve(opts.root)
  const modulesDir = path.join(root, 'modules')
  if (!fs.existsSync(modulesDir)) {
    throw new Error(`No modules/ directory under ${root} - point --root at an Antora docs repo`)
  }

  // An empty diff is no diff: demoting every finding because the diff could
  // not be read would turn a broken input into a passing gate.
  const changedLines = opts.changedLines instanceof Map && opts.changedLines.size > 0 ? new Map(opts.changedLines) : null
  if (changedLines) {
    // Every path in the diff is in scope, with or without --files: the old
    // path of a rename is in the diff but not in a file list built from the
    // new names, and pages that still use it must be linted.
    opts.files = [...new Set([...(Array.isArray(opts.files) ? opts.files : []), ...changedLines.keys()])]
    // A file in the --files scope that the diff does not cover counts as
    // changed throughout, for the same reason.
    for (const f of opts.files) if (!changedLines.has(f)) changedLines.set(f, 'all')
  }
  const scoped = Array.isArray(opts.files)
  const changedAdoc = new Set()
  const changedImages = new Set()
  // Deleted images stay in scope. Skipping a path that no longer exists would
  // drop the pages that still reference it out of the scoped pass, so a PR
  // that deletes a screenshot still referenced by a page would report nothing
  // in --files mode while a whole-repo run reports image-missing. They are
  // tracked separately so the orphaned-image rule can skip them: a file that
  // is gone cannot be orphaned.
  const deletedImages = new Set()
  if (scoped) {
    for (const f of opts.files) {
      const abs = path.resolve(root, f)
      const exists = fs.existsSync(abs)
      if (f.endsWith('.adoc')) {
        if (exists) changedAdoc.add(abs)
      } else if (IMAGE_EXT_RE.test(f)) {
        changedImages.add(abs)
        if (!exists) deletedImages.add(abs)
      }
    }
  }

  const adocFiles = findAdocFiles(modulesDir)
  const allRefs = adocFiles.flatMap((f) => collectReferences(f, modulesDir, root))
  const refs = scoped
    ? allRefs.filter((r) => changedAdoc.has(r.adocFile) || (r.resolved && changedImages.has(r.resolved)))
    : allRefs

  const baselines = findBaselines(root)
  const lineChanged = (ref) => {
    if (!changedLines) return true
    const lines = changedLines.get(ref.relPath)
    return lines === 'all' || (lines instanceof Set && lines.has(ref.line))
  }
  const imageChanged = (ref) => Boolean(changedLines && ref.resolved && changedLines.has(path.relative(root, ref.resolved)))

  const findings = []
  // imageRule: a fact about the image file, which a PR also owns when it
  // changed that file.
  const add = (rule, severity, ref, message, file, imageRule = false) => {
    const finding = {
      rule,
      severity,
      file: file || ref.relPath,
      line: ref ? ref.line : null,
      image: ref ? ref.target : null,
      message
    }
    if (ref && changedLines && !lineChanged(ref) && !(imageRule && imageChanged(ref))) {
      finding.preexisting = true
      if (severity === 'error') {
        finding.severity = 'warning'
        finding.message = `Already on the base branch, not blocking: ${message}`
      }
    }
    findings.push(finding)
  }

  const seenImages = new Set()
  for (const ref of refs) {
    const { altText, hasUnquotedComma } = parseAltText(ref.attrs)

    if (!altText) {
      add('alt-missing', 'error', ref, 'Missing alt text')
    } else {
      if (hasUnquotedComma) {
        add('alt-unquoted-comma', 'error', ref,
          `Unquoted alt text contains a comma, which Asciidoctor splits into separate width/height attributes at render time. Wrap the alt text in double quotes or remove the comma: "${altText}"`)
      }
      if (altText.length > opts.maxAltLength) {
        add('alt-too-long', 'error', ref, `Alt text is ${altText.length} chars (max ${opts.maxAltLength}): "${altText}"`)
      }
      const lowerAlt = altText.toLowerCase()
      if (opts.bannedAltPrefixes.some((p) => lowerAlt.startsWith(p))) {
        add('alt-banned-prefix', 'error', ref, `Alt text starts with a banned prefix: "${altText}"`)
      }
    }

    if (!ref.resolved) continue
    if (!fs.existsSync(ref.resolved)) {
      add('image-missing', 'error', ref, `Referenced image not found: ${path.relative(root, ref.resolved)}`, null, true)
      continue
    }
    // Image-file facts are reported once per image, on its first reference,
    // so a shared image on five pages is one finding, not five.
    if (seenImages.has(ref.resolved)) continue
    seenImages.add(ref.resolved)

    const size = fs.statSync(ref.resolved).size
    const baselineSpec = baselines.get(ref.resolved)
    if (size > opts.maxBytes && baselineSpec) {
      add('baseline-too-large', 'warning', ref, `Image is ${kb(size)}, over the ${kb(opts.maxBytes)} ceiling, but it is a Doc Detective comparison baseline in ${baselineSpec}: do not quantize it, because that changes its pixels and fails the comparison. Compress it losslessly, or capture a tighter region`, null, true)
    } else if (size > opts.maxBytes) {
      add('image-too-large', 'error', ref, `Image is ${kb(size)}, over the ${kb(opts.maxBytes)} ceiling`, null, true)
    } else if (size > opts.targetBytes) {
      add('image-above-target', 'warning', ref, `Image is ${kb(size)}, above the ${kb(opts.targetBytes)} target (${kb(opts.maxBytes)} ceiling)${baselineSpec ? ` (a Doc Detective baseline in ${baselineSpec}: compress it losslessly only)` : ''}`, null, true)
    }

    const ext = path.extname(ref.resolved).toLowerCase()
    if (['.jpg', '.jpeg', '.webp', '.avif'].includes(ext)) {
      add('image-format', 'warning', ref, `Use PNG for screenshots or SVG for diagrams (got ${ext})`, null, true)
    }

    const width = imageWidth(ref.resolved)
    if (width !== null && width > opts.maxWidth) {
      add('image-too-wide', 'warning', ref, `Image is ${width}px wide, over the ${opts.maxWidth}px capture width (2x of a ${opts.maxWidth / 2}px display)`, null, true)
    }
  }

  if (scoped) {
    const referenced = new Set(allRefs.map((r) => r.resolved).filter(Boolean))
    for (const img of changedImages) {
      if (deletedImages.has(img)) continue // gone, so not orphaned
      if (!referenced.has(img)) {
        add('orphaned-image', 'warning', null,
          'No image macro under modules/ references this file - if it is used through an attribute or from another repo, ignore this; otherwise remove it or add the macro',
          path.relative(root, img))
      }
    }
  }

  const severityRank = { error: 0, warning: 1 }
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] ||
    a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0))

  const lintedFiles = new Set(refs.map((r) => r.relPath))
  return {
    scope: scoped ? 'changed' : 'repo',
    findings,
    summary: {
      adoc_files_scanned: adocFiles.length,
      adoc_files_linted: scoped ? lintedFiles.size : adocFiles.length,
      references: refs.length,
      images: seenImages.size,
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
      ...(changedLines ? { preexisting: findings.filter((f) => f.preexisting).length } : {})
    }
  }
}

function formatHuman (result) {
  const { summary, findings } = result
  const scopeNote = result.scope === 'changed'
    ? `${summary.adoc_files_linted} changed .adoc file(s) (${summary.references} image reference(s))`
    : `${summary.adoc_files_scanned} .adoc files (${summary.references} image reference(s))`
  if (findings.length === 0) {
    return `Checked ${scopeNote}. No screenshot standard violations found.`
  }
  const lines = [`Checked ${scopeNote}. Found ${summary.errors} error(s), ${summary.warnings} warning(s):`, '']
  const fmt = (f) => `${f.file}${f.line ? `:${f.line}` : ''}${f.image ? ` [${f.image}]` : ''} ${f.message}`
  const errors = findings.filter((f) => f.severity === 'error')
  const warnings = findings.filter((f) => f.severity === 'warning')
  if (errors.length) {
    lines.push('Errors:')
    for (const f of errors) lines.push(`  ${fmt(f)}`)
  }
  if (warnings.length) {
    if (errors.length) lines.push('')
    lines.push('Warnings (not blocking):')
    for (const f of warnings) lines.push(`  ${fmt(f)}`)
  }
  return lines.join('\n')
}

function readFileList (listPath) {
  const text = fs.readFileSync(path.resolve(listPath), 'utf8')
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}

function readDiff (options) {
  if (options.diffFile) return parseUnifiedDiff(fs.readFileSync(path.resolve(options.diffFile), 'utf8'))
  if (options.diff) {
    const { execFileSync } = require('child_process')
    const text = execFileSync('git', ['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U0', `${options.diff}...HEAD`],
      { cwd: path.resolve(options.root || process.cwd()), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    return parseUnifiedDiff(text)
  }
  return undefined
}

function intOption (value, name) {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer (got ${value})`)
  return n
}

function runCli (options) {
  let result
  try {
    result = lintScreenshots({
      root: options.root || process.cwd(),
      files: options.files ? readFileList(options.files) : undefined,
      changedLines: readDiff(options),
      maxAltLength: intOption(options.maxAltLength, '--max-alt-length'),
      maxBytes: intOption(options.maxBytes, '--max-bytes'),
      targetBytes: intOption(options.targetBytes, '--target-bytes'),
      maxWidth: intOption(options.maxWidth, '--max-width')
    })
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(2)
  }

  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
    fs.writeFileSync(path.resolve(options.output), JSON.stringify(result, null, 2) + '\n')
  }
  console.log(options.format === 'json' ? JSON.stringify(result, null, 2) : formatHuman(result))

  const blocking = result.summary.errors + (options.warningsAsErrors ? result.summary.warnings : 0)
  process.exit(blocking > 0 ? 1 : 0)
}

module.exports = {
  DEFAULTS,
  lintScreenshots,
  formatHuman,
  runCli,
  parseAltText,
  parseUnifiedDiff,
  findBaselines,
  resolveImage,
  imageWidth
}
