'use strict'

const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const semver = require('semver')
const { findRepoRoot } = require('../../cli-utils/doc-tools-utils')
const { generateRpkDocs, applyOverridesToTree, resolveReferences } = require('./generate-rpk-docs')
const { generateRpkDiff, printDiffReport, generateWhatsNewSection } = require('./report-delta')
const { loadAndValidateOverrides, ValidationResult } = require('./validate-overrides')
const { validateDirectory, formatResults } = require('./validate-output')

/**
 * Known rpk plugins that are managed separately (have install/uninstall commands)
 */
const KNOWN_PLUGINS = ['ai', 'check', 'connect', 'oxla']

/**
 * Parse Go version from 'go version' output
 * @param {string} versionOutput - Output from 'go version' command
 * @returns {string|null} Semver-compatible version string or null
 */
function parseGoVersion(versionOutput) {
  // go version go1.26.4 darwin/arm64 -> 1.26.4
  const match = versionOutput.match(/go(\d+\.\d+(?:\.\d+)?)/)
  return match ? match[1] : null
}

/**
 * Get required Go version from go.mod file
 * @param {string} sourcePath - Path to rpk source directory
 * @returns {string|null} Required Go version or null
 */
function getRequiredGoVersion(sourcePath) {
  const goModPath = path.join(sourcePath, 'go.mod')
  if (!fs.existsSync(goModPath)) {
    return null
  }
  const content = fs.readFileSync(goModPath, 'utf8')
  // go 1.26.4
  const match = content.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m)
  return match ? match[1] : null
}

/**
 * Check if installed Go version meets requirements
 * @param {string} installedVersion - Installed Go version
 * @param {string} requiredVersion - Required Go version from go.mod
 * @returns {boolean} True if version is sufficient
 */
function checkGoVersionSufficient(installedVersion, requiredVersion) {
  // Normalize to semver format (add .0 if needed)
  const normalize = (v) => {
    const parts = v.split('.')
    while (parts.length < 3) parts.push('0')
    return parts.join('.')
  }
  return semver.gte(normalize(installedVersion), normalize(requiredVersion))
}


/**
 * Extract all command paths from a command tree
 * @param {Object} tree - Command tree
 * @param {string} prefix - Command path prefix
 * @returns {Set<string>} Set of all command paths
 */
function extractCommandPaths(tree, prefix = '') {
  const paths = new Set()
  const fullPath = prefix ? `${prefix} ${tree.name}` : tree.name || 'rpk'
  paths.add(fullPath)

  if (tree.commands && Array.isArray(tree.commands)) {
    for (const cmd of tree.commands) {
      const childPaths = extractCommandPaths(cmd, fullPath)
      for (const p of childPaths) {
        paths.add(p)
      }
    }
  }
  return paths
}

/**
 * Detect Linux-only commands by comparing Linux and Darwin builds
 * @param {Object} linuxTree - Command tree from Linux build
 * @param {Object} darwinTree - Command tree from Darwin/macOS build
 * @returns {Set<string>} Commands that exist only on Linux
 */
function detectLinuxOnlyByComparison(linuxTree, darwinTree) {
  const linuxCommands = extractCommandPaths(linuxTree)
  const darwinCommands = extractCommandPaths(darwinTree)

  // Find commands in Linux but not in Darwin
  const linuxOnly = new Set()
  for (const cmd of linuxCommands) {
    if (!darwinCommands.has(cmd)) {
      linuxOnly.add(cmd)
    }
  }

  return linuxOnly
}

/**
 * Platform identifiers
 */
const PLATFORMS = {
  LINUX: 'linux',
  DARWIN: 'darwin',
  WINDOWS: 'windows'
}

/**
 * Get current platform identifier
 * @returns {string}
 */
function getCurrentPlatform() {
  const platform = os.platform()
  if (platform === 'darwin') return PLATFORMS.DARWIN
  if (platform === 'win32') return PLATFORMS.WINDOWS
  return PLATFORMS.LINUX
}

/**
 * Check if a command is a plugin by looking for install/uninstall subcommands
 * @param {Object} command - Command object from rpk tree
 * @returns {boolean}
 */
function isPlugin(command) {
  if (!command.commands || !Array.isArray(command.commands)) return false
  const subcommandNames = command.commands.map(c => c.name)
  return subcommandNames.includes('install') && subcommandNames.includes('uninstall')
}

/**
 * Detect all plugins in the rpk tree
 * @param {Object} tree - Full rpk command tree
 * @returns {string[]} Array of plugin names
 */
function detectPlugins(tree) {
  if (!tree.commands) return []
  return tree.commands
    .filter(cmd => isPlugin(cmd))
    .map(cmd => cmd.name)
}

/**
 * Prepare rpk source directory from a GitHub ref (branch or tag)
 * If sourcePath is provided and is a git repo, checkout the ref there
 * If no sourcePath, do a sparse checkout from GitHub to a temp directory
 * @param {string} sourceRef - Git ref (branch or tag, e.g., 'dev', 'v26.2.0')
 * @param {string} [sourcePath] - Optional local path to existing repo
 * @returns {string} Path to the rpk source directory (src/go/rpk)
 */
function prepareSourceFromRef(sourceRef, sourcePath = null) {
  if (sourcePath) {
    // Use existing local repo, checkout the specified ref
    const absolutePath = path.resolve(sourcePath)

    // Check if it's the rpk subdirectory or the repo root
    let repoRoot = absolutePath
    if (absolutePath.endsWith('src/go/rpk')) {
      repoRoot = absolutePath.replace(/\/src\/go\/rpk$/, '')
    } else if (fs.existsSync(path.join(absolutePath, 'src', 'go', 'rpk'))) {
      // It's the repo root
    } else {
      throw new Error(
        `Cannot determine repo root from ${absolutePath}\n` +
        `Provide either the repo root or src/go/rpk directory.`
      )
    }

    // Verify it's a git repo
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
      throw new Error(`Not a git repository: ${repoRoot}`)
    }

    console.log(`Checking out ref '${sourceRef}' in ${repoRoot}...`)

    // Fetch and checkout
    const fetchResult = spawnSync('git', ['fetch', 'origin', sourceRef], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120000
    })

    if (fetchResult.status !== 0) {
      console.warn(`Warning: Could not fetch ref '${sourceRef}': ${fetchResult.stderr}`)
    }

    const checkoutResult = spawnSync('git', ['checkout', sourceRef], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000
    })

    if (checkoutResult.status !== 0) {
      throw new Error(`Failed to checkout ref '${sourceRef}': ${checkoutResult.stderr}`)
    }

    console.log(`Checked out ${sourceRef}`)
    return path.join(repoRoot, 'src', 'go', 'rpk')
  }

  // No local path - do sparse checkout from GitHub
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-source-'))
  const repoDir = path.join(tmpDir, 'redpanda')

  console.log(`Sparse-cloning redpanda repo (ref: ${sourceRef}) to ${repoDir}...`)

  // Clone with sparse checkout
  const cloneResult = spawnSync('git', [
    'clone',
    '--depth', '1',
    '--filter=blob:none',
    '--sparse',
    '--branch', sourceRef,
    'https://github.com/redpanda-data/redpanda.git',
    repoDir
  ], {
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  if (cloneResult.status !== 0) {
    throw new Error(
      `Failed to clone redpanda repo with ref '${sourceRef}'.\n` +
      `Make sure the branch or tag exists.\n` +
      `Error: ${cloneResult.stderr}`
    )
  }

  // Set sparse checkout to only get rpk
  const sparseResult = spawnSync('git', ['sparse-checkout', 'set', 'src/go/rpk'], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 60000
  })

  if (sparseResult.status !== 0) {
    throw new Error(`Failed to set sparse checkout: ${sparseResult.stderr}`)
  }

  console.log(`Sparse checkout complete`)
  return path.join(repoDir, 'src', 'go', 'rpk')
}

