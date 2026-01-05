'use strict'

const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { findRepoRoot } = require('../../cli-utils/doc-tools-utils')
const { getAntoraValue, setAntoraValue } = require('../../cli-utils/antora-utils')
const fetchFromGithub = require('../fetch-from-github.js')
const { generateRpcnConnectorDocs } = require('./generate-rpcn-connector-docs.js')
const { getRpkConnectVersion, printDeltaReport } = require('./report-delta')

/**
 * Cap description to two sentences
 * @param {string} description - Full description text
 * @returns {string} Description capped to two sentences
 */
function capToTwoSentences (description) {
  if (!description) return ''

  const hasProblematicContent = (text) => {
    return /```[\s\S]*?```/.test(text) ||
           /`[^`]+`/.test(text) ||
           /^[=#]+\s+.+$/m.test(text) ||
           /\n/.test(text)
  }

  const abbreviations = [
    /\bv\d+\.\d+(?:\.\d+)?/gi,
    /\d+\.\d+/g,
    /\be\.g\./gi,
    /\bi\.e\./gi,
    /\betc\./gi,
    /\bvs\./gi,
    /\bDr\./gi,
    /\bMr\./gi,
    /\bMs\./gi,
    /\bMrs\./gi,
    /\bSt\./gi,
    /\bNo\./gi
  ]

  let normalized = description
  const placeholders = []

  abbreviations.forEach((abbrevRegex, idx) => {
    normalized = normalized.replace(abbrevRegex, (match) => {
      const placeholder = `__ABBREV${idx}_${placeholders.length}__`
      placeholders.push({ placeholder, original: match })
      return placeholder
    })
  })

  normalized = normalized.replace(/\.{3,}/g, (match) => {
    const placeholder = `__ELLIPSIS_${placeholders.length}__`
    placeholders.push({ placeholder, original: match })
    return placeholder
  })

  const sentenceRegex = /[^.!?]+[.!?]+(?:\s|$)/g
  const sentences = normalized.match(sentenceRegex)

  if (!sentences || sentences.length === 0) {
    let result = normalized
    placeholders.forEach(({ placeholder, original }) => {
      result = result.replace(placeholder, original)
    })
    return result
  }

  let maxSentences = 2

  if (sentences.length >= 2) {
    let secondSentence = sentences[1]
    placeholders.forEach(({ placeholder, original }) => {
      secondSentence = secondSentence.replace(new RegExp(placeholder, 'g'), original)
    })

    if (hasProblematicContent(secondSentence)) {
      maxSentences = 1
    }
  }

  let result = sentences.slice(0, maxSentences).join('')

  placeholders.forEach(({ placeholder, original }) => {
    result = result.replace(new RegExp(placeholder, 'g'), original)
  })

  return result.trim()
}

/**
 * Update whats-new.adoc with new release information
 * @param {Object} params - Parameters
 * @param {string} params.dataDir - Data directory path
 * @param {string} params.oldVersion - Old version string
 * @param {string} params.newVersion - New version string
 * @param {Object} params.binaryAnalysis - Binary analysis data
 */
function updateWhatsNew ({ dataDir, oldVersion, newVersion, binaryAnalysis }) {
  try {
    const whatsNewPath = path.join(findRepoRoot(), 'modules/get-started/pages/whats-new.adoc')
    if (!fs.existsSync(whatsNewPath)) {
      console.error(`Error: Unable to update release notes: 'whats-new.adoc' was not found at: ${whatsNewPath}`)
      return
    }

    const diffPath = path.join(dataDir, `connect-diff-${oldVersion}_to_${newVersion}.json`)
    if (!fs.existsSync(diffPath)) {
      console.error(`Error: Unable to update release notes: The connector diff JSON was not found at: ${diffPath}`)
      return
    }

    let diff
    try {
      diff = JSON.parse(fs.readFileSync(diffPath, 'utf8'))
    } catch (jsonErr) {
      console.error(`Error: Unable to parse connector diff JSON at ${diffPath}: ${jsonErr.message}`)
      return
    }

    let whatsNew
    try {
      whatsNew = fs.readFileSync(whatsNewPath, 'utf8')
    } catch (readErr) {
      console.error(`Error: Unable to read whats-new.adoc at ${whatsNewPath}: ${readErr.message}`)
      return
    }

    const versionRe = new RegExp(`^== Version ${diff.comparison.newVersion.replace(/[-.]/g, '\\$&')}(?:\\r?\\n|$)`, 'm')
    const match = versionRe.exec(whatsNew)
    let startIdx = match ? match.index : -1
    let endIdx = -1
    if (startIdx !== -1) {
      const rest = whatsNew.slice(startIdx + 1)
      const nextMatch = /^== Version /m.exec(rest)
      endIdx = nextMatch ? startIdx + 1 + nextMatch.index : whatsNew.length
    }

    let releaseNotesLink = ''
    if (diff.comparison && diff.comparison.newVersion) {
      releaseNotesLink = `link:https://github.com/redpanda-data/connect/releases/tag/v${diff.comparison.newVersion}[See the full release notes^].\n\n`
    }
    let section = `\n== Version ${diff.comparison.newVersion}\n\n${releaseNotesLink}`

    // Separate Bloblang and regular components
    const bloblangComponents = []
    const regularComponents = []

    if (diff.details.newComponents && diff.details.newComponents.length) {
      for (const comp of diff.details.newComponents) {
        if (comp.type === 'bloblang-functions' || comp.type === 'bloblang-methods') {
          bloblangComponents.push(comp)
        } else {
          const isCgoOnly = binaryAnalysis?.cgoOnly?.some(cgo => {
            const typeSingular = cgo.type.replace(/s$/, '')
            return cgo.name === comp.name && typeSingular === comp.type
          })

          regularComponents.push({
            ...comp,
            requiresCgo: isCgoOnly
          })
        }
      }
    }

    // Bloblang updates section
    if (bloblangComponents.length > 0) {
      section += '=== Bloblang updates\n\n'
      section += 'This release adds the following new Bloblang capabilities:\n\n'

      const byType = {}
      for (const comp of bloblangComponents) {
        if (!byType[comp.type]) byType[comp.type] = []
        byType[comp.type].push(comp)
      }

      for (const [type, comps] of Object.entries(byType)) {
        if (type === 'bloblang-functions') {
          section += '* Functions:\n'
          for (const comp of comps) {
            section += `** xref:guides:bloblang/functions.adoc#${comp.name}[\`${comp.name}\`]`
            if (comp.status && comp.status !== 'stable') section += ` (${comp.status})`
            if (comp.description) {
              section += `: ${capToTwoSentences(comp.description)}`
            } else {
              section += `\n+\n// TODO: Add description for ${comp.name} function`
            }
            section += '\n'
          }
        } else if (type === 'bloblang-methods') {
          section += '* Methods:\n'
          for (const comp of comps) {
            section += `** xref:guides:bloblang/methods.adoc#${comp.name}[\`${comp.name}\`]`
            if (comp.status && comp.status !== 'stable') section += ` (${comp.status})`
            if (comp.description) {
              section += `: ${capToTwoSentences(comp.description)}`
            } else {
              section += `\n+\n// TODO: Add description for ${comp.name} method`
            }
            section += '\n'
          }
        }
      }
      section += '\n'
    }

    // Component updates section
    if (regularComponents.length > 0) {
      section += '=== Component updates\n\n'
      section += 'This release adds the following new components:\n\n'

      section += '[cols="1m,1a,1a,3a"]\n'
      section += '|===\n'
      section += '|Component |Type |Status |Description\n\n'

      for (const comp of regularComponents) {
        const typeLabel = comp.type.charAt(0).toUpperCase() + comp.type.slice(1)
        const statusLabel = comp.status || '-'
        let desc = comp.summary || (comp.description ? capToTwoSentences(comp.description) : '// TODO: Add description')

        if (comp.requiresCgo) {
          const cgoNote = '\nNOTE: Requires a cgo-enabled binary. See the xref:install:index.adoc[installation guides] for details.'
          desc = desc.startsWith('// TODO') ? cgoNote : `${desc}\n\n${cgoNote}`
        }

        const typePlural = comp.type.endsWith('s') ? comp.type : `${comp.type}s`
        section += `|xref:components:${typePlural}/${comp.name}.adoc[${comp.name}]\n`
        section += `|${typeLabel}\n`
        section += `|${statusLabel}\n`
        section += `|${desc}\n\n`
      }

      section += '|===\n\n'
    }

    // New fields section
    if (diff.details.newFields && diff.details.newFields.length) {
      const regularFields = diff.details.newFields.filter(field => {
        const [type] = field.component.split(':')
        return type !== 'bloblang-functions' && type !== 'bloblang-methods'
      })

      if (regularFields.length > 0) {
        section += '\n=== New field support\n\n'
        section += 'This release adds support for the following new fields:\n\n'
        section += buildFieldsTable(regularFields, capToTwoSentences)
      }
    }

    // Deprecated components section
    if (diff.details.deprecatedComponents && diff.details.deprecatedComponents.length) {
      section += '\n=== Deprecations\n\n'
      section += 'The following components are now deprecated:\n\n'

      section += '[cols="1m,1,3"]\n'
      section += '|===\n'
      section += '|Component |Type |Description\n\n'

      for (const comp of diff.details.deprecatedComponents) {
        const typeLabel = comp.type.charAt(0).toUpperCase() + comp.type.slice(1)
        const desc = comp.description ? capToTwoSentences(comp.description) : '-'

        if (comp.type === 'bloblang-functions') {
          section += `|xref:guides:bloblang/functions.adoc#${comp.name}[${comp.name}]\n`
        } else if (comp.type === 'bloblang-methods') {
          section += `|xref:guides:bloblang/methods.adoc#${comp.name}[${comp.name}]\n`
        } else {
          section += `|xref:components:${comp.type}/${comp.name}.adoc[${comp.name}]\n`
        }
        section += `|${typeLabel}\n`
        section += `|${desc}\n\n`
      }

      section += '|===\n\n'
    }

    // Deprecated fields section
    if (diff.details.deprecatedFields && diff.details.deprecatedFields.length) {
      const regularDeprecatedFields = diff.details.deprecatedFields.filter(field => {
        const [type] = field.component.split(':')
        return type !== 'bloblang-functions' && type !== 'bloblang-methods'
      })

      if (regularDeprecatedFields.length > 0) {
        if (!diff.details.deprecatedComponents || diff.details.deprecatedComponents.length === 0) {
          section += '\n=== Deprecations\n\n'
        } else {
          section += '\n'
        }
        section += 'The following fields are now deprecated:\n\n'
        section += buildFieldsTable(regularDeprecatedFields, capToTwoSentences)
      }
    }

    // Changed defaults section
    if (diff.details.changedDefaults && diff.details.changedDefaults.length) {
      const regularChangedDefaults = diff.details.changedDefaults.filter(change => {
        const [type] = change.component.split(':')
        return type !== 'bloblang-functions' && type !== 'bloblang-methods'
      })

      if (regularChangedDefaults.length > 0) {
        section += '\n=== Default value changes\n\n'
        section += 'This release includes the following default value changes:\n\n'
        section += buildChangedDefaultsTable(regularChangedDefaults, capToTwoSentences)
      }
    }

    // Update the file
    let contentWithoutOldSection = whatsNew
    if (startIdx !== -1) {
      contentWithoutOldSection = whatsNew.slice(0, startIdx) + whatsNew.slice(endIdx)
    }

    const versionHeading = /^== Version /m
    const firstMatch = versionHeading.exec(contentWithoutOldSection)
    const insertIdx = firstMatch ? firstMatch.index : contentWithoutOldSection.length

    const updated = contentWithoutOldSection.slice(0, insertIdx) + section + '\n' + contentWithoutOldSection.slice(insertIdx)

    if (startIdx !== -1) {
      console.log(`♻️  whats-new.adoc: replaced section for Version ${diff.comparison.newVersion}`)
    } else {
      console.log(`Done: whats-new.adoc updated with Version ${diff.comparison.newVersion}`)
    }

    fs.writeFileSync(whatsNewPath, updated, 'utf8')
  } catch (err) {
    console.error(`Error: Failed to update whats-new.adoc: ${err.message}`)
  }
}

