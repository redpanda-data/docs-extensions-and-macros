'use strict'

const { spawnSync } = require('child_process')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const os = require('os')
const semver = require('semver')
const { findRepoRoot } = require('../../cli-utils/doc-tools-utils')
const { generateRpkDocs, applyOverridesToTree, resolveReferences, shouldExcludeCommand, shouldUsePartialDir, derivePartialsDir } = require('./generate-rpk-docs')
const { detectLinuxOnlyFromSource, warnIfDetectionLooksBroken } = require('./detect-platform-commands')
const { generateRpkDiff, printDiffReport, generateWhatsNewSection, flattenToMap } = require('./report-delta')
const { loadAndValidateOverrides, ValidationResult } = require('./validate-overrides')
const { validateDirectory, formatResults } = require('./validate-output')

/**
 * Known rpk plugins that are managed separately (have install/uninstall commands)
 */
const KNOWN_PLUGINS = ['ai', 'check', 'connect', 'k8s', 'oxla']

/**
 * Plugins whose docs can be refreshed individually with --plugin.
 * oxla is excluded: it is a "Coming Soon" stub with no installable binary.
 */
const REFRESHABLE_PLUGINS = ['ai', 'check', 'connect', 'k8s']

/**
 * Per-plugin install flags that pin a version (rpk <plugin> install <flag> <version>).
 * k8s uses the generic flag name; the others embed the plugin name.
 */
const PLUGIN_INSTALL_VERSION_FLAGS = {
  ai: '--ai-version',
  check: '--check-version',
  connect: '--connect-version',
  k8s: '--plugin-version'
}

/**
 * Manifest slugs at https://rpk-plugins.redpanda.com/<slug>/manifest.json
 * where the slug differs from the rpk command name.
 */
const PLUGIN_MANIFEST_SLUGS = { ai: 'rpai' }

const PLUGIN_MANIFEST_HOST = 'https://rpk-plugins.redpanda.com'

/**
 * Subcommands compiled into rpk itself for managed plugins. A plugin node
 * whose children are only these never actually installed.
 */