/**
 * Fetch rpk tree by running from Go source code
 * Useful for pre-releases before Docker images are published
 * @param {string} sourcePath - Path to rpk Go source directory (e.g., ~/redpanda/src/go/rpk)
 * @returns {Object} Parsed JSON tree
 */
function fetchRpkTreeFromSource(sourcePath) {
  // Verify the source path exists
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `rpk source directory not found: ${sourcePath}\n` +
      'To use --from-source, you need a local checkout of the redpanda repository.\n' +
      'Clone it with: git clone https://github.com/redpanda-data/redpanda.git\n' +
      'Then point to: <repo>/src/go/rpk'
    )
  }

  // Verify it looks like the right directory (should have cmd/rpk)
  const mainPath = path.join(sourcePath, 'cmd', 'rpk', 'main.go')
  if (!fs.existsSync(mainPath)) {
    throw new Error(
      `Invalid rpk source directory: ${sourcePath}\n` +
      `Expected to find cmd/rpk/main.go. Make sure you point to the src/go/rpk directory.`
    )
  }

  // Check if Go is installed
  const goCheck = spawnSync('go', ['version'], { encoding: 'utf8', timeout: 5000 })
  if (goCheck.status !== 0) {
    throw new Error(
      'Go is required for --from-source but was not found.\n' +
      'Install Go from https://go.dev/ and ensure it\'s in your PATH.'
    )
  }

  console.log(`Building and running rpk from source at ${sourcePath}...`)
  console.log(`Go version: ${goCheck.stdout.trim()}`)

  // Check Go version meets go.mod requirements
  const installedGoVersion = parseGoVersion(goCheck.stdout)
  const requiredGoVersion = getRequiredGoVersion(sourcePath)
  if (installedGoVersion && requiredGoVersion) {
    if (!checkGoVersionSufficient(installedGoVersion, requiredGoVersion)) {
      throw new Error(
        `Go version mismatch: installed ${installedGoVersion}, required >= ${requiredGoVersion}\n` +
        `The rpk source (go.mod) requires Go ${requiredGoVersion} or newer.\n` +
        'Update Go: brew upgrade go (macOS) or download from https://go.dev/dl/'
      )
    }
  }

  // Run rpk directly from source using go run
  const result = spawnSync('go', ['run', 'cmd/rpk/main.go', '--print-tree'], {
    cwd: sourcePath,
    encoding: 'utf8',
    timeout: 120000, // 2 minutes (includes build time)
    maxBuffer: 50 * 1024 * 1024
  })

  if (result.status !== 0) {
    const stderr = result.stderr || ''
    if (stderr.includes('unknown flag')) {
      throw new Error(
        `rpk source does not support --print-tree flag.\n` +
        `This feature requires rpk source from after the --print-tree feature was added.\n` +
        'Update your source checkout: cd <repo> && git pull origin dev'
      )
    }
    if (stderr.includes('go.mod') || stderr.includes('module')) {
      throw new Error(
        `Go module error while building rpk: ${stderr}\n` +
        'Try running "go mod download" in the source directory first.'
      )
    }
    throw new Error(
      `Failed to build/run rpk from source: ${stderr}\n` +
      'Common fixes:\n' +
      '  1. Update Go to the latest version\n' +
      '  2. Run "go mod download" in the source directory\n' +
      '  3. Ensure the source is up to date: git pull origin dev'
    )
  }

  try {
    return JSON.parse(result.stdout)
  } catch (err) {
    throw new Error(
      `Failed to parse rpk tree JSON from source build: ${err.message}\n` +
      'The build succeeded but the output was not valid JSON.\n' +
      'This may indicate a version mismatch or corrupted source.'
    )
  }
}

/**
 * Build rpk from Go source inside a Linux Docker container (optional optimization).
 * Builds rpk binary, installs plugins, then runs --print-tree for complete command coverage.
 * Falls back to native Go build if Docker is unavailable.
 * @param {string} sourcePath - Path to rpk Go source directory (e.g., ~/redpanda/src/go/rpk)
 * @returns {Object} Parsed JSON tree
 */