/**
 * Build a fields table for whats-new.adoc
 * @param {Array} fields - Field data
 * @param {Function} capFn - Caption function
 * @returns {string} AsciiDoc table
 */
function buildFieldsTable (fields, capFn) {
  const byField = {}
  for (const field of fields) {
    const [type, compName] = field.component.split(':')
    if (!byField[field.field]) {
      byField[field.field] = {
        description: field.description,
        components: []
      }
    }
    byField[field.field].components.push({ type, name: compName })
  }

  let section = '[cols="1m,3,2a"]\n'
  section += '|===\n'
  section += '|Field |Description |Affected components\n\n'

  for (const [fieldName, info] of Object.entries(byField)) {
    const byType = {}
    for (const comp of info.components) {
      if (!byType[comp.type]) byType[comp.type] = []
      byType[comp.type].push(comp.name)
    }

    let componentList = ''
    for (const [type, names] of Object.entries(byType)) {
      if (componentList) componentList += '\n\n'

      const typeLabel = names.length === 1
        ? type.charAt(0).toUpperCase() + type.slice(1)
        : type.charAt(0).toUpperCase() + type.slice(1) + (type.endsWith('s') ? '' : 's')

      componentList += `*${typeLabel}:*\n\n`
      names.forEach(name => {
        componentList += `* xref:components:${type}/${name}.adoc#${fieldName}[${name}]\n`
      })
    }

    const desc = info.description ? capFn(info.description) : '// TODO: Add description'

    section += `|${fieldName}\n`
    section += `|${desc}\n`
    section += `|${componentList}\n\n`
  }

  section += '|===\n\n'
  return section
}

