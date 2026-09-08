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

function parseAltText (attrs) {
  const trimmed = attrs.trim()
  if (trimmed.startsWith('"')) {
    const closingIdx = trimmed.indexOf('"', 1)
    if (closingIdx !== -1) {
      return { altText: trimmed.slice(1, closingIdx), hasUnquotedComma: false }
    }
  }
  const segments = trimmed.split(',').map((s) => s.trim())
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
 * @returns {Object} { findings, summary, scope }
 */
function lintScreenshots (options) {
  const opts = { ...DEFAULTS, ...options }
  if (!opts.root) throw new Error('lint-screenshots requires a root directory')
  const root = path.resolve(opts.root)
  const modulesDir = path.join(root, 'modules')
  if (!fs.existsSync(modulesDir)) {
    throw new Error(`No modules/ directory under ${root} - point --root at an Antora docs repo`)
  }

  const scoped = Array.isArray(opts.files)
  const changedAdoc = new Set()
  const changedImages = new Set()
  if (scoped) {
    for (const f of opts.files) {
      const abs = path.resolve(root, f)
      if (!fs.existsSync(abs)) continue // deletions
      if (f.endsWith('.adoc')) changedAdoc.add(abs)
      else if (IMAGE_EXT_RE.test(f)) changedImages.add(abs)
    }
  }

  const adocFiles = findAdocFiles(modulesDir)
  const allRefs = adocFiles.flatMap((f) => collectReferences(f, modulesDir, root))
  const refs = scoped
    ? allRefs.filter((r) => changedAdoc.has(r.adocFile) || (r.resolved && changedImages.has(r.resolved)))
    : allRefs

  const findings = []
  const add = (rule, severity, ref, message, file) => {
    findings.push({
      rule,
      severity,
      file: file || ref.relPath,
      line: ref ? ref.line : null,
      image: ref ? ref.target : null,
      message
    })
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
      add('image-missing', 'error', ref, `Referenced image not found: ${path.relative(root, ref.resolved)}`)
      continue
    }
    // Image-file facts are reported once per image, on its first reference,
    // so a shared image on five pages is one finding, not five.
    if (seenImages.has(ref.resolved)) continue
    seenImages.add(ref.resolved)

    const size = fs.statSync(ref.resolved).size
    if (size > opts.maxBytes) {
      add('image-too-large', 'error', ref, `Image is ${kb(size)}, over the ${kb(opts.maxBytes)} ceiling`)
    } else if (size > opts.targetBytes) {
      add('image-above-target', 'warning', ref, `Image is ${kb(size)}, above the ${kb(opts.targetBytes)} target (${kb(opts.maxBytes)} ceiling)`)
    }

    const ext = path.extname(ref.resolved).toLowerCase()
    if (['.jpg', '.jpeg', '.webp', '.avif'].includes(ext)) {
      add('image-format', 'warning', ref, `Use PNG for screenshots or SVG for diagrams (got ${ext})`)
    }

    const width = imageWidth(ref.resolved)
    if (width !== null && width > opts.maxWidth) {
      add('image-too-wide', 'warning', ref, `Image is ${width}px wide, over the ${opts.maxWidth}px capture width (2x of a ${opts.maxWidth / 2}px display)`)
    }
  }

  if (scoped) {
    const referenced = new Set(allRefs.map((r) => r.resolved).filter(Boolean))
    for (const img of changedImages) {
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
      warnings: findings.filter((f) => f.severity === 'warning').length
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
  resolveImage,
  imageWidth
}