function fetchRpkTreeFromLinuxSource(sourcePath) {
  // Resolve to absolute path
  const absoluteSourcePath = path.resolve(sourcePath)

  // Verify the source path exists
  if (!fs.existsSync(absoluteSourcePath)) {
    throw new Error(
      `rpk source directory not found: ${absoluteSourcePath}\n` +
      'Expected a checkout of the redpanda repository.\n' +
      'Clone it with: git clone https://github.com/redpanda-data/redpanda.git'
    )
  }

  // Verify it looks like the right directory (should have cmd/rpk)
  const mainPath = path.join(absoluteSourcePath, 'cmd', 'rpk', 'main.go')
  if (!fs.existsSync(mainPath)) {
    throw new Error(
      `Invalid rpk source directory: ${absoluteSourcePath}\n` +
      'Expected to find cmd/rpk/main.go.\n' +
      'Make sure you point to the src/go/rpk directory inside your redpanda checkout.'
    )
  }

  // Docker is optional - used when available for Linux plugin support
  const dockerCheck = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 5000 })
  if (dockerCheck.status !== 0) {
    // Docker not available - this function shouldn't be called
    throw new Error(
      'Docker not available for Linux container build.\n' +
      'Use fetchRpkTreeFromSource() for native Go build instead.'
    )
  }

  console.log(`Building and running rpk from source in Linux container...`)
  console.log(`Source path: ${absoluteSourcePath}`)

  // Start a container with the Go image, mount source, build rpk, install plugins, then print-tree
  // Use a long-running container so we can run multiple commands
  console.log('Starting build container...')
  const createResult = spawnSync('docker', [
    'run', '-d', '--rm',
    '-v', `${absoluteSourcePath}:/rpk-source:ro`,
    '-w', '/rpk-source',
    'golang:1',
    'sh', '-c', 'sleep 600' // Keep container alive for 10 minutes
  ], {
    encoding: 'utf8',
    timeout: 60000
  })

  if (createResult.status !== 0) {
    const stderr = createResult.stderr || ''
    if (stderr.includes('Cannot connect to the Docker daemon')) {
      throw new Error(
        'Docker daemon is not running.\n' +
        'Start Docker Desktop or the Docker service and try again.'
      )
    }
    throw new Error(
      `Failed to create build container: ${stderr}\n` +
      'Make sure Docker is running and has sufficient resources.'
    )
  }

  const containerId = createResult.stdout.trim()
  console.log(`Build container started: ${containerId.substring(0, 12)}`)

  try {
    // Step 1: Build rpk binary
    console.log('Building rpk binary...')
    const buildResult = spawnSync('docker', [
      'exec', containerId,
      'go', 'build', '-o', '/tmp/rpk', './cmd/rpk'
    ], {
      encoding: 'utf8',
      timeout: 300000 // 5 minutes for build
    })

    if (buildResult.status !== 0) {
      const stderr = buildResult.stderr || ''
      throw new Error(
        `Failed to build rpk in Linux container: ${stderr}\n` +
        'Common causes:\n' +
        '  1. Source code is out of date - run: git pull origin dev\n' +
        '  2. Go module issues - the container will download dependencies automatically\n' +
        '  3. Insufficient Docker resources - check Docker Desktop settings'
      )
    }
    console.log('  ✓ rpk binary built')

    // Step 2: Install plugins
    console.log('Installing plugins for complete command coverage...')
    for (const plugin of KNOWN_PLUGINS) {
      console.log(`  Installing plugin: ${plugin}...`)
      const installResult = spawnSync('docker', [
        'exec', containerId,
        '/tmp/rpk', plugin, 'install'
      ], {
        encoding: 'utf8',
        timeout: 120000
      })

      if (installResult.status === 0) {
        console.log(`    ✓ ${plugin} installed`)
      } else {
        const stderr = installResult.stderr || ''
        const stdout = installResult.stdout || ''
        if (stderr.includes('already installed') || stdout.includes('already installed')) {
          console.log(`    ✓ ${plugin} already installed`)
        } else if (stderr.includes('unknown command') || stderr.includes('Error: unknown command')) {
          console.log(`    - ${plugin} is not an installable plugin`)
        } else {
          console.warn(`    ✗ Failed to install ${plugin}: ${stderr || stdout}`)
        }
      }
    }

    // Step 3: Run --print-tree with all plugins installed
    console.log('Fetching rpk tree with plugins installed...')
    const result = spawnSync('docker', [
      'exec', containerId,
      '/tmp/rpk', '--print-tree'
    ], {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024
    })

    if (result.status !== 0) {
      const stderr = result.stderr || ''
      if (stderr.includes('unknown flag')) {
        throw new Error(
          `rpk source does not support --print-tree flag.\n` +
          `This feature requires rpk source from after the --print-tree feature was added.\n` +
          'Update your source checkout: cd <repo> && git pull origin dev'
        )
      }
      throw new Error(
        `Failed to run rpk --print-tree in Linux container: ${stderr}\n` +
        'The build succeeded but --print-tree failed.\n' +
        'This may indicate a version or configuration issue.'
      )
    }

    try {
      return JSON.parse(result.stdout)
    } catch (err) {
      throw new Error(
        `Failed to parse rpk tree JSON from Linux source build: ${err.message}\n` +
        'The build and --print-tree succeeded but the output was not valid JSON.\n' +
        'This may indicate a version mismatch or corrupted source.'
      )
    }
  } finally {
    // Clean up container
    console.log('Cleaning up build container...')
    spawnSync('docker', ['stop', containerId], {
      encoding: 'utf8',
      timeout: 30000
    })
  }
}

/**
 * Scan Go source files for Linux-only build tags
 * Looks for //go:build linux or // +build linux
 * @param {string} sourcePath - Path to rpk Go source directory
 * @returns {Set<string>} Set of Linux-only command paths (e.g., 'rpk redpanda tune')
 */
function detectLinuxOnlyFromSource(sourcePath) {
  const linuxOnlyCommands = new Set()

  // Map of source directory patterns to command paths
  // rpk commands are typically in pkg/cli/cmd/<command>/<subcommand>/
  const scanDirectory = (dir, prefix = '') => {
    if (!fs.existsSync(dir)) return

    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        const newPrefix = prefix ? `${prefix} ${entry.name}` : entry.name
        scanDirectory(fullPath, newPrefix)
      } else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
        // Check Go files for build tags
        try {
          const content = fs.readFileSync(fullPath, 'utf8')
          const firstLines = content.split('\n').slice(0, 20).join('\n')

          // Check for Linux build constraints
          const hasLinuxTag = /\/\/go:build\s+.*linux/.test(firstLines) ||
                             /\/\/\s*\+build\s+.*linux/.test(firstLines)

          if (hasLinuxTag) {
            // Try to determine command path from file location
            const commandPath = inferCommandPath(sourcePath, fullPath, entry.name)
            if (commandPath) {
              linuxOnlyCommands.add(commandPath)
            }
          }
        } catch (err) {
          // Skip files we can't read
        }
      }
    }
  }

  // Scan the cmd/rpk directory for command implementations
  const cmdDir = path.join(sourcePath, 'pkg', 'cli', 'cmd')
  if (fs.existsSync(cmdDir)) {
    scanDirectory(cmdDir, 'rpk')
  }

  // Also check the older structure
  const oldCmdDir = path.join(sourcePath, 'cmd', 'rpk')
  if (fs.existsSync(oldCmdDir)) {
    scanDirectory(oldCmdDir, 'rpk')
  }

  return linuxOnlyCommands
}

/**
 * Infer command path from Go source file location
 * @param {string} sourcePath - Root source path
 * @param {string} filePath - Full path to Go file
 * @param {string} fileName - Name of the Go file
 * @returns {string|null} Command path or null
 */
