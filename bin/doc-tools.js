#!/usr/bin/env node

'use strict'

const { spawnSync } = require('child_process')
const os = require('os')
const { Command, Option } = require('commander')
const path = require('path')
const fs = require('fs')

// Import extracted utility modules
const { findRepoRoot, fail, commonOptions } = require('../cli-utils/doc-tools-utils')
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
  cleanupOldDiffs
} = require('../cli-utils/diff-utils')

// Import other utilities
const { determineDocsBranch } = require('../cli-utils/self-managed-docs-branch.js')
const fetchFromGithub = require('../tools/fetch-from-github.js')
const { urlToXref } = require('../cli-utils/convert-doc-links.js')
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
 * @description Validate the MCP server configuration including prompts, resources,
 * and metadata. Reports any issues with prompt definitions or missing files.
 * @why Use this command to verify that all MCP prompts and resources are properly
 * configured before deploying or after making changes to prompt files.
 * @example
 * # Validate MCP configuration
 * npx doc-tools validate-mcp
 * @requirements None.
 */
programCli
  .command('validate-mcp')
  .description('Validate MCP server configuration (prompts, resources, metadata)')
  .action(() => {
    const {
      PromptCache,
      loadAllPrompts
    } = require('./mcp-tools/prompt-discovery')
    const {
      validateMcpConfiguration,
      formatValidationResults
    } = require('./mcp-tools/mcp-validation')

    const baseDir = findRepoRoot()
    const promptCache = new PromptCache()

    const resources = [
      {
        uri: 'redpanda://style-guide',
        name: 'Redpanda Documentation Style Guide',
        description: 'Complete style guide based on Google Developer Documentation Style Guide with Redpanda-specific guidelines',
        mimeType: 'text/markdown',
        version: '1.0.0',
        lastUpdated: '2025-12-11'
      }
    ]

    const resourceMap = {
      'redpanda://style-guide': { file: 'style-guide.md', mimeType: 'text/markdown' }
    }

    try {
      console.log('Loading prompts...')
      const prompts = loadAllPrompts(baseDir, promptCache)
      console.log(`Found ${prompts.length} prompts`)

      console.log('\nValidating configuration...')
      const validation = validateMcpConfiguration({
        resources,
        resourceMap,
        prompts,
        baseDir
      })

      const output = formatValidationResults(validation, { resources, prompts })
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
 * @description Preview an MCP prompt with sample arguments to see the final rendered
 * output. Useful for testing and debugging prompt templates.
 * @why Use this command when developing or modifying MCP prompts to verify the
 * output format and argument substitution works correctly.
 * @example
 * # Preview a prompt with content argument
 * npx doc-tools preview-prompt review-content --content "Sample text"
 *
 * # Preview a prompt with topic and audience
 * npx doc-tools preview-prompt write-docs --topic "Kafka" --audience "developers"
 * @requirements None.
 */
programCli
  .command('preview-prompt')
  .description('Preview a prompt with arguments to see the final output')
  .argument('<prompt-name>', 'Name of the prompt to preview')
  .option('--content <text>', 'Content argument (for review/check prompts)')
  .option('--topic <text>', 'Topic argument (for write prompts)')
  .option('--audience <text>', 'Audience argument (for write prompts)')
  .action((promptName, options) => {
    const {
      PromptCache,
      loadAllPrompts,
      buildPromptWithArguments
    } = require('./mcp-tools/prompt-discovery')

    const baseDir = findRepoRoot()
    const promptCache = new PromptCache()

    try {
      loadAllPrompts(baseDir, promptCache)

      const prompt = promptCache.get(promptName)
      if (!prompt) {
        console.error(`Error: Prompt not found: ${promptName}`)
        console.error(`\nAvailable prompts: ${promptCache.getNames().join(', ')}`)
        process.exit(1)
      }

      const args = {}
      if (options.content) args.content = options.content
      if (options.topic) args.topic = options.topic
      if (options.audience) args.audience = options.audience

      const promptText = buildPromptWithArguments(prompt, args)

      console.log('='.repeat(70))
      console.log(`PROMPT PREVIEW: ${promptName}`)
      console.log('='.repeat(70))
      console.log(`Description: ${prompt.description}`)
      console.log(`Version: ${prompt.version}`)
      if (prompt.arguments.length > 0) {
        console.log(`Arguments: ${prompt.arguments.map(a => a.name).join(', ')}`)
      }
      console.log('='.repeat(70))
      console.log('\n' + promptText)
      console.log('\n' + '='.repeat(70))
    } catch (err) {
      console.error(`Error: Preview failed: ${err.message}`)
      process.exit(1)
    }
  })

/**
 * @description Show MCP server version information including available prompts,
 * resources, and optionally usage statistics from previous sessions.
 * @why Use this command to see what MCP capabilities are available and to review
 * usage patterns for optimization.
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
    const {
      PromptCache,
      loadAllPrompts
    } = require('./mcp-tools/prompt-discovery')

    const baseDir = findRepoRoot()
    const promptCache = new PromptCache()

    try {
      const prompts = loadAllPrompts(baseDir, promptCache)

      const resources = [
        {
          uri: 'redpanda://style-guide',
          name: 'Redpanda Documentation Style Guide',
          version: '1.0.0',
          lastUpdated: '2025-12-11'
        }
      ]

      console.log('Redpanda Doc Tools MCP Server')
      console.log('='.repeat(60))
      console.log(`Server version: ${packageJson.version}`)
      console.log(`Base directory: ${baseDir}`)
      console.log('')

      console.log(`Prompts (${prompts.length} available):`)
      prompts.forEach(prompt => {
        const args = prompt.arguments.length > 0
          ? ` [${prompt.arguments.map(a => a.name).join(', ')}]`
          : ''
        console.log(`  - ${prompt.name} (v${prompt.version})${args}`)
        console.log(`    ${prompt.description}`)
      })
      console.log('')

      console.log(`Resources (${resources.length} available):`)
      resources.forEach(resource => {
        console.log(`  - ${resource.name} (v${resource.version})`)
        console.log(`    URI: ${resource.uri}`)
        console.log(`    Last updated: ${resource.lastUpdated}`)
      })
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

            if (stats.prompts && Object.keys(stats.prompts).length > 0) {
              console.log('\nPrompt Usage:')
              Object.entries(stats.prompts)
                .sort(([, a], [, b]) => b - a)
                .forEach(([name, count]) => {
                  console.log(`  ${name}: ${count} invocations`)
                })
            }

            if (stats.resources && Object.keys(stats.resources).length > 0) {
              console.log('\nResource Access:')
              Object.entries(stats.resources)
                .sort(([, a], [, b]) => b - a)
                .forEach(([uri, count]) => {
                  console.log(`  ${uri}: ${count} reads`)
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
      console.log('  mcp/AI_CONSISTENCY_ARCHITECTURE.adoc')
    } catch (err) {
      console.error(`Error: Failed to retrieve version information: ${err.message}`)
      process.exit(1)
    }
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
  .option('--template-bloblang <path>', 'Custom Handlebars template for bloblang function/method partials')
  .option('--overrides <path>', 'Optional JSON file with overrides', 'docs-data/overrides.json')
  .option('--include-bloblang', 'Include Bloblang functions and methods in generation')
  .option('--cloud-version <version>', 'Cloud binary version (default: auto-detect latest)')
  .option('--cgo-version <version>', 'cgo binary version (default: same as cloud-version)')
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
 * - Internet connection to clone Redpanda repository
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
  .option('--diff <oldTag>', 'Also diff autogenerated properties from <oldTag> to current tag/branch')
  .option('--overrides <path>', 'Optional JSON file with property description overrides', 'docs-data/property-overrides.json')
  .option('--output-dir <dir>', 'Where to write all generated files', 'modules/reference')
  .option('--cloud-support', 'Add AsciiDoc tags to generated property docs to indicate which ones are supported in Redpanda Cloud. This data is fetched from the cloudv2 repository so requires a GitHub token with repo permissions. Set the token as an environment variable using GITHUB_TOKEN, GH_TOKEN, or REDPANDA_GITHUB_TOKEN', true)
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

    if (options.cloudSupport) {
      console.log('Validating cloud support dependencies...')
      const { getGitHubToken } = require('../cli-utils/github-token')
      const token = getGitHubToken()
      if (!token) {
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

    const overridesPath = options.overrides
    const outputDir = options.outputDir
    const cwd = path.resolve(__dirname, '../tools/property-extractor')

    const make = (tag, overrides, templates = {}, outDir = 'modules/reference/') => {
      console.log(`Building property docs for ${tag}…`)
      const args = ['build', `TAG=${tag}`]
      const env = { ...process.env }
      if (overrides) env.OVERRIDES = path.resolve(overrides)
      if (options.cloudSupport) env.CLOUD_SUPPORT = '1'
      if (templates.property) env.TEMPLATE_PROPERTY = path.resolve(templates.property)
      if (templates.topicProperty) env.TEMPLATE_TOPIC_PROPERTY = path.resolve(templates.topicProperty)
      if (templates.topicPropertyMappings) env.TEMPLATE_TOPIC_PROPERTY_MAPPINGS = path.resolve(templates.topicPropertyMappings)
      if (templates.deprecated) env.TEMPLATE_DEPRECATED = path.resolve(templates.deprecated)
      if (templates.deprecatedProperty) env.TEMPLATE_DEPRECATED_PROPERTY = path.resolve(templates.deprecatedProperty)
      env.OUTPUT_JSON_DIR = path.resolve(outDir, 'attachments')
      env.OUTPUT_AUTOGENERATED_DIR = path.resolve(outDir)
      if (options.generatePartials) {
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
    if (oldTag && !tagsAreSame) {
      make(oldTag, overridesPath, templates, outputDir)
    }
    make(newTag, overridesPath, templates, outputDir)
    if (oldTag && !tagsAreSame) {
      const diffOutputDir = overridesPath ? path.dirname(path.resolve(overridesPath)) : outputDir
      generatePropertyComparisonReport(oldTag, newTag, diffOutputDir)

      try {
        const diffReportPath = path.join(diffOutputDir, `redpanda-property-changes-${oldTag}-to-${newTag}.json`)
        if (fs.existsSync(diffReportPath)) {
          const diffData = JSON.parse(fs.readFileSync(diffReportPath, 'utf8'))
          const { printPRSummary } = require('../tools/property-extractor/pr-summary-formatter')
          printPRSummary(diffData)

          if (overridesPath && fs.existsSync(overridesPath)) {
            updatePropertyOverridesWithVersion(overridesPath, diffData, newTag)
          }
        }
      } catch (err) {
        console.warn(`Warning: Failed to generate PR summary: ${err.message}`)
      }

      cleanupOldDiffs(diffOutputDir)
    }

    if (!options.diff && !tagsAreSame) {
      const tagSuccess = setAntoraValue('asciidoc.attributes.latest-redpanda-tag', newTag)
      if (tagSuccess) console.log(`Done: Updated Antora latest-redpanda-tag to: ${newTag}`)

      const versionWithoutV = newTag.startsWith('v') ? newTag.slice(1) : newTag
      const versionSuccess = setAntoraValue('asciidoc.attributes.full-version', versionWithoutV)
      if (versionSuccess) console.log(`Done: Updated Antora full-version to: ${versionWithoutV}`)

      try {
        const jsonDir = path.resolve(outputDir, 'attachments')
        const propertyFiles = fs.readdirSync(jsonDir)
          .filter(f => /^redpanda-properties-v[\d.]+\.json$/.test(f))
          .sort()

        const keepFile = `redpanda-properties-${newTag}.json`
        const filesToDelete = propertyFiles.filter(f => f !== keepFile)

        if (filesToDelete.length > 0) {
          console.log('🧹 Cleaning up old property JSON files...')
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
 * Generates comprehensive CLI reference documentation for RPK (Redpanda Keeper), the official
 * Redpanda command-line tool. Starts Redpanda in Docker (RPK is bundled with Redpanda), executes
 * `rpk --help` for all commands and subcommands recursively, parses the help output, and generates
 * structured AsciiDoc documentation for each command with usage, flags, and descriptions.
 * Optionally compares RPK commands between versions to identify new or changed commands.
 *
 * @why
 * RPK has dozens of commands and subcommands with complex flags and options. The built-in help
 * text is the source of truth for RPK's CLI interface. Manual documentation becomes outdated as
 * RPK evolves. This automation extracts documentation directly from RPK's help output, ensuring
 * accuracy. Running RPK from Docker guarantees the exact version being documented, and diffing
 * between versions automatically highlights CLI changes for release notes.
 *
 * @example
 * # Basic: Generate RPK docs for a specific version
 * npx doc-tools generate rpk-docs --tag v25.3.1
 *
 * # Compare RPK commands between versions
 * npx doc-tools generate rpk-docs \
 *   --tag v25.3.1 \
 *   --diff v25.2.1
 *
 * # Use custom Docker repository
 * npx doc-tools generate rpk-docs \
 *   --tag v25.3.1 \
 *   --docker-repo docker.redpanda.com/redpandadata/redpanda
 *
 * # Full workflow: document new release
 * VERSION=$(npx doc-tools get-redpanda-version)
 * npx doc-tools generate rpk-docs --tag $VERSION
 *
 * @requirements
 * - Docker must be installed and running
 * - Sufficient disk space for Docker image
 * - Internet connection to pull Docker images
 */
automation
  .command('rpk-docs')
  .description('Generate AsciiDoc documentation for rpk CLI commands. Defaults to branch "dev" if neither --tag nor --branch is specified.')
  .option('-t, --tag <tag>', 'Git tag for released content (GA/beta)')
  .option('-b, --branch <branch>', 'Branch name for in-progress content')
  .option('--docker-repo <repo>', 'Docker repository to use', commonOptions.dockerRepo)
  .option('--console-tag <tag>', 'Redpanda Console version to use', commonOptions.consoleTag)
  .option('--console-docker-repo <repo>', 'Docker repository for Console', commonOptions.consoleDockerRepo)
  .option('--diff <oldTag>', 'Also diff autogenerated rpk docs from <oldTag> → <tag>')
  .action((options) => {
    verifyMetricsDependencies()

    if (options.tag && options.branch) {
      console.error('Error: Cannot specify both --tag and --branch')
      process.exit(1)
    }

    const newTag = options.tag || options.branch || 'dev'
    const oldTag = options.diff

    if (oldTag) {
      const oldDir = path.join('autogenerated', oldTag, 'rpk')
      if (!fs.existsSync(oldDir)) {
        console.log(`Generating rpk docs for old tag ${oldTag}…`)
        runClusterDocs('rpk', oldTag, options)
      }
    }

    console.log(`Generating rpk docs for new tag ${newTag}…`)
    runClusterDocs('rpk', newTag, options)

    if (oldTag) {
      diffDirs('rpk', oldTag, newTag)
    }

    process.exit(0)
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

      let doc = fs.readFileSync(outFile, 'utf8')
      const xrefRe = /https:\/\/docs\.redpanda\.com[^\s\]\[\)"]+(?:\[[^\]]*\])?/g
      doc = doc
        .replace(/(\[\d+\])\]\./g, '$1\\].')
        .replace(/(\[\d+\])\]\]/g, '$1\\]\\]')
        .replace(/^=== +(https?:\/\/[^\[]*)\[([^\]]*)\]/gm, '=== link:++$1++[$2]')
        .replace(/^== # (.*)$/gm, '= $1')
        .replace(/^== description: (.*)$/gm, ':description: $1')
        .replace(xrefRe, (match) => {
          let urlPart = match
          let bracketPart = ''
          const m = match.match(/^([^\[]+)(\[[^\]]*\])$/)
          if (m) {
            urlPart = m[1]
            bracketPart = m[2]
          }
          if (urlPart.endsWith('#')) return match
          try {
            const xref = urlToXref(urlPart)
            return bracketPart ? `${xref}${bracketPart}` : `${xref}[]`
          } catch (err) {
            console.warn(`⚠️ urlToXref failed on ${urlPart}: ${err.message}`)
            return match
          }
        })
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
  .option('--output <file>', 'Output file (relative to repo root)', 'cloud-controlplane/x-topics/cloud-regions.md')
  .option('--format <fmt>', 'Output format: md (Markdown) or adoc (AsciiDoc)', 'md')
  .option('--owner <owner>', 'GitHub repository owner', 'redpanda-data')
  .option('--repo <repo>', 'GitHub repository name', 'cloudv2-infra')
  .option('--path <path>', 'Path to YAML file in repository', 'apps/master-data-reconciler/manifests/overlays/production/master-data.yaml')
  .option('--ref <ref>', 'Git reference (branch, tag, or commit SHA)', 'integration')
  .option('--template <path>', 'Path to custom Handlebars template (relative to repo root)')
  .option('--dry-run', 'Print output to stdout instead of writing file')
  .action(async (options) => {
    const { generateCloudRegions } = require('../tools/cloud-regions/generate-cloud-regions.js')
    const { getGitHubToken } = require('../cli-utils/github-token')

    try {
      const token = getGitHubToken()
      if (!token) {
        throw new Error('GitHub token is required to fetch from private cloudv2-infra repo.')
      }
      const fmt = (options.format || 'md').toLowerCase()
      let templatePath
      if (options.template) {
        const repoRoot = findRepoRoot()
        templatePath = path.resolve(repoRoot, options.template)
        if (!fs.existsSync(templatePath)) {
          throw new Error(`Custom template not found: ${templatePath}`)
        }
      }
      const out = await generateCloudRegions({
        owner: options.owner,
        repo: options.repo,
        path: options.path,
        ref: options.ref,
        format: fmt,
        token,
        template: templatePath
      })
      if (options.dryRun) {
        process.stdout.write(out)
        console.log(`\nDone: (dry-run) ${fmt === 'adoc' ? 'AsciiDoc' : 'Markdown'} output printed to stdout.`)
      } else {
        const repoRoot = findRepoRoot()
        const absOutput = path.resolve(repoRoot, options.output)
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

    let doc = fs.readFileSync(opts.output, 'utf8')
    const xrefRe = /https:\/\/docs\.redpanda\.com[^\s\]\[\)"]+(?:\[[^\]]*\])?/g
    doc = doc.replace(xrefRe, (match) => {
      let urlPart = match
      let bracketPart = ''
      const m = match.match(/^([^\[]+)(\[[^\]]*\])$/)
      if (m) {
        urlPart = m[1]
        bracketPart = m[2]
      }
      if (urlPart.endsWith('#')) return match
      try {
        const xref = urlToXref(urlPart)
        return bracketPart ? `${xref}${bracketPart}` : `${xref}[]`
      } catch (err) {
        console.warn(`⚠️ urlToXref failed on ${urlPart}: ${err.message}`)
        return match
      }
    })
    fs.writeFileSync(opts.output, doc, 'utf8')

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
 * - Git to clone Redpanda repository
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
  .option('--repo <url>', 'Repository URL', 'https://github.com/redpanda-data/redpanda.git')
  .addOption(new Option('-s, --surface <surface>', 'Which API surface(s) to bundle').choices(['admin', 'connect', 'both']).makeOptionMandatory())
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

programCli.addCommand(automation)
programCli.parse(process.argv)