/**
 * Build changed defaults table for whats-new.adoc
 * @param {Array} changedDefaults - Changed defaults data
 * @param {Function} capFn - Caption function
 * @returns {string} AsciiDoc table
 */
function buildChangedDefaultsTable (changedDefaults, capFn) {
  const byFieldAndDefaults = {}
  for (const change of changedDefaults) {
    const [type, compName] = change.component.split(':')
    const compositeKey = `${change.field}|${String(change.oldDefault)}|${String(change.newDefault)}`
    if (!byFieldAndDefaults[compositeKey]) {
      byFieldAndDefaults[compositeKey] = {
        field: change.field,
        oldDefault: change.oldDefault,
        newDefault: change.newDefault,
        description: change.description,
        components: []
      }
    }
    byFieldAndDefaults[compositeKey].components.push({ type, name: compName })
  }

  let section = '[cols="1m,1,1,3,2a"]\n'
  section += '|===\n'
  section += '|Field |Old default |New default |Description |Affected components\n\n'

  for (const [, info] of Object.entries(byFieldAndDefaults)) {
    const formatDefault = (val) => {
      if (val === undefined || val === null) return 'none'
      if (typeof val === 'string') return val
      if (typeof val === 'number' || typeof val === 'boolean') return String(val)
      return JSON.stringify(val)
    }

    const oldVal = formatDefault(info.oldDefault)
    const newVal = formatDefault(info.newDefault)
    const desc = info.description ? capFn(info.description) : '// TODO: Add description'

    const byType = {}
    for (const comp of info.components) {
      if (!byType[comp.type]) byType[comp.type] = []
      byType[comp.type].push(comp.name)
    }

    let componentList = ''
    for (const [type, names] of Object.entries(byType)) {
      if (componentList) componentList += '\n\n'

      const typeLabel = names.length === 1
        ? type.charAt(0).toUpperCase() + type.slice(1)
        : type.charAt(0).toUpperCase() + type.slice(1) + (type.endsWith('s') ? '' : 's')

      componentList += `*${typeLabel}:*\n\n`
      names.forEach(name => {
        componentList += `* xref:components:${type}/${name}.adoc#${info.field}[${name}]\n`
      })
    }

    section += `|${info.field}\n`
    section += `|${oldVal}\n`
    section += `|${newVal}\n`
    section += `|${desc}\n`
    section += `|${componentList}\n\n`
  }

  section += '|===\n\n'
  return section
}

/**
 * Log a collapsed list of files
 * @param {string} label - Label for the list
 * @param {Array} filesArray - Array of file paths
 * @param {number} maxToShow - Maximum items to show
 */