function inferCommandPath(sourcePath, filePath, fileName) {
  // Get relative path from source root
  const relativePath = filePath.replace(sourcePath, '').replace(/^\//, '')

  // Common patterns:
  // pkg/cli/cmd/redpanda/tune.go -> rpk redpanda tune
  // pkg/cli/cmd/redpanda/start.go -> rpk redpanda start
  // cmd/rpk/iotune/iotune.go -> rpk iotune

  // Remove common prefixes and file extension
  let parts = relativePath
    .replace(/^pkg\/cli\/cmd\//, '')
    .replace(/^cmd\/rpk\//, '')
    .replace(/\.go$/, '')
    .split('/')

  // If file name matches directory name, use directory only
  // e.g., iotune/iotune.go -> iotune
  if (parts.length > 1 && parts[parts.length - 1] === parts[parts.length - 2]) {
    parts = parts.slice(0, -1)
  }

  // Filter out common non-command directories
  parts = parts.filter(p => !['internal', 'common', 'config', 'cmd'].includes(p))

  if (parts.length === 0) return null

  return 'rpk ' + parts.join(' ')
}

/**
 * Add platform markers to command tree based on source analysis
 * @param {Object} tree - Command tree from rpk --print-tree
 * @param {Set<string>} linuxOnlyCommands - Set of Linux-only command paths
 * @returns {Object} Tree with platform availability info
 */
function addPlatformMarkersFromSource(tree, linuxOnlyCommands) {
  const isLinuxOnly = (cmdPath) => {
    // Check if this command or any parent is Linux-only from source detection
    // Detection comes from: 1) Go build tags in source, 2) dynamic comparison of Linux vs Darwin builds
    return linuxOnlyCommands.has(cmdPath) ||
           [...linuxOnlyCommands].some(loc => cmdPath.startsWith(loc + ' '))
  }

  const markCommands = (commands, parentPath = 'rpk') => {
    if (!commands) return commands
    return commands.map(cmd => {
      const fullPath = `${parentPath} ${cmd.name}`
      const platforms = isLinuxOnly(fullPath)
        ? [PLATFORMS.LINUX]
        : [PLATFORMS.LINUX, PLATFORMS.DARWIN]
      return {
        ...cmd,
        platforms,
        commands: markCommands(cmd.commands, fullPath)
      }
    })
  }

  // Log detected Linux-only commands
  if (linuxOnlyCommands.size > 0) {
    console.log(`Detected ${linuxOnlyCommands.size} Linux-only command path(s) from source:`)
    for (const cmd of linuxOnlyCommands) {
      console.log(`  - ${cmd}`)
    }
  }

  return {
    ...tree,
    platforms: [PLATFORMS.LINUX, PLATFORMS.DARWIN],
    linux_only_commands: [...linuxOnlyCommands],
    commands: markCommands(tree.commands)
  }
}

/**
 * Get platform availability description for a command
 * @param {string[]} platforms - Array of platform identifiers
 * @returns {string} Human-readable description
 */
function getPlatformDescription(platforms) {
  if (!platforms || platforms.length === 0) return ''
  if (platforms.length >= 2 && platforms.includes(PLATFORMS.LINUX) && platforms.includes(PLATFORMS.DARWIN)) {
    return '' // Available on all major platforms, no need to note
  }
  if (platforms.length === 1) {
    switch (platforms[0]) {
      case PLATFORMS.LINUX:
        return 'Linux only'
      case PLATFORMS.DARWIN:
        return 'macOS only'
      case PLATFORMS.WINDOWS:
        return 'Windows only'
      default:
        return platforms[0]
    }
  }
  return platforms.map(p => {
    switch (p) {
      case PLATFORMS.LINUX: return 'Linux'
      case PLATFORMS.DARWIN: return 'macOS'
      case PLATFORMS.WINDOWS: return 'Windows'
      default: return p
    }
  }).join(', ')
}

/**
 * Load overrides from JSON file with validation
 * @param {string} overridesPath - Path to overrides file
 * @param {Object} [commandTree] - Optional command tree for path validation
 * @param {Object} [options] - Options
 * @param {boolean} [options.strict=false] - If true, throw on validation errors
 * @returns {Object|null} Overrides object or null if not found
 */
function loadOverrides(overridesPath, commandTree = null, options = {}) {
  const { strict = false } = options

  if (!overridesPath || !fs.existsSync(overridesPath)) {
    return null
  }

  const { overrides, validation } = loadAndValidateOverrides(overridesPath, commandTree)

  // Report validation issues
  if (validation.errors.length > 0 || validation.warnings.length > 0) {
    console.log('\n' + '='.repeat(60))
    console.log('OVERRIDE VALIDATION RESULTS')
    console.log('='.repeat(60))
    console.log(validation.format())
    console.log('='.repeat(60) + '\n')
  }

  // In strict mode, fail on errors
  if (strict && !validation.valid) {
    throw new Error(
      `Override validation failed with ${validation.errors.length} error(s).\n` +
      `Fix the issues above or run without --strict to proceed with warnings.`
    )
  }

  // Warn but continue on non-strict validation failures
  if (!validation.valid && !strict) {
    console.warn(
      `⚠ Proceeding with ${validation.errors.length} validation error(s). ` +
      `Generated docs may be incorrect.`
    )
  }

  return overrides
}

/**
 * Save versioned JSON tree
 * @param {Object} data - Data to save
 * @param {string} version - Version string
 * @param {string} dataDir - Output directory
 * @returns {string} Path to saved file
 */
function saveVersionedJson(data, version, dataDir) {
  const normalizedVersion = version.startsWith('v') ? version : `v${version}`
  const fileName = `rpk-${normalizedVersion}.json`
  const filePath = path.join(dataDir, fileName)

  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')

  console.log(`Saved versioned JSON to ${filePath}`)
  return filePath
}

/**
 * Load existing versioned JSON
 * @param {string} version - Version string
 * @param {string} dataDir - Data directory
 * @returns {Object|null} Loaded data or null
 */
function loadVersionedJson(version, dataDir) {
  const normalizedVersion = version.startsWith('v') ? version : `v${version}`
  const fileName = `rpk-${normalizedVersion}.json`
  const filePath = path.join(dataDir, fileName)

  if (!fs.existsSync(filePath)) {
    return null
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(content)
  } catch (err) {
    console.warn(`Warning: Could not load ${filePath}: ${err.message}`)
    return null
  }
}

/**
 * Update overrides file with introducedInVersion for new commands and flags
 * @param {Object} diffData - Diff data with new commands and flags
 * @param {string} overridesPath - Path to overrides JSON file
 * @param {string} version - Version to set as introducedInVersion
 */
function updateOverridesWithIntroducedVersions(diffData, overridesPath, version) {
  const hasNewCommands = diffData.details.newCommands && diffData.details.newCommands.length > 0
  const hasNewFlags = diffData.details.newFlags && diffData.details.newFlags.length > 0

  if (!hasNewCommands && !hasNewFlags) {
    return
  }

  let overrides = {}
  if (fs.existsSync(overridesPath)) {
    try {
      overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
    } catch (err) {
      console.warn(`Warning: Could not parse overrides file: ${err.message}`)
      return
    }
  }

  if (!overrides.commands) {
    overrides.commands = {}
  }

  let commandsUpdated = 0
  let flagsUpdated = 0

  // Update new commands
  if (hasNewCommands) {
    for (const newCmd of diffData.details.newCommands) {
      const cmdPath = newCmd.path
      if (!overrides.commands[cmdPath]) {
        overrides.commands[cmdPath] = {}
      }
      // Only set if not already set (preserve manual overrides)
      if (!overrides.commands[cmdPath].introducedInVersion) {
        overrides.commands[cmdPath].introducedInVersion = version
        commandsUpdated++
      }
    }
  }

  // Update new flags
  if (hasNewFlags) {
    for (const newFlag of diffData.details.newFlags) {
      const cmdPath = newFlag.commandPath
      const flagName = newFlag.flagName

      if (!overrides.commands[cmdPath]) {
        overrides.commands[cmdPath] = {}
      }
      if (!overrides.commands[cmdPath].flags) {
        overrides.commands[cmdPath].flags = {}
      }
      if (!overrides.commands[cmdPath].flags[flagName]) {
        overrides.commands[cmdPath].flags[flagName] = {}
      }

      // Only set if not already set (preserve manual overrides)
      if (!overrides.commands[cmdPath].flags[flagName].introducedInVersion) {
        overrides.commands[cmdPath].flags[flagName].introducedInVersion = version
        flagsUpdated++
      }
    }
  }

  if (commandsUpdated > 0 || flagsUpdated > 0) {
    fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 2), 'utf8')
    const updates = []
    if (commandsUpdated > 0) updates.push(`${commandsUpdated} new command(s)`)
    if (flagsUpdated > 0) updates.push(`${flagsUpdated} new flag(s)`)
    console.log(`Updated ${overridesPath} with introducedInVersion for ${updates.join(' and ')}`)
  }
}

/**
 * Get the latest documented version from data directory
 * @param {string} dataDir - Data directory path
 * @returns {string|null} Latest version or null
 */
function getLatestDocumentedVersion(dataDir) {
  if (!fs.existsSync(dataDir)) return null

  const files = fs.readdirSync(dataDir)
    .filter(f => f.startsWith('rpk-v') && f.endsWith('.json') && !f.includes('diff'))
    .map(f => f.replace('rpk-', '').replace('.json', ''))
    .filter(v => semver.valid(v))
    .sort((a, b) => semver.compare(b, a)) // Descending

  return files.length > 0 ? files[0] : null
}

/**
 * Common locations where tech writers might have redpanda source checked out
 */
const COMMON_SOURCE_LOCATIONS = [
  '~/redpanda/src/go/rpk',
  '~/Documents/redpanda/src/go/rpk',
  '~/repos/redpanda/src/go/rpk',
  '~/code/redpanda/src/go/rpk',
  '~/projects/redpanda/src/go/rpk',
  '../redpanda/src/go/rpk',
  '../../redpanda/src/go/rpk'
]

/**
 * Try to find a local redpanda source checkout
 * @returns {string|null} Path to rpk source directory, or null if not found
 */
function findLocalSource() {
  const homeDir = os.homedir()

  for (const location of COMMON_SOURCE_LOCATIONS) {
    const expandedPath = location.replace('~', homeDir)
    const absolutePath = path.resolve(expandedPath)
    const mainGoPath = path.join(absolutePath, 'cmd', 'rpk', 'main.go')

    if (fs.existsSync(mainGoPath)) {
      return absolutePath
    }
  }

  return null
}

/**
 * Count total commands in tree (recursive)
 * @param {Object} node - Tree node
 * @returns {number} Total command count
 */
function countCommands(node) {
  if (!node) return 0
  let count = 1 // Count this node
  if (node.commands && Array.isArray(node.commands)) {
    for (const child of node.commands) {
      count += countCommands(child)
    }
  }
  return count
}

/**
 * Update what's-new file with rpk changes from diff
 * @param {Object} diffData - Diff data from generateRpkDiff
 * @param {string} whatsNewPath - Path to what's-new.adoc file
 * @param {string} version - Version string for display
 */
function updateWhatsNewFile(diffData, whatsNewPath, version) {
  const whatsNewContent = generateWhatsNewSection(diffData, { version })

  if (!whatsNewContent) {
    console.log('No Redpanda CLI changes to add to what\'s new')
    return
  }

  if (!fs.existsSync(whatsNewPath)) {
    console.warn(`Warning: what's-new file not found: ${whatsNewPath}`)
    console.log('Generated what\'s-new content:')
    console.log(whatsNewContent)
    return
  }

  const existingContent = fs.readFileSync(whatsNewPath, 'utf8')

  // Check if Redpanda CLI section already exists
  if (existingContent.includes('== Redpanda CLI')) {
    console.log('Redpanda CLI section already exists in what\'s-new file')
    return
  }

  // Find a good insertion point - before the last section or at the end
  // Look for a pattern like "== New configuration properties" or similar
  const insertionPatterns = [
    /^== New configuration properties/m,
    /^== Deprecations/m,
    /^== Bug fixes/m,
    /^== See also/m
  ]

  let insertIndex = -1
  for (const pattern of insertionPatterns) {
    const match = existingContent.match(pattern)
    if (match) {
      insertIndex = match.index
      break
    }
  }

  let updatedContent
  if (insertIndex > 0) {
    // Insert before the matched section
    updatedContent = existingContent.slice(0, insertIndex) +
      whatsNewContent + '\n' +
      existingContent.slice(insertIndex)
  } else {
    // Append at the end
    updatedContent = existingContent + '\n' + whatsNewContent
  }

  fs.writeFileSync(whatsNewPath, updatedContent, 'utf8')
  console.log(`Updated what's-new file: ${whatsNewPath}`)
}

/**
 * Main handler for rpk docs generation
 *
 * Simplified workflow:
 * 1. Use --ref to specify version (clones from GitHub or uses local source)
 * 2. Build rpk from Go source
 * 3. Parse source to detect Linux-only commands (via build tags)
 * 4. Generate documentation with accurate platform markers
 *
 * @param {Object} options - Generation options
 */
async function handleRpkDocsGeneration(options = {}) {
  const {
    overrides: overridesPath,
    fromSource, // Path to local rpk Go source directory
    fromJson, // Path to existing versioned JSON file to regenerate from
    ref, // Git ref (branch or tag) to document
    sourceRef, // Alias for ref
    diff: diffVersion,
    updateWhatsNew: whatsNewPath, // Path to what's-new.adoc file to update
    draftMissing = false,
    outputDir,
    cloudSecretDir, // Directory for rpk cloud and rpk security secret commands
    dataDir: customDataDir,
    preserveFrom, // Path to existing docs to preserve cloud conditionals and includes from
    printSummary = false, // Print PR summary to console
    showInfo = false // Include info-level validation messages
  } = options

  // Normalize ref/sourceRef
  const effectiveRef = ref || sourceRef

  const repoRoot = findRepoRoot()
  const dataDir = customDataDir || path.join(repoRoot, 'docs-data')
  const defaultOutputDir = path.join(repoRoot, 'modules', 'reference', 'pages', 'rpk')
  const finalOutputDir = outputDir || defaultOutputDir

  // cloudSecretDir should be relative to outputDir, not repoRoot
  // If outputDir is .../modules/reference/pages/rpk, cloudSecretDir should be .../modules/reference/partials
  let defaultCloudSecretDir
  if (outputDir) {
    // Check if outputDir follows docs repo structure (ends with pages/rpk or similar)
    const normalizedOutput = finalOutputDir.replace(/\\/g, '/')
    if (normalizedOutput.includes('/pages/')) {
      // Derive cloudSecretDir from outputDir by going up from pages/rpk to partials
      const pagesIndex = normalizedOutput.lastIndexOf('/pages/')
      const referenceDir = normalizedOutput.substring(0, pagesIndex)
      defaultCloudSecretDir = path.join(referenceDir, 'partials')
    } else {
      // Arbitrary output directory - use sibling partials directory
      const outputParent = path.dirname(finalOutputDir)
      defaultCloudSecretDir = path.join(outputParent, 'partials')
    }
  } else {
    defaultCloudSecretDir = path.join(repoRoot, 'modules', 'reference', 'partials')
  }
  const finalCloudSecretDir = cloudSecretDir || defaultCloudSecretDir

  // Determine which version to document
  const version = effectiveRef || 'dev'
  console.log(`\nGenerating rpk documentation for version: ${version}`)

  let tree
  let rpkVersion
  let sourcePath

  try {
    // Fast path: regenerate from existing JSON file
    if (fromJson) {
      const jsonPath = path.resolve(fromJson)
      if (!fs.existsSync(jsonPath)) {
        throw new Error(`JSON file not found: ${jsonPath}`)
      }
      console.log(`Loading command tree from ${jsonPath}`)
      const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      tree = jsonData.raw_tree || jsonData.tree
      rpkVersion = jsonData.rpk_version || 'local'

      if (!tree) {
        throw new Error('JSON file does not contain a valid command tree')
      }

      console.log(`Loaded tree with rpk version: ${rpkVersion}`)

      // Skip to documentation generation (after the source building steps)
      // Load and validate overrides
      const defaultOverridesPath = path.join(dataDir, 'rpk-overrides.json')
      const effectiveOverridesPath = overridesPath || defaultOverridesPath
      const overridesData = loadOverrides(effectiveOverridesPath, tree, { strict: false })

      if (overridesData) {
        console.log(`Loaded overrides from ${effectiveOverridesPath}`)
      }

      // Generate AsciiDoc documentation
      console.log(`\nGenerating AsciiDoc files to ${finalOutputDir}...`)

      const result = await generateRpkDocs({
        tree,
        overrides: overridesData,
        outputDir: finalOutputDir,
        cloudSecretDir: finalCloudSecretDir,
        rpkVersion,
        pluginVersions: {},
        draftMissing,
        preservationsDir: preserveFrom
      })

      console.log(`\nGeneration complete!`)
      console.log(`  - Commands documented: ${result.commandCount}`)
      console.log(`  - Files generated: ${result.filesGenerated}`)
      console.log(`  - Output directory: ${finalOutputDir}`)

      // Run validation on generated output
      const validationResult = runValidation(finalOutputDir, {
        showInfo
      })

      // Generate diff if requested
      let diffData = null
      if (diffVersion) {
        const oldData = loadVersionedJson(diffVersion, dataDir)
        if (oldData) {
          // Use raw_tree for diffing (falls back to tree for backward compatibility)
          const oldTree = oldData.raw_tree || oldData.tree
          diffData = generateRpkDiff(oldTree, tree, {
            oldVersion: diffVersion,
            newVersion: rpkVersion
          })

          // Save diff
          const diffFileName = `rpk-diff-${diffVersion}_to_${rpkVersion}.json`
          const diffPath = path.join(dataDir, diffFileName)
          fs.writeFileSync(diffPath, JSON.stringify(diffData, null, 2), 'utf8')
          console.log(`Saved diff to ${diffPath}`)

          // Print diff report
          printDiffReport(diffData)

          // Update what's-new file if requested
          if (whatsNewPath) {
            updateWhatsNewFile(diffData, whatsNewPath, rpkVersion)
          }
        } else {
          console.warn(`Warning: Could not load previous version ${diffVersion} for diff`)
        }
      }

      // Generate PR summary
      const prSummary = generatePRSummary({
        rpkVersion,
        commandCount: result.commandCount,
        filesGenerated: result.filesGenerated,
        filesSkipped: result.filesSkipped,
        diffData,
        validationResult,
        outputDir: finalOutputDir
      })

      // Print PR summary if requested or if there are issues
      if (printSummary || validationResult.summary.totalErrors > 0) {
        console.log('\n' + '='.repeat(60))
        console.log('PR SUMMARY (for GitHub Actions)')
        console.log('='.repeat(60))
        console.log(prSummary)
        console.log('='.repeat(60) + '\n')
      }

      return {
        success: true,
        commandCount: result.commandCount,
        filesGenerated: result.filesGenerated,
        filesSkipped: result.filesSkipped,
        outputDir: finalOutputDir,
        rpkVersion,
        diffData,
        validationResult,
        prSummary
      }
    }

    // Step 1: Get source code
    if (effectiveRef) {
      // Clone/checkout from ref
      if (fromSource) {
        // Use provided local path, checkout the ref
        sourcePath = prepareSourceFromRef(effectiveRef, fromSource)
      } else {
        // Sparse clone from GitHub
        console.log(`Cloning redpanda source at ref: ${effectiveRef}`)
        sourcePath = prepareSourceFromRef(effectiveRef, null)
      }
    } else if (fromSource) {
      // Use local source without checkout
      sourcePath = path.resolve(fromSource)
      if (!fs.existsSync(path.join(sourcePath, 'cmd', 'rpk', 'main.go'))) {
        throw new Error(
          `Invalid source path: ${sourcePath}\n` +
          'Expected to find cmd/rpk/main.go. Point to src/go/rpk directory.'
        )
      }
    } else {
      // Auto-detect local source
      const localSource = findLocalSource()
      if (localSource) {
        console.log(`Auto-detected local source: ${localSource}`)
        sourcePath = localSource
      }
    }

    // Require source
    if (!sourcePath) {
      throw new Error(
        'No source specified.\n\n' +
        'USAGE: npx doc-tools generate rpk-docs --ref <version>\n\n' +
        'Examples:\n' +
        '  --ref dev         Document latest development branch\n' +
        '  --ref v26.2.0     Document specific release\n' +
        '  --ref main        Document main branch\n\n' +
        'Requirements:\n' +
        '  - Git for cloning source\n' +
        '  - Go (optional) for building rpk natively'
      )
    }

    rpkVersion = effectiveRef || 'local'

    // Step 2: Detect Linux-only commands
    // Try dynamic detection first (compare Linux vs Darwin builds)
    // Fall back to static lists for plugins and known commands
    console.log('\nAnalyzing source for Linux-only commands...')
    let linuxOnlyCommands = detectLinuxOnlyFromSource(sourcePath)

    // Step 3: Build rpk and get command tree
    // Use Docker if available (for running rpk plugins in Linux)
    // Otherwise build natively with Go
    const dockerCheck = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 5000 })
    const goCheck = spawnSync('go', ['version'], { encoding: 'utf8', timeout: 5000 })
    const canBuildNative = goCheck.status === 0
    const canBuildLinux = dockerCheck.status === 0

    // Dynamic detection: if we can build on both platforms, compare the trees
    if (canBuildLinux && canBuildNative && os.platform() !== 'linux') {
      console.log('\nBuilding rpk on both Linux and Darwin for dynamic platform detection...')

      try {
        // Build on Linux (in container) - has all commands
        console.log('Building rpk in Linux container...')
        const linuxTree = fetchRpkTreeFromLinuxSource(sourcePath)

        // Build natively (on Darwin) - missing Linux-only commands
        console.log('Building rpk natively for comparison...')
        const darwinTree = fetchRpkTreeFromSource(sourcePath)

        // Compare trees to find Linux-only commands
        const dynamicLinuxOnly = detectLinuxOnlyByComparison(linuxTree, darwinTree)
        if (dynamicLinuxOnly.size > 0) {
          console.log(`Dynamic detection found ${dynamicLinuxOnly.size} Linux-only command(s):`)
          for (const cmd of dynamicLinuxOnly) {
            console.log(`  - ${cmd}`)
            linuxOnlyCommands.add(cmd)
          }
        }

        // Use the Linux tree (has all commands)
        tree = linuxTree
      } catch (dockerErr) {
        // Docker build failed (e.g., Go version mismatch) - fall back to native build
        console.warn(`\n⚠ Docker build failed: ${dockerErr.message}`)
        console.log('Falling back to native Go build...')
        console.log('Note: Linux-only commands will be detected via source scanning only.\n')
        tree = fetchRpkTreeFromSource(sourcePath)
      }
    } else if (canBuildLinux) {
      console.log('\nBuilding rpk in Linux container...')
      try {
        tree = fetchRpkTreeFromLinuxSource(sourcePath)
      } catch (dockerErr) {
        if (canBuildNative) {
          console.warn(`\n⚠ Docker build failed: ${dockerErr.message}`)
          console.log('Falling back to native Go build...\n')
          tree = fetchRpkTreeFromSource(sourcePath)
        } else {
          throw dockerErr
        }
      }
    } else if (canBuildNative) {
      console.log('\nBuilding rpk natively with Go...')
      tree = fetchRpkTreeFromSource(sourcePath)
    } else {
      throw new Error(
        'Neither Docker nor Go available to build rpk.\n' +
        'Install Docker or Go to continue.'
      )
    }

    // Step 4: Add platform markers based on detection
    // This includes both source scanning results and static fallback lists
    tree = addPlatformMarkersFromSource(tree, linuxOnlyCommands)

    console.log(`\nrpk version: ${rpkVersion}`)
    console.log(`Total commands in tree: ${countCommands(tree)}`)

    // Detect plugins from tree
    const plugins = detectPlugins(tree)
    console.log(`Detected plugins: ${plugins.join(', ') || 'none'}`)

    // Note: Plugin versions not available when building from source
    const pluginVersions = {}

    // Step 5: Scan source for deprecated/hidden commands
    let deprecatedCommands = {}
    if (sourcePath && fs.existsSync(sourcePath)) {
      console.log('\nScanning source for deprecated/hidden commands...')
      const { scanDeprecatedCommands } = require('./scan-deprecated-commands.js')

      try {
        deprecatedCommands = scanDeprecatedCommands(sourcePath)
        if (Object.keys(deprecatedCommands).length > 0) {
          console.log(`Found ${Object.keys(deprecatedCommands).length} deprecated/hidden command(s)`)
        }
      } catch (err) {
        console.warn(`Warning: Failed to scan for deprecated commands: ${err.message}`)
      }
    }

    // Load and validate overrides
    const defaultOverridesPath = path.join(dataDir, 'rpk-overrides.json')
    const effectiveOverridesPath = overridesPath || defaultOverridesPath
    const overridesData = loadOverrides(effectiveOverridesPath, tree, { strict: false })

    if (overridesData) {
      console.log(`Loaded overrides from ${effectiveOverridesPath}`)
    }

    // Create enhanced tree with overrides applied (for canonical JSON)
    let enhancedTree = tree
    if (overridesData) {
      const resolvedOverrides = resolveReferences(overridesData, overridesData)
      enhancedTree = applyOverridesToTree(tree, resolvedOverrides, '')
      console.log('Applied overrides to command tree for versioned JSON')
    }

    // Build augmented data structure with enhanced tree
    const augmentedData = {
      rpk_version: rpkVersion,
      plugin_versions: pluginVersions,
      generated_at: new Date().toISOString(),
      tree: enhancedTree,
      // Also include raw tree for diffing purposes (used by diff generation)
      raw_tree: tree,
      // Deprecated commands metadata (from source code scanning)
      deprecated_commands: deprecatedCommands
    }

    // Save versioned JSON
    saveVersionedJson(augmentedData, rpkVersion, dataDir)

    // Generate diff if requested or if previous version exists
    let diffData = null
    if (diffVersion) {
      const oldData = loadVersionedJson(diffVersion, dataDir)
      if (oldData) {
        // Use raw_tree for diffing (falls back to tree for backward compatibility)
        const oldTree = oldData.raw_tree || oldData.tree
        diffData = generateRpkDiff(oldTree, tree, {
          oldVersion: diffVersion,
          newVersion: rpkVersion
        })

        // Save diff
        const diffFileName = `rpk-diff-${diffVersion}_to_${rpkVersion}.json`
        const diffPath = path.join(dataDir, diffFileName)
        fs.writeFileSync(diffPath, JSON.stringify(diffData, null, 2), 'utf8')
        console.log(`Saved diff to ${diffPath}`)

        // Print diff report
        printDiffReport(diffData)

        // Update overrides with introducedInVersion for new commands
        if (diffData.details.newCommands.length > 0 && effectiveOverridesPath) {
          updateOverridesWithIntroducedVersions(diffData, effectiveOverridesPath, rpkVersion)
        }

        // Update what's-new file if requested
        if (whatsNewPath) {
          updateWhatsNewFile(diffData, whatsNewPath, rpkVersion)
        }
      } else {
        console.warn(`Warning: Could not load previous version ${diffVersion} for diff`)
      }
    }

    // Generate AsciiDoc documentation
    console.log(`\nGenerating AsciiDoc files to ${finalOutputDir}...`)

    const result = await generateRpkDocs({
      tree,
      overrides: overridesData,
      outputDir: finalOutputDir,
      cloudSecretDir: finalCloudSecretDir,
      rpkVersion,
      pluginVersions,
      draftMissing,
      preservationsDir: preserveFrom
    })

    console.log(`\nGeneration complete!`)
    console.log(`  - Commands documented: ${result.commandCount}`)
    console.log(`  - Files generated: ${result.filesGenerated}`)
    console.log(`  - Output directory: ${finalOutputDir}`)

    // Run validation on generated output
    const validationResult = runValidation(finalOutputDir, {
      showInfo
    })

    // Generate PR summary
    const prSummary = generatePRSummary({
      rpkVersion,
      commandCount: result.commandCount,
      filesGenerated: result.filesGenerated,
      filesSkipped: result.filesSkipped,
      diffData,
      validationResult,
      outputDir: finalOutputDir
    })

    // Print PR summary if requested or if there are issues
    if (printSummary || validationResult.summary.totalErrors > 0) {
      console.log('\n' + '='.repeat(60))
      console.log('PR SUMMARY (for GitHub Actions)')
      console.log('='.repeat(60))
      console.log(prSummary)
      console.log('='.repeat(60) + '\n')
    }

    return {
      success: true,
      rpkVersion,
      pluginVersions,
      commandCount: result.commandCount,
      filesGenerated: result.filesGenerated,
      filesSkipped: result.filesSkipped,
      outputDir: finalOutputDir,
      dataDir,
      diffData,
      sourcePath,
      validationResult,
      prSummary
    }
  } catch (err) {
    console.error(`Error: ${err.message}`)
    throw err
  }
}

