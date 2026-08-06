'use strict'

/**
 * Stub reconciler for consumer repos that publish rpk plugin docs through
 * single-source stubs (adp-docs for rpk ai).
 *
 * The docs repo owns the generated partials; consumer repos own one static
 * stub page per command plus a nav entry. When a plugin release adds or
 * removes commands, the stubs drift: a new partial has no stub (command
 * invisible on the consumer site) and a deleted partial leaves a stub with an
 * unresolved include (broken page). This module reconciles the stub set
 * against the current partials rather than applying a diff, so it also heals
 * pre-existing drift and is idempotent.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

/**
 * Read command titles from generated partials. The title line is
 * authoritative: dashified filenames cannot be reversed unambiguously
 * (rpk-ai-llm-provider could be `llm provider` or `llm-provider`).
 * @param {string} partialsDir - Directory of generated .adoc partials
 * @returns {Array<{file: string, title: string, description: string|undefined}>} Sorted by command path
 */
function readPartialTitles(partialsDir) {
  const partials = []
  for (const file of fs.readdirSync(partialsDir)) {
    if (!file.endsWith('.adoc')) continue
    const content = fs.readFileSync(path.join(partialsDir, file), 'utf8')
    const match = content.match(/^= (.+)$/m)
    if (!match) {
      console.warn(`Warning: no title line in ${file}; skipping`)
      continue
    }
    // The partial repeats :description: inside its single-source tag, but
    // Antora resolves page metadata with a header-only parse that never sees
    // the include — the stub must carry the description in its own header.
    const description = (content.match(/^:description:[ \t]*(.+)$/m) || [])[1]
    partials.push({ file, title: match[1].trim(), description: description && description.trim() })
  }
  // Hierarchical order: sort by command words so parents precede children
  partials.sort((a, b) => {
    const aw = a.title.split(' ')
    const bw = b.title.split(' ')
    for (let i = 0; i < Math.max(aw.length, bw.length); i++) {
      if (aw[i] === bw[i]) continue
      if (aw[i] === undefined) return -1
      if (bw[i] === undefined) return 1
      return aw[i] < bw[i] ? -1 : 1
    }
    return 0
  })
  return partials
}

/**
 * Sparse-clone the docs repo and return the path to a plugin's partials dir.
 * @param {Object} params
 * @param {string} params.docsRepo - owner/repo (e.g. redpanda-data/docs)
 * @param {string} params.docsRef - Branch or tag to read (e.g. main)
 * @param {string} params.plugin - Plugin command name (e.g. ai)
 * @returns {string} Local path to the partials directory
 */
function fetchPartialsDir({ docsRepo, docsRef, plugin, sourcePath }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-stubs-'))
  const repoDir = path.join(tmpDir, 'docs')
  // ai and cloud content renders as partials; connect renders as pages —
  // both carry the single-source tag, so either family can be stubbed
  const sparsePath = sourcePath || `modules/reference/partials/rpk-${plugin}`

  console.log(`Fetching ${sparsePath} from ${docsRepo}@${docsRef}...`)
  const cloneResult = spawnSync('git', [
    'clone', '--depth', '1', '--filter=blob:none', '--sparse',
    '--branch', docsRef,
    `https://github.com/${docsRepo}.git`, repoDir
  ], { encoding: 'utf8', timeout: 180000 })
  if (cloneResult.status !== 0) {
    throw new Error(`Failed to clone ${docsRepo}@${docsRef}: ${cloneResult.stderr}`)
  }

  const sparseResult = spawnSync('git', ['sparse-checkout', 'set', sparsePath], {
    cwd: repoDir, encoding: 'utf8', timeout: 60000
  })
  if (sparseResult.status !== 0) {
    throw new Error(`Failed sparse checkout of ${sparsePath}: ${sparseResult.stderr}`)
  }

  const partialsDir = path.join(repoDir, sparsePath)
  if (!fs.existsSync(partialsDir)) {
    throw new Error(`Partials directory not found in ${docsRepo}@${docsRef}: ${sparsePath}`)
  }
  return partialsDir
}