function logCollapsed (label, filesArray, maxToShow = 10) {
  console.log(`  • ${label}: ${filesArray.length} total`)
  const sample = filesArray.slice(0, maxToShow)
  sample.forEach(fp => console.log(`    – ${fp}`))
  const remaining = filesArray.length - sample.length
  if (remaining > 0) {
    console.log(`    … plus ${remaining} more`)
  }
  console.log('')
}

/**
 * Main handler for rpcn-connector-docs command
 * @param {Object} options - Command options
 */
async function handleRpcnConnectorDocs (options) {
  const dataDir = path.resolve(process.cwd(), options.dataDir)
  fs.mkdirSync(dataDir, { recursive: true })

  const timestamp = new Date().toISOString()

  let newVersion
  let dataFile
  let binaryAnalysis = null
  let draftsWritten = 0
  let draftFiles = []
  let needsAugmentation = false

  if (options.fetchConnectors) {
    try {
      if (options.connectVersion) {
        console.log(`Installing Redpanda Connect version ${options.connectVersion}...`)
        const installResult = spawnSync('rpk', ['connect', 'install', '--connect-version', options.connectVersion, '--force'], {
          stdio: 'inherit'
        })
        if (installResult.status !== 0) {
          throw new Error(`Failed to install Connect version ${options.connectVersion}`)
        }
        console.log(`Done: Installed Redpanda Connect version ${options.connectVersion}`)
        newVersion = options.connectVersion
      } else {
        newVersion = getRpkConnectVersion()
      }
      console.log(`Fetching connector data from Connect ${newVersion}...`)

      const tmpFile = path.join(dataDir, `connect-${newVersion}.tmp.json`)
      const finalFile = path.join(dataDir, `connect-${newVersion}.json`)

      const fd = fs.openSync(tmpFile, 'w')
      const r = spawnSync('rpk', ['connect', 'list', '--format', 'json-full'], { stdio: ['ignore', fd, 'inherit'] })
      fs.closeSync(fd)

      const rawJson = fs.readFileSync(tmpFile, 'utf8')
      const parsed = JSON.parse(rawJson)
      fs.writeFileSync(finalFile, JSON.stringify(parsed, null, 2))
      fs.unlinkSync(tmpFile)
      dataFile = finalFile
      needsAugmentation = true
      console.log(`Done: Fetched connector data for version ${newVersion}`)

      // Fetch info.csv
      try {
        console.log(`Fetching info.csv for Connect v${newVersion}...`)
        const csvFile = path.join(dataDir, `connect-info-${newVersion}.csv`)

        if (!fs.existsSync(csvFile)) {
          await fetchFromGithub(
            'redpanda-data',
            'connect',
            'internal/plugins/info.csv',
            dataDir,
            `connect-info-${newVersion}.csv`,
            `v${newVersion}`
          )
          console.log(`Done: Fetched info.csv for version ${newVersion}`)
        } else {
          console.log(`✓ CSV already exists: connect-info-${newVersion}.csv`)
        }
      } catch (csvErr) {
        console.warn(`Warning: Failed to fetch info.csv: ${csvErr.message}`)
      }

      // Fetch Bloblang examples
      try {
        console.log(`Fetching Bloblang playground examples for Connect v${newVersion}...`)
        const examplesFile = path.join(dataDir, `bloblang-samples-${newVersion}.json`)

        if (!fs.existsSync(examplesFile)) {
          const tempExamplesDir = path.join(dataDir, `temp-playground-${newVersion}`)
          await fetchFromGithub(
            'redpanda-data',
            'connect',
            'docs/guides/bloblang/playground',
            tempExamplesDir,
            null,
            `v${newVersion}`
          )

          const yaml = require('js-yaml')
          const bloblangSamples = {}
          const files = fs.readdirSync(tempExamplesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))

          for (const file of files) {
            try {
              const content = fs.readFileSync(path.join(tempExamplesDir, file), 'utf8')
              const parsedYaml = yaml.load(content)
              if (parsedYaml.title && parsedYaml.input && parsedYaml.mapping) {
                bloblangSamples[file] = parsedYaml
              }
            } catch (err) {
              console.warn(`Warning: Failed to parse ${file}: ${err.message}`)
            }
          }

          fs.writeFileSync(examplesFile, JSON.stringify(bloblangSamples, null, 2))
          fs.rmSync(tempExamplesDir, { recursive: true, force: true })
          console.log(`Done: Fetched ${Object.keys(bloblangSamples).length} Bloblang examples`)
        } else {
          console.log(`✓ Bloblang samples already exist: bloblang-samples-${newVersion}.json`)
        }
      } catch (examplesErr) {
        console.warn(`Warning: Failed to fetch Bloblang examples: ${examplesErr.message}`)
      }
    } catch (err) {
      console.error(`Error: Failed to fetch connectors: ${err.message}`)
      process.exit(1)
    }
  } else {
    const candidates = fs.readdirSync(dataDir).filter(f => /^connect-\d+\.\d+\.\d+\.json$/.test(f))
    if (candidates.length === 0) {
      console.error('Error: No connect-<version>.json found. Use --fetch-connectors.')
      process.exit(1)
    }
    candidates.sort()
    dataFile = path.join(dataDir, candidates[candidates.length - 1])
    newVersion = candidates[candidates.length - 1].match(/connect-(\d+\.\d+\.\d+)\.json/)[1]
  }

  console.log('Generating connector partials...')
  let partialsWritten, partialFiles

  try {
    const result = await generateRpcnConnectorDocs({
      data: dataFile,
      overrides: options.overrides,
      template: options.templateMain,
      templateIntro: options.templateIntro,
      templateFields: options.templateFields,
      templateExamples: options.templateExamples,
      templateBloblang: options.templateBloblang,
      writeFullDrafts: false,
      includeBloblang: !!options.includeBloblang
    })
    partialsWritten = result.partialsWritten
    partialFiles = result.partialFiles
  } catch (err) {
    console.error(`Error: Failed to generate partials: ${err.message}`)
    process.exit(1)
  }

  let oldIndex = {}
  let oldVersion = null
  if (options.oldData && fs.existsSync(options.oldData)) {
    oldIndex = JSON.parse(fs.readFileSync(options.oldData, 'utf8'))
    const m = options.oldData.match(/connect-([\d.]+)\.json$/)
    if (m) oldVersion = m[1]
  } else {
    const existingDataFiles = fs.readdirSync(dataDir)
      .filter(f => /^connect-\d+\.\d+\.\d+\.json$/.test(f))
      .filter(f => f !== path.basename(dataFile))
      .sort()

    if (existingDataFiles.length > 0) {
      const oldFile = existingDataFiles[existingDataFiles.length - 1]
      oldVersion = oldFile.match(/connect-(\d+\.\d+\.\d+)\.json/)[1]
      const oldPath = path.join(dataDir, oldFile)
      oldIndex = JSON.parse(fs.readFileSync(oldPath, 'utf8'))
      console.log(`📋 Using old version data: ${oldFile}`)
    } else {
      oldVersion = getAntoraValue('asciidoc.attributes.latest-connect-version')
      if (oldVersion) {
        const oldPath = path.join(dataDir, `connect-${oldVersion}.json`)
        if (fs.existsSync(oldPath)) {
          oldIndex = JSON.parse(fs.readFileSync(oldPath, 'utf8'))
        }
      }
    }
  }

  let newIndex = JSON.parse(fs.readFileSync(dataFile, 'utf8'))

  const versionsMatch = oldVersion && newVersion && oldVersion === newVersion
  if (versionsMatch) {
    console.log(`\n✓ Already at version ${newVersion}`)
    console.log('  Skipping diff generation, but will run binary analysis.\n')
  }

  // Publish merged version
  if (options.overrides && fs.existsSync(options.overrides)) {
    try {
      const { mergeOverrides, resolveReferences } = require('./generate-rpcn-connector-docs.js')

      const mergedData = JSON.parse(JSON.stringify(newIndex))
      const ovRaw = fs.readFileSync(options.overrides, 'utf8')
      const ovObj = JSON.parse(ovRaw)
      const resolvedOverrides = resolveReferences(ovObj, ovObj)
      mergeOverrides(mergedData, resolvedOverrides)

      const attachmentsRoot = path.resolve(process.cwd(), 'modules/components/attachments')
      fs.mkdirSync(attachmentsRoot, { recursive: true })

      const existingFiles = fs.readdirSync(attachmentsRoot)
        .filter(f => /^connect-\d+\.\d+\.\d+\.json$/.test(f))
        .sort()

      for (const oldFile of existingFiles) {
        const oldFilePath = path.join(attachmentsRoot, oldFile)
        fs.unlinkSync(oldFilePath)
        console.log(`🧹 Deleted old version: ${oldFile}`)
      }

      const destFile = path.join(attachmentsRoot, `connect-${newVersion}.json`)
      fs.writeFileSync(destFile, JSON.stringify(mergedData, null, 2), 'utf8')
      console.log(`Done: Published merged version to: ${path.relative(process.cwd(), destFile)}`)
    } catch (err) {
      console.error(`Error: Failed to publish merged version: ${err.message}`)
    }
  }

  printDeltaReport(oldIndex, newIndex)

  // Binary analysis
  let oldBinaryAnalysis = null

  if (oldVersion) {
    const standalonePath = path.join(dataDir, `binary-analysis-${oldVersion}.json`)
    if (fs.existsSync(standalonePath)) {
      try {
        oldBinaryAnalysis = JSON.parse(fs.readFileSync(standalonePath, 'utf8'))
        console.log(`✓ Loaded old binary analysis from: binary-analysis-${oldVersion}.json`)
      } catch (err) {
        console.warn(`Warning: Failed to load ${standalonePath}: ${err.message}`)
      }
    }

    if (!oldBinaryAnalysis) {
      const diffFiles = fs.readdirSync(dataDir)
        .filter(f => f.startsWith('connect-diff-') && f.endsWith(`_to_${oldVersion}.json`))
        .sort()
        .reverse()

      for (const file of diffFiles) {
        const diffPath = path.join(dataDir, file)
        try {
          const oldDiff = JSON.parse(fs.readFileSync(diffPath, 'utf8'))
          if (oldDiff.binaryAnalysis) {
            oldBinaryAnalysis = {
              comparison: {
                inCloud: oldDiff.binaryAnalysis.details?.cloudSupported || [],
                notInCloud: oldDiff.binaryAnalysis.details?.selfHostedOnly || []
              },
              cgoOnly: oldDiff.binaryAnalysis.details?.cgoOnly || []
            }
            console.log(`✓ Loaded old binary analysis from: ${file}`)
            break
          }
        } catch {
          // Continue to next file
        }
      }
    }
  }

  try {
    console.log('\nAnalyzing connector binaries...')
    const { analyzeAllBinaries } = require('./connector-binary-analyzer.js')

    const analysisOptions = {
      skipCloud: false,
      skipCgo: false,
      cgoVersion: options.cgoVersion || null
    }

    binaryAnalysis = await analyzeAllBinaries(
      newVersion,
      options.cloudVersion || null,
      dataDir,
      analysisOptions
    )

    console.log('Done: Binary analysis complete:')
    console.log(`   • OSS version: ${binaryAnalysis.ossVersion}`)

    if (binaryAnalysis.cloudVersion) {
      console.log(`   • Cloud version: ${binaryAnalysis.cloudVersion}`)
    }

    if (binaryAnalysis.comparison) {
      console.log(`   • Connectors in cloud: ${binaryAnalysis.comparison.inCloud.length}`)
      console.log(`   • Self-hosted only: ${binaryAnalysis.comparison.notInCloud.length}`)
      if (binaryAnalysis.comparison.cloudOnly && binaryAnalysis.comparison.cloudOnly.length > 0) {
        console.log(`   • Cloud-only connectors: ${binaryAnalysis.comparison.cloudOnly.length}`)
      }
    }

    if (binaryAnalysis.cgoOnly && binaryAnalysis.cgoOnly.length > 0) {
      console.log(`   • cgo-only connectors: ${binaryAnalysis.cgoOnly.length}`)
    }
  } catch (err) {
    console.error(`Warning: Binary analysis failed: ${err.message}`)
    console.error('   Continuing without binary analysis data...')
  }

  // Augment data file
  if (needsAugmentation && binaryAnalysis) {
    try {
      console.log('\nAugmenting connector data with cloud/cgo fields...')

      const connectorData = JSON.parse(fs.readFileSync(dataFile, 'utf8'))

      const cloudSet = new Set(
        (binaryAnalysis.comparison?.inCloud || []).map(c => `${c.type}:${c.name}`)
      )
      const cgoOnlySet = new Set(
        (binaryAnalysis.cgoOnly || []).map(c => `${c.type}:${c.name}`)
      )

      let augmentedCount = 0
      let addedCgoCount = 0
      let addedCloudOnlyCount = 0

      const connectorTypes = ['inputs', 'outputs', 'processors', 'caches', 'rate_limits',
        'buffers', 'metrics', 'scanners', 'tracers']

      for (const type of connectorTypes) {
        if (!Array.isArray(connectorData[type])) {
          connectorData[type] = []
        }

        for (const connector of connectorData[type]) {
          const key = `${type}:${connector.name}`
          connector.cloudSupported = cloudSet.has(key)
          connector.requiresCgo = cgoOnlySet.has(key)
          augmentedCount++
        }

        if (binaryAnalysis.cgoOnly) {
          for (const cgoConn of binaryAnalysis.cgoOnly) {
            if (cgoConn.type === type) {
              const exists = connectorData[type].some(c => c.name === cgoConn.name)
              if (!exists) {
                connectorData[type].push({
                  ...cgoConn,
                  type: cgoConn.type.replace(/s$/, ''),
                  cloudSupported: false,
                  requiresCgo: true
                })
                addedCgoCount++
              }
            }
          }
        }

        if (binaryAnalysis.comparison?.cloudOnly) {
          for (const cloudConn of binaryAnalysis.comparison.cloudOnly) {
            if (cloudConn.type === type) {
              const exists = connectorData[type].some(c => c.name === cloudConn.name)
              if (!exists) {
                connectorData[type].push({
                  ...cloudConn,
                  type: cloudConn.type.replace(/s$/, ''),
                  cloudSupported: true,
                  requiresCgo: false,
                  cloudOnly: true
                })
                addedCloudOnlyCount++
              }
            }
          }
        }
      }

      fs.writeFileSync(dataFile, JSON.stringify(connectorData, null, 2), 'utf8')
      console.log(`Done: Augmented ${augmentedCount} connectors with cloud/cgo fields`)
      if (addedCgoCount > 0) {
        console.log(`   • Added ${addedCgoCount} cgo-only connector(s) to data file`)
      }
      if (addedCloudOnlyCount > 0) {
        console.log(`   • Added ${addedCloudOnlyCount} cloud-only connector(s) to data file`)
      }

      // Keep only 2 most recent versions
      const dataFiles = fs.readdirSync(dataDir)
        .filter(f => /^connect-\d+\.\d+\.\d+\.json$/.test(f))
        .sort()

      while (dataFiles.length > 2) {
        const oldestFile = dataFiles.shift()
        const oldestPath = path.join(dataDir, oldestFile)
        fs.unlinkSync(oldestPath)
        console.log(`🧹 Deleted old version from docs-data: ${oldestFile}`)
      }
    } catch (err) {
      console.error(`Warning: Failed to augment data file: ${err.message}`)
    }
  }

  // Generate diff JSON
  let diffJson = null
  if (!oldVersion) {
    console.warn('Warning: Skipping diff generation: oldVersion not available')
  } else if (versionsMatch) {
    console.log(`⏭️  Skipping diff generation: versions match (${oldVersion} === ${newVersion})`)
  } else {
    const { generateConnectorDiffJson } = require('./report-delta.js')
    diffJson = generateConnectorDiffJson(
      oldIndex,
      newIndex,
      {
        oldVersion: oldVersion,
        newVersion,
        timestamp,
        binaryAnalysis,
        oldBinaryAnalysis
      }
    )

    // Add new cgo-only components
    if (binaryAnalysis && binaryAnalysis.cgoOnly && binaryAnalysis.cgoOnly.length > 0) {
      let newCgoComponents

      if (oldBinaryAnalysis) {
        const oldCgoSet = new Set((oldBinaryAnalysis.cgoOnly || []).map(c => `${c.type}:${c.name}`))
        newCgoComponents = binaryAnalysis.cgoOnly.filter(cgoComp => {
          const wasInOldOss = oldIndex[cgoComp.type]?.some(c => c.name === cgoComp.name)
          const wasInOldCgo = oldCgoSet.has(`${cgoComp.type}:${cgoComp.name}`)
          return !wasInOldOss && !wasInOldCgo
        })
      } else {
        newCgoComponents = binaryAnalysis.cgoOnly.filter(cgoComp => {
          const wasInOldOss = oldIndex[cgoComp.type]?.some(c => c.name === cgoComp.name)
          return !wasInOldOss
        })
        if (newCgoComponents.length > 0) {
          console.log(`   ℹ️  No old binary analysis found - treating ${newCgoComponents.length} cgo component(s) not in old OSS data as new`)
        }
      }

      if (newCgoComponents && newCgoComponents.length > 0) {
        console.log(`   • Found ${newCgoComponents.length} new cgo-only component(s)`)
        newCgoComponents.forEach(cgoComp => {
          const typeSingular = cgoComp.type.replace(/s$/, '')
          diffJson.details.newComponents.push({
            name: cgoComp.name,
            type: typeSingular,
            status: cgoComp.status || '',
            version: '',
            description: cgoComp.description || '',
            summary: cgoComp.summary || ''
          })
        })
      }
    }

    const diffPath = path.join(dataDir, `connect-diff-${oldVersion}_to_${newVersion}.json`)
    fs.writeFileSync(diffPath, JSON.stringify(diffJson, null, 2), 'utf8')
    console.log(`Done: Connector diff JSON written to: ${diffPath}`)
    if (diffJson.binaryAnalysis) {
      console.log(`   • Includes binary analysis: OSS ${diffJson.binaryAnalysis.versions.oss}, Cloud ${diffJson.binaryAnalysis.versions.cloud || 'N/A'}, cgo ${diffJson.binaryAnalysis.versions.cgo || 'N/A'}`)
    }

    // Cleanup old diff files
    try {
      const oldDiffFiles = fs.readdirSync(dataDir)
        .filter(f => f.startsWith('connect-diff-') && f.endsWith('.json') && f !== path.basename(diffPath))

      if (oldDiffFiles.length > 0) {
        console.log(`🧹 Cleaning up ${oldDiffFiles.length} old diff file(s)...`)
        oldDiffFiles.forEach(f => {
          const oldDiffPath = path.join(dataDir, f)
          fs.unlinkSync(oldDiffPath)
          console.log(`   • Deleted: ${f}`)
        })
      }
    } catch (err) {
      console.warn(`Warning: Failed to clean up old diff files: ${err.message}`)
    }
  }

  // Draft missing connectors
  if (options.draftMissing) {
    console.log('\nDrafting missing connectors…')
    try {
      const rawData = fs.readFileSync(dataFile, 'utf8')
      const dataObj = JSON.parse(rawData)

      const validConnectors = []
      const types = ['inputs', 'outputs', 'processors', 'caches', 'rate_limits', 'buffers', 'metrics', 'scanners', 'tracers']
      types.forEach(type => {
        if (Array.isArray(dataObj[type])) {
          dataObj[type].forEach(connector => {
            if (connector.name) {
              validConnectors.push({
                name: connector.name,
                type: type.replace(/s$/, ''),
                status: connector.status || connector.type || 'stable'
              })
            }
          })
        }
      })

      // Add cgo-only connectors
      if (binaryAnalysis && binaryAnalysis.cgoOnly) {
        binaryAnalysis.cgoOnly.forEach(cgoConn => {
          const exists = validConnectors.some(c =>
            c.name === cgoConn.name && c.type === cgoConn.type.replace(/s$/, '')
          )
          if (!exists) {
            validConnectors.push({
              name: cgoConn.name,
              type: cgoConn.type.replace(/s$/, ''),
              status: cgoConn.status || 'stable',
              requiresCgo: true
            })
          }
        })
      }

      // Add cloud-only connectors
      if (binaryAnalysis && binaryAnalysis.comparison?.cloudOnly) {
        binaryAnalysis.comparison.cloudOnly.forEach(cloudConn => {
          const exists = validConnectors.some(c =>
            c.name === cloudConn.name && c.type === cloudConn.type.replace(/s$/, '')
          )
          if (!exists) {
            validConnectors.push({
              name: cloudConn.name,
              type: cloudConn.type.replace(/s$/, ''),
              status: cloudConn.status || 'stable',
              cloudOnly: true
            })
          }
        })
      }

      const roots = {
        pages: path.resolve(process.cwd(), 'modules/components/pages'),
        partials: path.resolve(process.cwd(), 'modules/components/partials/components')
      }

      const allMissing = validConnectors.filter(({ name, type }) => {
        const relPath = path.join(`${type}s`, `${name}.adoc`)
        const existsInAny = Object.values(roots).some(root =>
          fs.existsSync(path.join(root, relPath))
        )
        return !existsInAny
      })

      const missingConnectors = allMissing.filter(c =>
        !c.name.includes('sql_driver') &&
        c.status !== 'deprecated'
      )

      if (missingConnectors.length === 0) {
        console.log('Done: All connectors (excluding sql_drivers) already have docs—nothing to draft.')
      } else {
        console.log(`Docs missing for ${missingConnectors.length} connectors:`)
        missingConnectors.forEach(({ name, type }) => {
          console.log(`   • ${type}/${name}`)
        })
        console.log('')

        const filteredDataObj = {}

        for (const [key, arr] of Object.entries(dataObj)) {
          if (!Array.isArray(arr)) {
            filteredDataObj[key] = arr
            continue
          }
          filteredDataObj[key] = arr.filter(component =>
            missingConnectors.some(
              m => m.name === component.name && `${m.type}s` === key
            )
          )
        }

        const cgoMissing = missingConnectors.filter(m => m.requiresCgo)
        if (cgoMissing.length > 0 && binaryAnalysis && binaryAnalysis.cgoIndex) {
          console.log('Fetching cgo-only connector schemas for drafting...')
          cgoMissing.forEach(cgo => {
            const typeKey = `${cgo.type}s`
            if (binaryAnalysis.cgoIndex[typeKey]) {
              const cgoConnector = binaryAnalysis.cgoIndex[typeKey].find(c => c.name === cgo.name)
              if (cgoConnector) {
                if (!filteredDataObj[typeKey]) filteredDataObj[typeKey] = []
                filteredDataObj[typeKey].push(cgoConnector)
                console.log(`   • Added cgo connector schema: ${cgo.type}/${cgo.name}`)
              }
            }
          })
        }

        const cloudMissing = missingConnectors.filter(m => m.cloudOnly)
        if (cloudMissing.length > 0 && binaryAnalysis && binaryAnalysis.cloudIndex) {
          console.log('Fetching cloud-only connector schemas for drafting...')
          cloudMissing.forEach(cloud => {
            const typeKey = `${cloud.type}s`
            if (binaryAnalysis.cloudIndex[typeKey]) {
              const cloudConnector = binaryAnalysis.cloudIndex[typeKey].find(c => c.name === cloud.name)
              if (cloudConnector) {
                if (!filteredDataObj[typeKey]) filteredDataObj[typeKey] = []
                filteredDataObj[typeKey].push(cloudConnector)
                console.log(`   • Added cloud-only connector schema: ${cloud.type}/${cloud.name}`)
              }
            }
          })
        }

        const tempDataPath = path.join(dataDir, '._filtered_connect_data.json')
        fs.writeFileSync(tempDataPath, JSON.stringify(filteredDataObj, null, 2), 'utf8')

        const draftResult = await generateRpcnConnectorDocs({
          data: tempDataPath,
          overrides: options.overrides,
          template: options.templateMain,
          templateFields: options.templateFields,
          templateExamples: options.templateExamples,
          templateIntro: options.templateIntro,
          writeFullDrafts: true,
          cgoOnly: binaryAnalysis?.cgoOnly || [],
          cloudOnly: binaryAnalysis?.comparison?.cloudOnly || []
        })

        fs.unlinkSync(tempDataPath)
        draftsWritten = draftResult.draftsWritten
        draftFiles = draftResult.draftFiles
      }
    } catch (err) {
      console.error(`Error: Could not draft missing: ${err.message}`)
      process.exit(1)
    }
  }

  // Update nav.adoc if drafts were generated
  if (draftFiles && draftFiles.length > 0) {
    try {
      const { updateNavFromDrafts } = require('./update-nav.js')
      const navResult = updateNavFromDrafts(draftFiles)

      if (navResult.updated > 0) {
        console.log(`\nDone: Updated nav.adoc: added ${navResult.updated} connector${navResult.updated !== 1 ? 's' : ''}`)
        navResult.updates.forEach(u => {
          console.log(`   • ${u.type}/${u.name}`)
        })
      }

      if (navResult.skippedCount > 0) {
        console.log(`\nℹ️  Skipped ${navResult.skippedCount} connector${navResult.skippedCount !== 1 ? 's' : ''}:`)
        navResult.skipped.forEach(s => {
          console.log(`   • ${s.type}/${s.name} (${s.reason})`)
        })
      }
    } catch (err) {
      console.error(`Warning: Failed to update nav.adoc: ${err.message}`)
    }
  }

  // Generate PR summary
  try {
    const { printPRSummary } = require('./pr-summary-formatter.js')
    printPRSummary(diffJson, binaryAnalysis, draftFiles)
  } catch (err) {
    console.error(`Warning: Failed to generate PR summary: ${err.message}`)
  }

  const wrote = setAntoraValue('asciidoc.attributes.latest-connect-version', newVersion)
  if (wrote) {
    console.log(`Done: Updated Antora version: ${newVersion}`)
  }

  console.log('Generation Report:')
  console.log(`   • Partial files: ${partialsWritten}`)
  const fieldsPartials = partialFiles.filter(fp => fp.includes('/fields/'))
  const examplesPartials = partialFiles.filter(fp => fp.includes('/examples/'))

  logCollapsed('Fields partials', fieldsPartials, 10)
  logCollapsed('Examples partials', examplesPartials, 10)

  if (options.draftMissing) {
    console.log(`   • Full drafts:   ${draftsWritten}`)
    const draftFilePaths = draftFiles.map(df => typeof df === 'string' ? df : df.path)
    logCollapsed('Draft files', draftFilePaths, 5)
  }

  // Update whats-new.adoc
  if (options.updateWhatsNew) {
    if (!oldVersion) {
      console.warn('Warning: Skipping whats-new update: oldVersion not available')
    } else {
      updateWhatsNew({ dataDir, oldVersion, newVersion, binaryAnalysis })
    }
  }

  console.log('\n📄 Summary:')
  console.log(`   • Run time: ${timestamp}`)
  console.log(`   • Version used: ${newVersion}`)
  process.exit(0)
}

module.exports = {
  handleRpcnConnectorDocs,
  updateWhatsNew,
  capToTwoSentences
}