const PLUGIN_SHIM_SUBCOMMANDS = new Set(['install', 'uninstall', 'upgrade'])

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

  // streaming-enterprise is private, so a token is required. Auth travels
  // via a credential helper registered through GIT_CONFIG_* environment
  // variables, never as a git -c argument, so the token cannot appear in
  // this process's argv (visible to anything that can list processes) and
  // never embedded in the remote URL, so no token is persisted in the
  // clone's .git/config either.
  const { getGitHubToken } = require('../../cli-utils/github-token')
  const token = getGitHubToken()
  if (!token) {
    throw new Error(
      'redpanda-data/streaming-enterprise is a private repository.\n' +
      'Set GH_TOKEN, GITHUB_TOKEN, or REDPANDA_GITHUB_TOKEN so the clone can authenticate.'
    )
  }
  const gitEnv = {
    ...process.env,
    RPK_SOURCE_CLONE_TOKEN: token,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '!f() { echo "username=x-access-token"; echo "password=$RPK_SOURCE_CLONE_TOKEN"; }; f'
  }

  console.log(`Sparse-cloning streaming-enterprise repo (ref: ${sourceRef}) to ${repoDir}...`)

  // Clone with sparse checkout
  const cloneResult = spawnSync('git', [
    'clone',
    '--depth', '1',
    '--filter=blob:none',
    '--sparse',
    '--branch', sourceRef,
    'https://github.com/redpanda-data/streaming-enterprise.git',
    repoDir
  ], {
    encoding: 'utf8',
    timeout: 120000,
    env: gitEnv,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  if (cloneResult.status !== 0) {
    throw new Error(
      `Failed to clone streaming-enterprise repo with ref '${sourceRef}'.\n` +
      `Make sure the branch or tag exists.\n` +
      `Error: ${cloneResult.stderr}`
    )
  }

  // Set sparse checkout to only get rpk. With --filter=blob:none, the blobs
  // for src/go/rpk were not fetched by the clone above and are pulled lazily
  // here, so this invocation needs the same credential helper.
  const sparseResult = spawnSync('git', ['sparse-checkout', 'set', 'src/go/rpk'], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 60000,
    env: gitEnv
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
      'To use --from-source, you need a local checkout of the streaming-enterprise repository (private).\n' +
      'Clone it with: git clone https://github.com/redpanda-data/streaming-enterprise.git\n' +
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
 * @returns {Object} { tree, failedPlugins } — the parsed JSON tree plus the
 *   names of managed plugins whose install failed this run. Callers pass
 *   failedPlugins to generateRpkDocs as protectedPlugins so those plugins'
 *   existing pages and nav entries are preserved instead of treated as stale.
 */
function fetchRpkTreeFromLinuxSource(sourcePath, pluginPins = {}) {
  // Resolve to absolute path
  const absoluteSourcePath = path.resolve(sourcePath)

  // Verify the source path exists
  if (!fs.existsSync(absoluteSourcePath)) {
    throw new Error(
      `rpk source directory not found: ${absoluteSourcePath}\n` +
      'Expected a checkout of the streaming-enterprise repository (private).\n' +
      'Clone it with: git clone https://github.com/redpanda-data/streaming-enterprise.git'
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
  // Pin the Go image to the exact version required by go.mod to prevent
  // "go.mod requires go >= X.Y.Z (running X.Y.Z-1)" build failures when
  // golang:1 resolves to a patch release behind the requirement.
  const requiredGoVersion = getRequiredGoVersion(absoluteSourcePath)
  const goImage = requiredGoVersion ? `golang:${requiredGoVersion}` : 'golang:1'

  console.log('Starting build container...')
  const createResult = spawnSync('docker', [
    'run', '-d', '--rm',
    '-v', `${absoluteSourcePath}:/rpk-source:ro`,
    '-w', '/rpk-source',
    goImage,
    'sh', '-c', 'sleep 600' // Keep container alive for 10 minutes
  ], {
    encoding: 'utf8',
    timeout: 60000
  })

  let activeResult = createResult
  let activeImage = goImage

  if (createResult.status !== 0) {
    const stderr = createResult.stderr || ''
    if (stderr.includes('Cannot connect to the Docker daemon')) {
      throw new Error(
        'Docker daemon is not running.\n' +
        'Start Docker Desktop or the Docker service and try again.'
      )
    }

    // If the pinned tag couldn't be pulled (not yet on Docker Hub for a new
    // patch release), retry with golang:1 before giving up.
    const isPullFailure = requiredGoVersion && (
      stderr.includes('manifest unknown') ||
      stderr.includes('pull access denied') ||
      stderr.includes('not found') ||
      stderr.includes('repository does not exist')
    )
    if (isPullFailure) {
      console.warn(`⚠ Could not pull ${goImage}: ${stderr.trim()}`)
      console.log('Retrying with golang:1...')
      activeImage = 'golang:1'
      activeResult = spawnSync('docker', [
        'run', '-d', '--rm',
        '-v', `${absoluteSourcePath}:/rpk-source:ro`,
        '-w', '/rpk-source',
        activeImage,
        'sh', '-c', 'sleep 600'
      ], {
        encoding: 'utf8',
        timeout: 60000
      })
    }

    if (activeResult.status !== 0) {
      throw new Error(
        `Failed to create build container: ${activeResult.stderr || stderr}\n` +
        'Make sure Docker is running and has sufficient resources.'
      )
    }
  }

  const containerId = activeResult.stdout.trim()
  console.log(`Build container started: ${containerId.substring(0, 12)}`)

  try {
    // Step 1: Build rpk binary
    console.log('Building rpk binary...')
    // Module downloads from proxy.golang.org fail transiently (stream
    // INTERNAL_ERROR), especially on a cold module cache. Retry: the second
    // attempt reuses whatever the first already downloaded.
    let buildResult
    let binaryExists = false
    for (let attempt = 1; attempt <= 4; attempt++) {
      buildResult = spawnSync('docker', [
        'exec', containerId,
        'go', 'build', '-o', '/tmp/rpk', './cmd/rpk'
      ], {
        encoding: 'utf8',
        timeout: 300000 // 5 minutes per attempt
      })

      if (buildResult.status === 0) {
        // Trust but verify: docker exec has been observed returning zero for
        // a build that produced nothing, and everything downstream execs
        // /tmp/rpk. Treat a phantom success as a failed attempt.
        const binCheck = spawnSync('docker', [
          'exec', containerId, 'test', '-x', '/tmp/rpk'
        ], { encoding: 'utf8', timeout: 15000 })
        if (binCheck.status === 0) {
          binaryExists = true
          break
        }
        if (attempt < 4) {
          console.warn(`  Build attempt ${attempt} reported success but produced no binary; retrying...`)
          continue
        }
      } else if (attempt < 4) {
        const firstError = (buildResult.stderr || buildResult.signal || 'unknown error')
          .toString().trim().split('\n').slice(-1)[0]
        console.warn(`  Build attempt ${attempt} failed (${firstError}); retrying...`)
      }
    }

    if (!binaryExists) {
      const stderr = buildResult.stderr || ''
      throw new Error(
        `Failed to build rpk in Linux container: ${stderr || 'build produced no binary'}\n` +
        'Common causes:\n' +
        '  1. Source code is out of date - run: git pull origin dev\n' +
        '  2. Go module issues - the container will download dependencies automatically\n' +
        '  3. Insufficient Docker resources - check Docker Desktop settings'
      )
    }
    console.log('  ✓ rpk binary built')

    // Step 2: Install plugins
    console.log('Installing plugins for complete command coverage...')
    const failedPlugins = []
    for (const plugin of KNOWN_PLUGINS) {
      // A pin installs a specific version instead of the manifest's latest.
      // This is how pre-GA plugins (no version promoted to latest) get into a
      // full regeneration at all — without a pin their install resolves
      // nothing and their commands are absent from the tree.
      const pin = pluginPins[plugin]
      const versionFlag = PLUGIN_INSTALL_VERSION_FLAGS[plugin]
      const runInstall = (pinned) => {
        const args = ['exec', containerId, '/tmp/rpk', plugin, 'install']
        if (pinned && pin && versionFlag) {
          args.push(versionFlag, pin)
        }
        return spawnSync('docker', args, { encoding: 'utf8', timeout: 120000 })
      }

      console.log(`  Installing plugin: ${plugin}${pin ? ` (pinned to ${pin})` : ''}...`)
      let installResult = runInstall(true)
      if (installResult.status !== 0 && pin) {
        const output = `${installResult.stderr || ''}${installResult.stdout || ''}`
        if (output.includes('unknown flag') || output.includes('is not valid')) {
          console.warn(`    rpk rejected the version pin for ${plugin}; retrying without the pin (installs latest)`)
          installResult = runInstall(false)
        }
      }

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
          // A failed install is non-fatal: generation continues, but this
          // plugin's commands will be absent from the tree. Expected for
          // beta-only plugins with no version pin — `rpk <plugin> install`
          // finds no `latest` release because the plugin publisher's
          // stableVersionRe only promotes pure X.Y.Z versions, so their
          // commands only appear at GA unless the run pins a version.
          // See redpanda-data/docs#1801.
          console.warn(`    ✗ Failed to install ${plugin}: ${stderr || stdout}`)
          failedPlugins.push(plugin)
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

    let tree
    try {
      tree = JSON.parse(result.stdout)
    } catch (err) {
      throw new Error(
        `Failed to parse rpk tree JSON from Linux source build: ${err.message}\n` +
        'The build and --print-tree succeeded but the output was not valid JSON.\n' +
        'This may indicate a version mismatch or corrupted source.'
      )
    }

    // Step 4: Fill in flags for plugin subtrees. Their commands come from
    // --help-autocomplete, which carries no flag data, so without this every
    // plugin command page renders an empty flags section.
    console.log('Extracting flags from plugin command help output...')
    for (const plugin of KNOWN_PLUGINS) {
      const node = (tree.commands || []).find(c => c.name === plugin)
      if (!node || !pluginNodeHasRealCommands(node)) continue
      const enriched = enrichPluginTreeWithFlags(node, (argPath) => {
        const helpResult = spawnSync('docker', [
          'exec', containerId, '/tmp/rpk', ...argPath, '--help'
        ], { encoding: 'utf8', timeout: 30000 })
        return helpResult.status === 0 ? helpResult.stdout : null
      })
      if (enriched > 0) {
        console.log(`  ${plugin}: extracted flags for ${enriched} command(s)`)
      }
    }

    return { tree, failedPlugins }
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

  // Collect every tree path actually marked Linux-only so the persisted
  // linux_only_commands list is fully expanded (each descendant listed),
  // matching what dynamic Linux-vs-Darwin tree comparison produces.
  const markedPaths = new Set()

  const markCommands = (commands, parentPath = 'rpk') => {
    if (!commands) return commands
    return commands.map(cmd => {
      const fullPath = `${parentPath} ${cmd.name}`
      const linuxOnly = isLinuxOnly(fullPath)
      if (linuxOnly) markedPaths.add(fullPath)
      const platforms = linuxOnly
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

  const markedCommands = markCommands(tree.commands)

  return {
    ...tree,
    platforms: [PLATFORMS.LINUX, PLATFORMS.DARWIN],
    // Union of detected paths and marked tree paths: keeps detected roots
    // even when the tree was built on a platform where they don't exist
    linux_only_commands: [...new Set([...linuxOnlyCommands, ...markedPaths])].sort(),
    commands: markedCommands
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

  return { overrides, validation }
}

/**
 * Merge deprecation metadata for commands still present in the tree into the
 * overrides file, so their pages render deprecation banners without manual
 * curation. Hidden deprecated commands are excluded: they are absent from
 * --print-tree, have no pages, and would only produce unknown-path warnings.
 * Commands whose overrides already carry a `deprecated` value are left alone.
 * @param {Object} deprecatedCommands - Map from scan-deprecated-commands.js
 * @param {Object} tree - Current command tree
 * @param {string} overridesPath - Path to overrides JSON file
 */
function mergeVisibleDeprecationsIntoOverrides(deprecatedCommands, tree, overridesPath) {
  const entries = Object.entries(deprecatedCommands || {})
  if (entries.length === 0 || !overridesPath || !fs.existsSync(overridesPath)) {
    return
  }

  const treePaths = new Set(flattenToMap(tree).keys())

  let overrides
  try {
    overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
  } catch (err) {
    console.warn(`Warning: Could not parse overrides file for deprecation merge: ${err.message}`)
    return
  }
  if (!overrides.commands) {
    overrides.commands = {}
  }

  let annotated = 0
  for (const [cmdPath, info] of entries) {
    if (!treePaths.has(cmdPath)) continue
    const existing = overrides.commands[cmdPath] || {}
    if (existing.deprecated !== undefined) continue
    overrides.commands[cmdPath] = {
      ...existing,
      deprecated: true,
      ...(info.deprecatedMessage && !existing.deprecatedMessage
        ? { deprecatedMessage: info.deprecatedMessage } : {}),
      ...(info.replacement && !existing.replacement
        ? { replacement: info.replacement } : {})
    }
    annotated++
  }

  if (annotated > 0) {
    fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 2), 'utf8')
    console.log(`Annotated ${annotated} visible deprecated command(s) in ${overridesPath}`)
  }
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
 * @param {Object} [pluginVersions] - Plugin versions keyed by rpk command
 *   name. Commands under a plugin subtree are stamped with the plugin's own
 *   version (the page note renders "introduced in <plugin> version X"), not
 *   the rpk version, because plugins release on their own cadence.
 */
function updateOverridesWithIntroducedVersions(diffData, overridesPath, version, pluginVersions = {}, options = {}) {
  const hasNewCommands = diffData.details.newCommands && diffData.details.newCommands.length > 0
  const hasNewFlags = diffData.details.newFlags && diffData.details.newFlags.length > 0

  if (!hasNewCommands && !hasNewFlags) {
    return
  }

  // "rpk connect lint" -> pluginVersions.connect, else the rpk version
  const versionFor = (cmdPath) => {
    const topLevel = cmdPath.split(' ')[1]
    return pluginVersions[topLevel] || version
  }

  // Plugin-owned entries are only stamped when the caller vouches that the
  // baseline is manifest-adjacent to this run's plugin version (see
  // isPluginStampAttributable). "New relative to the snapshot" is not "new
  // in this release" when the snapshot skipped releases. Callers that omit
  // attributablePlugins keep legacy stamp-everything behavior.
  const attributable = options.attributablePlugins
    ? new Set(options.attributablePlugins)
    : null
  const skippedByPlugin = new Map()
  const stampable = (cmdPath) => {
    const topLevel = cmdPath.split(' ')[1]
    if (!KNOWN_PLUGINS.includes(topLevel) || !attributable) return true
    if (attributable.has(topLevel)) return true
    skippedByPlugin.set(topLevel, (skippedByPlugin.get(topLevel) || 0) + 1)
    return false
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
      if (!stampable(cmdPath)) continue
      if (!overrides.commands[cmdPath]) {
        overrides.commands[cmdPath] = {}
      }
      // Only set if not already set (preserve manual overrides)
      if (!overrides.commands[cmdPath].introducedInVersion) {
        overrides.commands[cmdPath].introducedInVersion = versionFor(cmdPath)
        commandsUpdated++
      }
    }
  }

  // Update new flags
  if (hasNewFlags) {
    for (const newFlag of diffData.details.newFlags) {
      const cmdPath = newFlag.commandPath
      const flagName = newFlag.flagName
      if (!stampable(cmdPath)) continue

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
        overrides.commands[cmdPath].flags[flagName].introducedInVersion = versionFor(cmdPath)
        flagsUpdated++
      }
    }
  }

  for (const [plugin, count] of skippedByPlugin) {
    console.warn(
      `\u26a0 Skipped stamping introducedInVersion for ${count} new '${plugin}' entr${count === 1 ? 'y' : 'ies'}: ` +
      `the baseline snapshot's ${plugin} version is not the release immediately before ` +
      `${pluginVersions[plugin] || version} in the plugin manifest, so the introduction ` +
      'version cannot be attributed automatically. Attribute manually against released binaries.'
    )
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
/**
 * Build a predicate that reports whether a command path renders as a
 * linkable page (not excluded and not routed to partials by the overrides).
 * @param {Object|null} overridesData - Loaded overrides
 * @returns {Function} (commandPath) => boolean
 */
/**
 * Build a predicate that reports whether a command path has subcommands,
 * which determines its page location (groups render into their own dir).
 * @param {Object} tree - Full command tree
 * @returns {Function} (commandPath) => boolean
 */
function makeSubcommandPredicate(tree) {
  const commandMap = flattenToMap(tree)
  return (commandPath) => {
    const node = commandMap.get(commandPath)
    return Boolean(node && (node.commands || []).length > 0)
  }
}

function makeLinkablePredicate(overridesData) {
  const resolved = overridesData ? resolveReferences(overridesData, overridesData) : null
  return (commandPath) => {
    // rpk cloud and rpk security secret render to partials (single-sourced
    // into cloud docs), so this repo has no linkable pages for them
    if (commandPath.startsWith('rpk cloud') || commandPath.startsWith('rpk security secret')) {
      return false
    }
    if (!resolved) return true
    return !shouldExcludeCommand(resolved, commandPath) &&
      !shouldUsePartialDir(resolved, commandPath)
  }
}

// Command subtrees whose changes never belong in the Self-Managed What's
// new. rpk ai's documentation home is adp-docs, and the ADP release notes
// already cover its CLI changes per release. The plugin-release receiver
// workflow excludes ai from --update-whats-new for exactly this reason; the
// full-regeneration path must agree, or a full run floods the Self-Managed
// release notes with rpk ai entries (a rename release alone produces 21 new
// plus 21 removed bullets).
const WHATS_NEW_EXCLUDED_SUBTREES = ['rpk ai']

/**
 * Return a copy of diffData without entries under the excluded subtrees.
 * Only the published What's-new block filters; diff reports and PR
 * summaries keep the full picture.
 * @param {Object} diffData - Diff from generateRpkDiff
 * @param {string[]} [excluded] - Command-path prefixes to drop
 * @returns {Object} Filtered copy
 */
function filterDiffForWhatsNew(diffData, excluded = WHATS_NEW_EXCLUDED_SUBTREES) {
  const outside = (cmdPath) => !excluded.some(prefix =>
    cmdPath === prefix || (typeof cmdPath === 'string' && cmdPath.startsWith(prefix + ' ')))
  const details = diffData.details || {}
  const filteredDetails = { ...details }
  for (const key of ['newCommands', 'newlyDeprecatedCommands', 'removedCommands', 'descriptionChanges']) {
    if (Array.isArray(details[key])) filteredDetails[key] = details[key].filter(e => outside(e.path))
  }
  for (const key of ['newFlags', 'removedFlags', 'changedDefaults', 'changedFlagTypes', 'changedFlagRequirements', 'changedFlagDescriptions']) {
    if (Array.isArray(details[key])) filteredDetails[key] = details[key].filter(e => outside(e.commandPath))
  }
  return { ...diffData, details: filteredDetails }
}

function updateWhatsNewFile(diffData, whatsNewPath, version, options = {}) {
  // Each block opens with a "=== <version>" heading so accumulated blocks
  // (successive RCs, multiple plugin releases) never collide on section ids
  const sectionHeading = options.sectionHeading || '== Redpanda CLI'
  const whatsNewContent = generateWhatsNewSection(diffData, {
    version,
    blockLabel: version,
    ...options
  })

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

  // Version-scoped marker block: re-runs for the same version replace their
  // own block, and later versions (for example, successive RCs in a beta
  // cycle, or plugin releases) append their own blocks inside the existing
  // Redpanda CLI section instead of being dropped. Writers can edit or
  // remove blocks freely; the automation only ever touches content between
  // its own markers for the same version label.
  const startMarker = `// AUTOGEN-RPK-CHANGES ${version} START`
  const endMarker = `// AUTOGEN-RPK-CHANGES ${version} END`
  const sectionBody = whatsNewContent.replace(/^== [^\n]*\n+/, '')
  const block = `${startMarker}\n${sectionBody.trimEnd()}\n${endMarker}`
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  if (existingContent.includes(startMarker)) {
    // Replace this version's existing block (idempotent re-runs)
    const blockRe = new RegExp(`${escapeRe(startMarker)}[\\s\\S]*?${escapeRe(endMarker)}`)
    const updatedContent = existingContent.replace(blockRe, block)
    fs.writeFileSync(whatsNewPath, updatedContent, 'utf8')
    console.log(`Refreshed existing ${version} block in what's-new file: ${whatsNewPath}`)
    return
  }

  const headingMatch = existingContent.match(new RegExp(`^${escapeRe(sectionHeading)}[^\\n]*$`, 'm'))
  if (headingMatch) {
    // Append this version's block at the end of the existing section, just
    // before the next level-2 heading (or end of file)
    const sectionStart = headingMatch.index + headingMatch[0].length
    const rest = existingContent.slice(sectionStart)
    const nextHeading = rest.search(/\n== /)
    const insertAt = nextHeading === -1 ? existingContent.length : sectionStart + nextHeading
    const before = existingContent.slice(0, insertAt).replace(/\s*$/, '\n\n')
    const after = existingContent.slice(insertAt).replace(/^\n*/, '\n')
    fs.writeFileSync(whatsNewPath, `${before}${block}${after}`, 'utf8')
    console.log(`Appended ${version} block to the "${sectionHeading}" section in: ${whatsNewPath}`)
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

  const fullSection = `${sectionHeading}\n\n${block}\n`

  let updatedContent
  if (insertIndex > 0) {
    // Insert before the matched section
    updatedContent = existingContent.slice(0, insertIndex) +
      fullSection + '\n' +
      existingContent.slice(insertIndex)
  } else {
    // Append at the end
    updatedContent = existingContent.replace(/\s*$/, '\n\n') + fullSection
  }

  fs.writeFileSync(whatsNewPath, updatedContent, 'utf8')
  console.log(`Created "${sectionHeading}" section in what's-new file: ${whatsNewPath}`)
}

/**
 * Build an rpk binary natively from Go source.
 * @param {string} sourcePath - Path to rpk Go source directory (src/go/rpk)
 * @param {string} outPath - Where to write the binary
 * @returns {string} Path to the built binary
 */
function buildRpkBinary(sourcePath, outPath) {
  const goCheck = spawnSync('go', ['version'], { encoding: 'utf8', timeout: 5000 })
  if (goCheck.status !== 0) {
    throw new Error(
      'Go is required to build rpk from source but was not found.\n' +
      'Install Go from https://go.dev/ and ensure it\'s in your PATH.'
    )
  }

  const installedGoVersion = parseGoVersion(goCheck.stdout)
  const requiredGoVersion = getRequiredGoVersion(sourcePath)
  if (installedGoVersion && requiredGoVersion &&
      !checkGoVersionSufficient(installedGoVersion, requiredGoVersion)) {
    throw new Error(
      `Go version mismatch: installed ${installedGoVersion}, required >= ${requiredGoVersion}\n` +
      `The rpk source (go.mod) requires Go ${requiredGoVersion} or newer.`
    )
  }

  console.log(`Building rpk from source at ${sourcePath}...`)
  const buildResult = spawnSync('go', ['build', '-o', outPath, './cmd/rpk'], {
    cwd: sourcePath,
    encoding: 'utf8',
    timeout: 300000
  })

  if (buildResult.status !== 0) {
    throw new Error(`Failed to build rpk from source: ${buildResult.stderr}`)
  }

  return outPath
}

/**
 * Download an official rpk release binary for the current platform.
 * @param {string} tag - Release tag (e.g., v26.1.12)
 * @param {string} destDir - Directory to download and extract into
 * @returns {string|null} Path to the extracted binary, or null if the
 *   release asset is unavailable (caller falls back to a source build)
 */
function downloadRpkRelease(tag, destDir) {
  const osName = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
  const archName = { arm64: 'arm64', x64: 'amd64' }[process.arch]
  if (!osName || !archName) {
    console.warn(`No rpk release asset for platform ${process.platform}/${process.arch}`)
    return null
  }

  // Releases now publish to streaming-enterprise (private), not the public
  // redpanda-data/redpanda. This function already has a fallback (the
  // caller builds from source instead), so a missing token warns and
  // returns null here rather than throwing the way the clone-only paths do.
  const { getGitHubToken } = require('../../cli-utils/github-token')
  const token = getGitHubToken()
  if (!token) {
    console.warn('No GitHub token available for the private streaming-enterprise release download; falling back to a source build.')
    return null
  }

  const assetName = `rpk-${osName}-${archName}.zip`
  const checksumAsset = `rpk_${tag.replace(/^v/, '')}_checksums.txt`
  const zipPath = path.join(destDir, assetName)
  const authHeader = `Authorization: token ${token}`

  // streaming-enterprise is private, so the release's browser download URL
  // (releases/download/<tag>/<asset>) 404s even with a valid token: it
  // redirects to a signed storage URL that requires an authenticated
  // browser session, not a bearer token. Only the API's per-asset url
  // (asset.url, not asset.browser_download_url) accepts this Authorization
  // header, so resolve assets through the release-by-tag API first.
  const releaseResult = spawnSync('curl', [
    '-fsSL', '--retry', '5', '--retry-all-errors',
    '--connect-timeout', '30', '--max-time', '60',
    '-H', authHeader,
    '-H', 'Accept: application/vnd.github+json',
    `https://api.github.com/repos/redpanda-data/streaming-enterprise/releases/tags/${tag}`
  ], { encoding: 'utf8', timeout: 90000 })

  if (releaseResult.status !== 0) {
    console.warn(`Could not look up release ${tag} from streaming-enterprise (draft or missing release)`)
    return null
  }

  let release
  try {
    release = JSON.parse(releaseResult.stdout)
  } catch {
    console.warn(`Could not parse release metadata for ${tag}`)
    return null
  }

  const assetUrl = (release.assets || []).find(a => a.name === assetName)?.url
  if (!assetUrl) {
    console.warn(`Release ${tag} has no asset named ${assetName} (draft or missing release asset)`)
    return null
  }
  const checksumUrl = (release.assets || []).find(a => a.name === checksumAsset)?.url

  console.log(`Downloading ${assetName} for ${tag}...`)
  // Accept: application/octet-stream is required on the API asset url to
  // receive the binary itself instead of its JSON metadata.
  const curlResult = spawnSync('curl', [
    '-fL', '--retry', '5', '--retry-all-errors',
    '--connect-timeout', '30', '--max-time', '300',
    '-H', authHeader,
    '-H', 'Accept: application/octet-stream',
    '-o', zipPath, assetUrl
  ], { encoding: 'utf8', timeout: 360000 })

  if (curlResult.status !== 0) {
    console.warn(`Could not download rpk release for ${tag} (draft or missing release asset)`)
    return null
  }

  // Verify against the release checksum file when it exists
  const checksumPath = path.join(destDir, checksumAsset)
  const checksumResult = checksumUrl ? spawnSync('curl', [
    '-fsSL', '--retry', '3', '--connect-timeout', '30', '--max-time', '60',
    '-H', authHeader,
    '-H', 'Accept: application/octet-stream',
    '-o', checksumPath, checksumUrl
  ], { encoding: 'utf8', timeout: 90000 }) : { status: 1 }

  if (checksumResult.status === 0) {
    const expectedLine = fs.readFileSync(checksumPath, 'utf8')
      .split('\n')
      .find(line => line.trim().endsWith(assetName))
    if (expectedLine) {
      const expected = expectedLine.trim().split(/\s+/)[0]
      const actual = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
      if (expected !== actual) {
        throw new Error(
          `Checksum mismatch for ${assetName} (${tag}):\n` +
          `  expected ${expected}\n  actual   ${actual}`
        )
      }
      console.log('Checksum verified')
    }
  } else {
    console.warn('No checksum file published for this release; skipping verification')
  }

  const unzipResult = spawnSync('unzip', ['-o', zipPath, '-d', destDir], {
    encoding: 'utf8',
    timeout: 60000
  })
  if (unzipResult.status !== 0) {
    throw new Error(`Failed to extract ${assetName}: ${unzipResult.stderr}`)
  }

  const binPath = path.join(destDir, 'rpk')
  if (!fs.existsSync(binPath)) {
    throw new Error(`Extracted archive did not contain an rpk binary: ${zipPath}`)
  }
  fs.chmodSync(binPath, 0o755)
  return binPath
}

/**
 * Get an rpk binary matching the given version.
 * Prefers the official release download (published stable releases only;
 * RC releases are drafts, so their assets are not publicly downloadable).
 * Falls back to building from source at the tag.
 * @param {string} rpkVersion - Version tag from the snapshot (e.g., v26.1.12, v26.2.1-rc2)
 * @param {Object} [options]
 * @param {string} [options.rpkBin] - Existing binary to use, skipping download/build
 * @returns {string} Path to an rpk binary
 */
function acquireRpkBinary(rpkVersion, options = {}) {
  const { rpkBin } = options

  if (rpkBin) {
    const binPath = path.resolve(rpkBin)
    if (!fs.existsSync(binPath)) {
      throw new Error(`rpk binary not found: ${binPath}`)
    }
    console.log(`Using provided rpk binary: ${binPath}`)
    return binPath
  }

  const tag = rpkVersion.startsWith('v') ? rpkVersion : `v${rpkVersion}`
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-bin-'))

  // Only published (non-draft) releases have downloadable assets
  if (/^v\d+\.\d+\.\d+$/.test(tag)) {
    const downloaded = downloadRpkRelease(tag, workDir)
    if (downloaded) {
      return downloaded
    }
    console.log('Falling back to building rpk from source...')
  } else {
    console.log(`No published release binary for ${tag}; building from source...`)
  }

  if (!/^v\d+\.\d+\.\d+(-rc\d+)?$/.test(tag) && tag !== 'vdev') {
    throw new Error(
      `Cannot acquire an rpk binary for version '${rpkVersion}'.\n` +
      'The snapshot\'s rpk_version is not a release tag. ' +
      'Pass --rpk-bin <path> to use a local rpk binary instead.'
    )
  }

  const sourceRef = tag === 'vdev' ? 'dev' : tag
  const sourcePath = prepareSourceFromRef(sourceRef, null)
  try {
    return buildRpkBinary(sourcePath, path.join(workDir, 'rpk'))
  } catch (nativeErr) {
    // Local Go older than go.mod requires is common on laptops; the --ref
    // path already tolerates this by building in a container, so do the same
    // here when Docker is available
    const dockerCheck = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 10000 })
    if (dockerCheck.status !== 0) {
      throw new Error(
        `${nativeErr.message}\n` +
        'Docker is not available for a container build either. ' +
        'Update Go, start Docker, or pass --rpk-bin <path> to use an existing rpk binary.'
      )
    }
    console.warn(`Native build failed (${nativeErr.message.split('\n')[0]}); building in a container...`)
    const goVersion = getRequiredGoVersion(sourcePath)
    const goImage = goVersion ? `golang:${goVersion}` : 'golang:1'
    // Cross-compile for the HOST platform: the container reports
    // GOOS=linux, and a linux binary dies silently when executed on the
    // macOS host that needs it for plugin installs (review finding on the
    // 5.3.0 train). rpk builds with CGO disabled, so cross-compilation
    // from the linux container is safe.
    // Only macOS and Linux hosts are supported: mapping anything else to
    // linux would hand a Windows host an unrunnable binary, the exact bug
    // class the cross-compile fixes (review finding on #238).
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error(
        `${nativeErr.message}\n` +
        `Container fallback does not support host platform "${process.platform}". ` +
        'Update Go, or pass --rpk-bin <path> to use an existing rpk binary.'
      )
    }
    const hostGoos = process.platform === 'darwin' ? 'darwin' : 'linux'
    const hostGoarch = process.arch === 'arm64' ? 'arm64' : 'amd64'
    const buildResult = spawnSync('docker', [
      'run', '--rm',
      '-e', `GOOS=${hostGoos}`,
      '-e', `GOARCH=${hostGoarch}`,
      '-e', 'CGO_ENABLED=0',
      '-v', `${path.resolve(sourcePath)}:/rpk-source:ro`,
      '-v', `${workDir}:/out`,
      '-w', '/rpk-source',
      goImage,
      'go', 'build', '-o', '/out/rpk', './cmd/rpk'
    ], { encoding: 'utf8', timeout: 600000 })
    const binPath = path.join(workDir, 'rpk')
    if (buildResult.status !== 0 || !fs.existsSync(binPath)) {
      throw new Error(`Container build failed: ${buildResult.stderr || 'no binary produced'}`)
    }
    return binPath
  }
}

/**
 * Look up the latest published version of a plugin from its manifest.
 * @param {string} plugin - rpk command name (ai, connect, k8s, check)
 * @returns {string|null} Latest version, or null if unavailable
 */
function fetchLatestPluginVersion(plugin) {
  const slug = PLUGIN_MANIFEST_SLUGS[plugin] || plugin
  const result = spawnSync('curl', [
    '-fsSL', '--retry', '3', '--connect-timeout', '15', '--max-time', '30',
    `${PLUGIN_MANIFEST_HOST}/${slug}/manifest.json`
  ], { encoding: 'utf8', timeout: 60000 })

  if (result.status !== 0) {
    console.warn(`Could not fetch plugin manifest for ${plugin} (slug: ${slug})`)
    return null
  }

  try {
    const manifest = JSON.parse(result.stdout)
    const latest = (manifest.archives || []).find(a => a.is_latest)
    return latest ? latest.version : null
  } catch (err) {
    console.warn(`Could not parse plugin manifest for ${plugin}: ${err.message}`)
    return null
  }
}

/**
 * Fetch the ordered list of published versions for a plugin from its
 * manifest. Cached per plugin for the process lifetime.
 * @param {string} plugin - rpk command name (ai, connect, k8s, check)
 * @returns {string[]|null} Versions in manifest (release) order, or null
 */
const pluginManifestVersionsCache = new Map()
function fetchPluginManifestVersions(plugin) {
  if (pluginManifestVersionsCache.has(plugin)) {
    return pluginManifestVersionsCache.get(plugin)
  }
  const slug = PLUGIN_MANIFEST_SLUGS[plugin] || plugin
  const result = spawnSync('curl', [
    '-fsSL', '--retry', '3', '--connect-timeout', '15', '--max-time', '30',
    `${PLUGIN_MANIFEST_HOST}/${slug}/manifest.json`
  ], { encoding: 'utf8', timeout: 60000 })
  let versions = null
  if (result.status === 0) {
    try {
      versions = (JSON.parse(result.stdout).archives || []).map(a => a.version)
    } catch (err) {
      console.warn(`Could not parse plugin manifest for ${plugin}: ${err.message}`)
    }
  } else {
    console.warn(`Could not fetch plugin manifest for ${plugin} (slug: ${slug})`)
  }
  pluginManifestVersionsCache.set(plugin, versions)
  return versions
}

/**
 * Decide whether new commands under a plugin can truthfully be attributed
 * to newVersion: only when the baseline snapshot recorded the plugin
 * version AND that version is the release immediately before newVersion in
 * the plugin's manifest. Any gap means a "new" command may have shipped in
 * an intermediate release, so a stamp would fabricate history (30 rpk ai
 * commands were once labeled 0.2.32 when they shipped in 0.2.26/0.2.28).
 * @param {string} plugin - rpk command name
 * @param {string|undefined} oldVersion - Plugin version recorded in the
 *   baseline snapshot's plugin_versions, if any
 * @param {string} newVersion - Plugin version in this run
 * @returns {boolean}
 */
function isPluginStampAttributable(plugin, oldVersion, newVersion) {
  if (!oldVersion || !newVersion) return false
  if (oldVersion === newVersion) return true
  const versions = fetchPluginManifestVersions(plugin)
  if (!versions) return false
  const oldIdx = versions.indexOf(oldVersion)
  const newIdx = versions.indexOf(newVersion)
  return oldIdx !== -1 && newIdx === oldIdx + 1
}

/**
 * Compute the set of plugins whose new commands may be stamped this run.
 * @param {Object} oldPluginVersions - plugin_versions from the baseline snapshot
 * @param {Object} newPluginVersions - plugin_versions for this run
 * @returns {Set<string>}
 */
function attributablePluginSet(oldPluginVersions = {}, newPluginVersions = {}) {
  const attributable = new Set()
  for (const plugin of Object.keys(newPluginVersions)) {
    if (isPluginStampAttributable(plugin, oldPluginVersions[plugin], newPluginVersions[plugin])) {
      attributable.add(plugin)
    }
  }
  return attributable
}

/**
 * Check whether a plugin node contains real plugin commands, as opposed to
 * only the install/uninstall/upgrade shim compiled into rpk itself.
 * @param {Object} node - Top-level command node for the plugin
 * @returns {boolean}
 */
function pluginNodeHasRealCommands(node) {
  return (node.commands || []).some(c => !PLUGIN_SHIM_SUBCOMMANDS.has(c.name))
}

/**
 * Replace a plugin's top-level node in a command tree.
 * Replace-only: throws if the plugin is not already present, so a refresh
 * can never introduce a command that the snapshot's rpk version lacks.
 * @param {Object} tree - Full command tree (root node)
 * @param {string} plugin - rpk command name
 * @param {Object} freshNode - Replacement node
 * @returns {Object} New tree with the node replaced
 */
function splicePluginNode(tree, plugin, freshNode) {
  const commands = tree.commands || []
  if (!commands.some(c => c.name === plugin)) {
    throw new Error(`Cannot splice plugin '${plugin}': not present in the base tree`)
  }
  return {
    ...tree,
    commands: commands.map(c => (c.name === plugin ? freshNode : c))
  }
}

/**
 * Carry a snapshot's recorded Linux-only command list onto a working tree.
 * The list comes from scanning Go build tags in the rpk source, which
 * from-json runs (including --plugin refreshes) never see, so it can only be
 * inherited from the existing snapshot. Without it the refreshed snapshot
 * would lose its platform markers for every future from-json run.
 * @param {Object} tree - Working command tree (root node)
 * @param {Object} [fallbackTree] - Tree to inherit linux_only_commands from
 *   when the working tree does not carry the field itself
 * @returns {Object} Tree that carries linux_only_commands when available
 */
function preserveLinuxOnlyCommands(tree, fallbackTree) {
  if (!tree || tree.linux_only_commands) return tree
  const inherited = fallbackTree && fallbackTree.linux_only_commands
  if (!inherited) return tree
  return { ...tree, linux_only_commands: [...inherited] }
}

/**
 * Parse the local "Flags:" section of cobra --help output into flag objects
 * matching the shape rpk --print-tree emits for compiled-in commands.
 * The "Global Flags:" section is ignored: rpk-core globals are documented by
 * the shared global-flags table, and plugin-global flags are captured from
 * the plugin root command's own Flags section.
 * @param {string} helpText - Output of `rpk <command> --help`
 * @returns {Array<Object>} Flags: { name, shorthand?, type, description, default? }
 */
function parseCobraFlags(helpText) {
  const lines = (helpText || '').split('\n')
  const start = lines.findIndex(l => /^Flags:\s*$/.test(l))
  if (start === -1) return []

  const flags = []
  let flagIndent = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\S/.test(line)) break // next section (Global Flags:, Use "...", ...)
    if (line.trim() === '') break

    const m = line.match(/^\s+(?:-(\w),\s+)?--([\w.-]+)(?:\s+(\S+))?\s{2,}(.*)$/)
    if (m) {
      const [, shorthand, name, valueType, desc] = m
      if (name === 'help') continue
      flagIndent = line.search(/\S/)
      const flag = {
        name,
        type: valueType || 'bool',
        description: desc.trim()
      }
      if (shorthand) flag.shorthand = shorthand
      const def = flag.description.match(/\s*\(default (.+)\)$/)
      if (def) {
        flag.default = def[1]
        flag.description = flag.description.slice(0, def.index).trim()
      }
      flags.push(flag)
    } else if (flags.length > 0 && flagIndent !== null && line.search(/\S/) > flagIndent) {
      // Wrapped description continuation: any line indented deeper than the
      // flag column that did not parse as a flag. Continuations can begin
      // with flag-looking tokens ("(alias: --x-ref)" wraps to "--x-ref)"),
      // so no dash guard — a genuine flag line always matches the regex
      // above first.
      const last = flags[flags.length - 1]
      last.description = `${last.description} ${line.trim()}`.trim()
      const def = last.description.match(/\s*\(default (.+)\)$/)
      if (def) {
        last.default = def[1]
        last.description = last.description.slice(0, def.index).trim()
      }
    }
  }
  return flags
}

/**
 * Parse the OPTIONS section of urfave/cli --help output (Redpanda Connect)
 * into the same flag shape as parseCobraFlags. Entries look like:
 *   --log.level value                     override the configured log level
 *   --set value, -s value [ --set value, -s value ]   set a field ...
 *   --chilled                             continue ... (default: false)
 * The GLOBAL OPTIONS section is skipped, matching the cobra handling.
 * @param {string} helpText - Output of `rpk <command> --help`
 * @returns {Array<Object>} Flags: { name, shorthand?, type, description, default? }
 */
function parseUrfaveFlags(helpText) {
  const lines = (helpText || '').split('\n')
  const start = lines.findIndex(l => /^OPTIONS:\s*$/.test(l))
  if (start === -1) return []

  const flags = []
  let urfaveIndent = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\S/.test(line)) break // next section (GLOBAL OPTIONS:, ...)
    if (line.trim() === '') break

    const m = line.match(/^\s{2,}(--\S[^\s]*(?:[^ ]| (?!\s))*)\s{2,}(.*)$/)
    if (m) {
      const [, spec, desc] = m
      const nameMatch = spec.match(/^--([\w.-]+)/)
      if (!nameMatch) continue
      const name = nameMatch[1]
      if (name === 'help') continue
      urfaveIndent = line.search(/\S/)

      const flag = { name, description: desc.trim() }
      const shorthandMatch = spec.match(/,\s+-(\w)\b/)
      if (shorthandMatch) flag.shorthand = shorthandMatch[1]

      const repeatable = spec.includes('[ --')
      const hasValue = new RegExp(`^--${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\S`).test(spec)
      flag.type = repeatable ? 'strings' : (hasValue ? 'string' : 'bool')

      const def = flag.description.match(/\s*\(default:\s*(.+?)\)$/)
      if (def) {
        flag.default = def[1]
        flag.description = flag.description.slice(0, def.index).trim()
      }
      flags.push(flag)
    } else if (flags.length > 0 && urfaveIndent !== null && line.search(/\S/) > urfaveIndent) {
      // Continuation lines may begin with flag-looking tokens; see the
      // cobra parser above for why there is no dash guard
      const last = flags[flags.length - 1]
      last.description = `${last.description} ${line.trim()}`.trim()
      const def = last.description.match(/\s*\(default:\s*(.+?)\)$/)
      if (def) {
        last.default = def[1]
        last.description = last.description.slice(0, def.index).trim()
      }
    }
  }
  return flags
}

/**
 * Parse flags from --help output regardless of CLI framework: cobra prints a
 * "Flags:" section (rpk ai, k8s, check), urfave/cli prints "OPTIONS:"
 * (Redpanda Connect).
 * @param {string} helpText
 * @returns {Array<Object>}
 */
function parseHelpFlags(helpText) {
  if (/^Flags:\s*$/m.test(helpText || '')) return parseCobraFlags(helpText)
  if (/^OPTIONS:\s*$/m.test(helpText || '')) return parseUrfaveFlags(helpText)
  return []
}

/**
 * Fill in flags for plugin subtree commands by running `--help` per command.
 * Plugin subcommand nodes come from the plugin's --help-autocomplete output,
 * which carries no flag information, so without this every plugin command
 * page renders with an empty flags section. Nodes that already have flags
 * (the install/uninstall/upgrade shim compiled into rpk) are left alone.
 * Help failures are non-fatal: the affected command keeps an empty list.
 * @param {Object} node - The plugin's top-level command node (mutated)
 * @param {Function} execHelp - (argPath: string[]) => string|null, returns
 *   the help text for `rpk <argPath...> --help`
 * @returns {number} Number of commands enriched
 */
function enrichPluginTreeWithFlags(node, execHelp) {
  let enriched = 0
  const walk = (cmd, argPath) => {
    if (!cmd.flags || cmd.flags.length === 0) {
      const helpText = execHelp(argPath)
      if (helpText) {
        const flags = parseHelpFlags(helpText)
        if (flags.length > 0) {
          cmd.flags = flags
          enriched++
        }
      }
    }
    for (const child of cmd.commands || []) {
      walk(child, [...argPath, child.name])
    }
  }
  walk(node, [node.name])
  return enriched
}

/**
 * Install a single plugin and capture its fresh command subtree.
 * Runs with an isolated HOME so the install never touches the caller's
 * rpk plugin state, and the caller's installed plugins never leak in.
 * @param {Object} params
 * @param {string} params.plugin - rpk command name (ai, connect, k8s, check)
 * @param {string} [params.pluginVersion] - Version to pin; defaults to latest
 * @param {string} params.rpkBinPath - rpk binary to run
 * @returns {Object} { node, version } - Fresh plugin node and the version recorded
 */
function fetchPluginSubtree({ plugin, pluginVersion, rpkBinPath }) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-plugin-home-'))
  const env = { ...process.env, HOME: tmpHome }

  const runInstall = (pinned) => {
    const args = [plugin, 'install']
    const versionFlag = PLUGIN_INSTALL_VERSION_FLAGS[plugin]
    if (pinned && pluginVersion && versionFlag) {
      args.push(versionFlag, pluginVersion)
    }
    console.log(`Installing plugin: rpk ${args.join(' ')}`)
    return spawnSync(rpkBinPath, args, { encoding: 'utf8', env, timeout: 300000 })
  }

  let pinApplied = Boolean(pluginVersion)
  let installResult = runInstall(true)
  if (installResult.status !== 0 && pluginVersion) {
    const output = `${installResult.stderr || ''}${installResult.stdout || ''}`
    // 'unknown flag': this rpk predates the pin flag.
    // 'is not valid': rpk's version validation rejected the pin (its regex
    // caps each segment at two digits, so connect versions like 4.102.0
    // fail). In both cases installing latest is the right recovery: the
    // dispatch fires right after a release, when latest IS the release.
    if (output.includes('unknown flag') || output.includes('is not valid')) {
      console.warn(
        `rpk rejected the version pin for '${plugin}' ` +
        `(${output.trim().split('\n')[0]}); retrying without the pin (installs latest)`
      )
      pinApplied = false
      installResult = runInstall(false)
    }
  }
  if (installResult.status !== 0) {
    throw new Error(
      `Failed to install plugin '${plugin}':\n` +
      `${installResult.stderr || installResult.stdout || 'no output'}`
    )
  }

  const treeResult = spawnSync(rpkBinPath, ['--print-tree'], {
    encoding: 'utf8',
    env,
    timeout: 120000,
    maxBuffer: 50 * 1024 * 1024
  })
  if (treeResult.status !== 0) {
    const stderr = treeResult.stderr || ''
    if (stderr.includes('unknown flag')) {
      throw new Error(
        'This rpk binary does not support --print-tree (requires rpk >= v26.2.0).\n' +
        'Pass --rpk-bin with a newer binary.'
      )
    }
    throw new Error(`Failed to run rpk --print-tree: ${stderr}`)
  }

  const freshTree = JSON.parse(treeResult.stdout)
  const node = (freshTree.commands || []).find(c => c.name === plugin)
  if (!node) {
    throw new Error(`Plugin '${plugin}' not found in rpk command tree after install`)
  }
  if (!pluginNodeHasRealCommands(node)) {
    throw new Error(
      `Plugin '${plugin}' installed but exposed no commands beyond the ` +
      'install/uninstall/upgrade shim.\n' +
      'The install likely resolved nothing. For pre-GA plugins (no promoted ' +
      'latest version in the manifest), a version pin is required: ' +
      `--plugin-version <version>`
    )
  }

  // Fill in per-command flags: autocomplete trees carry none, but the plugin
  // binary is installed, so each command's --help documents them
  console.log(`Extracting flags from ${plugin} command help output...`)
  const enriched = enrichPluginTreeWithFlags(node, (argPath) => {
    const helpResult = spawnSync(rpkBinPath, [...argPath, '--help'], {
      encoding: 'utf8',
      env,
      timeout: 30000
    })
    return helpResult.status === 0 ? helpResult.stdout : null
  })
  console.log(`  Extracted flags for ${enriched} command(s)`)

  // When the pin was applied, record it. When we fell back to latest (or no
  // pin was given), record what the manifest says latest is: that is what
  // actually installed.
  const version = pinApplied ? pluginVersion : fetchLatestPluginVersion(plugin)
  if (!version) {
    console.warn(
      `Could not determine the installed version of '${plugin}'; ` +
      'plugin_versions will not be updated for this run'
    )
  } else if (pluginVersion && version !== pluginVersion) {
    console.warn(
      `Requested ${plugin} ${pluginVersion} but installed latest (${version}) ` +
      'because rpk rejected the version pin'
    )
  }

  return { node, version }
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
    plugin, // Refresh a single plugin's subtree (requires fromJson)
    pluginVersion, // Version to pin for the plugin install (defaults to latest)
    pluginPins = {}, // Per-plugin version pins for full generation (pre-GA plugins)
    rpkBin, // Existing rpk binary to use for the plugin refresh
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

  for (const pinnedPlugin of Object.keys(pluginPins)) {
    if (!REFRESHABLE_PLUGINS.includes(pinnedPlugin)) {
      console.warn(
        `Warning: --plugin-pin for unknown plugin '${pinnedPlugin}' ` +
        `(known plugins: ${REFRESHABLE_PLUGINS.join(', ')}); the pin will have no effect`
      )
    }
  }

  const repoRoot = findRepoRoot()
  const dataDir = customDataDir || path.join(repoRoot, 'docs-data')
  const defaultOutputDir = path.join(repoRoot, 'modules', 'reference', 'pages', 'rpk')
  const finalOutputDir = outputDir || defaultOutputDir

  // Partials live relative to outputDir, not repoRoot: for the docs layout
  // (.../modules/reference/pages/rpk) that is .../modules/reference/partials,
  // and for an arbitrary --output-dir it is a partials dir beside the output.
  // derivePartialsDir owns that rule so each consumer does not re-derive it.
  const derivedPartialsDir = outputDir
    ? derivePartialsDir(finalOutputDir)
    : path.join(repoRoot, 'modules', 'reference', 'partials')
  const finalCloudSecretDir = cloudSecretDir || derivedPartialsDir

  // nav.adoc lives at modules/ROOT/nav.adoc relative to the repo root
  const navFile = path.join(repoRoot, 'modules', 'ROOT', 'nav.adoc')

  // Determine which version to document
  const version = effectiveRef || 'dev'
  console.log(`\nGenerating rpk documentation for version: ${version}`)

  let tree
  let rpkVersion
  let sourcePath
  // Managed plugins whose install failed this run. Passed to generateRpkDocs
  // as explicit protectedPlugins (merged there with auto-detection) so a
  // failed install never deletes or rewrites that plugin's existing docs.
  let failedPlugins = []

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
      // Inherit the Linux-only command list from whichever stored tree
      // carries it: it cannot be re-detected without the rpk source, and
      // both rendering and the re-saved snapshot below depend on it.
      tree = preserveLinuxOnlyCommands(tree, jsonData.tree || jsonData.raw_tree)
      rpkVersion = jsonData.rpk_version || 'local'

      if (!tree) {
        throw new Error('JSON file does not contain a valid command tree')
      }

      console.log(`Loaded tree with rpk version: ${rpkVersion}`)

      // Refresh a single plugin's subtree in the snapshot before rendering.
      // Plugins release on their own cadence, so their commands can change
      // without a new rpk release. Splice the fresh subtree into the full
      // tree and re-render everything: only the plugin's pages actually
      // change, and stale-file cleanup, nav rebuild, and override
      // validation all see a complete tree.
      let pluginVersions = jsonData.plugin_versions || {}
      let pluginDiffData = null
      if (plugin) {
        if (!REFRESHABLE_PLUGINS.includes(plugin)) {
          throw new Error(
            `Unknown plugin '${plugin}'. Supported plugins: ${REFRESHABLE_PLUGINS.join(', ')}\n` +
            'Use the rpk command name (for example "ai"), not the manifest slug ("rpai").'
          )
        }

        const oldNode = (tree.commands || []).find(c => c.name === plugin)
        if (!oldNode) {
          console.log(
            `rpk ${rpkVersion} has no '${plugin}' command; nothing to update. ` +
            'This is expected when the plugin only exists in a newer rpk line.'
          )
          return {
            success: true,
            skipped: true,
            reason: `plugin '${plugin}' not present in rpk ${rpkVersion}`,
            rpkVersion
          }
        }

        const rpkBinPath = acquireRpkBinary(rpkVersion, { rpkBin })
        const { node: rawNode, version: resolvedVersion } = fetchPluginSubtree({
          plugin,
          pluginVersion,
          rpkBinPath
        })

        // Reapply platform markers: the fresh subtree comes from a plain
        // --print-tree run, but every command in the snapshot's tree carries
        // a platforms field. Reuse the snapshot's recorded Linux-only list.
        const linuxOnly = new Set(tree.linux_only_commands || [])
        const freshNode = addPlatformMarkersFromSource(
          { commands: [rawNode] },
          linuxOnly
        ).commands[0]

        // Plugin-scoped diff for the PR summary: compare only the plugin's
        // subtree, old snapshot state vs fresh install
        pluginDiffData = generateRpkDiff(
          { ...tree, commands: [oldNode] },
          { ...tree, commands: [freshNode] },
          {
            oldVersion: pluginVersions[plugin] || 'previous snapshot',
            newVersion: resolvedVersion || 'latest'
          }
        )
        printDiffReport(pluginDiffData)

        tree = splicePluginNode(tree, plugin, freshNode)
        if (resolvedVersion) {
          pluginVersions = { ...pluginVersions, [plugin]: resolvedVersion }
        }
        console.log(
          `Spliced fresh '${plugin}' subtree` +
          (resolvedVersion ? ` (version ${resolvedVersion})` : '') +
          ` into snapshot for rpk ${rpkVersion}`
        )

        // Stamp new plugin commands and flags with the plugin's own version
        // so pages render "This command was introduced in <plugin> version X".
        // Runs before the overrides load below, so the stamps apply to this
        // run's rendering, not just the next one.
        if (resolvedVersion) {
          updateOverridesWithIntroducedVersions(
            pluginDiffData,
            overridesPath || path.join(dataDir, 'rpk-overrides.json'),
            resolvedVersion,
            { [plugin]: resolvedVersion },
            {
              attributablePlugins: isPluginStampAttributable(
                plugin, (jsonData.plugin_versions || {})[plugin], resolvedVersion
              ) ? [plugin] : []
            }
          )
        }

        if (diffVersion) {
          console.warn('Note: --diff is ignored in --plugin mode (the summary uses a plugin-scoped diff)')
        }

        // Plugin releases land in What's new too when requested: their
        // changes never arrive through a Redpanda release diff. Entries
        // render without xrefs because plugin subtrees may render as
        // partials with no linkable pages.
        if (whatsNewPath) {
          if (WHATS_NEW_EXCLUDED_SUBTREES.includes(`rpk ${plugin}`)) {
            console.log(`Skipping What's new for rpk ${plugin}: its documentation home covers CLI changes in its own release notes`)
          } else {
            const label = resolvedVersion
              ? `${plugin} plugin ${resolvedVersion}`
              : `${plugin} plugin`
            updateWhatsNewFile(pluginDiffData, whatsNewPath, label, { xrefs: false, sectionHeading: '== rpk plugins' })
          }
        }
      }

      // Skip to documentation generation (after the source building steps)
      // Load and validate overrides
      const defaultOverridesPath = path.join(dataDir, 'rpk-overrides.json')
      const effectiveOverridesPath = overridesPath || defaultOverridesPath

      // Stamp new commands and flags with introducedInVersion BEFORE the
      // overrides load so this run's pages render the labels. Without this,
      // a --from-json --diff run emits unlabeled pages and the labels only
      // appear on the next regeneration (the from-source path stamps before
      // rendering already).
      if (diffVersion && !plugin) {
        const oldDataForStamp = loadVersionedJson(diffVersion, dataDir)
        if (oldDataForStamp) {
          const stampDiff = generateRpkDiff(oldDataForStamp.raw_tree || oldDataForStamp.tree, tree, {
            oldVersion: diffVersion,
            newVersion: rpkVersion,
            oldDeprecatedCommands: oldDataForStamp.deprecated_commands || {},
            newDeprecatedCommands: jsonData.deprecated_commands || {}
          })
          if (stampDiff.details.newCommands.length > 0 || stampDiff.details.newFlags.length > 0) {
            updateOverridesWithIntroducedVersions(stampDiff, effectiveOverridesPath, rpkVersion, pluginVersions, {
              attributablePlugins: attributablePluginSet(oldDataForStamp.plugin_versions, pluginVersions)
            })
          }
        }
      }

      const { overrides: overridesData, validation: overrideValidation } = loadOverrides(effectiveOverridesPath, tree, { strict: false }) || {}

      if (overridesData) {
        console.log(`Loaded overrides from ${effectiveOverridesPath}`)
      }

      // Persist the merged snapshot so the refreshed plugin subtree and its
      // recorded version become the new baseline (mirrors the from-source
      // path's augmentedData structure)
      if (plugin) {
        // The Linux-only list can't be re-detected during a plugin refresh
        // (it comes from Go build-tag scanning of the rpk source), so make
        // sure the saved snapshot's trees still carry it before persisting.
        tree = preserveLinuxOnlyCommands(tree, jsonData.raw_tree || jsonData.tree)
        let enhancedTree = tree
        if (overridesData) {
          const resolvedOverrides = resolveReferences(overridesData, overridesData)
          enhancedTree = applyOverridesToTree(tree, resolvedOverrides, '')
        }
        jsonData.raw_tree = tree
        jsonData.tree = enhancedTree
        jsonData.plugin_versions = pluginVersions
        jsonData.generated_at = new Date().toISOString()
        saveVersionedJson(jsonData, rpkVersion, dataDir)
      }

      // Generate AsciiDoc documentation
      console.log(`\nGenerating AsciiDoc files to ${finalOutputDir}...`)

      const result = await generateRpkDocs({
        tree,
        overrides: overridesData,
        outputDir: finalOutputDir,
        cloudSecretDir: finalCloudSecretDir,
        envPartialDir: derivedPartialsDir,
        rpkVersion,
        pluginVersions,
        draftMissing,
        preservationsDir: preserveFrom,
        navFile,
        protectedPlugins: failedPlugins
      })

      console.log(`\nGeneration complete!`)
      console.log(`  - Commands documented: ${result.commandCount}`)
      console.log(`  - Files generated: ${result.filesGenerated}`)
      if (result.filesDeleted > 0) {
        console.log(`  - Stale files deleted: ${result.filesDeleted}`)
      }
      if (result.navUpdated) {
        console.log(`  - Nav entries updated: ${result.navEntriesGenerated}`)
      }
      console.log(`  - Output directory: ${finalOutputDir}`)

      // Run validation on generated output
      const validationResult = runValidation(finalOutputDir, {
        showInfo
      })

      // Generate diff if requested (rpk-version diff; not used in --plugin
      // mode, which produces its own plugin-scoped diff)
      let diffData = null
      if (diffVersion && !plugin) {
        const oldData = loadVersionedJson(diffVersion, dataDir)
        if (oldData) {
          // Use raw_tree for diffing (falls back to tree for backward compatibility)
          const oldTree = oldData.raw_tree || oldData.tree
          diffData = generateRpkDiff(oldTree, tree, {
            oldVersion: diffVersion,
            newVersion: rpkVersion,
            oldDeprecatedCommands: oldData.deprecated_commands || {},
            newDeprecatedCommands: jsonData.deprecated_commands || {}
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
            updateWhatsNewFile(filterDiffForWhatsNew(diffData), whatsNewPath, rpkVersion, { linkable: makeLinkablePredicate(overridesData), hasSubcommands: makeSubcommandPredicate(tree) })
          }
        } else {
          console.warn(`Warning: Could not load previous version ${diffVersion} for diff`)
        }
      }

      // Generate PR summary
      const prSummary = generatePRSummary({
        rpkVersion,
        plugin,
        pluginVersion: plugin ? pluginVersions[plugin] : undefined,
        commandCount: result.commandCount,
        filesGenerated: result.filesGenerated,
        filesSkipped: result.filesSkipped,
        diffData: plugin ? pluginDiffData : diffData,
        validationResult,
        overrideValidation,
        descriptionCoverage: computeDescriptionCoverage(tree, overridesData),
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
        plugin,
        pluginVersion: plugin ? pluginVersions[plugin] : undefined,
        diffData: plugin ? pluginDiffData : diffData,
        validationResult,
        prSummary
      }
    }

    if (plugin) {
      throw new Error(
        '--plugin requires --from-json <snapshot>.\n' +
        'A plugin refresh splices the fresh subtree into an existing committed snapshot.'
      )
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
    // Static detection (build-constraint analysis) works on any platform,
    // including Linux CI runners. Dynamic detection (comparing Linux vs
    // Darwin builds) supplements it below when the host can run both.
    console.log('\nAnalyzing source for Linux-only commands...')
    let linuxOnlyCommands = detectLinuxOnlyFromSource(sourcePath)
    if (linuxOnlyCommands.size > 0) {
      console.log(`Static detection found ${linuxOnlyCommands.size} Linux-only command path(s):`)
      for (const cmd of [...linuxOnlyCommands].sort()) {
        console.log(`  - ${cmd}`)
      }
    }

    // Step 3: Build rpk and get command tree
    // Use Docker if available (for running rpk plugins in Linux)
    // Otherwise build natively with Go
    const dockerCheck = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 5000 })
    const goCheck = spawnSync('go', ['version'], { encoding: 'utf8', timeout: 5000 })
    const canBuildNative = goCheck.status === 0
    const canBuildLinux = dockerCheck.status === 0

    // Dynamic detection: if we can build on both platforms, compare the trees.
    // Only possible on non-Linux hosts: a Linux runner can cross-compile a
    // darwin rpk but cannot execute it to get its command tree, so Linux CI
    // relies on the static detection above.
    // RPK_DOCS_SKIP_DYNAMIC_DETECTION=1 forces the static-only path (useful
    // for testing what a Linux CI runner would produce).
    const skipDynamicDetection = ['1', 'true'].includes(
      String(process.env.RPK_DOCS_SKIP_DYNAMIC_DETECTION || '').toLowerCase()
    )
    if (skipDynamicDetection) {
      console.log('\nDynamic platform detection disabled via RPK_DOCS_SKIP_DYNAMIC_DETECTION')
    }
    if (canBuildLinux && canBuildNative && os.platform() !== 'linux' && !skipDynamicDetection) {
      console.log('\nBuilding rpk on both Linux and Darwin for dynamic platform detection...')

      try {
        // Build on Linux (in container) - has all commands
        console.log('Building rpk in Linux container...')
        const { tree: linuxTree, failedPlugins: linuxFailedPlugins } = fetchRpkTreeFromLinuxSource(sourcePath, pluginPins)

        // Build natively (on Darwin) for comparison. The Linux tree is
        // authoritative, so a comparison-build failure (for example, local
        // Go older than go.mod requires) only skips dynamic platform
        // detection - it must not discard the Linux tree.
        let darwinTree = null
        try {
          console.log('Building rpk natively for comparison...')
          darwinTree = fetchRpkTreeFromSource(sourcePath)
        } catch (nativeErr) {
          console.warn(`⚠ Native comparison build failed: ${nativeErr.message}`)
          console.log('Skipping dynamic platform detection; using source scanning only.')
        }

        if (darwinTree) {
          // Compare trees to find Linux-only commands
          const dynamicLinuxOnly = detectLinuxOnlyByComparison(linuxTree, darwinTree)
          if (dynamicLinuxOnly.size > 0) {
            console.log(`Dynamic detection found ${dynamicLinuxOnly.size} Linux-only command(s):`)
            for (const cmd of dynamicLinuxOnly) {
              console.log(`  - ${cmd}`)
              linuxOnlyCommands.add(cmd)
            }
          }
        }

        // Use the Linux tree (has all commands)
        tree = linuxTree
        failedPlugins = linuxFailedPlugins
      } catch (dockerErr) {
        // Docker build failed - fall back to native build
        console.warn(`\n⚠ Docker build failed: ${dockerErr.message}`)
        console.log('Falling back to native Go build...')
        console.log('Note: Linux-only commands will be detected via source scanning only.\n')
        tree = fetchRpkTreeFromSource(sourcePath)
      }
    } else if (canBuildLinux) {
      console.log('\nBuilding rpk in Linux container...')
      try {
        ({ tree, failedPlugins } = fetchRpkTreeFromLinuxSource(sourcePath, pluginPins))
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

    // Tripwire: an empty combined detection result while the source tree
    // demonstrably contains Linux-gated files means the scan is broken and
    // Linux-only pages are about to be published as cross-platform
    // (see redpanda-data/docs#1831).
    warnIfDetectionLooksBroken(sourcePath, linuxOnlyCommands)

    // Step 4: Add platform markers based on detection
    // This includes both source scanning results and static fallback lists
    tree = addPlatformMarkersFromSource(tree, linuxOnlyCommands)

    console.log(`\nrpk version: ${rpkVersion}`)
    console.log(`Total commands in tree: ${countCommands(tree)}`)

    // Detect plugins from tree
    const plugins = detectPlugins(tree)
    console.log(`Detected plugins: ${plugins.join(', ') || 'none'}`)

    // Record the version of each plugin that actually installed during the
    // build (`rpk <plugin> install` resolves the manifest's latest, so the
    // manifest lookup reflects what the tree contains). Shim-only plugins
    // (failed installs) are skipped: their subtree carries no plugin commands.
    const pluginVersions = {}
    for (const pluginName of REFRESHABLE_PLUGINS) {
      const node = (tree.commands || []).find(c => c.name === pluginName)
      if (node && pluginNodeHasRealCommands(node)) {
        const installedVersion = pluginPins[pluginName] || fetchLatestPluginVersion(pluginName)
        if (installedVersion) {
          pluginVersions[pluginName] = installedVersion
        }
      }
    }
    if (Object.keys(pluginVersions).length > 0) {
      console.log(`Plugin versions: ${JSON.stringify(pluginVersions)}`)
    }

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

    // Annotate deprecated commands that are still visible in the tree so
    // their pages render deprecation banners without manual curation. Runs
    // before the overrides load so the annotations apply to this run.
    mergeVisibleDeprecationsIntoOverrides(deprecatedCommands, tree, effectiveOverridesPath)

    const { overrides: overridesData, validation: overrideValidation } = loadOverrides(effectiveOverridesPath, tree, { strict: false }) || {}

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
          newVersion: rpkVersion,
          oldDeprecatedCommands: oldData.deprecated_commands || {},
          newDeprecatedCommands: deprecatedCommands
        })

        // Save diff
        const diffFileName = `rpk-diff-${diffVersion}_to_${rpkVersion}.json`
        const diffPath = path.join(dataDir, diffFileName)
        fs.writeFileSync(diffPath, JSON.stringify(diffData, null, 2), 'utf8')
        console.log(`Saved diff to ${diffPath}`)

        // Print diff report
        printDiffReport(diffData)

        // Update overrides with introducedInVersion for new commands. Plugin
        // commands get the plugin's own version (plugins release on their own
        // cadence, so the rpk version would be wrong and the page note would
        // render "introduced in <plugin> version <rpk version>").
        if ((diffData.details.newCommands.length > 0 || diffData.details.newFlags.length > 0) && effectiveOverridesPath) {
          updateOverridesWithIntroducedVersions(diffData, effectiveOverridesPath, rpkVersion, pluginVersions, {
            attributablePlugins: attributablePluginSet(oldData.plugin_versions, pluginVersions)
          })
        }

        // Update what's-new file if requested
        if (whatsNewPath) {
          updateWhatsNewFile(filterDiffForWhatsNew(diffData), whatsNewPath, rpkVersion, { linkable: makeLinkablePredicate(overridesData), hasSubcommands: makeSubcommandPredicate(tree) })
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
      envPartialDir: derivedPartialsDir,
      rpkVersion,
      pluginVersions,
      draftMissing,
      preservationsDir: preserveFrom,
      navFile,
      protectedPlugins: failedPlugins
    })

    console.log(`\nGeneration complete!`)
    console.log(`  - Commands documented: ${result.commandCount}`)
    console.log(`  - Files generated: ${result.filesGenerated}`)
    if (result.filesDeleted > 0) {
      console.log(`  - Stale files deleted: ${result.filesDeleted}`)
    }
    if (result.navUpdated) {
      console.log(`  - Nav entries updated: ${result.navEntriesGenerated}`)
    }
    console.log(`  - Output directory: ${finalOutputDir}`)

    // Run validation on generated output
    const validationResult = runValidation(finalOutputDir, {
      showInfo
    })

    // Generate PR summary
    const prSummary = generatePRSummary({
      rpkVersion,
      overrideValidation,
      commandCount: result.commandCount,
      filesGenerated: result.filesGenerated,
      filesSkipped: result.filesSkipped,
      diffData,
      validationResult,
      descriptionCoverage: computeDescriptionCoverage(tree, overridesData),
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
/**
 * Find description overrides that replace substantially longer source help.
 * Curation is legitimate, but silent replacement is how stale or wrong
 * content survives regeneration, so every regen PR lists what is hidden.
 * @param {Object} tree - Raw command tree
 * @param {Object} overridesData - Parsed overrides
 * @returns {Array<{commandPath: string, overrideChars: number, sourceChars: number}>}
 */
function computeDescriptionCoverage(tree, overridesData) {
  if (!tree || !overridesData?.commands) return []
  const commandMap = flattenToMap(tree)
  const results = []
  for (const [cmdPath, override] of Object.entries(overridesData.commands)) {
    if (typeof override?.description !== 'string') continue
    const cmd = commandMap.get(cmdPath)
    if (!cmd || typeof cmd.description !== 'string') continue
    const sourceChars = cmd.description.trim().length
    // appendToDescription content still reaches the page, so count it
    const appended = typeof override.appendToDescription === 'string' ? override.appendToDescription.trim().length : 0
    const overrideChars = override.description.trim().length + appended
    if (sourceChars - overrideChars > 500) {
      results.push({ commandPath: cmdPath, overrideChars, sourceChars })
    }
  }
  return results.sort((a, b) => (b.sourceChars - b.overrideChars) - (a.sourceChars - a.overrideChars))
}

function generatePRSummary(options) {
  const {
    rpkVersion,
    plugin,
    pluginVersion,
    commandCount,
    filesGenerated,
    filesSkipped = 0,
    diffData,
    validationResult,
    overrideValidation,
    descriptionCoverage,
    outputDir
  } = options

  const lines = []

  // Header
  if (plugin) {
    lines.push(`## rpk ${plugin} Plugin Documentation Update`)
    lines.push('')
    if (pluginVersion) {
      lines.push(`**Plugin version:** ${pluginVersion}`)
    }
    lines.push(`**Base rpk snapshot:** ${rpkVersion}`)
    lines.push('')
    lines.push(
      `The \`rpk ${plugin}\` subtree was refreshed in the snapshot, then the ` +
      'full rpk reference was re-rendered from it as a converge. Pages outside ' +
      `\`rpk ${plugin}\` can carry template-level or consistency updates, and ` +
      'stale generated files are cleaned up, so the change list may be wider ' +
      'than the plugin itself.'
    )
    lines.push('')
  } else {
    lines.push('## rpk Documentation Generation Summary')
    lines.push('')

    // Version info
    lines.push(`**Version:** ${rpkVersion}`)
    lines.push('')
  }

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

    const {
      newCommands,
      removedCommands,
      newFlags,
      removedFlags,
      changedDefaults = 0,
      changedFlagTypes = 0,
      changedFlagRequirements = 0,
      changedFlagDescriptions = 0,
      descriptionChanges = 0,
      newlyDeprecatedCommands = 0
    } = diffData.summary

    const totalChanges = newCommands + removedCommands + newFlags + removedFlags +
      changedDefaults + changedFlagTypes + changedFlagRequirements +
      changedFlagDescriptions + descriptionChanges + newlyDeprecatedCommands

    if (totalChanges === 0) {
      lines.push('No command, flag, or default changes detected.')
    } else {
      lines.push(`| Change Type | Count |`)
      lines.push(`|-------------|-------|`)
      if (newCommands > 0) lines.push(`| New commands | ${newCommands} |`)
      if (newlyDeprecatedCommands > 0) lines.push(`| Deprecated commands | ${newlyDeprecatedCommands} |`)
      if (removedCommands > 0) lines.push(`| Removed commands | ${removedCommands} |`)
      if (newFlags > 0) lines.push(`| New flags | ${newFlags} |`)
      if (removedFlags > 0) lines.push(`| Removed flags | ${removedFlags} |`)
      if (changedDefaults > 0) lines.push(`| Changed flag defaults | ${changedDefaults} |`)
      if (changedFlagTypes > 0) lines.push(`| Changed flag types | ${changedFlagTypes} |`)
      if (changedFlagRequirements > 0) lines.push(`| Changed flag requirements | ${changedFlagRequirements} |`)
      if (changedFlagDescriptions > 0) lines.push(`| Changed flag descriptions | ${changedFlagDescriptions} |`)
      if (descriptionChanges > 0) lines.push(`| Changed command descriptions | ${descriptionChanges} |`)
      if (diffData.summary?.flagDataBackfilled > 0) lines.push(`| Flag docs backfilled (not new flags) | ${diffData.summary.flagDataBackfilled} commands |`)
    }
    lines.push('')

    // Collapsible list helper: itemized up to a cap, with an overflow note
    const pushDetailsList = (title, items, renderItem) => {
      if (!items || items.length === 0) return
      lines.push('<details>')
      lines.push(`<summary>${title}</summary>`)
      lines.push('')
      for (const item of items.slice(0, 30)) {
        lines.push(renderItem(item))
      }
      if (items.length > 30) {
        lines.push(`- ... and ${items.length - 30} more (see the diff JSON in docs-data/)`)
      }
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }

    const formatValue = (value) => {
      if (value === undefined) return 'unset'
      if (value === null) return 'null'
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
    }

    pushDetailsList('New Commands', diffData.details?.newCommands,
      cmd => `- \`${cmd.path}\``)
    pushDetailsList('Deprecated Commands', diffData.details?.newlyDeprecatedCommands,
      cmd => `- \`${cmd.path}\`${cmd.message ? ` — ${cmd.message}` : ''}${cmd.hidden ? ' _(hidden from help output)_' : ''}`)
    pushDetailsList('Removed Commands', diffData.details?.removedCommands,
      cmd => `- \`${cmd.path}\``)
    pushDetailsList('New Flags', diffData.details?.newFlags,
      flag => `- \`${flag.commandPath}\`: \`--${flag.flagName}\` (${flag.type})`)
    pushDetailsList('Removed Flags', diffData.details?.removedFlags,
      flag => `- \`${flag.commandPath}\`: \`--${flag.flagName}\``)
    pushDetailsList('Changed Flag Defaults', diffData.details?.changedDefaults,
      change => `- \`${change.commandPath}\`: \`--${change.flagName}\` default \`${formatValue(change.oldDefault)}\` → \`${formatValue(change.newDefault)}\``)
    pushDetailsList('Changed Flag Types', diffData.details?.changedFlagTypes,
      change => `- \`${change.commandPath}\`: \`--${change.flagName}\` type \`${change.oldType}\` → \`${change.newType}\``)
    pushDetailsList('Changed Flag Requirements', diffData.details?.changedFlagRequirements,
      change => `- \`${change.commandPath}\`: \`--${change.flagName}\` required \`${change.oldRequired}\` → \`${change.newRequired}\``)
    pushDetailsList('Changed Command Descriptions', diffData.details?.descriptionChanges,
      change => `- \`${change.path}\``)
  }

  // Override validation: entries referencing commands the tree lacks do
  // nothing silently, so surface them where they become actionable
  if (overrideValidation && overrideValidation.errors && overrideValidation.errors.length > 0) {
    lines.push('### Override Validation')
    lines.push('')
    lines.push(`⚠ ${overrideValidation.errors.length} override entr${overrideValidation.errors.length === 1 ? 'y' : 'ies'} did not apply (unknown command paths — stale entries in the overrides file):`)
    lines.push('')
    for (const err of overrideValidation.errors.slice(0, 10)) {
      lines.push(`- ${typeof err === 'string' ? err : err.message || JSON.stringify(err)}`)
    }
    if (overrideValidation.errors.length > 10) {
      lines.push(`- ... and ${overrideValidation.errors.length - 10} more`)
    }
    lines.push('')
  }

  // Description overrides that hide most of the source help. Curation is
  // fine, but this is where stale content hides, so keep it reviewable.
  if (descriptionCoverage && descriptionCoverage.length > 0) {
    lines.push('### Curated descriptions replacing source help')
    lines.push('')
    lines.push('These overrides replace substantially longer help text from the rpk source. Confirm the curated version still carries every operational detail (or intentionally omits it):')
    lines.push('')
    lines.push('| Command | Override | Source help |')
    lines.push('|---------|----------|-------------|')
    for (const entry of descriptionCoverage.slice(0, 15)) {
      lines.push(`| \`${entry.commandPath}\` | ${entry.overrideChars} chars | ${entry.sourceChars} chars |`)
    }
    if (descriptionCoverage.length > 15) {
      lines.push(`| ... and ${descriptionCoverage.length - 15} more | | |`)
    }
    lines.push('')
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
  acquireRpkBinary,
  buildRpkBinary,
  downloadRpkRelease,
  fetchPluginSubtree,
  parseCobraFlags,
  parseUrfaveFlags,
  parseHelpFlags,
  mergeVisibleDeprecationsIntoOverrides,
  makeLinkablePredicate,
  enrichPluginTreeWithFlags,
  fetchLatestPluginVersion,
  pluginNodeHasRealCommands,
  splicePluginNode,
  preserveLinuxOnlyCommands,
  REFRESHABLE_PLUGINS,
  PLUGIN_INSTALL_VERSION_FLAGS,
  PLUGIN_MANIFEST_SLUGS,
  getRequiredGoVersion,
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
  isPluginStampAttributable,
  attributablePluginSet,
  fetchPluginManifestVersions,
  // Exported for tests to seed manifest data without network access
  pluginManifestVersionsCache,
  filterDiffForWhatsNew,
  computeDescriptionCoverage,
  updateWhatsNewFile,
  KNOWN_PLUGINS,
  extractCommandPaths,
  detectLinuxOnlyByComparison,
  PLATFORMS,
  COMMON_SOURCE_LOCATIONS,
  generatePRSummary,
  runValidation
}