/**
 * Generate a markdown summary for GitHub PR descriptions
 * Includes generation stats, validation results, and diff summary
 * @param {Object} options - Summary options
 * @returns {string} Markdown formatted summary
 */
function generatePRSummary(options) {
  const {
    rpkVersion,
    commandCount,
    filesGenerated,
    filesSkipped = 0,
    diffData,
    validationResult,
    outputDir
  } = options

  const lines = []

  // Header
  lines.push('## rpk Documentation Generation Summary')
  lines.push('')

  // Version info
  lines.push(`**Version:** ${rpkVersion}`)
  lines.push('')

  // Generation stats
  lines.push('### Generation Statistics')
  lines.push('')
  lines.push(`| Metric | Count |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Commands documented | ${commandCount} |`)
  lines.push(`| Files generated | ${filesGenerated} |`)
  if (filesSkipped > 0) {
    lines.push(`| Files skipped (excluded) | ${filesSkipped} |`)
  }
  lines.push('')

  // Diff summary (if available)
  if (diffData && diffData.summary) {
    lines.push('### Changes from Previous Version')
    lines.push('')

    const { newCommands, removedCommands, newFlags, removedFlags, changedDescriptions } = diffData.summary

    if (newCommands === 0 && removedCommands === 0 && newFlags === 0 && removedFlags === 0) {
      lines.push('No command or flag changes detected.')
    } else {
      lines.push(`| Change Type | Count |`)
      lines.push(`|-------------|-------|`)
      if (newCommands > 0) lines.push(`| New commands | ${newCommands} |`)
      if (removedCommands > 0) lines.push(`| Removed commands | ${removedCommands} |`)
      if (newFlags > 0) lines.push(`| New flags | ${newFlags} |`)
      if (removedFlags > 0) lines.push(`| Removed flags | ${removedFlags} |`)
      if (changedDescriptions > 0) lines.push(`| Changed descriptions | ${changedDescriptions} |`)
    }
    lines.push('')

    // List new commands
    if (diffData.details?.newCommands?.length > 0) {
      lines.push('<details>')
      lines.push('<summary>New Commands</summary>')
      lines.push('')
      for (const cmd of diffData.details.newCommands.slice(0, 20)) {
        lines.push(`- \`${cmd.path}\``)
      }
      if (diffData.details.newCommands.length > 20) {
        lines.push(`- ... and ${diffData.details.newCommands.length - 20} more`)
      }
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }

    // List removed commands
    if (diffData.details?.removedCommands?.length > 0) {
      lines.push('<details>')
      lines.push('<summary>Removed Commands</summary>')
      lines.push('')
      for (const cmd of diffData.details.removedCommands.slice(0, 20)) {
        lines.push(`- \`${cmd.path}\``)
      }
      if (diffData.details.removedCommands.length > 20) {
        lines.push(`- ... and ${diffData.details.removedCommands.length - 20} more`)
      }
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }
  }

  // Validation results
  if (validationResult) {
    lines.push('### Validation Report')
    lines.push('')

    const { summary } = validationResult

    if (summary.totalErrors === 0 && summary.totalWarnings === 0) {
      lines.push('✅ All files passed validation.')
    } else {
      // Summary table
      lines.push(`| Severity | Count |`)
      lines.push(`|----------|-------|`)
      if (summary.totalErrors > 0) {
        lines.push(`| ❌ Errors | ${summary.totalErrors} |`)
      }
      if (summary.totalWarnings > 0) {
        lines.push(`| ⚠️ Warnings | ${summary.totalWarnings} |`)
      }
      if (summary.totalInfo > 0) {
        lines.push(`| ℹ️ Info | ${summary.totalInfo} |`)
      }
      lines.push('')

      // Issues by rule
      if (Object.keys(summary.byRule).length > 0) {
        lines.push('<details>')
        lines.push('<summary>Issues by Rule</summary>')
        lines.push('')
        for (const [rule, counts] of Object.entries(summary.byRule)) {
          const parts = []
          if (counts.errors > 0) parts.push(`${counts.errors} errors`)
          if (counts.warnings > 0) parts.push(`${counts.warnings} warnings`)
          if (counts.info > 0) parts.push(`${counts.info} info`)
          lines.push(`- **${rule}**: ${parts.join(', ')}`)
        }
        lines.push('')
        lines.push('</details>')
        lines.push('')
      }

      // File details (errors only, limited)
      const filesWithErrors = validationResult.results.filter(r => r.errors.length > 0)
      if (filesWithErrors.length > 0) {
        lines.push('<details>')
        lines.push('<summary>Files with Errors</summary>')
        lines.push('')
        for (const result of filesWithErrors.slice(0, 10)) {
          lines.push(`**${result.file}**:`)
          for (const err of result.errors) {
            lines.push(`- Line ${err.line}: ${err.message}`)
          }
          lines.push('')
        }
        if (filesWithErrors.length > 10) {
          lines.push(`... and ${filesWithErrors.length - 10} more files with errors`)
          lines.push('')
        }
        lines.push('</details>')
        lines.push('')
      }
    }
  }

  // Footer
  lines.push('---')
  lines.push(`*Generated by rpk-docs automation*`)

  return lines.join('\n')
}