/**
 * Infer the include prefix from an existing managed stub, so the reconciler
 * follows whatever component/module coordinates the consumer repo uses.
 * @param {string} stubDir - Consumer repo stub directory
 * @param {string} plugin - Plugin command name
 * @returns {string|null} e.g. "streaming:reference:partial$rpk-ai/"
 */
function inferIncludePrefix(stubDir, plugin) {
  if (!fs.existsSync(stubDir)) return null
  for (const file of fs.readdirSync(stubDir)) {
    if (!file.endsWith('.adoc')) continue
    const content = fs.readFileSync(path.join(stubDir, file), 'utf8')
    const match = content.match(new RegExp(`include::([^\\[]*(?:partial|page)\\$[^\\[]*rpk-${plugin}/)`))
    if (match) return match[1]
  }
  return null
}

/**
 * Render a stub page.
 * @param {Object} params
 * @param {string} params.title - Command path (e.g. "rpk ai auth login")
 * @param {string} params.file - Partial filename
 * @param {string} [params.description] - Meta description from the partial header
 * @param {string} params.includePrefix - Antora resource prefix
 * @param {Array<string>} params.attributes - Page attribute lines
 * @returns {string}
 */
function renderStub({ title, file, description, includePrefix, attributes }) {
  const lines = [`= ${title}`]
  if (description) lines.push(`:description: ${description}`)
  for (const attr of attributes) lines.push(attr)
  lines.push('')
  lines.push(`include::${includePrefix}${file}[tag=single-source]`)
  lines.push('')
  return lines.join('\n')
}

/**
 * Reconcile a consumer repo's stub pages and nav section against the
 * current set of generated partials.
 * @param {Object} params
 * @param {Array<{file: string, title: string}>} params.partials
 * @param {string} params.stubDir - Consumer stub directory (created if missing)
 * @param {string} params.navFile - Consumer nav.adoc path
 * @param {string} params.plugin - Plugin command name (e.g. ai)
 * @param {string} params.includePrefix - Antora resource prefix for includes
 * @param {Array<string>} [params.attributes] - Page attributes for new stubs
 * @param {boolean} [params.dryRun]
 * @returns {Object} { created, deleted, keptNonStub, navUpdated, renameCandidates }
 */
