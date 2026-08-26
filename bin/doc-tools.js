#!/usr/bin/env node

'use strict'

// Load environment variables from .env file if it exists
require('dotenv').config()

const { spawnSync } = require('child_process')
const os = require('os')
const { Command, Option } = require('commander')
const path = require('path')
const fs = require('fs')

// Import extracted utility modules
const { findRepoRoot, resolveInsideRepo, fail, commonOptions } = require('../cli-utils/doc-tools-utils')
const {
  requireTool,
  requireCmd,
  verifyCrdDependencies,
  verifyHelmDependencies,
  verifyPropertyDependencies,
  verifyMetricsDependencies
} = require('../cli-utils/dependencies')
const {
  runClusterDocs,
  diffDirs,
  generatePropertyComparisonReport,
  updatePropertyOverridesWithVersion,
  updatePropertiesJsonWithVersion,
  repairPropertyAnchorsInJson,
  cleanupOldDiffs,
  resolveDiffBaseline
} = require('../cli-utils/diff-utils')

// Import other utilities
const { determineDocsBranch } = require('../cli-utils/self-managed-docs-branch.js')
const fetchFromGithub = require('../tools/fetch-from-github.js')
const { getAntoraValue, setAntoraValue } = require('../cli-utils/antora-utils')

// --------------------------------------------------------------------
// Main CLI Definition
// --------------------------------------------------------------------
const programCli = new Command()

const pkg = require('../package.json')
programCli
  .name('doc-tools')
  .description('Redpanda Document Automation CLI')
  .version(pkg.version)

// ====================================================================
// TOP-LEVEL COMMANDS
// ====================================================================

/**
 * install-test-dependencies
 *
 * @description
 * Installs all packages and dependencies required for documentation testing workflows.
 * This includes Redpanda Docker images, Python virtual environments for property extraction,
 * and other test dependencies.
 *
 * @why
 * Setting up a documentation environment requires multiple dependencies across different
 * package managers (npm, pip, Docker). This command automates the entire setup process.
 *
 * @example
 * # Set up a new documentation environment
 * npx doc-tools install-test-dependencies
 *
 * # Use in CI/CD before running doc tests
 * - run: npx doc-tools install-test-dependencies
 * - run: npm test
 *
 * @requirements
 * - Node.js and npm
 * - Python 3.9 or higher
 * - Docker (for some dependencies)
 */
programCli
  .command('install-test-dependencies')
  .description('Install packages for doc test workflows')
  .action(() => {
    const scriptPath = path.join(__dirname, '../cli-utils/install-test-dependencies.sh')
    const result = spawnSync(scriptPath, { stdio: 'inherit', shell: true })
    process.exit(result.status)
  })

/**
 * get-redpanda-version
 *
 * @description
 * Fetches the latest Redpanda version from GitHub releases. Can retrieve either stable
 * releases or beta/RC versions. Returns the version in format "v25.3.1" which can be
 * used directly with other doc-tools commands.
 *
 * @why
 * Documentation must reference the correct current version. This command ensures version
 * numbers are accurate and can be used in CI/CD pipelines or before generating
 * version-specific documentation. The version is fetched from GitHub releases, which is
 * the source of truth for Redpanda releases.
 *
 * @example
 * # Get latest stable version
 * npx doc-tools get-redpanda-version
 * # Output: v25.3.1
 *
 * # Get latest beta/RC version
 * npx doc-tools get-redpanda-version --beta
 * # Output: v26.1.1-rc1
 *
 * # Auto-detect from antora.yml prerelease flag
 * cd docs-site
 * npx doc-tools get-redpanda-version --from-antora
 *
 * # Use in CI/CD or scripts
 * VERSION=$(npx doc-tools get-redpanda-version)
 * npx doc-tools generate property-docs --tag $VERSION
 *
 * @requirements
 * - Internet connection to access GitHub API
 * - GitHub API rate limits apply (60 requests/hour unauthenticated)
 */