/**
 * Run validation on generated output and return structured results
 * @param {string} outputDir - Directory containing generated docs
 * @param {Object} options - Validation options
 * @returns {Object} Validation results with summary
 */
function runValidation(outputDir, options = {}) {
  console.log('\nRunning validation on generated docs...')

  const validationOutput = validateDirectory(outputDir, {
    showInfo: options.showInfo || false
  })

  // Print console report
  console.log(formatResults(validationOutput, { showInfo: options.showInfo }))

  return validationOutput
}

module.exports = {
  handleRpkDocsGeneration,
  fetchRpkTreeFromSource,
  fetchRpkTreeFromLinuxSource,
  prepareSourceFromRef,
  detectLinuxOnlyFromSource,
  addPlatformMarkersFromSource,
  detectPlugins,
  isPlugin,
  findLocalSource,
  loadOverrides,
  saveVersionedJson,
  loadVersionedJson,
  getLatestDocumentedVersion,
  countCommands,
  getPlatformDescription,
  getCurrentPlatform,
  updateOverridesWithIntroducedVersions,
  KNOWN_PLUGINS,
  extractCommandPaths,
  detectLinuxOnlyByComparison,
  PLATFORMS,
  COMMON_SOURCE_LOCATIONS,
  generatePRSummary,
  runValidation
}