function reconcileStubs({
  partials,
  stubDir,
  navFile,
  plugin,
  includePrefix,
  attributes = [':page-preview: true'],
  dryRun = false
}) {
  const managedStubRe = new RegExp(`include::[^\\[]*(?:partial|page)\\$[^\\[]*rpk-${plugin}/([\\w.-]+\\.adoc)\\[`)
  const partialByFile = new Map(partials.map(p => [p.file, p]))

  fs.mkdirSync(stubDir, { recursive: true })
  const existingStubs = fs.readdirSync(stubDir).filter(f => f.endsWith('.adoc'))

  const created = []
  const deleted = []
  const keptNonStub = []
  const skippedAliasTargets = []

  // Page names already claimed as aliases by other pages in this directory.
  // Creating a page whose resource ID is an alias target makes the Antora
  // build fatal ("Page alias cannot reference an existing page"), which
  // happens when a rename alias exists here while the upstream partial for
  // the old name still lingers. Skip those creations and surface them.
  const aliasClaims = new Map()
  for (const file of existingStubs) {
    const content = fs.readFileSync(path.join(stubDir, file), 'utf8')
    const aliasLine = content.match(/^:page-aliases:\s*(.+)$/m)
    if (!aliasLine) continue
    for (const target of aliasLine[1].split(',')) {
      const base = target.trim().split('/').pop()
      if (base) aliasClaims.set(base, file)
    }
  }

  // Delete managed stubs whose partial no longer exists. Pages that do not
  // match the managed-stub shape are never deleted: they may be hand-written.
  const deletedTitles = new Map()
  for (const file of existingStubs) {
    const stubPath = path.join(stubDir, file)
    const content = fs.readFileSync(stubPath, 'utf8')
    const match = content.match(managedStubRe)
    if (!match) {
      if (!partialByFile.has(file)) keptNonStub.push(file)
      continue
    }
    if (!partialByFile.has(match[1])) {
      const titleMatch = content.match(/^= (.+)$/m)
      deletedTitles.set(file, titleMatch ? titleMatch[1].trim() : '')
      if (!dryRun) fs.unlinkSync(stubPath)
      deleted.push(file)
    }
  }

  // Create stubs for partials that have none
  const remainingStubs = new Set(
    fs.existsSync(stubDir) ? fs.readdirSync(stubDir).filter(f => f.endsWith('.adoc')) : []
  )
  for (const partial of partials) {
    if (remainingStubs.has(partial.file)) continue
    if (aliasClaims.has(partial.file)) {
      skippedAliasTargets.push({ file: partial.file, claimedBy: aliasClaims.get(partial.file) })
      continue
    }
    if (!dryRun) {
      fs.writeFileSync(
        path.join(stubDir, partial.file),
        renderStub({ ...partial, includePrefix, attributes }),
        'utf8'
      )
    }
    created.push(partial.file)
  }

  // Rename candidates: same parent command, same depth, related last words
  // (llm -> llm-provider). Proposed for the reviewer, who decides whether
  // the new stub gets a page alias.
  const renameCandidates = []
  for (const [dFile, dTitle] of deletedTitles) {
    if (!dTitle) continue
    const dWords = dTitle.split(' ')
    for (const cFile of created) {
      const cTitle = (partialByFile.get(cFile) || {}).title || ''
      const cWords = cTitle.split(' ')
      if (cWords.length !== dWords.length) continue
      if (cWords.slice(0, -1).join(' ') !== dWords.slice(0, -1).join(' ')) continue
      const dLast = dWords[dWords.length - 1]
      const cLast = cWords[cWords.length - 1]
      if (cLast.startsWith(dLast) || dLast.startsWith(cLast)) {
        renameCandidates.push({ deleted: dFile, created: cFile })
      }
    }
  }

  // Rebuild the plugin's nav block: keep the labeled parent line, regenerate
  // child entries from titles at star depth = parent depth + (words - 2)
  let navUpdated = false
  if (navFile && fs.existsSync(navFile)) {
    const navLines = fs.readFileSync(navFile, 'utf8').split('\n')
    const parentRe = new RegExp(`^(\\*+) xref:[^\\[]*rpk-${plugin}/rpk-${plugin}\\.adoc\\[`)
    const parentIdx = navLines.findIndex(l => parentRe.test(l))
    if (parentIdx === -1) {
      console.warn(`Warning: no rpk-${plugin} parent entry found in ${navFile}; nav not updated`)
    } else {
      const parentStars = navLines[parentIdx].match(parentRe)[1].length
      const navPathPrefix = navLines[parentIdx].match(/xref:([^\[]*rpk-\w+\/)/)[1]

      // The block ends at the first line that is not a deeper entry
      let end = parentIdx + 1
      while (end < navLines.length) {
        const starMatch = navLines[end].match(/^(\*+) /)
        if (!starMatch || starMatch[1].length <= parentStars) break
        end++
      }

      const skippedFiles = new Set(skippedAliasTargets.map(t => t.file))
      const entries = []
      for (const partial of partials) {
        if (skippedFiles.has(partial.file)) continue
        const words = partial.title.split(' ').length
        if (words <= 2) continue // the parent line represents the root command
        const stars = '*'.repeat(parentStars + (words - 2))
        entries.push(`${stars} xref:${navPathPrefix}${partial.file}[]`)
      }

      const rebuilt = [
        ...navLines.slice(0, parentIdx + 1),
        ...entries,
        ...navLines.slice(end)
      ].join('\n')

      if (rebuilt !== navLines.join('\n')) {
        if (!dryRun) fs.writeFileSync(navFile, rebuilt, 'utf8')
        navUpdated = true
      }
    }
  }

  return { created, deleted, keptNonStub, navUpdated, renameCandidates, skippedAliasTargets }
}

module.exports = {
  readPartialTitles,
  fetchPartialsDir,
  inferIncludePrefix,
  renderStub,
  reconcileStubs
}