programCli
  .command('get-redpanda-version')
  .description('Print the latest Redpanda version')
  .option('--beta', 'Return the latest RC (beta) version if available')
  .option('--from-antora', 'Read prerelease flag from local antora.yml')
  .action(async (options) => {
    try {
      await require('../tools/get-redpanda-version.js')(options)
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

/**
 * get-console-version
 *
 * @description
 * Fetches the latest Redpanda Console version from GitHub releases. Can retrieve either
 * stable releases or beta versions. Returns the version in format "v2.7.2" which can be
 * used for documentation references and Docker image tags.
 *
 * @why
 * Console is released separately from Redpanda core. This command keeps Console
 * documentation in sync with releases and provides the correct version for Docker
 * Compose files and deployment documentation.
 *
 * @example
 * # Get latest stable Console version
 * npx doc-tools get-console-version
 * # Output: v2.7.2
 *
 * # Get latest beta version
 * npx doc-tools get-console-version --beta
 * # Output: v2.8.0-beta1
 *
 * # Auto-detect from antora.yml prerelease flag
 * cd docs-site
 * npx doc-tools get-console-version --from-antora
 *
 * # Use in Docker Compose documentation
 * CONSOLE_VERSION=$(npx doc-tools get-console-version)
 * echo "image: redpandadata/console:$CONSOLE_VERSION"
 *
 * @requirements
 * - Internet connection to access GitHub API
 * - GitHub API rate limits apply (60 requests/hour unauthenticated)
 */
programCli
  .command('get-console-version')
  .description('Print the latest Console version')
  .option('--beta', 'Return the latest beta version if available')
  .option('--from-antora', 'Read prerelease flag from local antora.yml')
  .action(async (options) => {
    try {
      await require('../tools/get-console-version.js')(options)
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

/**
 * get-antora-value
 *
 * @description
 * Reads a value from antora.yml using a dot-separated key path.
 * Useful for retrieving version attributes and other configuration in CI/CD pipelines.
 *
 * @why
 * Automation workflows need to read the currently documented versions from antora.yml
 * to determine what version to diff against when generating updated documentation.
 *
 * @example
 * # Get the latest documented Redpanda version
 * npx doc-tools get-antora-value asciidoc.attributes.latest-redpanda-tag
 * # Output: v26.1.9
 *
 * # Get the component name
 * npx doc-tools get-antora-value name
 * # Output: ROOT
 *
 * @requirements
 * - Must run from directory containing antora.yml or antora.yaml
 */
programCli
  .command('get-antora-value')
  .description('Read a value from antora.yml by dot-path (e.g., asciidoc.attributes.latest-redpanda-tag)')
  .argument('<keyPath>', 'Dot-separated path to the value (e.g., asciidoc.attributes.latest-redpanda-tag)')
  .action((keyPath) => {
    const value = getAntoraValue(keyPath)
    if (value === undefined) {
      process.exit(1)
    }
    console.log(value)
  })

/**
 * set-antora-value
 *
 * @description
 * Sets a value in antora.yml using a dot-separated key path.
 * Uses surgical text replacement to preserve formatting and comments.
 *
 * @why
 * Automation workflows need to update version attributes in antora.yml
 * after generating documentation to track the currently documented version.
 *
 * @example
 * # Update the latest rpk version
 * npx doc-tools set-antora-value asciidoc.attributes.latest-rpk-version v26.2.0
 *
 * # Update the latest Redpanda version
 * npx doc-tools set-antora-value asciidoc.attributes.latest-redpanda-tag v26.2.0
 *
 * @requirements
 * - Must run from directory containing antora.yml or antora.yaml
 */
programCli
  .command('set-antora-value')
  .description('Set a value in antora.yml by dot-path (e.g., asciidoc.attributes.latest-rpk-version)')
  .argument('<keyPath>', 'Dot-separated path to the value (e.g., asciidoc.attributes.latest-rpk-version)')
  .argument('<value>', 'The value to set')
  .action((keyPath, value) => {
    const success = setAntoraValue(keyPath, value)
    if (!success) {
      console.error(`Failed to set ${keyPath}`)
      process.exit(1)
    }
    console.log(`Set ${keyPath} = ${value}`)
  })

/**
 * link-readme
 *
 * @description
 * Creates a symbolic link from a project's README.adoc file into the Antora documentation
 * structure. This allows project README files to be included in the documentation site
 * without duplication. The command creates the necessary directory structure and establishes
 * a symlink in docs/modules/<module>/pages/ that points to the project's README.adoc.
 *
 * @why
 * Documentation repositories often contain multiple sub-projects (like labs or examples)
 * that have their own README files. Rather than manually copying these files into the
 * Antora structure (which creates maintenance burden), symlinks keep the content in one
 * place while making it available to Antora. Changes to the project README automatically
 * appear in the docs site.
 *
 * @example
 * # Link a lab project README into documentation
 * npx doc-tools link-readme \
 *   --subdir labs/docker-compose \
 *   --target docker-compose-lab.adoc
 *
 * # Link multiple lab READMEs
 * npx doc-tools link-readme -s labs/kubernetes -t k8s-lab.adoc
 * npx doc-tools link-readme -s labs/terraform -t terraform-lab.adoc
 *
 * # The symlink structure created:
 * # docs/modules/labs/pages/docker-compose-lab.adoc -> ../../../../labs/docker-compose/README.adoc
 *
 * @requirements
 * - Must run from repository root
 * - Target project must have README.adoc file
 * - Operating system must support symbolic links
 */
programCli
  .command('link-readme')
  .description('Symlink a README.adoc into docs/modules/<module>/pages/')
  .requiredOption('-s, --subdir <subdir>', 'Relative path to the lab project subdirectory')
  .requiredOption('-t, --target <filename>', 'Name of the target AsciiDoc file in pages/')
  .action((options) => {
    const repoRoot = findRepoRoot()
    const normalized = options.subdir.replace(/\/+$/, '')
    const moduleName = normalized.split('/')[0]

    const projectDir = path.join(repoRoot, normalized)
    const pagesDir = path.join(repoRoot, 'docs', 'modules', moduleName, 'pages')
    const sourceFile = path.join(projectDir, 'README.adoc')
    const destLink = path.join(pagesDir, options.target)

    if (!fs.existsSync(projectDir)) {
      console.error(`Error: Project directory not found: ${projectDir}`)
      process.exit(1)
    }
    if (!fs.existsSync(sourceFile)) {
      console.error(`Error: README.adoc not found in ${projectDir}`)
      process.exit(1)
    }

    fs.mkdirSync(pagesDir, { recursive: true })
    const relPath = path.relative(pagesDir, sourceFile)

    try {
      if (fs.existsSync(destLink)) {
        const stat = fs.lstatSync(destLink)
        if (stat.isSymbolicLink()) fs.unlinkSync(destLink)
        else fail(`Destination already exists and is not a symlink: ${destLink}`)
      }
      fs.symlinkSync(relPath, destLink)
      console.log(`Done: Linked ${relPath} → ${destLink}`)
    } catch (err) {
      fail(`Failed to create symlink: ${err.message}`)
    }
  })

/**
 * fetch
 *
 * @description
 * Downloads specific files or directories from GitHub repositories without cloning the entire
 * repository. Uses the GitHub API to fetch content and saves it to a local directory. Useful
 * for grabbing examples, configuration files, or documentation snippets from other repositories.
 * Supports both individual files and entire directories.
 *
 * @why
 * Documentation often needs to reference or include files from other repositories (examples,
 * configuration templates, code samples). Cloning entire repositories is inefficient when you
 * only need specific files. This command provides targeted fetching, saving bandwidth and time.
 * It's particularly useful in CI/CD pipelines where you need specific assets without full clones.
 *
 * @example
 * # Fetch a specific configuration file
 * npx doc-tools fetch \
 *   --owner redpanda-data \
 *   --repo redpanda \
 *   --remote-path docker/docker-compose.yml \
 *   --save-dir examples/
 *
 * # Fetch an entire directory of examples
 * npx doc-tools fetch \
 *   -o redpanda-data \
 *   -r connect-examples \
 *   -p pipelines/mongodb \
 *   -d docs/modules/examples/attachments/
 *
 * # Fetch with custom filename
 * npx doc-tools fetch \
 *   -o redpanda-data \
 *   -r helm-charts \
 *   -p charts/redpanda/values.yaml \
 *   -d examples/ \
 *   --filename redpanda-values-example.yaml
 *
 * @requirements
 * - Internet connection to access GitHub API
 * - GitHub API rate limits apply (60 requests/hour unauthenticated, 5000 with token)
 * - For private repositories: GitHub token with repo permissions
 */
programCli
  .command('fetch')
  .description('Fetch a file or directory from GitHub and save it locally')
  .requiredOption('-o, --owner <owner>', 'GitHub repo owner or org')
  .requiredOption('-r, --repo <repo>', 'GitHub repo name')
  .requiredOption('-p, --remote-path <path>', 'Path in the repo to fetch')
  .requiredOption('-d, --save-dir <dir>', 'Local directory to save into')
  .option('-f, --filename <name>', 'Custom filename to save as')
  .action(async (options) => {
    try {
      await fetchFromGithub(
        options.owner,
        options.repo,
        options.remotePath,
        options.saveDir,
        options.filename
      )
      console.log(`Done: Fetched to ${options.saveDir}`)
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

/**
 * setup-mcp
 *
 * @description
 * Configures the Redpanda Docs MCP (Model Context Protocol) server for Claude Code or
 * Claude Desktop. Automatically detects the installed application, updates the appropriate
 * configuration file, and enables Claude to use doc-tools commands through natural conversation.
 * Supports both production (npm package) and local development modes.
 *
 * @why
 * Manual MCP configuration requires editing JSON configuration files in the correct location
 * with the correct schema. This command handles all setup automatically, including path
 * detection, configuration merging, and validation. It enables AI-assisted documentation
 * workflows where writers can use natural language to run doc-tools commands.
 *
 * @example
 * # Auto-detect and configure for Claude Code or Desktop
 * npx doc-tools setup-mcp
 *
 * # Configure for local development (run from this repository)
 * cd /path/to/docs-extensions-and-macros
 * npx doc-tools setup-mcp --local
 *
 * # Force update existing configuration
 * npx doc-tools setup-mcp --force
 *
 * # Target specific application
 * npx doc-tools setup-mcp --target code
 * npx doc-tools setup-mcp --target desktop
 *
 * # Check current configuration status
 * npx doc-tools setup-mcp --status
 *
 * # After setup, restart Claude Code and use natural language
 * "What's the latest Redpanda version?"
 * "Generate property docs for v25.3.1"
 *
 * @requirements
 * - Claude Code or Claude Desktop must be installed
 * - For --local mode: must run from docs-extensions-and-macros repository
 * - After setup: restart Claude Code/Desktop to load the MCP server
 */
programCli
  .command('setup-mcp')
  .description('Configure the Redpanda Docs MCP server for Claude Code/Desktop')
  .option('--force', 'Force update even if already configured', false)
  .option('--target <type>', 'Target application: auto, code, or desktop', 'auto')
  .option('--local', 'Use local development mode (requires running from this repo)', false)
  .option('--status', 'Show current MCP server configuration status', false)
  .action(async (options) => {
    try {
      const { setupMCP, showStatus, printNextSteps } = require('../cli-utils/setup-mcp.js')

      if (options.status) {
        showStatus()
        return
      }

      const result = await setupMCP({
        force: options.force,
        target: options.target,
        local: options.local
      })

      if (result.success) {
        printNextSteps(result)
        process.exit(0)
      } else {
        console.error(`Error: Setup failed: ${result.error}`)
        process.exit(1)
      }
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

/**
 * @description Validate the MCP server configuration including tools and resources.
 * @why Use this command to verify the MCP server is properly configured.
 * @example
 * # Validate MCP configuration
 * npx doc-tools validate-mcp
 * @requirements None.
 */
programCli
  .command('validate-mcp')
  .description('Validate MCP server configuration (tools, resources)')
  .action(() => {
    const {
      validateMcpConfiguration,
      formatValidationResults
    } = require('./mcp-tools/mcp-validation')

    // Tools are defined in doc-tools-mcp.js - we validate the structure
    const tools = [
      { name: 'get_antora_structure', description: 'Get Antora documentation structure' },
      { name: 'get_redpanda_version', description: 'Get latest Redpanda version' },
      { name: 'get_console_version', description: 'Get latest Console version' },
      { name: 'generate_property_docs', description: 'Generate property documentation' },
      { name: 'generate_metrics_docs', description: 'Generate metrics documentation' },
      { name: 'generate_rpk_docs', description: 'Generate rpk CLI documentation' },
      { name: 'generate_rpcn_connector_docs', description: 'Generate connector documentation' },
      { name: 'generate_helm_docs', description: 'Generate Helm chart documentation' },
      { name: 'generate_crd_docs', description: 'Generate CRD documentation' },
      { name: 'generate_cloud_regions', description: 'Generate cloud regions documentation' },
      { name: 'generate_bundle_openapi', description: 'Bundle OpenAPI specifications' },
      { name: 'review_generated_docs', description: 'Review generated documentation' },
      { name: 'audit_overrides', description: 'Audit docs-side overrides against extracted source strings' },
      { name: 'run_doc_tools_command', description: 'Run raw doc-tools command' },
      { name: 'get_job_status', description: 'Get background job status' },
      { name: 'list_jobs', description: 'List background jobs' }
    ]

    const resources = [
      {
        uri: 'redpanda://personas',
        name: 'Repository Personas',
        description: 'Target audience personas loaded from docs-data/personas.yaml'
      }
    ]

    try {
      console.log('Validating MCP configuration...')
      const validation = validateMcpConfiguration({ tools, resources })
      const output = formatValidationResults(validation, { tools, resources })
      console.log('\n' + output)

      if (!validation.valid) {
        process.exit(1)
      }
    } catch (err) {
      console.error(`Error: Validation failed: ${err.message}`)
      process.exit(1)
    }
  })

/**
 * @description Copy this package's docs-data/*.schema.json files into a
 * content repo's own docs-data/ (the file that documents docs-data/x.json
 * lives alongside x.json itself, so a writer can change both in one PR
 * without waiting on a package release first). Run this after bumping
 * @redpanda-data/docs-extensions-and-macros so the local copy picks up
 * whatever changed upstream.
 * @why Nothing keeps a content repo's schema copy in sync with this
 * package's copy today, in either direction. A content repo's copy can
 * legitimately be ahead of this package's (confirmed happening in
 * practice: the docs repo's rpk-overrides.schema.json documents a real,
 * working `asPartial` override field that this package's own copy is
 * missing) — overwriting it in that case would delete real, correct
 * documentation, not fix drift. This only overwrites when this package's
 * copy is a strict superset of the destination; otherwise it reports which
 * keys only the destination has and leaves the file alone (status
 * 'diverged') unless --force is passed. --check never writes, for a CI
 * gate.
 * @example
 * # Sync into ./docs-data (writes any missing or out-of-date schema)
 * npx doc-tools sync-schemas
 *
 * # Report drift without writing -- exits 1 if anything is out of sync
 * npx doc-tools sync-schemas --check
 *
 * # Sync into a non-default location
 * npx doc-tools sync-schemas --dest path/to/docs-data
 *
 * # Overwrite even a destination that has diverged (rarely correct --
 * # read the 'diverged' output first; it names what would be lost)
 * npx doc-tools sync-schemas --force
 * @requirements None.
 */
programCli
  .command('sync-schemas')
  .description("Sync this package's docs-data/*.schema.json into a content repo's docs-data/")
  .option('--dest <path>', 'Destination docs-data directory', 'docs-data')
  .option('--check', 'Report drift without writing; exit 1 if any schema is missing, out of date, or diverged')
  .option('--force', 'Overwrite even a destination that has diverged (has content this package lacks)')
  .action((options) => {
    const { syncSchemas } = require('../cli-utils/sync-schemas')

    try {
      const { destDir, results, drift } = syncSchemas({
        destDir: options.dest,
        check: Boolean(options.check),
        force: Boolean(options.force),
      })

      if (results.length === 0) {
        console.log('No *.schema.json files found in this package to sync.')
        process.exit(0)
      }

      console.log(`${options.check ? 'Checking' : 'Syncing'} against: ${destDir}`)
      console.log('')
      let hasUnresolvedDivergence = false
      for (const { name, status, destOnlyPaths } of results) {
        const label = {
          unchanged: '✓ up to date',
          created: '+ created',
          updated: '↻ updated',
          diverged: options.force ? '↻ updated (forced)' : '⚠ diverged, left alone',
        }[status]
        console.log(`  ${label}  ${name}`)
        if (status === 'diverged' && !options.force) {
          hasUnresolvedDivergence = true
          for (const p of destOnlyPaths) console.log(`      only in the destination: ${p}`)
        }
      }
      console.log('')

      if (options.check) {
        if (drift) {
          const hint = hasUnresolvedDivergence
            ? 'A diverged file needs a human decision (see paths above), not just a re-run.'
            : 'Run `npx doc-tools sync-schemas` to fix.'
          console.log(`✗ One or more schemas are out of date. ${hint}`)
          process.exit(1)
        }
        console.log('✓ All schemas are in sync.')
        process.exit(0)
      }

      if (hasUnresolvedDivergence) {
        console.log('⚠ Synced what was safe to sync. One or more files diverged and were left alone -- see paths above. Re-run with --force only after confirming the destination-only content should be lost.')
        process.exit(1)
      }

      console.log(drift ? '✓ Synced.' : '✓ Already in sync -- nothing to do.')
      process.exit(0)
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

/**
 * @description Show MCP server version information including available tools
 * and optionally usage statistics from previous sessions.
 * @why Use this command to see what MCP capabilities are available.
 * @example
 * # Show version and capabilities
 * npx doc-tools mcp-version
 *
 * # Show with usage statistics
 * npx doc-tools mcp-version --stats
 * @requirements None.
 */
programCli
  .command('mcp-version')
  .description('Show MCP server version and configuration information')
  .option('--stats', 'Show usage statistics if available', false)
  .action((options) => {
    const packageJson = require('../package.json')

    const tools = [
      { name: 'get_antora_structure', description: 'Get Antora documentation structure' },
      { name: 'get_redpanda_version', description: 'Get latest Redpanda version' },
      { name: 'get_console_version', description: 'Get latest Console version' },
      { name: 'generate_property_docs', description: 'Generate property documentation' },
      { name: 'generate_metrics_docs', description: 'Generate metrics documentation' },
      { name: 'generate_rpk_docs', description: 'Generate rpk CLI documentation' },
      { name: 'generate_rpcn_connector_docs', description: 'Generate connector documentation' },
      { name: 'generate_helm_docs', description: 'Generate Helm chart documentation' },
      { name: 'generate_crd_docs', description: 'Generate CRD documentation' },
      { name: 'generate_cloud_regions', description: 'Generate cloud regions documentation' },
      { name: 'generate_bundle_openapi', description: 'Bundle OpenAPI specifications' },
      { name: 'review_generated_docs', description: 'Structural validation of generated docs' },
      { name: 'run_doc_tools_command', description: 'Run raw doc-tools command' },
      { name: 'get_job_status', description: 'Get background job status' },
      { name: 'list_jobs', description: 'List background jobs' }
    ]

    const resources = [
      {
        uri: 'redpanda://personas',
        name: 'Repository Personas',
        description: 'Loaded from docs-data/personas.yaml'
      }
    ]

    console.log('Redpanda Doc Tools MCP Server')
    console.log('='.repeat(60))
    console.log(`Server version: ${packageJson.version}`)
    console.log('')

    console.log(`Tools (${tools.length} available):`)
    tools.forEach(tool => {
      console.log(`  - ${tool.name}`)
      console.log(`    ${tool.description}`)
    })
    console.log('')

    console.log(`Resources (${resources.length} available):`)
    resources.forEach(resource => {
      console.log(`  - ${resource.name}`)
      console.log(`    URI: ${resource.uri}`)
      console.log(`    ${resource.description}`)
    })
    console.log('')

    console.log('Note: Prompts and most resources have been migrated to')
    console.log('the docs-team-standards Claude Code plugin.')
    console.log('')

    if (options.stats) {
      const statsPath = path.join(os.tmpdir(), 'mcp-usage-stats.json')
      if (fs.existsSync(statsPath)) {
        try {
          const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'))
          console.log('Usage Statistics:')
          console.log('='.repeat(60))

          if (stats.tools && Object.keys(stats.tools).length > 0) {
            console.log('\nTool Usage:')
            Object.entries(stats.tools)
              .sort(([, a], [, b]) => b.count - a.count)
              .forEach(([name, data]) => {
                console.log(`  ${name}:`)
                console.log(`    Invocations: ${data.count}`)
                if (data.errors > 0) {
                  console.log(`    Errors: ${data.errors}`)
                }
              })
          }
        } catch (err) {
          console.error('Failed to parse usage statistics:', err.message)
        }
      } else {
        console.log('No usage statistics available yet.')
        console.log('Statistics are exported when the MCP server shuts down.')
      }
    }

    console.log('')
    console.log('For more information, see:')
    console.log('  mcp/WRITER_EXTENSION_GUIDE.adoc')
    console.log('  mcp/README.adoc')
  })

// ====================================================================
// GENERATE SUBCOMMAND GROUP
// ====================================================================

const automation = new Command('generate').description('Run docs automations')

/**
 * generate metrics-docs
 *
 * @description
 * Generates comprehensive metrics reference documentation by running Redpanda in Docker and
 * scraping the `/public_metrics` Prometheus endpoint. Starts a Redpanda cluster with the
 * specified version, waits for it to be ready, collects all exposed metrics, parses the
 * Prometheus format, and generates categorized AsciiDoc documentation. Optionally compares
 * metrics between versions to identify new, removed, or changed metrics.
 *
 * @why
 * Redpanda exposes hundreds of metrics for monitoring and observability. Manual documentation
 * of metrics is error-prone and becomes outdated as new metrics are added or existing ones
 * change. This automation ensures metrics documentation accurately reflects what Redpanda
 * actually exports at each version. Running Redpanda in Docker and scraping metrics directly
 * is the only reliable way to capture the complete and accurate metrics set.
 *
 * @example
 * # Basic: Generate metrics docs for a specific version
 * npx doc-tools generate metrics-docs --tag v25.3.1
 *
 * # Compare metrics between versions to see what changed
 * npx doc-tools generate metrics-docs \
 *   --tag v25.3.1 \
 *   --diff v25.2.1
 *
 * # Use custom Docker repository
 * npx doc-tools generate metrics-docs \
 *   --tag v25.3.1 \
 *   --docker-repo docker.redpanda.com/redpandadata/redpanda
 *
 * # Full workflow: document new release
 * VERSION=$(npx doc-tools get-redpanda-version)
 * npx doc-tools generate metrics-docs --tag $VERSION
 *
 * @requirements
 * - Docker must be installed and running
 * - Port 9644 must be available (Redpanda metrics endpoint)
 * - Sufficient disk space for Docker image
 * - Internet connection to pull Docker images
 */
automation
  .command('metrics-docs')
  .description('Generate JSON and AsciiDoc documentation for Redpanda metrics. Defaults to branch "dev" if neither --tag nor --branch is specified.')
  .option('-t, --tag <tag>', 'Git tag for released content (GA/beta)')
  .option('-b, --branch <branch>', 'Branch name for in-progress content')
  .option('--docker-repo <repo>', 'Docker repository to use', commonOptions.dockerRepo)
  .option('--console-tag <tag>', 'Redpanda Console version to use', commonOptions.consoleTag)
  .option('--console-docker-repo <repo>', 'Docker repository for Console', commonOptions.consoleDockerRepo)
  .option('--diff <oldTag>', 'Also diff autogenerated metrics from <oldTag> → <tag>')
  .action((options) => {
    verifyMetricsDependencies()

    if (options.tag && options.branch) {
      console.error('Error: Cannot specify both --tag and --branch')
      process.exit(1)
    }

    const newTag = options.tag || options.branch || 'dev'
    const oldTag = options.diff

    if (oldTag) {
      const oldDir = path.join('autogenerated', oldTag, 'metrics')
      if (!fs.existsSync(oldDir)) {
        console.log(`Generating metrics docs for old tag ${oldTag}…`)
        runClusterDocs('metrics', oldTag, options)
      }
    }

    console.log(`Generating metrics docs for new tag ${newTag}…`)
    runClusterDocs('metrics', newTag, options)

    if (oldTag) {
      diffDirs('metrics', oldTag, newTag)
    }

    process.exit(0)
  })

/**
 * generate rpcn-connector-docs
 *
 * @description
 * Generates complete reference documentation for Redpanda Connect (formerly Benthos) connectors,
 * processors, and components. Parses component templates and configuration schemas, reads
 * connector metadata from CSV, and generates AsciiDoc documentation for each component. Supports
 * diffing changes between versions and automatically updating what's new documentation. Can also
 * generate Bloblang function documentation.
 *
 * @why
 * Redpanda Connect has hundreds of connectors (inputs, outputs, processors) with complex
 * configuration schemas. Each component's documentation lives in its source code as struct
 * tags and comments. Manual documentation is impossible to maintain. This automation extracts
 * documentation directly from code, ensuring accuracy and completeness. The diff capability
 * automatically identifies new connectors and changed configurations for release notes.
 *
 * @example
 * # Basic: Generate all connector docs
 * npx doc-tools generate rpcn-connector-docs
 *
 * # Generate docs and automatically update what's new page
 * npx doc-tools generate rpcn-connector-docs --update-whats-new
 *
 * # Include Bloblang function documentation
 * npx doc-tools generate rpcn-connector-docs --include-bloblang
 *
 * # Fetch latest connector data using rpk
 * npx doc-tools generate rpcn-connector-docs --fetch-connectors
 *
 * # Full workflow with diff and what's new update
 * npx doc-tools generate rpcn-connector-docs \
 *   --update-whats-new \
 *   --include-bloblang
 *
 * @requirements
 * - rpk and rpk connect must be installed
 * - Internet connection for fetching connector data
 * - Node.js for parsing and generation
 */
automation
  .command('rpcn-connector-docs')
  .description('Generate RPCN connector docs and diff changes since the last version')
  .option('-d, --data-dir <path>', 'Directory where versioned connect JSON files live', path.resolve(process.cwd(), 'docs-data'))
  .option('--old-data <path>', 'Optional override for old data file (for diff)')
  .option('--update-whats-new', 'Update whats-new.adoc with new section from diff JSON')
  .option('-f, --fetch-connectors', 'Fetch latest connector data using rpk')
  .option('--connect-version <version>', 'Connect version to fetch (requires --fetch-connectors)')
  .option('-m, --draft-missing', 'Generate full-doc drafts for connectors missing in output')
  .option('--template-main <path>', 'Main Handlebars template', path.resolve(__dirname, '../tools/redpanda-connect/templates/connector.hbs'))
  .option('--template-intro <path>', 'Intro section partial template', path.resolve(__dirname, '../tools/redpanda-connect/templates/intro.hbs'))
  .option('--template-fields <path>', 'Fields section partial template', path.resolve(__dirname, '../tools/redpanda-connect/templates/fields-partials.hbs'))
  .option('--template-examples <path>', 'Examples section partial template', path.resolve(__dirname, '../tools/redpanda-connect/templates/examples-partials.hbs'))
  .option('--template-metadata <path>', 'Metadata section partial template', path.resolve(__dirname, '../tools/redpanda-connect/templates/metadata-partials.hbs'))
  .option('--template-description <path>', 'Description section partial template', path.resolve(__dirname, '../tools/redpanda-connect/templates/descriptions-partials.hbs'))
  .option('--template-bloblang <path>', 'Custom Handlebars template for bloblang function/method partials')
  .option('--overrides <path>', 'Optional JSON file with overrides', 'docs-data/overrides.json')
  .option('--include-bloblang', 'Include Bloblang functions and methods in generation')
  .option('--prune-orphaned-descriptions', 'Allow the description-partial orphan sweep to blank more than 10% of the tree. Only use this when the connector dataset is confirmed complete: an incomplete dataset looks identical to a mass upstream deletion and the sweep blanks published content')
  .option('--cloud-version <version>', 'Cloud binary version (default: auto-detect latest)')
  .option('--cgo-version <version>', 'cgo binary version (default: same as cloud-version)')
  .option('--skip-intermediate', 'Skip intermediate release processing (legacy mode - only compare latest vs last documented)')
  .option('--from-version <version>', 'Override starting version instead of using antora.yml (useful for backfilling)')
  .action(async (options) => {
    requireTool('rpk', {
      versionFlag: '--version',
      help: 'rpk is not installed. Install rpk: https://docs.redpanda.com/current/get-started/rpk-install/'
    })

    requireTool('rpk connect', {
      versionFlag: '--version',
      help: 'rpk connect is not installed. Run rpk connect install before continuing.'
    })

    const { handleRpcnConnectorDocs } = require('../tools/redpanda-connect/rpcn-connector-docs-handler.js')
    await handleRpcnConnectorDocs(options)
  })

/**
 * generate migrate-rpcn-descriptions
 *
 * @description
 * One-time migration that rewires published connector reference pages onto the
 * regenerated description partial: the header `:description:` becomes
 * `include::...[tag=attrs]` and the frozen intro prose becomes
 * `include::...[tag=body]`. Afterwards `generate rpcn-connector-docs` keeps
 * both fresh on every run.
 *
 * @why
 * Connector pages are one-time first drafts, so their summary, "Introduced in
 * version" line and description prose never change again even when the
 * connector does. The body rewire is guarded: a page whose intro carries
 * anything the partial does not reproduce is reported and left for a human,
 * because rewriting it would delete published content.
 *
 * @example
 * # Dry run (default): report the pages that would change
 * npx doc-tools generate migrate-rpcn-descriptions
 *
 * # Apply the migration
 * npx doc-tools generate migrate-rpcn-descriptions --write
 *
 * # Rewire page headers only, leaving the body prose alone
 * npx doc-tools generate migrate-rpcn-descriptions --write --skip-body
 */
automation
  .command('migrate-rpcn-descriptions')
  .description('One-time migration of frozen connector summaries and description prose onto the regenerated description partial. Dry run unless --write is given.')
  .option('--write', 'Apply changes (default is a dry run that only reports)')
  .option('--skip-body', 'Rewire page headers only, leaving the frozen intro prose in the page')
  .action((options) => {
    const { migrateDescriptionsToPartials } = require('../tools/redpanda-connect/migrate-descriptions-to-partials.js')
    migrateDescriptionsToPartials({ write: Boolean(options.write), skipBody: Boolean(options.skipBody) })
  })

/**
 * generate migrate-rpcn-metadata
 *
 * @description
 * One-time migration that moves inline `== Metadata` blocks out of connector
 * reference pages (modules/components/pages/<type>/<name>.adoc) and into
 * regenerated partials (modules/components/partials/metadata/<type>/<name>.adoc),
 * replacing the inline block in the page with an include directive. Afterwards
 * `generate rpcn-connector-docs` keeps the partial in sync with the connector's
 * upstream description on every run.
 *
 * @why
 * Metadata documented inline in the main page is never refreshed by normal
 * regeneration, so it drifts from the source. Extracting it into a partial makes
 * it flow through automatically, matching the fields and examples partials.
 *
 * @example
 * # Dry run (default): report the pages that would change
 * npx doc-tools generate migrate-rpcn-metadata
 *
 * # Apply the migration
 * npx doc-tools generate migrate-rpcn-metadata --write
 */
automation
  .command('migrate-rpcn-metadata')
  .description('One-time migration of inline connector == Metadata blocks into regenerated partials. Dry run unless --write is given.')
  .option('--write', 'Apply changes (default is a dry run that only reports)')
  .action((options) => {
    const { migrateMetadataToPartials } = require('../tools/redpanda-connect/migrate-metadata-to-partials.js')
    migrateMetadataToPartials({ write: Boolean(options.write) })
  })

/**
 * @description One-time migration of plain-backtick property mentions to the
 * prop: inline macro, so property tooltips become opt-in. Only names that
 * exist in the published property reference JSON AND contain a separator
 * (_ or .) are converted. Separator-free names such as admin, brokers, rack,
 * retries, and superusers are the ambiguous words that motivated opt-in
 * marking, so they are always left for a human. Dry run unless --write is given.
 *
 * @example
 * # Preview the conversion from a docs repo checkout
 * npx doc-tools generate migrate-property-refs --properties modules/reference/attachments/redpanda-properties-v26.2.1.json
 *
 * # Apply it
 * npx doc-tools generate migrate-property-refs --properties modules/reference/attachments/redpanda-properties-v26.2.1.json --write
 */
automation
  .command('migrate-property-refs')
  .description('One-time migration of `property_name` prose mentions to prop:property_name[] macros. Dry run unless --write is given.')
  .requiredOption('--properties <path>', 'Path to the published redpanda-properties JSON to validate names against')
  .option('--docs-dir <path>', 'Docs repo root containing modules/', '.')
  .option('--config-refs', 'Also convert config_ref macro calls to prop macro calls')
  .option('--write', 'Apply changes (default is a dry run that only reports)')
  .action((options) => {
    const { migrate } = require('../tools/migrate-property-refs.js')
    const propertiesJson = JSON.parse(fs.readFileSync(path.resolve(options.properties), 'utf8'))
    const result = migrate({
      docsDir: path.resolve(options.docsDir),
      propertiesJson,
      write: Boolean(options.write),
      configRefs: Boolean(options.configRefs),
    })
    result.changed
      .sort((a, b) => b.count - a.count)
      .forEach(({ file, count }) => console.log(`${String(count).padStart(4)}  ${file}`))
    console.log(`\n${options.write ? 'Converted' : 'Would convert'} ${result.conversions} mention(s) across ${result.changed.length} of ${result.files} files.`)
    console.log(`Left alone (ambiguous, no separator): ${result.ambiguous.join(', ')}`)
    if (result.skippedConfigRefs && result.skippedConfigRefs.length) {
      console.log(`config_ref calls left alone (names not in the published JSON): ${result.skippedConfigRefs.join(', ')}`)
    }
    if (!options.write && result.conversions) console.log('Re-run with --write to apply.')
  })

/**
 * generate property-docs
 *
 * @description
 * Generates comprehensive reference documentation for Redpanda cluster and topic configuration
 * properties. Clones the Redpanda repository at a specified version, runs a Python extractor
 * to parse C++ configuration code, and outputs JSON data files with all property metadata
 * (descriptions, types, defaults, constraints). Optionally generates consolidated AsciiDoc
 * partials for direct inclusion in documentation sites.
 *
 * @why
 * Property definitions in the C++ source code are the single source of truth for Redpanda
 * configuration. Manual documentation becomes outdated quickly. This automation ensures docs
 * stay perfectly in sync with implementation by extracting properties directly from code,
 * including type information, default values, and constraints that would be error-prone to
 * maintain manually.
 *
 * @example
 * # Basic: Extract properties to JSON only (default)
 * npx doc-tools generate property-docs --tag v25.3.1
 *
 * # Generate AsciiDoc partials for documentation site
 * npx doc-tools generate property-docs --tag v25.3.1 --generate-partials
 *
 * # Include Cloud support tags (requires GitHub token)
 * export GITHUB_TOKEN=ghp_xxx
 * npx doc-tools generate property-docs \
 *   --tag v25.3.1 \
 *   --generate-partials \
 *   --cloud-support
 *
 * # Compare properties between versions
 * npx doc-tools generate property-docs \
 *   --tag v25.3.1 \
 *   --diff v25.2.1
 *
 * # Use custom output directory
 * npx doc-tools generate property-docs \
 *   --tag v25.3.1 \
 *   --output-dir docs/modules/reference
 *
 * # Full workflow: document new release
 * VERSION=$(npx doc-tools get-redpanda-version)
 * npx doc-tools generate property-docs \
 *   --tag $VERSION \
 *   --generate-partials \
 *   --cloud-support
 *
 * @requirements
 * - Python 3.9 or higher
 * - Git
 * - A GitHub token (GH_TOKEN, GITHUB_TOKEN, or REDPANDA_GITHUB_TOKEN) with
 *   access to redpanda-data/streaming-enterprise, which is private
 * - Internet connection to clone the streaming-enterprise repository
 * - For --cloud-support: GitHub token with repo permissions (GITHUB_TOKEN env var)
 * - For --cloud-support: Python packages pyyaml and requests
 */
automation
  .command('property-docs')
  .description(
    'Generate JSON and consolidated AsciiDoc partials for Redpanda configuration properties. ' +
    'Defaults to branch "dev" if neither --tag nor --branch is specified.'
  )
  .option('-t, --tag <tag>', 'Git tag for released content (GA/beta)')
  .option('-b, --branch <branch>', 'Branch name for in-progress content')
  .option('--diff <oldTag>', 'Diff properties against <oldTag> and restore removed deprecated properties. Recommended for accurate output; falls back to latest-redpanda-tag from antora.yml if not specified')
  .option('--regenerate-old-baseline', 'Re-extract the --diff tag from source instead of using the committed attachments/redpanda-properties-<oldTag>.json baseline')
  .option('--overrides <path>', 'Optional JSON file with property description overrides', 'docs-data/property-overrides.json')
  .option('--output-dir <dir>', 'Where to write all generated files', 'modules/reference')
  .option('--cloud-support', 'Add AsciiDoc tags to generated property docs to indicate which ones are supported in Redpanda Cloud. This data is fetched from the cloudv2 repository so requires a GitHub token with repo permissions. Set the token as an environment variable using GITHUB_TOKEN, GH_TOKEN, or REDPANDA_GITHUB_TOKEN', true)
  .option('--no-cloud-support', 'Skip Cloud support tags entirely -- and the GitHub token requirement that comes with them')
  .option('--template-property <path>', 'Custom Handlebars template for individual property sections')
  .option('--template-topic-property <path>', 'Custom Handlebars template for topic property sections')
  .option('--template-topic-property-mappings <path>', 'Custom Handlebars template for topic property mappings table')
  .option('--template-deprecated <path>', 'Custom Handlebars template for deprecated properties page')
  .option('--template-deprecated-property <path>', 'Custom Handlebars template for individual deprecated property sections')
  .option('--generate-partials', 'Generate consolidated property partials')
  .option('--partials-dir <path>', 'Directory for property partials (relative to output-dir)', 'partials')
  .action((options) => {
    verifyPropertyDependencies()

    if (options.tag && options.branch) {
      console.error('Error: Cannot specify both --tag and --branch')
      process.exit(1)
    }

    const newTag = options.tag || options.branch || 'dev'

    // Resolved once, via the same priority chain every other GitHub-fetching
    // command in this CLI already uses (cli-utils/github-token.js) --
    // notably GIT_CREDENTIALS, which is the token Antora/Netlify builds
    // actually populate, and which the Makefile's own narrower shell
    // fallback (REDPANDA_GITHUB_TOKEN/GITHUB_TOKEN/GH_TOKEN only) can't see.
    // Passed through as GH_TOKEN so the Makefile's clone step picks up
    // whatever this resolved, private-repo access included, without having
    // to duplicate the GIT_CREDENTIALS parsing logic in shell.
    const { getGitHubToken } = require('../cli-utils/github-token')
    const githubToken = getGitHubToken()

    if (options.cloudSupport) {
      console.log('Validating cloud support dependencies...')
      if (!githubToken) {
        console.error('Error: Cloud support requires a GitHub token')
        console.error('   Set: export GITHUB_TOKEN=your_token_here')
        console.error('   Or disable cloud support with: --no-cloud-support')
        process.exit(1)
      }
      console.log('Done: GitHub token validated')
    }

    let oldTag = options.diff

    if (!oldTag) {
      oldTag = getAntoraValue('asciidoc.attributes.latest-redpanda-tag')
      if (oldTag) {
        console.log(`Using latest-redpanda-tag from Antora attributes for --diff: ${oldTag}`)
      }
    }

    if (!oldTag) {
      console.warn('Warning: No previous version specified (--diff) and no latest-redpanda-tag found in Antora attributes.')
      console.warn('   Deprecated properties that were removed from source (v26.1+) will not be detected.')
      console.warn('   For accurate output, specify --diff <previous-tag> or set latest-redpanda-tag in antora.yml.')
    }

    const overridesPath = options.overrides
    const outputDir = options.outputDir
    const cwd = path.resolve(__dirname, '../tools/property-extractor')

    const make = (tag, overrides, templates = {}, outDir = 'modules/reference/', { skipPartials = false } = {}) => {
      console.log(`Building property docs for ${tag}…`)
      const args = ['build', `TAG=${tag}`]
      const env = { ...process.env }
      if (githubToken) env.GH_TOKEN = githubToken
      if (overrides) env.OVERRIDES = path.resolve(overrides)
      if (options.cloudSupport) env.CLOUD_SUPPORT = '1'
      if (templates.property) env.TEMPLATE_PROPERTY = path.resolve(templates.property)
      if (templates.topicProperty) env.TEMPLATE_TOPIC_PROPERTY = path.resolve(templates.topicProperty)
      if (templates.topicPropertyMappings) env.TEMPLATE_TOPIC_PROPERTY_MAPPINGS = path.resolve(templates.topicPropertyMappings)
      if (templates.deprecated) env.TEMPLATE_DEPRECATED = path.resolve(templates.deprecated)
      if (templates.deprecatedProperty) env.TEMPLATE_DEPRECATED_PROPERTY = path.resolve(templates.deprecatedProperty)
      env.OUTPUT_JSON_DIR = path.resolve(outDir, 'attachments')
      env.OUTPUT_AUTOGENERATED_DIR = path.resolve(outDir)
      if (options.generatePartials && !skipPartials) {
        env.GENERATE_PARTIALS = '1'
        env.OUTPUT_PARTIALS_DIR = path.resolve(outDir, options.partialsDir || 'partials')
      }
      const r = spawnSync('make', args, { cwd, stdio: 'inherit', env })
      if (r.error) {
        console.error(`Error: ${r.error.message}`)
        process.exit(1)
      }
      if (r.status !== 0) process.exit(r.status)
    }

    const templates = {
      property: options.templateProperty,
      topicProperty: options.templateTopicProperty,
      topicPropertyMappings: options.templateTopicPropertyMappings,
      deprecated: options.templateDeprecated,
      deprecatedProperty: options.templateDeprecatedProperty
    }

    const tagsAreSame = oldTag && newTag && oldTag === newTag
    const needsDiff = oldTag && !tagsAreSame

    // Phase 1: Extract JSON from C++ source.
    // When a diff is needed, skip AsciiDoc generation during extraction so we
    // can merge removed deprecated properties first and generate only once.
    if (needsDiff) {
      const { useCommitted, baselinePath } = resolveDiffBaseline(outputDir, oldTag, options.regenerateOldBaseline)
      if (useCommitted) {
        console.log(`Using committed baseline for ${oldTag}: ${baselinePath}`)
        console.log('   Pass --regenerate-old-baseline to rebuild it from source instead.')
      } else {
        make(oldTag, overridesPath, templates, outputDir, { skipPartials: true })
      }
      make(newTag, overridesPath, templates, outputDir, { skipPartials: true })
    } else {
      make(newTag, overridesPath, templates, outputDir)
    }

    // Phase 2: Compare old vs new and merge removed deprecated properties into
    // the new JSON so they appear in the generated documentation.
    if (needsDiff) {
      const diffOutputDir = overridesPath ? path.dirname(path.resolve(overridesPath)) : outputDir
      try {
        generatePropertyComparisonReport(oldTag, newTag, diffOutputDir)
      } catch (err) {
        // A missing baseline only warns inside generatePropertyComparisonReport.
        // Reaching this catch means both inputs existed and the comparison
        // itself failed, so fail the run: continuing would silently drop
        // removed-deprecated restoration and "Introduced in" version stamping.
        console.error(`Error: Property comparison failed: ${err.message}`)
        process.exit(1)
      }

      try {
        const diffReportPath = path.join(diffOutputDir, `redpanda-property-changes-${oldTag}-to-${newTag}.json`)
        if (fs.existsSync(diffReportPath)) {
          const diffData = JSON.parse(fs.readFileSync(diffReportPath, 'utf8'))
          const { printPRSummary } = require('../tools/property-extractor/pr-summary-formatter')
          printPRSummary(diffData)

          if (overridesPath && fs.existsSync(overridesPath)) {
            updatePropertyOverridesWithVersion(overridesPath, diffData, newTag)
            // The overrides were baked into the extracted JSON during Phase 1,
            // before the stamp above existed. Stamp the JSON too, so the
            // AsciiDoc generated in Phase 3 shows "Introduced in" for
            // properties new in this release instead of one release late.
            const extractedJsonPath = path.resolve(outputDir, 'attachments', `redpanda-properties-${newTag}.json`)
            updatePropertiesJsonWithVersion(extractedJsonPath, diffData, newTag)
            // Repair anchors HERE, in Phase 2, so the attachment the docs UI
            // reads and the partials Phase 3 renders come from the same
            // corrected text. Normalizing only in Phase 3 left the two
            // disagreeing: the partials linked <<flush-bytes>> while the
            // published attachment still said <<flushbytes>>.
            repairPropertyAnchorsInJson(extractedJsonPath)
          }
        }
      } catch (err) {
        // The diff report exists but could not be read or applied. Fail the
        // run rather than shipping docs that are missing removed-deprecated
        // restoration or version stamps.
        console.error(`Error: Failed to process the property diff report: ${err.message}`)
        process.exit(1)
      }

      cleanupOldDiffs(diffOutputDir)

      // Phase 3: Generate AsciiDoc once from the complete JSON (includes merged deprecated properties)
      if (options.generatePartials) {
        const updatedJsonPath = path.resolve(outputDir, 'attachments', `redpanda-properties-${newTag}.json`)
        if (fs.existsSync(updatedJsonPath)) {
          process.env.GENERATE_PARTIALS = '1'
          process.env.OUTPUT_PARTIALS_DIR = path.resolve(outputDir, options.partialsDir || 'partials')
          const { generateAllDocs } = require('../tools/property-extractor/generate-handlebars-docs')
          console.log('Generating AsciiDoc from complete property data…')
          generateAllDocs(updatedJsonPath, path.resolve(outputDir))
        }
      }
    }

    if (!options.diff && !tagsAreSame) {
      const tagSuccess = setAntoraValue('asciidoc.attributes.latest-redpanda-tag', newTag)
      if (tagSuccess) console.log(`Done: Updated Antora latest-redpanda-tag to: ${newTag}`)

      const versionWithoutV = newTag.startsWith('v') ? newTag.slice(1) : newTag
      const versionSuccess = setAntoraValue('asciidoc.attributes.full-version', versionWithoutV)
      if (versionSuccess) console.log(`Done: Updated Antora full-version to: ${versionWithoutV}`)

      try {
        const jsonDir = path.resolve(outputDir, 'attachments')
        // Invariant: always retain the comparison pair this run actually used
        // (the current tag's JSON and the diff baseline's JSON) in addition to
        // the 2 newest versioned JSONs. A backport run can compare tags that
        // are not the 2 newest, and the next run's comparison needs its
        // baseline JSON to survive. Mirrors the retention in
        // tools/property-extractor/Makefile (generate-docs cleanup).
        const parseVersion = f => f.match(/^redpanda-properties-v([\d.]+)\.json$/)[1].split('.').map(Number)
        const byVersionDesc = (a, b) => {
          const [va, vb] = [parseVersion(a), parseVersion(b)]
          for (let i = 0; i < Math.max(va.length, vb.length); i++) {
            if ((vb[i] || 0) !== (va[i] || 0)) return (vb[i] || 0) - (va[i] || 0)
          }
          return 0
        }
        const propertyFiles = fs.readdirSync(jsonDir)
          .filter(f => /^redpanda-properties-v[\d.]+\.json$/.test(f))
          .sort(byVersionDesc)

        const filesToKeep = new Set(propertyFiles.slice(0, 2))
        for (const tag of [newTag, oldTag]) {
          if (tag) filesToKeep.add(`redpanda-properties-${tag}.json`)
        }
        const filesToDelete = propertyFiles.filter(f => !filesToKeep.has(f))

        if (filesToDelete.length > 0) {
          console.log('🧹 Cleaning up old property JSON files (keeping the 2 newest plus the comparison pair)...')
          filesToDelete.forEach(file => {
            fs.unlinkSync(path.join(jsonDir, file))
            console.log(`   Deleted: ${file}`)
          })
        }
      } catch (err) {
        console.warn(`Warning: Failed to cleanup old property JSON files: ${err.message}`)
      }
    }

    process.exit(0)
  })

/**
 * generate rpk-docs
 *
 * @description
 * Generates comprehensive CLI reference documentation for rpk (Redpanda Keeper).
 * Clones the Redpanda source from streaming-enterprise (private), builds rpk
 * with Go, and parses `rpk --print-tree` JSON output. Detects Linux-only
 * commands by analyzing Go build tags in the source code.
 *
 * Key features:
 * - Clones source from GitHub (sparse checkout for speed)
 * - Builds rpk from source using Go
 * - Parses Go build tags to detect Linux-only commands
 * - Automatically includes rpk plugins (connect, ai, check, etc.)
 * - Supports overrides.json for description improvements
 * - Generates versioned JSON files for downstream consumers (tooltips, etc.)
 * - Generates diffs between versions for release notes
 *
 * @why
 * Building from source provides accurate platform detection by analyzing Go build tags
 * (//go:build linux) rather than comparing binaries. This is faster and more reliable.
 *
 * @example
 * # Generate docs for a specific version
 * npx doc-tools generate rpk-docs --ref v26.2.0
 *
 * # Generate docs for latest development branch
 * npx doc-tools generate rpk-docs --ref dev
 *
 * # Auto-detect local redpanda checkout (if available)
 * npx doc-tools generate rpk-docs
 *
 * # Generate with diff against previous version
 * npx doc-tools generate rpk-docs --ref v26.2.0 --diff v26.1.9
 *
 * # Use custom overrides file
 * npx doc-tools generate rpk-docs --ref dev --overrides custom-overrides.json
 *
 * @requirements
 * - Go must be installed (https://go.dev/)
 * - Git must be installed (for cloning source)
 * - A GitHub token (GH_TOKEN, GITHUB_TOKEN, or REDPANDA_GITHUB_TOKEN) with
 *   access to redpanda-data/streaming-enterprise, which is private (not
 *   needed when --from-source points at an existing local checkout)
 */
automation
  .command('rpk-docs')
  .description('Generate rpk CLI documentation from source. Builds rpk and parses source for platform detection.')
  .option('-r, --ref <ref>', 'Git branch or tag to document (e.g., dev, v26.2.0). Clones from GitHub.')
  .option('--from-source <path>', 'Path to local rpk source (src/go/rpk directory)')
  .option('--from-json <path>', 'Regenerate docs from an existing versioned JSON file (skips building)')
  .option('--plugin <name>', 'Refresh a single rpk plugin\'s docs (ai, connect, k8s, check). Requires --from-json. Installs the plugin, splices its fresh subtree into the snapshot, and re-renders.')
  .option('--plugin-version <version>', 'Plugin version to install and record (for example, 4.102.0). Defaults to the latest published version.')
  .option('--plugin-pin <name=version>', 'Pin a plugin version for the installs during full generation (repeatable, for example --plugin-pin k8s=26.3.1-beta.1). Required for pre-GA plugins with no promoted latest version.', (value, pins) => {
    const eq = value.indexOf('=')
    if (eq < 1 || eq === value.length - 1) {
      throw new Error(`Invalid --plugin-pin '${value}': expected <name>=<version>`)
    }
    pins[value.slice(0, eq)] = value.slice(eq + 1)
    return pins
  }, {})
  .option('--rpk-bin <path>', 'Path to an existing rpk binary for the plugin refresh (skips download/build)')
  .option('--overrides <path>', 'Path to overrides JSON file', 'docs-data/rpk-overrides.json')
  .option('--diff <oldVersion>', 'Generate diff against previous version')
  .option('--update-whats-new [path]', 'Update what\'s-new file with rpk changes from diff (default: modules/get-started/pages/release-notes/redpanda.adoc)')
  .option('--draft-missing', 'Generate draft pages for new commands')
  .option('--output-dir <dir>', 'Output directory for generated AsciiDoc', 'modules/reference/pages/rpk')
  .option('--cloud-secret-dir <dir>', 'Output directory for rpk cloud and rpk security secret commands (defaults to partials relative to output-dir)')
  .option('--data-dir <dir>', 'Directory for versioned JSON and diff files', 'docs-data')
  .option('--preserve-from <path>', 'Path to existing docs to preserve cloud conditionals from')
  .option('--print-summary', 'Print PR summary (for GitHub Actions)')
  .option('--summary-file <path>', 'Write PR summary to file (for GitHub Actions)')
  .option('--show-info', 'Include info-level validation messages')
  .action(async (options) => {
    try {
      const { handleRpkDocsGeneration } = require('../tools/rpk-docs/rpk-docs-handler.js')

      if (options.plugin && !options.fromJson) {
        console.error('Error: --plugin requires --from-json <snapshot>')
        console.error('A plugin refresh splices the fresh subtree into an existing committed snapshot.')
        process.exit(1)
      }

      // Handle --update-whats-new with optional path
      let whatsNewPath = null
      if (options.updateWhatsNew !== undefined) {
        // If true (flag without path), use default; if string, use that path
        whatsNewPath = typeof options.updateWhatsNew === 'string'
          ? options.updateWhatsNew
          : 'modules/get-started/pages/release-notes/redpanda.adoc'
      }

      const result = await handleRpkDocsGeneration({
        ref: options.ref,
        fromSource: options.fromSource,
        fromJson: options.fromJson,
        plugin: options.plugin,
        pluginVersion: options.pluginVersion,
        pluginPins: options.pluginPin,
        rpkBin: options.rpkBin,
        overrides: options.overrides,
        diff: options.diff,
        updateWhatsNew: whatsNewPath,
        draftMissing: options.draftMissing,
        outputDir: options.outputDir,
        cloudSecretDir: options.cloudSecretDir,
        dataDir: options.dataDir,
        preserveFrom: options.preserveFrom,
        printSummary: options.printSummary,
        showInfo: options.showInfo
      })

      if (result.success) {
        if (result.skipped) {
          console.log(`\n✓ Skipped: ${result.reason}`)
          process.exit(0)
        }
        console.log('\n✓ rpk documentation generated successfully')

        // Write PR summary to file if requested (useful for GitHub Actions)
        if (options.summaryFile && result.prSummary) {
          fs.writeFileSync(options.summaryFile, result.prSummary, 'utf8')
          console.log(`PR summary written to: ${options.summaryFile}`)
        }

        // Exit with warning if validation errors found
        if (result.validationResult?.summary?.totalErrors > 0) {
          console.error(`\n⚠ Validation found ${result.validationResult.summary.totalErrors} error(s)`)
          process.exit(1)
        }

        process.exit(0)
      } else {
        console.error('Error: Generation failed')
        process.exit(1)
      }
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

/**
 * generate rpk-env-partial
 *
 * @description
 * Generates the -X option -> RPK_* environment variable mapping table as an
 * AsciiDoc partial from rpk's own -X option data, so the table cannot drift
 * from the CLI. Prefers the structured x_options array in `rpk --print-tree`
 * (which carries the env var names rpk itself derives) and falls back to
 * parsing `-X list` text for rpk versions that predate it. Hidden -X options
 * appear in neither source, so they are excluded automatically.
 *
 * The main rpk-docs pipeline also writes this partial from the tree it
 * already holds; this standalone command is for targeted refreshes without
 * a full generation run.
 *
 * @example
 * # Generate for a release tag (sparse-clones redpanda, builds rpk with Go)
 * npx doc-tools generate rpk-env-partial --ref v26.2.1 --output modules/reference/partials/rpk-env-vars.adoc
 *
 * # Use a local source checkout (as-is, no checkout changes), an existing
 * # rpk binary, or a versioned tree snapshot (no clone or build at all)
 * npx doc-tools generate rpk-env-partial --from-source ~/redpanda --output modules/reference/partials/rpk-env-vars.adoc
 * npx doc-tools generate rpk-env-partial --rpk-bin "$(command -v rpk)" --output modules/reference/partials/rpk-env-vars.adoc
 * npx doc-tools generate rpk-env-partial --from-json docs-data/rpk-v26.2.1.json --output modules/reference/partials/rpk-env-vars.adoc
 */
automation
  .command('rpk-env-partial')
  .description('Generate the -X -> RPK_* env var mapping partial from rpk -X list output.')
  .option('-r, --ref <ref>', 'Git branch or tag to build rpk from (e.g., dev, v26.2.1). Clones from GitHub.')
  .option('--from-source <path>', 'Path to local rpk source (src/go/rpk directory)')
  .option('--rpk-bin <path>', 'Path to an existing rpk binary (skips clone and build)')
  .option('--from-json <path>', 'Versioned tree snapshot from docs-data (skips clone and build; requires a snapshot with x_options)')
  .option('--output <path>', 'Path to write the partial to', 'modules/reference/partials/rpk-env-vars.adoc')
  .action((options) => {
    try {
      const { handleXEnvPartialGeneration } = require('../tools/rpk-docs/generate-x-env-partial.js')
      const result = handleXEnvPartialGeneration({
        ref: options.ref,
        fromSource: options.fromSource,
        rpkBin: options.rpkBin,
        fromJson: options.fromJson,
        output: options.output
      })
      console.log(`Wrote ${result.keyCount} -X option mappings to ${result.output} (source: ${result.source})`)
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

/**
 * generate rpk-plugin-stubs
 *
 * @description
 * Reconciles a consumer repo's single-source stub pages and nav section
 * against the rpk plugin partials generated in the docs repo. Run from the
 * consumer repo root (for example, adp-docs for rpk ai). Creates stubs for
 * new partials, deletes managed stubs whose partial is gone, rebuilds the
 * plugin's nav block, and proposes page aliases for likely renames.
 * Full reconcile, so it is idempotent and heals pre-existing drift.
 */
automation
  .command('rpk-plugin-stubs')
  .description('Reconcile single-source stub pages and nav against the docs repo\'s rpk plugin partials. Run from the consumer repo root.')
  .option('--plugin <name>', 'rpk plugin command name', 'ai')
  .option('--docs-repo <owner/repo>', 'Docs repo that owns the partials', 'redpanda-data/docs')
  .option('--docs-ref <ref>', 'Branch or tag to read partials from', 'main')
  .option('--partials-dir <path>', 'Local partials directory (skips cloning the docs repo)')
  .option('--source-path <path>', 'Path in the docs repo to read from (default: modules/reference/partials/rpk-<plugin>; use modules/reference/pages/rpk/rpk-connect for page-family content)')
  .option('--stub-dir <path>', 'Stub pages directory in the consumer repo (default: modules/reference/pages/rpk/rpk-<plugin>)')
  .option('--nav-file <path>', 'Nav file whose plugin block is rebuilt', 'modules/ROOT/nav.adoc')
  .option('--include-prefix <prefix>', 'Antora resource prefix for stub includes. Default: inferred from an existing stub.')
  .option('--attribute <line>', 'Page attribute line added to new stubs (repeatable)', (value, acc) => { acc.push(value); return acc }, [])
  .option('--summary-file <path>', 'Write a markdown summary (for PR bodies)')
  .option('--dry-run', 'Report what would change without writing')
  .action(async (options) => {
    try {
      const {
        readPartialTitles, fetchPartialsDir, inferIncludePrefix, reconcileStubs
      } = require('../tools/rpk-docs/generate-plugin-stubs.js')

      const plugin = options.plugin
      const stubDir = options.stubDir || `modules/reference/pages/rpk/rpk-${plugin}`
      const partialsDir = options.partialsDir || fetchPartialsDir({
        docsRepo: options.docsRepo,
        docsRef: options.docsRef,
        plugin,
        sourcePath: options.sourcePath
      })

      const includePrefix = options.includePrefix || inferIncludePrefix(stubDir, plugin)
      if (!includePrefix) {
        console.error('Error: could not infer the include prefix (no existing stubs). Pass --include-prefix, for example: streaming:reference:partial$rpk-ai/')
        process.exit(1)
      }

      const partials = readPartialTitles(partialsDir)
      console.log(`Reconciling ${partials.length} partial(s) against ${stubDir}`)

      const result = reconcileStubs({
        partials,
        stubDir,
        navFile: options.navFile,
        plugin,
        includePrefix,
        ...(options.attribute.length > 0 ? { attributes: options.attribute } : {}),
        dryRun: options.dryRun
      })

      console.log(`  Created: ${result.created.length}, deleted: ${result.deleted.length}, nav updated: ${result.navUpdated}`)
      for (const f of result.created) console.log(`  + ${f}`)
      for (const f of result.deleted) console.log(`  - ${f}`)
      for (const f of result.keptNonStub) console.log(`  ! kept (not a managed stub): ${f}`)

      const lines = []
      lines.push(`## rpk ${plugin} stub reconciliation`)
      lines.push('')
      lines.push(`Reconciled against \`${options.partialsDir ? partialsDir : `${options.docsRepo}@${options.docsRef}`}\`.`)
      lines.push('')
      if (result.created.length + result.deleted.length === 0 && !result.navUpdated) {
        lines.push('No changes: stubs and nav already match the partials.')
      }
      if (result.created.length > 0) {
        lines.push(`### New stubs (${result.created.length})`)
        lines.push('')
        result.created.forEach(f => lines.push(`- \`${f}\``))
        lines.push('')
      }
      if (result.deleted.length > 0) {
        lines.push(`### Deleted stubs (${result.deleted.length})`)
        lines.push('')
        result.deleted.forEach(f => lines.push(`- \`${f}\``))
        lines.push('')
      }
      if ((result.skippedAliasTargets || []).length > 0) {
        lines.push('### Skipped: names claimed as page aliases')
        lines.push('')
        lines.push('These partials exist upstream, but a page here already claims the name as a `:page-aliases:` target — creating the stub would make the Antora build fatal. Usually this means a rename alias exists while the upstream partial for the old name has not been cleaned up yet:')
        lines.push('')
        for (const t of result.skippedAliasTargets) {
          lines.push(`- \`${t.file}\` (claimed by \`${t.claimedBy}\`)`)
        }
        lines.push('')
      }
      const straightDeletions = result.deleted.filter(d => !result.renameCandidates.some(rc => rc.deleted === d))
      if (straightDeletions.length > 0) {
        lines.push('### Deletions with no rename partner')
        lines.push('')
        lines.push('These pages were removed with no successor detected. Their published URLs will 404 — consider adding a redirect or an alias on a related page:')
        lines.push('')
        straightDeletions.forEach(f => lines.push(`- \`${f}\``))
        lines.push('')
      }
      if (result.renameCandidates.length > 0) {
        lines.push('### Possible renames — reviewer decision needed')
        lines.push('')
        lines.push('These deleted/created pairs look like renames. If so, add `:page-aliases:` for the old page name to the new stub so published URLs keep working:')
        lines.push('')
        for (const rc of result.renameCandidates) {
          lines.push(`- \`${rc.deleted}\` → \`${rc.created}\`: add \`:page-aliases: reference:rpk/rpk-${plugin}/${rc.deleted}\` to the new stub`)
        }
        lines.push('')
      }
      if (result.keptNonStub.length > 0) {
        lines.push('### Kept (not managed stubs)')
        lines.push('')
        lines.push('These pages do not match the managed stub shape, so they were not touched:')
        lines.push('')
        result.keptNonStub.forEach(f => lines.push(`- \`${f}\``))
        lines.push('')
      }
      const summary = lines.join('\n')
      if (options.summaryFile) {
        fs.writeFileSync(options.summaryFile, summary, 'utf8')
        console.log(`Summary written to: ${options.summaryFile}`)
      }

      process.exit(0)
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })



/**
 * generate helm-spec
 *
 * @description
 * Generates Helm chart reference documentation by parsing values.yaml files and README.md
 * documentation from Helm chart repositories. Supports both local chart directories and
 * GitHub URLs. Extracts all configuration options with their types, defaults, and descriptions,
 * and generates comprehensive AsciiDoc documentation. Can process single charts or entire
 * chart repositories with multiple charts.
 *
 * @why
 * Helm charts have complex configuration with hundreds of values. The values.yaml file and
 * chart README contain the configuration options, but they're not in a documentation-friendly
 * format. This automation parses the YAML structure and README documentation to generate
 * comprehensive reference documentation. Supporting both local and GitHub sources allows
 * documenting charts from any source without manual cloning.
 *
 * @example
 * # Generate docs from GitHub repository
 * npx doc-tools generate helm-spec \
 *   --chart-dir https://github.com/redpanda-data/helm-charts \
 *   --tag v5.9.0 \
 *   --output-dir modules/deploy/pages
 *
 * # Generate docs from local chart directory
 * npx doc-tools generate helm-spec \
 *   --chart-dir ./charts/redpanda \
 *   --output-dir docs/modules/deploy/pages
 *
 * # Use custom README and output suffix
 * npx doc-tools generate helm-spec \
 *   --chart-dir https://github.com/redpanda-data/helm-charts \
 *   --tag v5.9.0 \
 *   --readme docs/README.md \
 *   --output-suffix -values.adoc
 *
 * @requirements
 * - For GitHub URLs: Git and internet connection
 * - For local charts: Chart directory must contain Chart.yaml
 * - README.md file in chart directory (optional but recommended)
 * - helm-docs and pandoc must be installed
 */
automation
  .command('helm-spec')
  .description('Generate AsciiDoc documentation for Helm charts. Requires either --tag or --branch for GitHub URLs.')
  .option('--chart-dir <dir|url>', 'Chart directory or GitHub URL', 'https://github.com/redpanda-data/redpanda-operator/charts')
  .option('-t, --tag <tag>', 'Git tag for released content')
  .option('-b, --branch <branch>', 'Branch name for in-progress content')
  .option('--readme <file>', 'Relative README.md path inside each chart dir', 'README.md')
  .option('--output-dir <dir>', 'Where to write generated AsciiDoc files', 'modules/reference/pages')
  .option('--output-suffix <suffix>', 'Suffix to append to each chart name', '-helm-spec.adoc')
  .action((opts) => {
    verifyHelmDependencies()

    let root = opts.chartDir
    let tmpClone = null

    if (/^https?:\/\/github\.com\//.test(root)) {
      if (!opts.tag && !opts.branch) {
        console.error('Error: When using a GitHub URL you must pass either --tag or --branch')
        process.exit(1)
      }
      if (opts.tag && opts.branch) {
        console.error('Error: Cannot specify both --tag and --branch')
        process.exit(1)
      }

      let gitRef = opts.tag || opts.branch

      if (opts.tag && !gitRef.startsWith('v')) {
        gitRef = `v${gitRef}`
        console.log(`ℹ️  Auto-prepending "v" to tag: ${gitRef}`)
      }

      const u = new URL(root)
      const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
      if (parts.length < 2) {
        console.error(`Error: Invalid GitHub URL: ${root}`)
        process.exit(1)
      }
      const [owner, repo, ...sub] = parts
      const repoUrl = `https://${u.host}/${owner}/${repo}.git`

      if (opts.tag && owner === 'redpanda-data' && repo === 'redpanda-operator') {
        if (!gitRef.startsWith('operator/')) {
          gitRef = `operator/${gitRef}`
          console.log(`ℹ️  Auto-prepending "operator/" to tag: ${gitRef}`)
        }
      }

      console.log(`Verifying ${repoUrl}@${gitRef}…`)
      const ok = spawnSync(
        'git',
        ['ls-remote', '--exit-code', repoUrl, `refs/heads/${gitRef}`, `refs/tags/${gitRef}`],
        { stdio: 'ignore' }
      ).status === 0
      if (!ok) {
        console.error(`Error: ${gitRef} not found on ${repoUrl}`)
        process.exit(1)
      }

      const { getAuthenticatedGitHubUrl, hasGitHubToken } = require('../cli-utils/github-token')

      tmpClone = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-'))

      let cloneUrl = repoUrl
      if (hasGitHubToken() && repoUrl.includes('github.com')) {
        cloneUrl = getAuthenticatedGitHubUrl(repoUrl)
        console.log(`Cloning ${repoUrl}@${gitRef} → ${tmpClone} (authenticated)`)
      } else {
        console.log(`Cloning ${repoUrl}@${gitRef} → ${tmpClone}`)
      }

      if (spawnSync('git', ['clone', '--depth', '1', '--branch', gitRef, cloneUrl, tmpClone], { stdio: 'inherit' }).status !== 0) {
        console.error('Error: git clone failed')
        process.exit(1)
      }
      root = sub.length ? path.join(tmpClone, sub.join('/')) : tmpClone
    }

    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      console.error(`Error: Chart root not found: ${root}`)
      process.exit(1)
    }
    let charts = []
    if (fs.existsSync(path.join(root, 'Chart.yaml'))) {
      charts = [root]
    } else {
      charts = fs.readdirSync(root)
        .map((n) => path.join(root, n))
        .filter((p) => fs.existsSync(path.join(p, 'Chart.yaml')))
    }
    if (charts.length === 0) {
      console.error(`Error: No charts found under: ${root}`)
      process.exit(1)
    }

    const outDir = path.resolve(opts.outputDir)
    fs.mkdirSync(outDir, { recursive: true })

    for (const chartPath of charts) {
      const name = path.basename(chartPath)
      console.log(`Processing chart "${name}"…`)

      console.log(`helm-docs in ${chartPath}`)
      let r = spawnSync('helm-docs', { cwd: chartPath, stdio: 'inherit' })
      if (r.status !== 0) process.exit(r.status)

      const md = path.join(chartPath, opts.readme)
      if (!fs.existsSync(md)) {
        console.error(`Error: README not found: ${md}`)
        process.exit(1)
      }
      const outFile = path.join(outDir, `k-${name}${opts.outputSuffix}`)
      console.log(`pandoc ${md} → ${outFile}`)
      fs.mkdirSync(path.dirname(outFile), { recursive: true })
      r = spawnSync('pandoc', [md, '-t', 'asciidoc', '-o', outFile], { stdio: 'inherit' })
      if (r.status !== 0) process.exit(r.status)

      const { formatHelmSpec } = require('../cli-utils/format-helm-spec')
      let doc = formatHelmSpec(fs.readFileSync(outFile, 'utf8'))

      // helm-docs only renders keys that exist in the YAML tree, so optional
      // values that ship commented out never appear in the reference. Pull
      // documented commented-out keys from values.yaml and inject them. This
      // runs after formatHelmSpec so the injected body sections are not affected
      // by the blank-line normalization that its header fix performs.
      const valuesFile = path.join(chartPath, 'values.yaml')
      if (fs.existsSync(valuesFile)) {
        const { extractCommentedValueDocs, injectIntoAsciiDoc, filterEntriesBySchema } = require('../cli-utils/helm-commented-values')
        try {
          let entries = extractCommentedValueDocs(fs.readFileSync(valuesFile, 'utf8'))

          // Deprecation notices and other prose can produce paths the chart
          // no longer accepts (for example the removed
          // storage.tiered.credentialsSecretRef.configurationKey). When the
          // chart ships a values schema, drop any path it provably rejects.
          const schemaFile = path.join(chartPath, 'values.schema.json')
          if (entries.length > 0 && fs.existsSync(schemaFile)) {
            const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'))
            const { accepted, rejected } = filterEntriesBySchema(entries, schema)
            if (rejected.length > 0) {
              console.warn(`Warning: Skipping ${rejected.length} commented-out value(s) rejected by values.schema.json: ${rejected.map((e) => e.path).join(', ')}`)
            }
            entries = accepted
          }

          if (entries.length > 0) {
            const { doc: withInjected, injected, sectionsFound } = injectIntoAsciiDoc(doc, entries)
            doc = withInjected
            if (injected.length > 0) {
              console.log(`Documented ${injected.length} commented-out value(s): ${injected.join(', ')}`)
            } else if (sectionsFound === 0) {
              // Without this, a heading-level change upstream would silently
              // drop every documented commented-out value from the reference.
              console.warn(`Warning: No value section headings found in ${name} to anchor commented-out value docs; dropped: ${entries.map((e) => e.path).join(', ')}`)
            }
          }
        } catch (err) {
          console.warn(`Warning: Skipping commented-out value docs for ${name}: ${err.message}`)
        }
      }

      fs.writeFileSync(outFile, doc, 'utf8')

      console.log(`Done: Wrote ${outFile}`)
    }

    if (tmpClone) fs.rmSync(tmpClone, { recursive: true, force: true })
  })

/**
 * generate cloud-regions
 *
 * @description
 * Generates a formatted table of Redpanda Cloud regions, tiers, and availability information
 * by fetching data from the private cloudv2-infra repository. Reads a YAML configuration file
 * that contains master data for cloud infrastructure, parses region and tier information, and
 * generates either Markdown or AsciiDoc tables for documentation. Supports custom templates
 * and dry-run mode for previewing output.
 *
 * A custom template is a Handlebars file inside this repository and receives this context:
 * `providers`, each with `name` ("GCP"), `displayName` ("Google Cloud Platform (GCP)") and
 * `regions`, each region with `name`, `zones` (comma separated) and `tiers`; `clusterType`,
 * the cluster type the data was filtered to, set only with --cluster-type, in which case the
 * tier entries carry no per-tier cluster type; and `lastUpdated`, an ISO timestamp. The
 * bundled templates in tools/cloud-regions show all of it in use. The template decides the
 * markup, so with --template the --format value is only checked for validity.
 *
 * @why
 * Cloud region data changes frequently as new regions are added and tier availability evolves.
 * The cloudv2-infra repository contains the source of truth for cloud infrastructure. Manual
 * documentation becomes outdated quickly. This automation fetches the latest data directly from
 * the infrastructure repository, ensuring documentation always reflects current cloud offerings.
 * Weekly or triggered updates keep docs in sync with cloud expansion.
 *
 * @example
 * # Basic: Generate Markdown table
 * export GITHUB_TOKEN=ghp_xxx
 * npx doc-tools generate cloud-regions
 *
 * # Generate AsciiDoc format
 * export GITHUB_TOKEN=ghp_xxx
 * npx doc-tools generate cloud-regions --format adoc
 *
 * # Preview without writing file
 * export GITHUB_TOKEN=ghp_xxx
 * npx doc-tools generate cloud-regions --dry-run
 *
 * # Use custom output file
 * export GITHUB_TOKEN=ghp_xxx
 * npx doc-tools generate cloud-regions \
 *   --output custom/path/regions.md
 *
 * # Generate an AsciiDoc partial for one cluster type with a custom template
 * export GITHUB_TOKEN=ghp_xxx
 * npx doc-tools generate cloud-regions --format adoc --cluster-type BYOC \
 *   --template docs-data/templates/cloud-regions.hbs \
 *   --output modules/reference/partials/generated/regions-byoc.adoc
 *
 * # Use different branch for testing
 * export GITHUB_TOKEN=ghp_xxx
 * npx doc-tools generate cloud-regions --ref staging
 *
 * @requirements
 * - GitHub token with access to redpanda-data/cloudv2-infra repository
 * - Token must be set via GITHUB_TOKEN, GH_TOKEN, or REDPANDA_GITHUB_TOKEN environment variable
 * - Internet connection to access GitHub API
 */
automation
  .command('cloud-regions')
  .description('Generate Markdown table of cloud regions and tiers from GitHub YAML file')
  .option('--output <file>', 'Output file (relative to repo root, must stay inside the repository)', 'cloud-controlplane/x-topics/cloud-regions.md')
  .option('--format <fmt>', 'Output format: md (Markdown) or adoc (AsciiDoc)', 'md')
  .option('--owner <owner>', 'GitHub repository owner', 'redpanda-data')
  .option('--repo <repo>', 'GitHub repository name', 'cloudv2-infra')
  .option('--path <path>', 'Path to YAML file in repository', 'apps/master-data-reconciler/manifests/overlays/production/master-data.yaml')
  .option('--ref <ref>', 'Git reference (branch, tag, or commit SHA)', 'integration')
  .option('--template <path>', 'Path to custom Handlebars template (relative to repo root, must stay inside the repository)')
  .option('--cluster-type <type>', 'Only include regions/tiers available for this cluster type, such as BYOC or Dedicated (requires --output or --dry-run)')
  .option('--dry-run', 'Print output to stdout instead of writing file')
  .action(async (options, command) => {
    const { generateCloudRegions } = require('../tools/cloud-regions/generate-cloud-regions.js')
    const { getGitHubToken } = require('../cli-utils/github-token')

    try {
      // The default output path holds the unfiltered table, so a filtered run
      // that forgets --output silently replaces it, and the documented
      // BYOC-then-Dedicated pair would leave only whichever ran last.
      if (options.clusterType && !options.dryRun && command.getOptionValueSource('output') === 'default') {
        throw new Error('--cluster-type needs its own destination: pass --output <file> for the filtered table, or --dry-run to preview it.')
      }
      // Contain every caller-supplied path before doing any work: both options
      // are also reachable through the MCP server, so --template must not read
      // and --output must not write outside the repository.
      const repoRoot = findRepoRoot()
      const templatePath = options.template
        ? resolveInsideRepo(repoRoot, options.template, '--template')
        : undefined
      if (templatePath && !fs.existsSync(templatePath)) {
        throw new Error(`Custom template not found: ${templatePath}`)
      }
      const absOutput = options.dryRun
        ? undefined
        : resolveInsideRepo(repoRoot, options.output, '--output')
      const token = getGitHubToken()
      if (!token) {
        throw new Error('GitHub token is required to fetch from private cloudv2-infra repo.')
      }
      const fmt = (options.format || 'md').toLowerCase()
      const out = await generateCloudRegions({
        owner: options.owner,
        repo: options.repo,
        path: options.path,
        ref: options.ref,
        format: fmt,
        token,
        template: templatePath,
        clusterType: options.clusterType
      })
      if (options.dryRun) {
        process.stdout.write(out)
        console.log(`\nDone: (dry-run) ${fmt === 'adoc' ? 'AsciiDoc' : 'Markdown'} output printed to stdout.`)
      } else {
        fs.mkdirSync(path.dirname(absOutput), { recursive: true })
        fs.writeFileSync(absOutput, out, 'utf8')
        console.log(`Done: Wrote ${absOutput}`)
      }
    } catch (err) {
      console.error(`Error: Failed to generate cloud regions: ${err.message}`)
      process.exit(1)
    }
  })

/**
 * generate crd-spec
 *
 * @description
 * Generates Kubernetes Custom Resource Definition (CRD) reference documentation by parsing
 * Go type definitions from the Redpanda Operator repository. Uses the crd-ref-docs tool to
 * extract API field definitions, types, descriptions, and validation rules from Go struct tags
 * and comments, then generates comprehensive AsciiDoc documentation. Supports both local Go
 * source directories and GitHub URLs for operator versions.
 *
 * When to use --tag vs --branch:
 * - Use --tag for released content (GA or beta releases). Tags reference specific release points.
 * - Use --branch for in-progress content (unreleased features). Branches track ongoing development.
 *
 * @why
 * Kubernetes CRDs define complex APIs for deploying and managing Redpanda. The API schema
 * is defined in Go code with hundreds of fields across nested structures. Manual documentation
 * is error-prone and becomes outdated as the API evolves. This automation uses specialized
 * tooling (crd-ref-docs) to extract API documentation directly from Go source code, ensuring
 * accuracy and completeness. It captures field types, validation rules, and descriptions that
 * are essential for users configuring Redpanda in Kubernetes.
 *
 * @example
 * # Generate CRD docs for specific operator tag
 * npx doc-tools generate crd-spec --tag operator/v2.2.6-25.3.1
 *
 * # Version without prefix (auto-prepends operator/)
 * npx doc-tools generate crd-spec --tag v25.1.2
 *
 * # Generate from release branch
 * npx doc-tools generate crd-spec --branch release/v2.2.x
 *
 * # Generate from main branch
 * npx doc-tools generate crd-spec --branch main
 *
 * # Generate from any custom branch
 * npx doc-tools generate crd-spec --branch dev
 *
 * # Use custom templates and output location
 * npx doc-tools generate crd-spec \
 *   --tag operator/v2.2.6-25.3.1 \
 *   --templates-dir custom/templates \
 *   --output modules/reference/pages/operator-crd.adoc
 *
 * @requirements
 * - For GitHub URLs: Git and internet connection
 * - crd-ref-docs tool (automatically installed if missing)
 * - Go toolchain for running crd-ref-docs
 */
automation
  .command('crd-spec')
  .description('Generate Asciidoc documentation for Kubernetes CRD references. Requires either --tag or --branch.')
  .option('-t, --tag <operatorTag>', 'Operator release tag for GA/beta content')
  .option('-b, --branch <branch>', 'Branch name for in-progress content')
  .option('-s, --source-path <src>', 'CRD Go types dir or GitHub URL', 'https://github.com/redpanda-data/redpanda-operator/operator/api/redpanda/v1alpha2')
  .option('-d, --depth <n>', 'How many levels deep', '10')
  .option('--templates-dir <dir>', 'Asciidoctor templates dir', '.github/crd-config/templates/asciidoctor/operator')
  .option('--output <file>', 'Where to write the generated AsciiDoc file', 'modules/reference/pages/k-crd.adoc')
  .action(async (opts) => {
    verifyCrdDependencies()

    if (!opts.tag && !opts.branch) {
      console.error('Error: Either --tag or --branch must be specified')
      process.exit(1)
    }
    if (opts.tag && opts.branch) {
      console.error('Error: Cannot specify both --tag and --branch')
      process.exit(1)
    }

    let configRef = opts.branch || (opts.tag.startsWith('operator/') ? opts.tag : `operator/${opts.tag}`)

    const configTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-config-'))
    console.log(`Fetching crd-ref-docs-config.yaml from redpanda-operator@${configRef}…`)
    await fetchFromGithub(
      'redpanda-data',
      'redpanda-operator',
      'operator/crd-ref-docs-config.yaml',
      configTmp,
      'crd-ref-docs-config.yaml',
      configRef
    )
    const configPath = path.join(configTmp, 'crd-ref-docs-config.yaml')

    const repoRoot = findRepoRoot()
    const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    const inDocs = pkgJson.name === 'redpanda-docs-playbook' || (pkgJson.repository && pkgJson.repository.url.includes('redpanda-data/docs'))
    let docsBranch = null

    if (!inDocs) {
      console.warn('⚠️ Not inside redpanda-data/docs; skipping branch suggestion.')
    } else {
      try {
        docsBranch = await determineDocsBranch(configRef)
        console.log(`Done: Detected docs repo; you should commit to branch '${docsBranch}'.`)
      } catch (err) {
        console.error(`Error: Unable to determine docs branch: ${err.message}`)
        process.exit(1)
      }
    }

    if (!fs.existsSync(opts.templatesDir)) {
      console.error(`Error: Templates directory not found: ${opts.templatesDir}`)
      process.exit(1)
    }

    let localSrc = opts.sourcePath
    let tmpSrc
    if (/^https?:\/\/github\.com\//.test(opts.sourcePath)) {
      const u = new URL(opts.sourcePath)
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts.length < 2) {
        console.error(`Error: Invalid GitHub URL: ${opts.sourcePath}`)
        process.exit(1)
      }
      const [owner, repo, ...subpathParts] = parts
      const repoUrl = `https://${u.host}/${owner}/${repo}`
      const subpath = subpathParts.join('/')
      console.log(`Verifying "${configRef}" in ${repoUrl}…`)
      const ok = spawnSync('git', ['ls-remote', '--exit-code', repoUrl, `refs/tags/${configRef}`, `refs/heads/${configRef}`], { stdio: 'ignore' }).status === 0
      if (!ok) {
        console.error(`Error: Tag or branch "${configRef}" not found on ${repoUrl}`)
        process.exit(1)
      }
      const { getAuthenticatedGitHubUrl, hasGitHubToken } = require('../cli-utils/github-token')

      tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-src-'))

      let cloneUrl = repoUrl
      if (hasGitHubToken() && repoUrl.includes('github.com')) {
        cloneUrl = getAuthenticatedGitHubUrl(repoUrl)
        console.log(`Cloning ${repoUrl}@${configRef} → ${tmpSrc} (authenticated)`)
      } else {
        console.log(`Cloning ${repoUrl}@${configRef} → ${tmpSrc}`)
      }

      if (spawnSync('git', ['clone', '--depth', '1', '--branch', configRef, cloneUrl, tmpSrc], { stdio: 'inherit' }).status !== 0) {
        console.error('Error: git clone failed')
        process.exit(1)
      }
      localSrc = subpath ? path.join(tmpSrc, subpath) : tmpSrc
      if (!fs.existsSync(localSrc)) {
        console.error(`Error: Subdirectory not found in repo: ${subpath}`)
        process.exit(1)
      }
    }

    const outputDir = path.dirname(opts.output)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    const args = [
      '--source-path', localSrc,
      '--max-depth', opts.depth,
      '--templates-dir', opts.templatesDir,
      '--config', configPath,
      '--renderer', 'asciidoctor',
      '--output-path', opts.output
    ]
    console.log(`Running crd-ref-docs ${args.join(' ')}`)
    if (spawnSync('crd-ref-docs', args, { stdio: 'inherit' }).status !== 0) {
      console.error('Error: crd-ref-docs failed')
      process.exit(1)
    }

    // docs.redpanda.com URLs are left as-is: the url-to-xref Antora
    // extension converts them to validated xrefs at site build time.

    if (tmpSrc) fs.rmSync(tmpSrc, { recursive: true, force: true })
    fs.rmSync(configTmp, { recursive: true, force: true })

    console.log(`Done: CRD docs generated at ${opts.output}`)
    if (inDocs) {
      console.log(`ℹ️ Don't forget to commit your changes on branch '${docsBranch}'.`)
    }
  })

/**
 * generate bundle-openapi
 *
 * @description
 * Bundles Redpanda's OpenAPI specification fragments into complete, usable OpenAPI 3.1 documents
 * for both Admin API and Connect API. Clones the Redpanda repository at a specified version,
 * collects OpenAPI fragments that are distributed throughout the codebase (alongside endpoint
 * implementations), uses Buf and Redocly CLI to bundle and validate the specifications, and
 * generates separate complete OpenAPI files for each API surface. The resulting specifications
 * can be used for API documentation, client SDK generation, or API testing tools.
 *
 * @why
 * Redpanda's API documentation is defined as OpenAPI fragments alongside the C++ implementation
 * code. This keeps API docs close to code and ensures they stay in sync, but it means the
 * specification is fragmented across hundreds of files. Users need complete OpenAPI specifications
 * for tooling (Swagger UI, Postman, client generators). This automation collects all fragments,
 * bundles them into valid OpenAPI 3.1 documents, and validates the result. It's the only way
 * to produce accurate, complete API specifications that match a specific Redpanda version.
 *
 * @example
 * # Bundle both Admin and Connect APIs
 * npx doc-tools generate bundle-openapi \
 *   --tag v25.3.1 \
 *   --surface both
 *
 * # Bundle only Admin API
 * npx doc-tools generate bundle-openapi \
 *   --tag v25.3.1 \
 *   --surface admin
 *
 * # Use custom output paths
 * npx doc-tools generate bundle-openapi \
 *   --tag v25.3.1 \
 *   --surface both \
 *   --out-admin api/admin-api.yaml \
 *   --out-connect api/connect-api.yaml
 *
 * # Use major version for Admin API version field
 * npx doc-tools generate bundle-openapi \
 *   --tag v25.3.1 \
 *   --surface admin \
 *   --use-admin-major-version
 *
 * # Full workflow: generate API specs for new release
 * VERSION=$(npx doc-tools get-redpanda-version)
 * npx doc-tools generate bundle-openapi --tag $VERSION --surface both
 *
 * @requirements
 * - Git to clone the streaming-enterprise repository
 * - A GitHub token (GH_TOKEN, GITHUB_TOKEN, or REDPANDA_GITHUB_TOKEN) with
 *   access to redpanda-data/streaming-enterprise, which is private
 * - Buf tool (automatically installed via npm)
 * - Redocly CLI or vacuum for OpenAPI bundling (automatically detected)
 * - Internet connection to clone repository
 * - Sufficient disk space for repository clone (~2GB)
 */
automation
  .command('bundle-openapi')
  .description('Bundle Redpanda OpenAPI fragments for admin and connect APIs. Requires either --tag or --branch.')
  .option('-t, --tag <tag>', 'Git tag for released content')
  .option('-b, --branch <branch>', 'Branch name for in-progress content')
  .option('--repo <url>', 'Repository URL. The default is a private repo, so requires a GitHub token (GH_TOKEN, GITHUB_TOKEN, or REDPANDA_GITHUB_TOKEN)', 'https://github.com/redpanda-data/streaming-enterprise.git')
  .addOption(new Option('-s, --surface <surface>', 'Which API surfaces to bundle').choices(['admin', 'connect', 'both']).makeOptionMandatory())
  .option('--out-admin <path>', 'Output path for admin API', 'admin/redpanda-admin-api.yaml')
  .option('--out-connect <path>', 'Output path for connect API', 'connect/redpanda-connect-api.yaml')
  .option('--admin-major <string>', 'Admin API major version', 'v2.0.0')
  .option('--use-admin-major-version', 'Use admin major version for info.version instead of git tag', false)
  .option('--quiet', 'Suppress logs', false)
  .action(async (options) => {
    if (!options.tag && !options.branch) {
      console.error('Error: Either --tag or --branch must be specified')
      process.exit(1)
    }
    if (options.tag && options.branch) {
      console.error('Error: Cannot specify both --tag and --branch')
      process.exit(1)
    }

    const gitRef = options.tag || options.branch
    requireCmd('git', 'Install Git: https://git-scm.com/downloads')
    requireCmd('buf', 'buf should be automatically available after npm install')

    try {
      const { detectBundler } = require('../tools/bundle-openapi.js')
      detectBundler(true)
    } catch (err) {
      fail(err.message)
    }

    try {
      const { bundleOpenAPI } = require('../tools/bundle-openapi.js')
      await bundleOpenAPI({
        tag: gitRef,
        repo: options.repo,
        surface: options.surface,
        outAdmin: options.outAdmin,
        outConnect: options.outConnect,
        adminMajor: options.adminMajor,
        useAdminMajorVersion: options.useAdminMajorVersion,
        quiet: options.quiet
      })
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(err.message.includes('Validation failed') ? 2 : 1)
    }
  })

/**
 * @description Update the Redpanda Connect version attribute in antora.yml by fetching
 * the latest release tag from GitHub or using a specified version.
 * @why Use this command before generating Connect connector docs to ensure the version
 * attribute is current. It updates the latest-connect-version attribute automatically.
 * @example
 * # Update to the latest version from GitHub
 * npx doc-tools generate update-connect-version
 *
 * # Update to a specific version
 * npx doc-tools generate update-connect-version --connect-version 4.50.0
 * @requirements None (uses GitHub API).
 */
automation
  .command('update-connect-version')
  .description('Update the Redpanda Connect version in antora.yml')
  .option('-v, --connect-version <version>', 'Specific Connect version (default: fetch latest from GitHub)')
  .action(async (options) => {
    const GetLatestConnectTag = require('../extensions/version-fetcher/get-latest-connect')

    try {
      let version

      if (options.connectVersion) {
        version = options.connectVersion.replace(/^v/, '')
        console.log(`Updating to specified Connect version: ${version}`)
      } else {
        console.log('Fetching latest Connect version from GitHub...')
        version = await GetLatestConnectTag()
        console.log(`Latest Connect version: ${version}`)
      }

      const currentVersion = getAntoraValue('asciidoc.attributes.latest-connect-version')

      if (currentVersion === version) {
        console.log(`✓ Already at version ${version}`)
        return
      }

      setAntoraValue('asciidoc.attributes.latest-connect-version', version)
      console.log(`Done: Updated latest-connect-version from ${currentVersion} to ${version}`)
      console.log('')
      console.log('Next steps:')
      console.log('  1. Run: npx doc-tools generate rpcn-connector-docs --fetch-connectors')
      console.log('  2. Review and commit the changes')
    } catch (err) {
      console.error(`Error: Failed to update Connect version: ${err.message}`)
      process.exit(1)
    }
  })

const validation = new Command('validate').description('Validate docs data against internal sources of truth')

/**
 * validate rpk-overrides
 *
 * @description
 * Validates the rpk-overrides.json file against the JSON schema and checks for common issues:
 * - Schema compliance (required fields, valid types)
 * - Valid $ref references (no broken or circular refs)
 * - Valid command paths (compared against actual rpk command tree)
 * - Valid admonition locations (after_flags, after_usage, etc.)
 * - Valid platform values (linux, darwin, windows)
 *
 * @why
 * Catching override errors early prevents broken documentation. This command lets writers
 * validate their changes before generation, avoiding cryptic errors during the build process.
 *
 * @example
 * # Validate overrides with default paths
 * npx doc-tools validate rpk-overrides
 *
 * # Validate against a specific rpk tree (for complete command path validation)
 * npx doc-tools validate rpk-overrides --tree docs-data/rpk-v26.2.0.json
 *
 * # Validate a custom overrides file
 * npx doc-tools validate rpk-overrides --overrides my-overrides.json
 *
 * # Strict mode - exit with error code on validation failures
 * npx doc-tools validate rpk-overrides --strict
 *
 * @requirements
 * - rpk-overrides.schema.json in docs-data/
 */
validation
  .command('rpk-overrides')
  .description('Validate rpk-overrides.json against schema and check for common issues')
  .option('--overrides <path>', 'Path to overrides JSON file', 'docs-data/rpk-overrides.json')
  .option('--tree <path>', 'Path to rpk tree JSON file for command path validation (e.g., docs-data/rpk-v26.2.0.json)')
  .option('--strict', 'Exit with error code on validation failures')
  .action((options) => {
    try {
      const { loadAndValidateOverrides } = require('../tools/rpk-docs/validate-overrides.js')
      const repoRoot = findRepoRoot()
      const overridesPath = path.resolve(repoRoot, options.overrides)

      // Load tree if provided for command path validation
      let commandTree = null
      if (options.tree) {
        const treePath = path.resolve(repoRoot, options.tree)
        if (!fs.existsSync(treePath)) {
          console.error(`Error: Tree file not found: ${treePath}`)
          process.exit(1)
        }
        const treeData = JSON.parse(fs.readFileSync(treePath, 'utf8'))
        commandTree = treeData.tree || treeData
      }

      console.log(`Validating: ${overridesPath}`)
      if (commandTree) {
        console.log(`Comparing against tree from: ${options.tree}`)
      } else {
        console.log('Note: Skipping command path validation (no --tree provided)')
      }
      console.log('')

      const { overrides, validation } = loadAndValidateOverrides(overridesPath, commandTree)

      if (!overrides) {
        console.error('Error: Could not load overrides file')
        process.exit(1)
      }

      // Print results
      console.log('=' .repeat(60))
      console.log('VALIDATION RESULTS')
      console.log('='.repeat(60))

      if (validation.errors.length === 0 && validation.warnings.length === 0) {
        console.log('✓ No issues found')
      } else {
        console.log(validation.format())
      }

      console.log('='.repeat(60))
      console.log(`Errors: ${validation.errors.length}`)
      console.log(`Warnings: ${validation.warnings.length}`)
      console.log('='.repeat(60))

      // Exit with appropriate code
      if (options.strict && !validation.valid) {
        console.log('\n✗ Validation failed (strict mode)')
        process.exit(1)
      } else if (validation.valid) {
        console.log('\n✓ Validation passed')
        process.exit(0)
      } else {
        console.log('\n⚠ Validation completed with errors (use --strict to fail)')
        process.exit(0)
      }
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })


/**
 * @description Checks the enterprise features registry (the shared component's
 * enterprise-features.yml in the docs repo) against the internal sources of
 * truth: the license_required_feature enum and config::enterprise<> property
 * wrappers in redpanda core, the enterprise plugins in connect info.csv, and
 * the hand-maintained disable-enterprise-features.adoc table.
 * Exit codes: 0 clean, 1 drift found (error or needs-human findings), 2 execution error.
 *
 * @why A feature must only be documented as enterprise under its approved
 * external name. This check catches new license-gated features in core that
 * have no registry entry yet, registry pointers that no longer match core,
 * and registry connect-plugin entries that no longer match info.csv.
 *
 * @example
 * # Check everything against the default remote sources
 * npx doc-tools validate enterprise-features
 *
 * # Check a local registry file (for example, in docs repo CI)
 * npx doc-tools validate enterprise-features --registry shared/modules/ROOT/partials/enterprise-features.yml
 *
 * # Regenerate the rpk name-mapping partial
 * npx doc-tools validate enterprise-features --write-mapping modules/get-started/partials/licensing/feature-name-mapping.adoc
 *
 * @requirements
 * Network access to raw.githubusercontent.com for any source not supplied
 * with a local path option.
 */
validation
  .command('enterprise-features')
  .description('Check the enterprise features registry against core, connect, and docs sources of truth')
  .option('--registry <path>', 'Local path to enterprise-features.yml (default: fetch from docs repo main)')
  .option('--tag <ref>', 'Redpanda git ref for the core headers', 'dev')
  .option('--connect-ref <ref>', "Connect git ref for info.csv ('latest' resolves the newest release tag; the registry documents released state)", 'latest')
  .option('--docs-ref <ref>', 'Docs repo git ref for remote fetches', 'main')
  .option('--disable-page <path>', 'Local path to disable-enterprise-features.adoc (default: fetch from docs repo)')
  .option('--properties <path>', 'Local path to a generated cluster-properties JSON; enables existence checks for gating properties')
  .option('--skip-connect', 'Skip the connect check (info.csv is not fetched, so registry connect-plugin entries go unverified)')
  .option('--format <format>', 'Output format: text or json', 'text')
  .option('--write-mapping <path>', 'Write the internal-to-external name mapping partial to this path')
  .action(async (options) => {
    const { runChecks, buildMappingPartial } = require('../tools/enterprise-features/verify')
    // Fetch wiring (GitHub auth, rejected-token retry, transient-failure
    // retries, --skip-connect short-circuits) lives in
    // cli-utils/enterprise-sources so it is testable without a network.
    const { loadEnterpriseSources } = require('../cli-utils/enterprise-sources')

    try {
      const { registryYaml, coreHeader, configurationHeader, infoCsv, connectRef, disablePage, failedSources } =
        await loadEnterpriseSources(options)

      let allPropertyNames
      if (options.properties) {
        const propertyData = JSON.parse(fs.readFileSync(path.resolve(options.properties), 'utf8'))
        allPropertyNames = Object.keys(propertyData.properties || propertyData)
      }

      const { findings, features, enumValues } = runChecks({
        registryYaml,
        coreHeader,
        configurationHeader,
        infoCsv,
        connectRef,
        disablePage,
        allPropertyNames,
      })
      findings.push(...failedSources)

      if (options.writeMapping) {
        const partial = buildMappingPartial(features, enumValues)
        fs.mkdirSync(path.dirname(path.resolve(options.writeMapping)), { recursive: true })
        fs.writeFileSync(path.resolve(options.writeMapping), `${partial}\n`)
        console.log(`Wrote name mapping partial to ${options.writeMapping}`)
      }

      const drift = findings.filter((f) => f.level === 'error' || f.level === 'needs-human')
      if (options.format === 'json') {
        console.log(JSON.stringify({ findings, drift: drift.length > 0 }, null, 2))
      } else {
        for (const level of ['error', 'needs-human', 'info']) {
          for (const f of findings.filter((entry) => entry.level === level)) {
            console.log(`${level.toUpperCase()} [${f.check}] ${f.message}`)
          }
        }
        console.log(drift.length ? `\n${drift.length} finding(s) need attention.` : '\nRegistry is in sync with all checked sources.')
      }
      process.exit(drift.length ? 1 : 0)
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(2)
    }
  })

/**
 * validate property-overrides
 *
 * @description
 * Validates docs-data/property-overrides.json against its JSON Schema:
 * unknown keys (a typo that would otherwise be silently dropped by the
 * extractor), and the see_also shape (a plain string, or an object naming
 * exactly one of cloud_only/self_hosted_only).
 *
 * @why
 * property-overrides.json has no catch-all pass-through when an override
 * targets an existing property — an unrecognized key like the typo
 * `acceptable_values` (the generated-only field is `acceptable_values`, but
 * the override key the extractor reads is `accepted_values`) is silently
 * ignored rather than erroring. This check catches that class of mistake
 * before generation, the same way `validate rpk-overrides` does for rpk.
 *
 * @example
 * # Validate overrides with the default path
 * npx doc-tools validate property-overrides
 *
 * # Validate a custom overrides file
 * npx doc-tools validate property-overrides --overrides my-overrides.json
 *
 * # Strict mode - exit with error code on validation failures
 * npx doc-tools validate property-overrides --strict
 *
 * @requirements
 * - property-overrides.schema.json in docs-data/
 */
validation
  .command('property-overrides')
  .description('Validate property-overrides.json against its schema')
  .option('--overrides <path>', 'Path to overrides JSON file', 'docs-data/property-overrides.json')
  .option('--strict', 'Exit with error code on validation failures')
  .action((options) => {
    try {
      const { loadAndValidateOverrides } = require('../tools/property-extractor/validate-overrides.js')
      const repoRoot = findRepoRoot()
      const overridesPath = path.resolve(repoRoot, options.overrides)

      console.log(`Validating: ${overridesPath}`)
      console.log('')

      const { overrides, validation: result } = loadAndValidateOverrides(overridesPath)

      if (!overrides) {
        console.error('Error: Could not load overrides file')
        process.exit(1)
      }

      console.log('='.repeat(60))
      console.log('VALIDATION RESULTS')
      console.log('='.repeat(60))

      if (result.errors.length === 0 && result.warnings.length === 0) {
        console.log('✓ No issues found')
      } else {
        console.log(result.format())
      }

      console.log('='.repeat(60))
      console.log(`Errors: ${result.errors.length}`)
      console.log(`Warnings: ${result.warnings.length}`)
      console.log('='.repeat(60))

      if (options.strict && !result.valid) {
        console.log('\n✗ Validation failed (strict mode)')
        process.exit(1)
      } else if (result.valid) {
        console.log('\n✓ Validation passed')
        process.exit(0)
      } else {
        console.log('\n⚠ Validation completed with errors (use --strict to fail)')
        process.exit(0)
      }
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

/**
 * lint-strings
 *
 * @description
 * Deterministic lint for user-facing doc strings embedded in engineering
 * source code (property descriptions, metric help strings, ...). These
 * strings ship verbatim to docs.redpanda.com, so this command surfaces
 * quality problems (empty descriptions, broken markup, name-echo
 * tautologies, convention drift) at write time, with exact file:line spans
 * for each declaration.
 *
 * @why
 * The docs team currently patches bad source strings after the fact via
 * override files. Linting where engineers write the strings - including a
 * declaration-anchored --diff mode for PR reviews - retires that drift debt.
 *
 * @example
 * # Lint all supported surfaces in a local redpanda checkout
 * npx doc-tools lint-strings --repo ~/redpanda
 *
 * # Lint only properties, machine-readable
 * npx doc-tools lint-strings --repo ~/redpanda --surface properties --format json
 *
 * # PR mode: only declarations whose span intersects the diff
 * npx doc-tools lint-strings --repo ~/redpanda --diff origin/dev
 */
programCli
  .command('lint-strings')
  .description('Lint user-facing doc strings embedded in engineering source code (properties, metrics, ...)')
  .requiredOption('--repo <path>', 'Path to an existing engineering checkout (for example, a local redpanda clone). Nothing is cloned.')
  .option('--surface <list>', 'Comma-separated surfaces to lint (default: all registered). Registered: properties, metrics, rpk, helm, crd, connect')
  .option('--diff <base>', 'Declaration-anchored diff mode: lint only declarations whose full span intersects lines changed in <base>...HEAD')
  .option('--format <format>', 'Output format: human or json', 'human')
  .option('--skip-rules <list>', 'Comma-separated rule ids to skip')
  .option('--only-rules <list>', 'Comma-separated rule ids to run exclusively')
  .option('--strict', 'Exit 1 when any error-severity finding exists (default: always exit 0 - suggest, never block)')
  .action((options) => {
    const { runCli } = require('../tools/lint-strings')
    runCli(options)
  })

/**
 * preview-string
 *
 * @description
 * Render ONE doc-string declaration from local engineering source to the
 * final published snippet: properties through the real extractor +
 * Handlebars template (two panes when --overrides shows a docs-repo
 * override masking the source string), rpk through the real
 * formatDescription() transformer, and metrics/helm/crd/connect in their
 * published output shapes.
 *
 * @why
 * Engineers can see what their embedded string becomes on
 * docs.redpanda.com BEFORE it ships - including whether an override in the
 * docs repo would silently mask their fix.
 *
 * @example
 * # What does this property's docs section look like?
 * npx doc-tools preview-string --repo ~/redpanda --surface properties --name log_segment_size
 *
 * # Is my override masking the source string?
 * npx doc-tools preview-string --repo ~/redpanda --surface properties --name log_segment_size --overrides ~/docs/docs-data/property-overrides.json
 *
 * # What does formatDescription do to my rpk Long text?
 * npx doc-tools preview-string --repo ~/redpanda --surface rpk --name health
 */
programCli
  .command('preview-string')
  .description('Render one embedded doc string (property, rpk command/flag, metric, helm key, CRD field, connect field) as it will publish')
  .requiredOption('--repo <path>', 'Path to an existing engineering checkout. Nothing is cloned.')
  .requiredOption('--surface <surface>', 'One of: properties, rpk, metrics, helm, crd, connect')
  .requiredOption('--name <name>', 'Declaration name: property name, rpk command token or --flag, metric name, helm key path, CRD json field (or Struct.field), connect component/field name')
  .option('--overrides <path>', 'Docs-repo overrides JSON (properties only): adds an "as shipped" pane and a MASKED-BY-OVERRIDE notice when the override differs')
  .action((options) => {
    const { runCli } = require('../tools/preview-string')
    runCli(options)
  })

// ====================================================================
// OVERRIDES COMMANDS
// ====================================================================
const overridesGroup = new Command('overrides').description('Audit docs-side override files against extracted source strings')

/**
 * @description Field-level classification of override entries against the
 * strings extracted from engineering source. Each override field classifies
 * as REDUNDANT (source already matches; retire it), UPSTREAMABLE (send the
 * prose upstream), KEEP_UNTIL_UPSTREAMED (markup-laden SPLIT case with a
 * stripped upstream candidate), UPSTREAMABLE_SLOT (migrate to a source
 * metadata slot), REDUNDANT_OR_UPSTREAMABLE (needs a human ruling), KEEP
 * (docs enrichment by design), or REVIEW (possible source bug; never
 * auto-delete). See tools/overrides-audit/README.adoc for the full rules
 * and the upstream_ref policy.
 *
 * @why Description overrides are stopgaps awaiting an upstream source fix;
 * once the fixed string ships in a release they silently mask all future
 * source improvements. This audit powers the retirement loop (delete
 * REDUNDANT fields on each release regeneration) and the upstreaming loop
 * (draft source PRs from the UPSTREAMABLE/SPLIT candidates).
 *
 * @example
 * # Audit the docs repo property overrides against a raw extraction
 * npx doc-tools overrides audit \
 *   --overrides docs-data/property-overrides.json \
 *   --extracted tools/property-extractor/gen/properties-output.json \
 *   --format human
 *
 * @requirements
 * The --extracted file must be the property extractor's RAW output (its
 * --output file, without overrides applied). The enhanced output and the
 * versioned redpanda-properties-<tag>.json attachments already have
 * overrides applied, so auditing against them classifies everything
 * REDUNDANT.
 */
overridesGroup
  .command('audit')
  .description('Classify each override field as redundant, upstreamable, or keep against extracted source strings')
  .requiredOption('--overrides <path>', 'Path to the overrides JSON file (for example docs-data/property-overrides.json)')
  .option('--extracted <path>', 'Path to the extracted source JSON (property extractor raw output; required for the properties surface)')
  .addOption(new Option('--surface <surface>', 'Override surface to audit').choices(['properties', 'rpk', 'connect']).default('properties'))
  .addOption(new Option('--format <format>', 'Output format').choices(['json', 'human']).default('json'))
  .option('--repo <path>', 'Redpanda checkout to extract raw source strings from (alternative to --extracted)')
  .option('--output <path>', 'Also write the JSON result to this file')
  .action((options) => {
    const { runAudit, formatHumanReport } = require('../tools/overrides-audit')
    try {
      const result = runAudit(options)
      if (options.output) {
        fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
        fs.writeFileSync(path.resolve(options.output), JSON.stringify(result, null, 2) + '\n')
        console.error(`JSON result written to ${options.output}`)
      }
      console.log(options.format === 'human' ? formatHumanReport(result) : JSON.stringify(result, null, 2))
    } catch (err) {
      fail(err.message)
    }
  })

programCli.addCommand(automation)
programCli.addCommand(validation)
programCli.addCommand(overridesGroup)
programCli.parse(process.argv)
