#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
const os = require('os');
const { Command, Option } = require('commander');
const path = require('path');
const fs = require('fs');
const { determineDocsBranch } = require('../cli-utils/self-managed-docs-branch.js');
const fetchFromGithub = require('../tools/fetch-from-github.js');
const { urlToXref } = require('../cli-utils/convert-doc-links.js');
const { generateRpcnConnectorDocs } = require('../tools/redpanda-connect/generate-rpcn-connector-docs.js');
const parseCSVConnectors = require('../tools/redpanda-connect/parse-csv-connectors.js');
const { getAntoraValue, setAntoraValue } = require('../cli-utils/antora-utils');
const {
  getRpkConnectVersion,
  printDeltaReport
} = require('../tools/redpanda-connect/report-delta');

/**
 * Searches upward from a starting directory to locate the repository root.
 *
 * Traverses parent directories from the specified start path, returning the first directory containing either a `.git` folder or a `package.json` file. Exits the process with an error if no such directory is found.
 *
 * @param {string} [start] - The directory to begin the search from. Defaults to the current working directory.
 * @returns {string} The absolute path to the repository root directory.
 */
function findRepoRoot(start = process.cwd()) {
  let dir = start;
  while (dir !== path.parse(dir).root) {
    if (
      fs.existsSync(path.join(dir, '.git')) ||
      fs.existsSync(path.join(dir, 'package.json'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  console.error('❌ Could not find repo root (no .git or package.json in any parent)');
  process.exit(1);
}

// --------------------------------------------------------------------
// Dependency check functions

/**
 * Prints an error message to stderr and exits the process with a non-zero status.
 *
 * @param {string} msg - The error message to display before exiting.
 */
function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

/**
 * Ensures that a specified command-line tool is installed and operational.
 *
 * Attempts to execute the tool with a version flag to verify its presence. If the tool is missing or fails to run, the process exits with an error message and optional installation hint.
 *
 * @param {string} cmd - The name of the tool to check (e.g., 'docker', 'helm-docs').
 * @param {object} [opts] - Optional settings.
 * @param {string} [opts.versionFlag='--version'] - The flag used to test the tool's execution.
 * @param {string} [opts.help] - An optional hint or installation instruction shown on failure.
 */
function requireTool(cmd, { versionFlag = '--version', help = '' } = {}) {
  try {
    execSync(`${cmd} ${versionFlag}`, { stdio: 'ignore' });
  } catch {
    const hint = help ? `\n→ ${help}` : '';
    fail(`'${cmd}' is required but not found.${hint}`);
  }
}

/**
 * Ensures that a command-line tool is installed by checking if it responds to a specified flag.
 *
 * @param {string} cmd - The name of the command-line tool to check.
 * @param {string} [help] - Optional help text to display if the tool is not found.
 * @param {string} [versionFlag='--version'] - The flag to use when checking if the tool is installed.
 *
 * @throws {Error} If the specified command is not found or does not respond to the specified flag.
 */
function requireCmd(cmd, help, versionFlag = '--version') {
  requireTool(cmd, { versionFlag, help });
}

// --------------------------------------------------------------------
// Special validators

/**
 * Ensures that Python with a minimum required version is installed and available in the system PATH.
 *
 * Checks for either `python3` or `python` executables and verifies that the version is at least the specified minimum (default: 3.10). Exits the process with an error message if the requirement is not met.
 *
 * @param {number} [minMajor=3] - Minimum required major version of Python.
 * @param {number} [minMinor=10] - Minimum required minor version of Python.
 */
function requirePython(minMajor = 3, minMinor = 10) {
  const candidates = ['python3', 'python', 'python3.12', 'python3.11', 'python3.10'];
  for (const p of candidates) {
    try {
      const out = execSync(`${p} --version`, { encoding: 'utf8' }).trim();
      const [maj, min] = out.split(' ')[1].split('.').map(Number);
      if (maj > minMajor || (maj === minMajor && min >= minMinor)) {
        return; // success
      }
    } catch {
      /* ignore & try next */
    }
  }
  fail(
    `Python ${minMajor}.${minMinor}+ not found or too old.
→ Install from your package manager or https://python.org`
  );
}

/**
 * Ensures that the Docker CLI is installed and the Docker daemon is running.
 *
 * @throws {Error} If Docker is not installed or the Docker daemon is not running.
 */
function requireDockerDaemon() {
  requireTool('docker', { help: 'https://docs.docker.com/get-docker/' });
  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch {
    fail('Docker daemon does not appear to be running. Please start Docker.');
  }
}

// --------------------------------------------------------------------
// Grouped checks

/**
 * Ensures that required dependencies for generating CRD documentation are installed.
 *
 * Verifies the presence of the {@link git} and {@link crd-ref-docs} command-line tools, exiting the process with an error message if either is missing.
 */
function verifyCrdDependencies() {
  requireCmd('git', 'Install Git: https://git-scm.com/downloads');
  requireCmd(
    'crd-ref-docs',
    `
The 'crd-ref-docs' command is required but was not found.

To install it, follow these steps (for macOS):

1. Determine your architecture:
   Run: \`uname -m\`

2. Download and install:

- For Apple Silicon (M1/M2/M3):
  curl -fLO https://github.com/elastic/crd-ref-docs/releases/download/v0.1.0/crd-ref-docs_0.1.0_Darwin_arm64.tar.gz
  tar -xzf crd-ref-docs_0.1.0_Darwin_arm64.tar.gz
  chmod +x crd-ref-docs
  sudo mv crd-ref-docs /usr/local/bin/

- For Intel (x86_64):
  curl -fLO https://github.com/elastic/crd-ref-docs/releases/download/v0.1.0/crd-ref-docs_0.1.0_Darwin_x86_64.tar.gz
  tar -xzf crd-ref-docs_0.1.0_Darwin_x86_64.tar.gz
  chmod +x crd-ref-docs
  sudo mv crd-ref-docs /usr/local/bin/

For more details, visit: https://github.com/elastic/crd-ref-docs
    `.trim()
  );
  requireCmd(
    'go',
    `
The 'go' command (Golang) is required but was not found.

To install it on macOS:

Option 1: Install via Homebrew (recommended):
  brew install go

Option 2: Download directly from the official site:
  1. Visit: https://go.dev/dl/
  2. Download the appropriate installer for macOS.
  3. Run the installer and follow the instructions.

After installation, verify it works:
  go version

For more details, see: https://go.dev/doc/install
    `.trim(),
    'version'
  );
}

/**
 * Ensures that all required tools for Helm documentation generation are installed.
 *
 * Checks for the presence of `helm-docs`, `pandoc`, and `git`, exiting the process with an error if any are missing.
 */
function verifyHelmDependencies() {
  requireCmd(
    'helm-docs',
    `
The 'helm-docs' command is required but was not found.

To install it, follow these steps (for macOS):

1. Determine your architecture:
   Run: \`uname -m\`

2. Download and install:

- For Apple Silicon (M1/M2/M3):
  curl -fLO https://github.com/norwoodj/helm-docs/releases/download/v1.11.0/helm-docs_1.11.0_Darwin_arm64.tar.gz
  tar -xzf helm-docs_1.11.0_Darwin_arm64.tar.gz
  chmod +x helm-docs
  sudo mv helm-docs /usr/local/bin/

- For Intel (x86_64):
  curl -fLO https://github.com/norwoodj/helm-docs/releases/download/v1.11.0/helm-docs_1.11.0_Darwin_x86_64.tar.gz
  tar -xzf helm-docs_1.11.0_Darwin_x86_64.tar.gz
  chmod +x helm-docs
  sudo mv helm-docs /usr/local/bin/

Alternatively, if you use Homebrew:
  brew install norwoodj/tap/helm-docs

For more details, visit: https://github.com/norwoodj/helm-docs
    `.trim()
  );
  requireCmd('pandoc', 'brew install pandoc or https://pandoc.org');
  requireCmd('git', 'Install Git: https://git-scm.com/downloads');
}

/**
 * Ensures all dependencies required for generating property documentation are installed.
 *
 * Checks for the presence of `make`, Python 3.10 or newer, Node.js, C++ compiler, and C++ standard library headers.
 * Exits the process with an error message if any dependency is missing.
 */
function verifyPropertyDependencies() {
  requireCmd('make', 'Your OS package manager');
  requirePython();
  
  // Check for Node.js (required for Handlebars templates)
  requireCmd('node', 'https://nodejs.org/en/download/ or use your package manager (e.g., brew install node)');
  requireCmd('npm', 'Usually installed with Node.js');

  // Check for C++ compiler
  let cppCompiler = null;
  try {
    execSync('gcc --version', { stdio: 'ignore' });
    cppCompiler = 'gcc';
  } catch {
    try {
      execSync('clang --version', { stdio: 'ignore' });
      cppCompiler = 'clang';
    } catch {
      fail(`A C++ compiler (gcc or clang) is required for tree-sitter compilation.

On macOS, install Xcode Command Line Tools:
  xcode-select --install

On Linux (Ubuntu/Debian):
  sudo apt update && sudo apt install build-essential

On Linux (CentOS/RHEL/Fedora):
  sudo yum groupinstall "Development Tools"
  # or on newer versions:
  sudo dnf groupinstall "Development Tools"

After installation, verify with:
  gcc --version
  # or
  clang --version`);
    }
  }

  // Check for C++ standard library headers (critical for tree-sitter compilation)
  let tempDir = null;
  let compileCmd = null;
  try {
    const testProgram = '#include <functional>\nint main() { return 0; }';
    tempDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'cpp-test-'));
    const tempFile = require('path').join(tempDir, 'test.cpp');
    require('fs').writeFileSync(tempFile, testProgram);

    compileCmd = cppCompiler === 'gcc' ? 'gcc' : 'clang++';
    execSync(`${compileCmd} -x c++ -fsyntax-only "${tempFile}"`, { stdio: 'ignore' });
    require('fs').rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Clean up temp directory if it was created
    if (tempDir) {
      try {
        require('fs').rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    fail(`C++ standard library headers are missing or incomplete.

1. **Test if the issue exists**:
   echo '#include <functional>' | ${compileCmd} -x c++ -fsyntax-only -

2. **If the test fails, try these fixes in order**:
   **Fix 1**: Reset developer path
   sudo xcode-select --reset

   **Fix 2**: Force reinstall Command Line Tools
   sudo rm -rf /Library/Developer/CommandLineTools
   xcode-select --install

   Complete the GUI installation dialog that appears.

3. **Verify the fix**:
   echo '#include <functional>' | ${compileCmd} -x c++ -fsyntax-only -
   If successful, you should see no output and the command should exit with code 0.
`);
  }
}

/**
 * Ensures all required dependencies for generating Redpanda metrics documentation are installed.
 *
 * Verifies that Python 3.10+, `curl`, and `tar` are available, and that the Docker daemon is running.
 *
 * @throws {Error} If any required dependency is missing or the Docker daemon is not running.
 */
function verifyMetricsDependencies() {
  requirePython();
  requireCmd('curl');
  requireCmd('tar');
  requireDockerDaemon();
}

// --------------------------------------------------------------------
// Main CLI Definition
// --------------------------------------------------------------------
const programCli = new Command();

const pkg = require('../package.json');
programCli
  .name('doc-tools')
  .description('Redpanda Document Automation CLI')
  .version(pkg.version);

// Top-level commands.

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
    const scriptPath = path.join(__dirname, '../cli-utils/install-test-dependencies.sh');
    const result = spawnSync(scriptPath, { stdio: 'inherit', shell: true });
    process.exit(result.status);
  });

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
      await require('../tools/get-redpanda-version.js')(options);
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  });

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
      await require('../tools/get-console-version.js')(options);
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  });

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
 * npx doc-tools link-readme \\
 *   --subdir labs/docker-compose \\
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
    const repoRoot = findRepoRoot();
    const normalized = options.subdir.replace(/\/+$/, '');
    const moduleName = normalized.split('/')[0];

    const projectDir = path.join(repoRoot, normalized);
    const pagesDir = path.join(repoRoot, 'docs', 'modules', moduleName, 'pages');
    const sourceFile = path.join(projectDir, 'README.adoc');
    const destLink = path.join(pagesDir, options.target);

    if (!fs.existsSync(projectDir)) {
      console.error(`❌ Project directory not found: ${projectDir}`);
      process.exit(1);
    }
    if (!fs.existsSync(sourceFile)) {
      console.error(`❌ README.adoc not found in ${projectDir}`);
      process.exit(1);
    }

    fs.mkdirSync(pagesDir, { recursive: true });
    const relPath = path.relative(pagesDir, sourceFile);

    try {
      if (fs.existsSync(destLink)) {
        const stat = fs.lstatSync(destLink);
        if (stat.isSymbolicLink()) fs.unlinkSync(destLink);
        else fail(`Destination already exists and is not a symlink: ${destLink}`);
      }
      fs.symlinkSync(relPath, destLink);
      console.log(`✅ Linked ${relPath} → ${destLink}`);
    } catch (err) {
      fail(`Failed to create symlink: ${err.message}`);
    }
  });

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
 * npx doc-tools fetch \\
 *   --owner redpanda-data \\
 *   --repo redpanda \\
 *   --remote-path docker/docker-compose.yml \\
 *   --save-dir examples/
 *
 * # Fetch an entire directory of examples
 * npx doc-tools fetch \\
 *   -o redpanda-data \\
 *   -r connect-examples \\
 *   -p pipelines/mongodb \\
 *   -d docs/modules/examples/attachments/
 *
 * # Fetch with custom filename
 * npx doc-tools fetch \\
 *   -o redpanda-data \\
 *   -r helm-charts \\
 *   -p charts/redpanda/values.yaml \\
 *   -d examples/ \\
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
      );
      console.log(`✅ Fetched to ${options.saveDir}`);
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  });

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
      const { setupMCP, showStatus, printNextSteps } = require('../cli-utils/setup-mcp.js');

      if (options.status) {
        showStatus();
        return;
      }

      const result = await setupMCP({
        force: options.force,
        target: options.target,
        local: options.local
      });

      if (result.success) {
        printNextSteps(result);
        process.exit(0);
      } else {
        console.error(`❌ Setup failed: ${result.error}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  });

// Create an "automation" subcommand group.
const automation = new Command('generate').description('Run docs automations');

// --------------------------------------------------------------------
// Automation subcommands
// --------------------------------------------------------------------

// Common options for both automation tasks.
const commonOptions = {
  dockerRepo: 'redpanda',
  consoleTag: 'latest',
  consoleDockerRepo: 'console',
};

/**
 * Run the cluster documentation generator script for a specific release/tag.
 *
 * Invokes the external `generate-cluster-docs.sh` script with the provided mode, tag,
 * and Docker-related options. The script's stdout/stderr are forwarded to the current
 * process; if the script exits with a non-zero status, this function will terminate
 * the Node.js process with that status code.
 *
 * @param {string} mode - Operation mode passed to the script (e.g., "generate" or "clean").
 * @param {string} tag - Release tag or version to generate docs for.
 * @param {Object} options - Runtime options.
 * @param {string} options.dockerRepo - Docker repository used by the script.
 * @param {string} options.consoleTag - Console image tag passed to the script.
 * @param {string} options.consoleDockerRepo - Console Docker repository used by the script.
 */
function runClusterDocs(mode, tag, options) {
  const script = path.join(__dirname, '../cli-utils/generate-cluster-docs.sh');
  const args = [mode, tag, options.dockerRepo, options.consoleTag, options.consoleDockerRepo];
  console.log(`⏳ Running ${script} with arguments: ${args.join(' ')}`);
  const r = spawnSync('bash', [script, ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status);
}

/**
 * Cleanup old diff files, keeping only the 2 most recent.
 *
 * @param {string} diffDir - Directory containing diff files
 */
function cleanupOldDiffs(diffDir) {
  try {
    console.log('Cleaning up old diff JSON files (keeping only 2 most recent)…');

    const absoluteDiffDir = path.resolve(diffDir);
    if (!fs.existsSync(absoluteDiffDir)) {
      return;
    }

    // Get all diff files sorted by modification time (newest first)
    const files = fs.readdirSync(absoluteDiffDir)
      .filter(file => file.startsWith('redpanda-property-changes-') && file.endsWith('.json'))
      .map(file => ({
        name: file,
        path: path.join(absoluteDiffDir, file),
        time: fs.statSync(path.join(absoluteDiffDir, file)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time);

    // Delete all but the 2 most recent
    if (files.length > 2) {
      files.slice(2).forEach(file => {
        console.log(`   Removing old file: ${file.name}`);
        fs.unlinkSync(file.path);
      });
    }
  } catch (error) {
    console.error(`  Failed to cleanup old diff files: ${error.message}`);
  }
}

/**
 * Generate a detailed JSON report describing property changes between two releases.
 *
 * Looks for `<oldTag>-properties.json` and `<newTag>-properties.json` in
 * `modules/reference/examples`. If both files exist, invokes the external
 * property comparison tool to produce `property-changes-<oldTag>-to-<newTag>.json`
 * in the provided output directory.
 *
 * If either input JSON is missing the function logs a message and returns without
 * error. Any errors from the comparison tool are logged; the function does not
 * throw.
 *
 * @param {string} oldTag - Release tag or identifier for the "old" properties set.
 * @param {string} newTag - Release tag or identifier for the "new" properties set.
 * @param {string} outputDir - Directory where the comparison report will be written.
 */
function generatePropertyComparisonReport(oldTag, newTag, outputDir) {
  try {
    console.log(`\n📊 Generating detailed property comparison report...`);

  // Look for the property JSON files in the standard location (modules/reference/attachments)
  // regardless of where we're saving the diff output
  const repoRoot = findRepoRoot();
  const attachmentsDir = path.join(repoRoot, 'modules/reference/attachments');
  const oldJsonPath = path.join(attachmentsDir, `redpanda-properties-${oldTag}.json`);
  const newJsonPath = path.join(attachmentsDir, `redpanda-properties-${newTag}.json`);
    
    // Check if JSON files exist
    if (!fs.existsSync(oldJsonPath)) {
      console.log(`⚠️  Old properties JSON not found at: ${oldJsonPath}`);
      console.log(`   Skipping detailed property comparison.`);
      return;
    }
    
    if (!fs.existsSync(newJsonPath)) {
      console.log(`⚠️  New properties JSON not found at: ${newJsonPath}`);
      console.log(`   Skipping detailed property comparison.`);
      return;
    }
    
    // Ensure output directory exists (use absolute path)
    const absoluteOutputDir = path.resolve(outputDir);
    fs.mkdirSync(absoluteOutputDir, { recursive: true });
    
    // Run the property comparison tool with descriptive filename
    const propertyExtractorDir = path.resolve(__dirname, '../tools/property-extractor');
    const compareScript = path.join(propertyExtractorDir, 'compare-properties.js');
    const reportFilename = `redpanda-property-changes-${oldTag}-to-${newTag}.json`;
    const reportPath = path.join(absoluteOutputDir, reportFilename);
    const args = [compareScript, oldJsonPath, newJsonPath, oldTag, newTag, absoluteOutputDir, reportFilename];
    
    const result = spawnSync('node', args, { 
      stdio: 'inherit',
      cwd: propertyExtractorDir 
    });
    
    if (result.error) {
      console.error(`❌ Property comparison failed: ${result.error.message}`);
    } else if (result.status !== 0) {
      console.error(`❌ Property comparison exited with code: ${result.status}`);
    } else {
      console.log(`✅ Property comparison report saved to: ${reportPath}`);
    }
  } catch (error) {
    console.error(`❌ Error generating property comparison: ${error.message}`);
  }
}

/**
 * Create a unified diff patch between two temporary directories and clean them up.
 *
 * Ensures both source directories exist, writes a recursive unified diff
 * (changes.patch) to tmp/diffs/<kind>/<oldTag>_to_<newTag>/, and removes the
 * provided temporary directories. On missing inputs or if the diff subprocess
 * fails to spawn, the process exits with a non-zero status.
 *
 * @param {string} kind - Logical category for the diff (e.g., "metrics" or "rpk"); used in the output path.
 * @param {string} oldTag - Identifier for the "old" version (used in the output path).
 * @param {string} newTag - Identifier for the "new" version (used in the output path).
 * @param {string} oldTempDir - Path to the existing temporary directory containing the old output; must exist.
 * @param {string} newTempDir - Path to the existing temporary directory containing the new output; must exist.
 */
function diffDirs(kind, oldTag, newTag, oldTempDir, newTempDir) {
  // Backwards compatibility: if temp directories not provided, use autogenerated paths
  if (!oldTempDir) {
    oldTempDir = path.join('autogenerated', oldTag, kind);
  }
  if (!newTempDir) {
    newTempDir = path.join('autogenerated', newTag, kind);
  }

  const diffDir = path.join('tmp', 'diffs', kind, `${oldTag}_to_${newTag}`);

  if (!fs.existsSync(oldTempDir)) {
    console.error(`❌ Cannot diff: missing ${oldTempDir}`);
    process.exit(1);
  }
  if (!fs.existsSync(newTempDir)) {
    console.error(`❌ Cannot diff: missing ${newTempDir}`);
    process.exit(1);
  }

  fs.mkdirSync(diffDir, { recursive: true });

  // Generate traditional patch for metrics and rpk
  const patch = path.join(diffDir, 'changes.patch');
  const cmd = `diff -ru "${oldTempDir}" "${newTempDir}" > "${patch}" || true`;
  const res = spawnSync(cmd, { stdio: 'inherit', shell: true });

  if (res.error) {
    console.error(`❌ diff failed: ${res.error.message}`);
    process.exit(1);
  }
  console.log(`✅ Wrote patch: ${patch}`);
  
  // Safety guard: only clean up directories that are explicitly passed as temp directories
  // For backwards compatibility with autogenerated paths, don't clean up automatically
  const tmpRoot = path.resolve('tmp') + path.sep;
  const workspaceRoot = path.resolve('.') + path.sep;
  
  // Only clean up if directories were explicitly provided as temp directories
  // (indicated by having all 5 parameters) and they're in the tmp/ directory
  const explicitTempDirs = arguments.length >= 5;
  
  if (explicitTempDirs) {
    [oldTempDir, newTempDir].forEach(dirPath => {
      const resolvedPath = path.resolve(dirPath) + path.sep;
      const isInTmp = resolvedPath.startsWith(tmpRoot);
      const isInWorkspace = resolvedPath.startsWith(workspaceRoot);
      
      if (isInWorkspace && isInTmp) {
        try {
          fs.rmSync(dirPath, { recursive: true, force: true });
          console.log(`🧹 Cleaned up temporary directory: ${dirPath}`);
        } catch (err) {
          console.warn(`⚠️  Warning: Could not clean up directory ${dirPath}: ${err.message}`);
        }
      } else {
        console.log(`ℹ️  Skipping cleanup of directory outside tmp/: ${dirPath}`);
      }
    });
  } else {
    console.log(`ℹ️  Using autogenerated directories - skipping cleanup for safety`);
  }
}

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
 * npx doc-tools generate metrics-docs \\
 *   --tag v25.3.1 \\
 *   --diff v25.2.1
 *
 * # Use custom Docker repository
 * npx doc-tools generate metrics-docs \\
 *   --tag v25.3.1 \\
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
  .option('-b, --branch <branch>', 'Branch name for in-progress content', 'dev')
  .option(
    '--docker-repo <repo>',
    'Docker repository to use when starting Redpanda in Docker',
    commonOptions.dockerRepo
  )
  .option(
    '--console-tag <tag>',
    'Redpanda Console version to use when starting Redpanda Console in Docker',
    commonOptions.consoleTag
  )
  .option(
    '--console-docker-repo <repo>',
    'Docker repository to use when starting Redpanda Console in Docker',
    commonOptions.consoleDockerRepo
  )
  .option('--diff <oldTag>', 'Also diff autogenerated metrics from <oldTag> → <tag>')
  .action((options) => {
    verifyMetricsDependencies();

    // Validate that tag and branch are mutually exclusive
    if (options.tag && options.branch) {
      console.error('❌ Error: Cannot specify both --tag and --branch');
      process.exit(1);
    }

    const newTag = options.tag || options.branch;
    const oldTag = options.diff;

    if (oldTag) {
      const oldDir = path.join('autogenerated', oldTag, 'metrics');
      if (!fs.existsSync(oldDir)) {
        console.log(`⏳ Generating metrics docs for old tag ${oldTag}…`);
        runClusterDocs('metrics', oldTag, options);
      }
    }

    console.log(`⏳ Generating metrics docs for new tag ${newTag}…`);
    runClusterDocs('metrics', newTag, options);

    if (oldTag) {
      diffDirs('metrics', oldTag, newTag);
    }

    process.exit(0);
  });

/**
 * generate rpcn-connector-docs
 *
 * @description
 * Generates complete reference documentation for Redpanda Connect (formerly Benthos) connectors,
 * processors, and components. Clones the Redpanda Connect repository, parses component templates
 * and configuration schemas embedded in Go code, reads connector metadata from CSV, and generates
 * AsciiDoc documentation for each component. Supports diffing changes between versions and
 * automatically updating what's new documentation. Can also generate Bloblang function documentation.
 *
 * @why
 * Redpanda Connect has hundreds of connectors (inputs, outputs, processors) with complex
 * configuration schemas. Each component's documentation lives in its Go source code as struct
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
 * # Generate with custom metadata CSV
 * npx doc-tools generate rpcn-connector-docs \\
 *   --csv custom/connector-metadata.csv
 *
 * # Full workflow with diff and what's new update
 * npx doc-tools generate rpcn-connector-docs \\
 *   --update-whats-new \\
 *   --include-bloblang
 *
 * @requirements
 * - Git to clone Redpanda Connect repository
 * - Internet connection to clone repository
 * - Node.js for parsing and generation
 * - Sufficient disk space for repository clone (~500MB)
 */
  automation
  .command('rpcn-connector-docs')
  .description('Generate RPCN connector docs and diff changes since the last version')
  .option('-d, --data-dir <path>', 'Directory where versioned connect JSON files live', path.resolve(process.cwd(), 'docs-data'))
  .option('--old-data <path>', 'Optional override for old data file (for diff)')
  .option('--update-whats-new', 'Update whats-new.adoc with new section from diff JSON')
  .option('-f, --fetch-connectors', 'Fetch latest connector data using rpk')
  .option('-m, --draft-missing', 'Generate full-doc drafts for connectors missing in output')
  .option('--csv <path>', 'Path to connector metadata CSV file', 'internal/plugins/info.csv')
  .option('--template-main <path>', 'Main Handlebars template', path.resolve(__dirname, '../tools/redpanda-connect/templates/connector.hbs'))
  .option('--template-intro <path>', 'Intro section partial template', path.resolve(__dirname, '../tools/redpanda-connect/templates/intro.hbs'))
  .option('--template-fields <path>', 'Fields section partial template', path.resolve(__dirname, '../tools/redpanda-connect/templates/fields-partials.hbs'))
  .option('--template-examples <path>', 'Examples section partial template', path.resolve(__dirname, '../tools/redpanda-connect/templates/examples-partials.hbs'))
  .option('--template-bloblang <path>', 'Custom Handlebars template for bloblang function/method partials')
  .option('--overrides <path>', 'Optional JSON file with overrides', 'docs-data/overrides.json')
  .option('--include-bloblang', 'Include Bloblang functions and methods in generation')
  .action(async (options) => {
    requireTool('rpk', {
      versionFlag: '--version',
      help: 'rpk is not installed. Install rpk: https://docs.redpanda.com/current/get-started/rpk-install/'
    });

    requireTool('rpk connect', {
      versionFlag: '--version',
      help: 'rpk connect is not installed. Run rpk connect install before continuing.'
    });

    const dataDir = path.resolve(process.cwd(), options.dataDir);
    fs.mkdirSync(dataDir, { recursive: true });

    const timestamp = new Date().toISOString();

    let newVersion;
    let dataFile;
    if (options.fetchConnectors) {
      try {
        newVersion = getRpkConnectVersion();
        const tmpFile = path.join(dataDir, `connect-${newVersion}.tmp.json`);
        const finalFile = path.join(dataDir, `connect-${newVersion}.json`);

        const fd = fs.openSync(tmpFile, 'w');
        const r = spawnSync('rpk', ['connect', 'list', '--format', 'json-full'], { stdio: ['ignore', fd, 'inherit'] });
        fs.closeSync(fd);

        const rawJson = fs.readFileSync(tmpFile, 'utf8');
        const parsed = JSON.parse(rawJson);
        fs.writeFileSync(finalFile, JSON.stringify(parsed, null, 2));
        fs.unlinkSync(tmpFile);
        dataFile = finalFile;
        console.log(`✅ Fetched and saved: ${finalFile}`);

        // Keep only 2 most recent versions in docs-data
        const dataFiles = fs.readdirSync(dataDir)
          .filter(f => /^connect-\d+\.\d+\.\d+\.json$/.test(f))
          .sort();

        while (dataFiles.length > 2) {
          const oldestFile = dataFiles.shift();
          const oldestPath = path.join(dataDir, oldestFile);
          fs.unlinkSync(oldestPath);
          console.log(`🧹 Deleted old version from docs-data: ${oldestFile}`);
        }
      } catch (err) {
        console.error(`❌ Failed to fetch connectors: ${err.message}`);
        process.exit(1);
      }
    } else {
      const candidates = fs.readdirSync(dataDir).filter(f => /^connect-\d+\.\d+\.\d+\.json$/.test(f));
      if (candidates.length === 0) {
        console.error('❌ No connect-<version>.json found. Use --fetch-connectors.');
        process.exit(1);
      }
      candidates.sort();
      dataFile = path.join(dataDir, candidates[candidates.length - 1]);
      newVersion = candidates[candidates.length - 1].match(/connect-(\d+\.\d+\.\d+)\.json/)[1];
    }

    console.log('⏳ Generating connector partials...');
    let partialsWritten, partialFiles, draftsWritten, draftFiles;

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
      });
      partialsWritten = result.partialsWritten;
      partialFiles    = result.partialFiles;
    } catch (err) {
      console.error(`❌ Failed to generate partials: ${err.message}`);
      process.exit(1);
    }

    if (options.draftMissing) {
      console.log('⏳ Drafting missing connectors…');
      try {
        const connectorList = await parseCSVConnectors(options.csv, console);
        const validConnectors = connectorList.filter(r => r.name && r.type);

        const roots = {
          pages:   path.resolve(process.cwd(), 'modules/components/pages'),
          partials:path.resolve(process.cwd(), 'modules/components/partials/components'),
        };

        // find any connector that has NO .adoc under pages/TYPEs or partials/TYPEs
        const allMissing = validConnectors.filter(({ name, type }) => {
          const relPath = path.join(`${type}s`, `${name}.adoc`);
          const existsInAny = Object.values(roots).some(root =>
            fs.existsSync(path.join(root, relPath))
          );
          return !existsInAny;
        });

        // still skip sql_driver
        const missingConnectors = allMissing.filter(c => !c.name.includes('sql_driver'));

        if (missingConnectors.length === 0) {
          console.log('✅ All connectors (excluding sql_drivers) already have docs—nothing to draft.');
        } else {
          console.log(`⏳ Docs missing for ${missingConnectors.length} connectors:`);
          missingConnectors.forEach(({ name, type }) => {
            console.log(`   • ${type}/${name}`);
          });
          console.log('');

          // build your filtered JSON as before…
          const rawData = fs.readFileSync(dataFile, 'utf8');
          const dataObj = JSON.parse(rawData);
          const filteredDataObj = {};

          for (const [key, arr] of Object.entries(dataObj)) {
            if (!Array.isArray(arr)) {
              filteredDataObj[key] = arr;
              continue;
            }
            filteredDataObj[key] = arr.filter(component =>
              missingConnectors.some(
                m => m.name === component.name && `${m.type}s` === key
              )
            );
          }

          const tempDataPath = path.join(dataDir, '._filtered_connect_data.json');
          fs.writeFileSync(tempDataPath, JSON.stringify(filteredDataObj, null, 2), 'utf8');

          const draftResult = await generateRpcnConnectorDocs({
            data:            tempDataPath,
            overrides:       options.overrides,
            template:        options.templateMain,
            templateFields:  options.templateFields,
            templateExamples:options.templateExamples,
            templateIntro:   options.templateIntro,
            writeFullDrafts: true
          });

          fs.unlinkSync(tempDataPath);
          draftsWritten = draftResult.draftsWritten;
          draftFiles   = draftResult.draftFiles;
        }
      } catch (err) {
        console.error(`❌ Could not draft missing: ${err.message}`);
        process.exit(1);
      }
    }

    let oldIndex = {};
    let oldVersion = null;
    if (options.oldData && fs.existsSync(options.oldData)) {
      oldIndex = JSON.parse(fs.readFileSync(options.oldData, 'utf8'));
      const m = options.oldData.match(/connect-([\d.]+)\.json$/);
      if (m) oldVersion = m[1];
    } else {
      oldVersion = getAntoraValue('asciidoc.attributes.latest-connect-version');
      if (oldVersion) {
        const oldPath = path.join(dataDir, `connect-${oldVersion}.json`);
        if (fs.existsSync(oldPath)) {
          oldIndex = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
        }
      }
    }

    const newIndex = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

    // Check if versions match - skip diff and updates if so
    if (oldVersion && newVersion && oldVersion === newVersion) {
      console.log(`\n✓ Already at version ${newVersion}`);
      console.log('  No diff or version updates needed.\n');

      console.log('📊 Generation Report:');
      console.log(`   • Partial files: ${partialsWritten}`);
      const fieldsPartials   = partialFiles.filter(fp => fp.includes('/fields/'));
      const examplesPartials = partialFiles.filter(fp => fp.includes('/examples/'));

      console.log(`   • Fields partials: ${fieldsPartials.length}`);
      console.log(`   • Examples partials: ${examplesPartials.length}`);

      if (options.draftMissing && draftsWritten) {
        console.log(`   • Draft files: ${draftsWritten}`);
      }

      process.exit(0);
    }

    // Publish merged version with overrides to modules/components/attachments
    if (options.overrides && fs.existsSync(options.overrides)) {
      try {
        const { mergeOverrides, resolveReferences } = require('../tools/redpanda-connect/generate-rpcn-connector-docs.js');

        // Create a copy of newIndex to merge overrides into
        const mergedData = JSON.parse(JSON.stringify(newIndex));

        // Read and apply overrides
        const ovRaw = fs.readFileSync(options.overrides, 'utf8');
        const ovObj = JSON.parse(ovRaw);
        const resolvedOverrides = resolveReferences(ovObj, ovObj);
        mergeOverrides(mergedData, resolvedOverrides);

        // Publish to modules/components/attachments
        const attachmentsRoot = path.resolve(process.cwd(), 'modules/components/attachments');
        fs.mkdirSync(attachmentsRoot, { recursive: true });

        // Delete older versions from modules/components/attachments
        const existingFiles = fs.readdirSync(attachmentsRoot)
          .filter(f => /^connect-\d+\.\d+\.\d+\.json$/.test(f))
          .sort();

        for (const oldFile of existingFiles) {
          const oldFilePath = path.join(attachmentsRoot, oldFile);
          fs.unlinkSync(oldFilePath);
          console.log(`🧹 Deleted old version: ${oldFile}`);
        }

        // Save merged version to modules/components/attachments
        const destFile = path.join(attachmentsRoot, `connect-${newVersion}.json`);
        fs.writeFileSync(destFile, JSON.stringify(mergedData, null, 2), 'utf8');
        console.log(`✅ Published merged version to: ${path.relative(process.cwd(), destFile)}`);
      } catch (err) {
        console.error(`❌ Failed to publish merged version: ${err.message}`);
      }
    }

    printDeltaReport(oldIndex, newIndex);

    // Generate JSON diff file for whats-new.adoc
    const { generateConnectorDiffJson } = require('../tools/redpanda-connect/report-delta.js');
    const diffJson = generateConnectorDiffJson(
      oldIndex,
      newIndex,
      {
        oldVersion: oldVersion || '',
        newVersion,
        timestamp
      }
    );
    const diffPath = path.join(dataDir, `connect-diff-${(oldVersion || 'unknown')}_to_${newVersion}.json`);
    fs.writeFileSync(diffPath, JSON.stringify(diffJson, null, 2), 'utf8');
    console.log(`✅ Connector diff JSON written to: ${diffPath}`);

    function logCollapsed(label, filesArray, maxToShow = 10) {
      console.log(`  • ${label}: ${filesArray.length} total`);
      const sample = filesArray.slice(0, maxToShow);
      sample.forEach(fp => console.log(`    – ${fp}`));
      const remaining = filesArray.length - sample.length;
      if (remaining > 0) {
        console.log(`    … plus ${remaining} more`);
      }
      console.log('');
    }

    const wrote = setAntoraValue('asciidoc.attributes.latest-connect-version', newVersion);
    if (wrote) {
      console.log(`✅ Updated Antora version: ${newVersion}`);
    }

    console.log('📊 Generation Report:');
    console.log(`   • Partial files: ${partialsWritten}`);
    // Split “partials” into fields vs examples by checking the path substring.
    const fieldsPartials   = partialFiles.filter(fp => fp.includes('/fields/'));
    const examplesPartials = partialFiles.filter(fp => fp.includes('/examples/'));

    // Show only up to 10 of each
    logCollapsed('Fields partials', fieldsPartials,   10);
    logCollapsed('Examples partials', examplesPartials, 10);

    if (options.draftMissing) {
      console.log(`   • Full drafts:   ${draftsWritten}`);
      logCollapsed('Draft files', draftFiles, 5);
    }

    // Optionally update whats-new.adoc
    if (options.updateWhatsNew) {
      // Helper function to cap description to two sentences
      const capToTwoSentences = (description) => {
        if (!description) return '';

        // Helper to check if text contains problematic content
        const hasProblematicContent = (text) => {
          return /```[\s\S]*?```/.test(text) ||  // code blocks
                 /`[^`]+`/.test(text) ||          // inline code
                 /^[=#]+\s+.+$/m.test(text) ||    // headings
                 /\n/.test(text);                 // newlines
        };

        // Step 1: Replace common abbreviations and ellipses with placeholders
        const abbreviations = [
          /\bv\d+\.\d+(?:\.\d+)?/gi, // version numbers like v4.12 or v4.12.0 (must come before decimal)
          /\d+\.\d+/g,               // decimal numbers
          /\be\.g\./gi,              // e.g.
          /\bi\.e\./gi,              // i.e.
          /\betc\./gi,               // etc.
          /\bvs\./gi,                // vs.
          /\bDr\./gi,                // Dr.
          /\bMr\./gi,                // Mr.
          /\bMs\./gi,                // Ms.
          /\bMrs\./gi,               // Mrs.
          /\bSt\./gi,                // St.
          /\bNo\./gi                 // No.
        ];

        let normalized = description;
        const placeholders = [];

        // Replace abbreviations with placeholders
        abbreviations.forEach((abbrevRegex, idx) => {
          normalized = normalized.replace(abbrevRegex, (match) => {
            const placeholder = `__ABBREV${idx}_${placeholders.length}__`;
            placeholders.push({ placeholder, original: match });
            return placeholder;
          });
        });

        // Replace ellipses (three or more dots) with placeholder
        normalized = normalized.replace(/\.{3,}/g, (match) => {
          const placeholder = `__ELLIPSIS_${placeholders.length}__`;
          placeholders.push({ placeholder, original: match });
          return placeholder;
        });

        // Step 2: Split sentences using the regex
        const sentenceRegex = /[^.!?]+[.!?]+(?:\s|$)/g;
        const sentences = normalized.match(sentenceRegex);

        if (!sentences || sentences.length === 0) {
          // Restore placeholders and return original
          let result = normalized;
          placeholders.forEach(({ placeholder, original }) => {
            result = result.replace(placeholder, original);
          });
          return result;
        }

        // Step 3: Determine how many sentences to include
        let maxSentences = 2;

        // If we have at least 2 sentences, check if the second one has problematic content
        if (sentences.length >= 2) {
          // Restore placeholders in second sentence to check original content
          let secondSentence = sentences[1];
          placeholders.forEach(({ placeholder, original }) => {
            secondSentence = secondSentence.replace(new RegExp(placeholder, 'g'), original);
          });

          // If second sentence has problematic content, only take first sentence
          if (hasProblematicContent(secondSentence)) {
            maxSentences = 1;
          }
        }

        let result = sentences.slice(0, maxSentences).join('');

        // Step 4: Restore placeholders back to original text
        placeholders.forEach(({ placeholder, original }) => {
          result = result.replace(new RegExp(placeholder, 'g'), original);
        });

        return result.trim();
      };

      try {
        const whatsNewPath = path.join(findRepoRoot(), 'modules/get-started/pages/whats-new.adoc');
        if (!fs.existsSync(whatsNewPath)) {
          console.error(`❌ Unable to update release notes: 'whats-new.adoc' was not found at: ${whatsNewPath}\nPlease ensure this file exists and is tracked in your repository.`);
          return;
        }
        // Find the diff JSON file we just wrote
        const diffPath = path.join(dataDir, `connect-diff-${(oldVersion || 'unknown')}_to_${newVersion}.json`);
        if (!fs.existsSync(diffPath)) {
          console.error(`❌ Unable to update release notes: The connector diff JSON was not found at: ${diffPath}\nPlease ensure the diff was generated successfully before updating release notes.`);
          return;
        }
        let diff;
        try {
          diff = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
        } catch (jsonErr) {
          console.error(`❌ Unable to parse connector diff JSON at ${diffPath}: ${jsonErr.message}\nPlease check the file for syntax errors or corruption.`);
          return;
        }
        let whatsNewContent;
        try {
          whatsNewContent = fs.readFileSync(whatsNewPath, 'utf8');
        } catch (readErr) {
          console.error(`❌ Unable to read whats-new.adoc at ${whatsNewPath}: ${readErr.message}\nPlease check file permissions and try again.`);
          return;
        }
  const whatsNew = whatsNewContent;
        // Regex to find section for this version
        const versionTitle = `== Version ${diff.comparison.newVersion}`;
        const versionRe = new RegExp(`^== Version ${diff.comparison.newVersion.replace(/[-.]/g, '\\$&')}(?:\\r?\\n|$)`, 'm');
        const match = versionRe.exec(whatsNew);
        let startIdx = match ? match.index : -1;
        let endIdx = -1;
        if (startIdx !== -1) {
          // Find the start of the next version section
          const rest = whatsNew.slice(startIdx + 1);
          const nextMatch = /^== Version /m.exec(rest);
          endIdx = nextMatch ? startIdx + 1 + nextMatch.index : whatsNew.length;
        }
        // Compose new section
        // Add link to full release notes for this connector version after version heading
        let releaseNotesLink = '';
        if (diff.comparison && diff.comparison.newVersion) {
          releaseNotesLink = `link:https://github.com/redpanda-data/connect/releases/tag/v${diff.comparison.newVersion}[See the full release notes^].\n\n`;
        }
        let section = `\n== Version ${diff.comparison.newVersion}\n\n${releaseNotesLink}`;

        // Separate Bloblang components from regular components
        const bloblangComponents = [];
        const regularComponents = [];

        if (diff.details.newComponents && diff.details.newComponents.length) {
          for (const comp of diff.details.newComponents) {
            if (comp.type === 'bloblang-functions' || comp.type === 'bloblang-methods') {
              bloblangComponents.push(comp);
            } else {
              regularComponents.push(comp);
            }
          }
        }

        // Bloblang updates section
        if (bloblangComponents.length > 0) {
          section += '=== Bloblang updates\n\n';
          section += 'This release adds the following new Bloblang capabilities:\n\n';

          // Group by type (functions vs methods)
          const byType = {};
          for (const comp of bloblangComponents) {
            if (!byType[comp.type]) byType[comp.type] = [];
            byType[comp.type].push(comp);
          }

          for (const [type, comps] of Object.entries(byType)) {
            if (type === 'bloblang-functions') {
              section += '* Functions:\n';
              for (const comp of comps) {
                section += `** xref:guides:bloblang/functions.adoc#${comp.name}[\`${comp.name}\`]`;
                if (comp.status && comp.status !== 'stable') section += ` (${comp.status})`;
                if (comp.description) section += `: ${capToTwoSentences(comp.description)}`;
                section += '\n';
              }
            } else if (type === 'bloblang-methods') {
              section += '* Methods:\n';
              for (const comp of comps) {
                section += `** xref:guides:bloblang/methods.adoc#${comp.name}[\`${comp.name}\`]`;
                if (comp.status && comp.status !== 'stable') section += ` (${comp.status})`;
                if (comp.description) section += `: ${capToTwoSentences(comp.description)}`;
                section += '\n';
              }
            }
          }
          section += '\n';
        }

        // Regular component updates section
        if (regularComponents.length > 0) {
          section += '=== Component updates\n\n';
          section += 'This release adds the following new components:\n\n';

          section += '[cols="1m,1,1,3"]\n';
          section += '|===\n';
          section += '|Component |Type |Status |Description\n\n';

          for (const comp of regularComponents) {
            const typeLabel = comp.type.charAt(0).toUpperCase() + comp.type.slice(1);
            const statusLabel = comp.status || '-';
            const desc = comp.description ? capToTwoSentences(comp.description) : '-';

            section += `|xref:components:${comp.type}/${comp.name}.adoc[${comp.name}]\n`;
            section += `|${typeLabel}\n`;
            section += `|${statusLabel}\n`;
            section += `|${desc}\n\n`;
          }

          section += '|===\n\n';
        }

        // New fields (exclude Bloblang functions/methods)
        if (diff.details.newFields && diff.details.newFields.length) {
          // Filter out Bloblang components
          const regularFields = diff.details.newFields.filter(field => {
            const [type] = field.component.split(':');
            return type !== 'bloblang-functions' && type !== 'bloblang-methods';
          });

          if (regularFields.length > 0) {
            section += '\n=== New field support\n\n';
            section += 'This release adds support for the following new fields:\n\n';

            // Group by field name
            const byField = {};
            for (const field of regularFields) {
              const [type, compName] = field.component.split(':');
              if (!byField[field.field]) {
                byField[field.field] = {
                  description: field.description,
                  components: []
                };
              }
              byField[field.field].components.push({ type, name: compName });
            }

            section += '[cols="1m,3,2a"]\n';
            section += '|===\n';
            section += '|Field |Description |Affected components\n\n';

            for (const [fieldName, info] of Object.entries(byField)) {
              // Format component list - group by type
              const byType = {};
              for (const comp of info.components) {
                if (!byType[comp.type]) byType[comp.type] = [];
                byType[comp.type].push(comp.name);
              }

              let componentList = '';
              for (const [type, names] of Object.entries(byType)) {
                if (componentList) componentList += '\n\n';

                // Smart pluralization: don't add 's' if already plural
                const typeLabel = names.length === 1
                  ? type.charAt(0).toUpperCase() + type.slice(1)
                  : type.charAt(0).toUpperCase() + type.slice(1) + (type.endsWith('s') ? '' : 's');

                componentList += `*${typeLabel}:*\n\n`;
                names.forEach(name => {
                  componentList += `* xref:components:${type}/${name}.adoc#${fieldName}[${name}]\n`;
                });
              }

              const desc = info.description ? capToTwoSentences(info.description) : '-';

              section += `|${fieldName}\n`;
              section += `|${desc}\n`;
              section += `|${componentList}\n\n`;
            }

            section += '|===\n\n';
          }
        }

        // Deprecated components
        if (diff.details.deprecatedComponents && diff.details.deprecatedComponents.length) {
          section += '\n=== Deprecations\n\n';
          section += 'The following components are now deprecated:\n\n';

          section += '[cols="1m,1,3"]\n';
          section += '|===\n';
          section += '|Component |Type |Description\n\n';

          for (const comp of diff.details.deprecatedComponents) {
            const typeLabel = comp.type.charAt(0).toUpperCase() + comp.type.slice(1);
            const desc = comp.description ? capToTwoSentences(comp.description) : '-';

            if (comp.type === 'bloblang-functions') {
              section += `|xref:guides:bloblang/functions.adoc#${comp.name}[${comp.name}]\n`;
            } else if (comp.type === 'bloblang-methods') {
              section += `|xref:guides:bloblang/methods.adoc#${comp.name}[${comp.name}]\n`;
            } else {
              section += `|xref:components:${comp.type}/${comp.name}.adoc[${comp.name}]\n`;
            }
            section += `|${typeLabel}\n`;
            section += `|${desc}\n\n`;
          }

          section += '|===\n\n';
        }

        // Deprecated fields (exclude Bloblang functions/methods)
        if (diff.details.deprecatedFields && diff.details.deprecatedFields.length) {
          // Filter out Bloblang components
          const regularDeprecatedFields = diff.details.deprecatedFields.filter(field => {
            const [type] = field.component.split(':');
            return type !== 'bloblang-functions' && type !== 'bloblang-methods';
          });

          if (regularDeprecatedFields.length > 0) {
            if (!diff.details.deprecatedComponents || diff.details.deprecatedComponents.length === 0) {
              section += '\n=== Deprecations\n\n';
            } else {
              section += '\n';
            }
            section += 'The following fields are now deprecated:\n\n';

            // Group by field name
            const byField = {};
            for (const field of regularDeprecatedFields) {
              const [type, compName] = field.component.split(':');
              if (!byField[field.field]) {
                byField[field.field] = {
                  description: field.description,
                  components: []
                };
              }
              byField[field.field].components.push({ type, name: compName });
            }

            section += '[cols="1m,3,2a"]\n';
            section += '|===\n';
            section += '|Field |Description |Affected components\n\n';

            for (const [fieldName, info] of Object.entries(byField)) {
              // Format component list - group by type
              const byType = {};
              for (const comp of info.components) {
                if (!byType[comp.type]) byType[comp.type] = [];
                byType[comp.type].push(comp.name);
              }

              let componentList = '';
              for (const [type, names] of Object.entries(byType)) {
                if (componentList) componentList += '\n\n';

                // Smart pluralization: don't add 's' if already plural
                const typeLabel = names.length === 1
                  ? type.charAt(0).toUpperCase() + type.slice(1)
                  : type.charAt(0).toUpperCase() + type.slice(1) + (type.endsWith('s') ? '' : 's');

                componentList += `*${typeLabel}:*\n\n`;
                names.forEach(name => {
                  componentList += `* xref:components:${type}/${name}.adoc#${fieldName}[${name}]\n`;
                });
              }

              const desc = info.description ? capToTwoSentences(info.description) : '-';

              section += `|${fieldName}\n`;
              section += `|${desc}\n`;
              section += `|${componentList}\n\n`;
            }

            section += '|===\n\n';
          }
        }

        // Changed defaults (exclude Bloblang functions/methods)
        if (diff.details.changedDefaults && diff.details.changedDefaults.length) {
          // Filter out Bloblang components
          const regularChangedDefaults = diff.details.changedDefaults.filter(change => {
            const [type] = change.component.split(':');
            return type !== 'bloblang-functions' && type !== 'bloblang-methods';
          });

          if (regularChangedDefaults.length > 0) {
            section += '\n=== Default value changes\n\n';
            section += 'This release includes the following default value changes:\n\n';

            // Group by field name and default values to avoid overwriting different default changes
            const byFieldAndDefaults = {};
            for (const change of regularChangedDefaults) {
              const [type, compName] = change.component.split(':');
              const compositeKey = `${change.field}|${String(change.oldDefault)}|${String(change.newDefault)}`;
              if (!byFieldAndDefaults[compositeKey]) {
                byFieldAndDefaults[compositeKey] = {
                  field: change.field,
                  oldDefault: change.oldDefault,
                  newDefault: change.newDefault,
                  description: change.description,
                  components: []
                };
              }
              byFieldAndDefaults[compositeKey].components.push({
                type,
                name: compName
              });
            }

            // Create table
            section += '[cols="1m,1,1,3,2a"]\n';
            section += '|===\n';
            section += '|Field |Old default |New default |Description |Affected components\n\n';

            for (const [compositeKey, info] of Object.entries(byFieldAndDefaults)) {
              // Format old and new defaults
              const formatDefault = (val) => {
                if (val === undefined || val === null) return 'none';
                if (typeof val === 'string') return val;
                if (typeof val === 'number' || typeof val === 'boolean') return String(val);
                return JSON.stringify(val);
              };

              const oldVal = formatDefault(info.oldDefault);
              const newVal = formatDefault(info.newDefault);

              // Get description
              const desc = info.description ? capToTwoSentences(info.description) : '-';

              // Format component references - group by type
              const byType = {};
              for (const comp of info.components) {
                if (!byType[comp.type]) byType[comp.type] = [];
                byType[comp.type].push(comp.name);
              }

              let componentList = '';
              for (const [type, names] of Object.entries(byType)) {
                if (componentList) componentList += '\n\n';

                // Smart pluralization: don't add 's' if already plural
                const typeLabel = names.length === 1
                  ? type.charAt(0).toUpperCase() + type.slice(1)
                  : type.charAt(0).toUpperCase() + type.slice(1) + (type.endsWith('s') ? '' : 's');

                componentList += `*${typeLabel}:*\n\n`;

                // List components, with links to the field anchor
                names.forEach(name => {
                  componentList += `* xref:components:${type}/${name}.adoc#${info.field}[${name}]\n`;
                });
              }

              section += `|${info.field}\n`;
              section += `|${oldVal}\n`;
              section += `|${newVal}\n`;
              section += `|${desc}\n`;
              section += `|${componentList}\n\n`;
            }

            section += '|===\n\n';
          }
        }

        let updated;
        if (startIdx !== -1) {
          // Replace the existing section
          updated = whatsNew.slice(0, startIdx) + section + '\n' + whatsNew.slice(endIdx);
          console.log(`♻️  whats-new.adoc: replaced section for Version ${diff.comparison.newVersion}`);
        } else {
          // Insert above first version heading
          const versionHeading = /^== Version /m;
          const firstMatch = versionHeading.exec(whatsNew);
          let insertIdx = firstMatch ? firstMatch.index : 0;
          updated = whatsNew.slice(0, insertIdx) + section + '\n' + whatsNew.slice(insertIdx);
          console.log(`✅ whats-new.adoc updated with Version ${diff.comparison.newVersion}`);
        }
        fs.writeFileSync(whatsNewPath, updated, 'utf8');
      } catch (err) {
        console.error(`❌ Failed to update whats-new.adoc: ${err.message}`);
      }
    }

    console.log('\n📄 Summary:');
    console.log(`   • Run time: ${timestamp}`);
    console.log(`   • Version used: ${newVersion}`);
    process.exit(0);
  });

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
 * npx doc-tools generate property-docs \\
 *   --tag v25.3.1 \\
 *   --generate-partials \\
 *   --cloud-support
 *
 * # Compare properties between versions
 * npx doc-tools generate property-docs \\
 *   --tag v25.3.1 \\
 *   --diff v25.2.1
 *
 * # Use custom output directory
 * npx doc-tools generate property-docs \\
 *   --tag v25.3.1 \\
 *   --output-dir docs/modules/reference
 *
 * # Full workflow: document new release
 * VERSION=$(npx doc-tools get-redpanda-version)
 * npx doc-tools generate property-docs \\
 *   --tag $VERSION \\
 *   --generate-partials \\
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
    'By default, only extracts properties to JSON. Use --generate-partials to create consolidated ' +
    'AsciiDoc partials (including deprecated properties). Defaults to branch "dev" if neither --tag nor --branch is specified.'
  )
  .option('-t, --tag <tag>', 'Git tag for released content (GA/beta)')
  .option('-b, --branch <branch>', 'Branch name for in-progress content', 'dev')
  .option('--diff <oldTag>', 'Also diff autogenerated properties from <oldTag> to current tag/branch')
  .option('--overrides <path>', 'Optional JSON file with property description overrides', 'docs-data/property-overrides.json')
  .option('--output-dir <dir>', 'Where to write all generated files', 'modules/reference')
  .option('--cloud-support', 'Add AsciiDoc tags to generated property docs to indicate which ones are supported in Redpanda Cloud. This data is fetched from the cloudv2 repository so requires a GitHub token with repo permissions. Set the token as an environment variable using GITHUB_TOKEN, GH_TOKEN, or REDPANDA_GITHUB_TOKEN')
  .option('--template-property <path>', 'Custom Handlebars template for individual property sections')
  .option('--template-topic-property <path>', 'Custom Handlebars template for individual topic property sections')
  .option('--template-topic-property-mappings <path>', 'Custom Handlebars template for topic property mappings table')
  .option('--template-deprecated <path>', 'Custom Handlebars template for deprecated properties page')
  .option('--template-deprecated-property <path>', 'Custom Handlebars template for individual deprecated property sections')
  .option('--generate-partials', 'Generate consolidated property partials (cluster-properties.adoc, topic-properties.adoc, etc.) in the partials directory')
  .option('--partials-dir <path>', 'Directory for property partials (relative to output-dir)', 'partials')
  .action((options) => {
    verifyPropertyDependencies();

    // Validate that tag and branch are mutually exclusive
    if (options.tag && options.branch) {
      console.error('❌ Error: Cannot specify both --tag and --branch');
      process.exit(1);
    }

    // Determine the git ref to use
    const newTag = options.tag || options.branch;

    // Validate cloud support dependencies if requested
    if (options.cloudSupport) {
      console.log('🔍 Validating cloud support dependencies...');
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.REDPANDA_GITHUB_TOKEN;
      if (!token) {
        console.error('❌ Cloud support requires GITHUB_TOKEN, GH_TOKEN, or REDPANDA_GITHUB_TOKEN environment variable');
        console.error('   Set up GitHub token:');
        console.error('   1. Go to https://github.com/settings/tokens');
        console.error('   2. Generate token with "repo" scope');
        console.error('   3. Set: export GITHUB_TOKEN=your_token_here');
        console.error('   Or: export GH_TOKEN=your_token_here');
        console.error('   Or: export REDPANDA_GITHUB_TOKEN=your_token_here');
        process.exit(1);
      }
      console.log('📦 Cloud support enabled - Python dependencies will be validated during execution');
      if (process.env.VIRTUAL_ENV) {
        console.log(`   Using virtual environment: ${process.env.VIRTUAL_ENV}`);
      }
      console.log('   Required packages: pyyaml, requests');
      console.log('✅ GitHub token validated');
    }
    let oldTag = options.diff;
    const overridesPath = options.overrides;
    const outputDir = options.outputDir;
    const cwd = path.resolve(__dirname, '../tools/property-extractor');

    // If --diff is not provided, try to get the latest-redpanda-tag from Antora attributes
    if (!oldTag) {
      oldTag = getAntoraValue('asciidoc.attributes.latest-redpanda-tag');
      if (oldTag) {
        console.log(`Using latest-redpanda-tag from Antora attributes for --diff: ${oldTag}`);
      } else {
        console.log('No --diff provided and no latest-redpanda-tag found in Antora attributes. Skipping diff.');
      }
    }

    const make = (tag, overrides, templates = {}, outDir = 'modules/reference/') => {
      console.log(`⏳ Building property docs for ${tag}…`);
      const args = ['build', `TAG=${tag}`];
      const env = { ...process.env };
      if (overrides) {
        env.OVERRIDES = path.resolve(overrides);
      }
      if (options.cloudSupport) {
        env.CLOUD_SUPPORT = '1';
      }
      if (templates.property) {
        env.TEMPLATE_PROPERTY = path.resolve(templates.property);
      }
      if (templates.topicProperty) {
        env.TEMPLATE_TOPIC_PROPERTY = path.resolve(templates.topicProperty);
      }
      if (templates.topicPropertyMappings) {
        env.TEMPLATE_TOPIC_PROPERTY_MAPPINGS = path.resolve(templates.topicPropertyMappings);
      }
      if (templates.deprecated) {
        env.TEMPLATE_DEPRECATED = path.resolve(templates.deprecated);
      }
      if (templates.deprecatedProperty) {
        env.TEMPLATE_DEPRECATED_PROPERTY = path.resolve(templates.deprecatedProperty);
      }
      env.OUTPUT_JSON_DIR = path.resolve(outDir, 'attachments');
      env.OUTPUT_AUTOGENERATED_DIR = path.resolve(outDir);
      if (options.generatePartials) {
        env.GENERATE_PARTIALS = '1';
        env.OUTPUT_PARTIALS_DIR = path.resolve(outDir, options.partialsDir || 'partials');
      }
      const r = spawnSync('make', args, { cwd, stdio: 'inherit', env });
      if (r.error) {
        console.error(`❌ ${r.error.message}`);
        process.exit(1);
      }
      if (r.status !== 0) process.exit(r.status);
    };

    const templates = {
      property: options.templateProperty,
      topicProperty: options.templateTopicProperty,
      topicPropertyMappings: options.templateTopicPropertyMappings,
      deprecated: options.templateDeprecated,
      deprecatedProperty: options.templateDeprecatedProperty,
    };

    const tagsAreSame = oldTag && newTag && oldTag === newTag;
    if (oldTag && !tagsAreSame) {
      make(oldTag, overridesPath, templates, outputDir);
    }
    make(newTag, overridesPath, templates, outputDir);
    if (oldTag && !tagsAreSame) {
      // Save diff to overrides directory if OVERRIDES is specified, otherwise to outputDir
      const diffOutputDir = overridesPath ? path.dirname(path.resolve(overridesPath)) : outputDir;
      generatePropertyComparisonReport(oldTag, newTag, diffOutputDir);

      // Cleanup old diff files (keep only 2 most recent)
      cleanupOldDiffs(diffOutputDir);
    } else if (tagsAreSame) {
      console.log('--diff and --tag are the same. Skipping diff and Antora config update.');
    }

    // If we used Antora's latest-redpanda-tag for diff, update it to the new tag
    if (!options.diff && !tagsAreSame) {
      const success = setAntoraValue('asciidoc.attributes.latest-redpanda-tag', newTag);
      if (success) {
        console.log(`✅ Updated Antora latest-redpanda-tag to: ${newTag}`);
      }
    }

    process.exit(0);
  });

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
 * npx doc-tools generate rpk-docs \\
 *   --tag v25.3.1 \\
 *   --diff v25.2.1
 *
 * # Use custom Docker repository
 * npx doc-tools generate rpk-docs \\
 *   --tag v25.3.1 \\
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
  .option('-b, --branch <branch>', 'Branch name for in-progress content', 'dev')
  .option(
    '--docker-repo <repo>',
    'Docker repository to use when starting Redpanda in Docker',
    commonOptions.dockerRepo
  )
  .option(
    '--console-tag <tag>',
    'Redpanda Console version to use when starting Redpanda Console in Docker',
    commonOptions.consoleTag
  )
  .option(
    '--console-docker-repo <repo>',
    'Docker repository to use when starting Redpanda Console in Docker',
    commonOptions.consoleDockerRepo
  )
  .option('--diff <oldTag>', 'Also diff autogenerated rpk docs from <oldTag> → <tag>')
  .action((options) => {
    verifyMetricsDependencies();

    // Validate that tag and branch are mutually exclusive
    if (options.tag && options.branch) {
      console.error('❌ Error: Cannot specify both --tag and --branch');
      process.exit(1);
    }

    const newTag = options.tag || options.branch;
    const oldTag = options.diff;

    if (oldTag) {
      const oldDir = path.join('autogenerated', oldTag, 'rpk');
      if (!fs.existsSync(oldDir)) {
        console.log(`⏳ Generating rpk docs for old tag ${oldTag}…`);
        runClusterDocs('rpk', oldTag, options);
      }
    }

    console.log(`⏳ Generating rpk docs for new tag ${newTag}…`);
    runClusterDocs('rpk', newTag, options);

    if (oldTag) {
      diffDirs('rpk', oldTag, newTag);
    }

    process.exit(0);
  });

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
 * npx doc-tools generate helm-spec \\
 *   --chart-dir https://github.com/redpanda-data/helm-charts \\
 *   --tag v5.9.0 \\
 *   --output-dir modules/deploy/pages
 *
 * # Generate docs from local chart directory
 * npx doc-tools generate helm-spec \\
 *   --chart-dir ./charts/redpanda \\
 *   --output-dir docs/modules/deploy/pages
 *
 * # Use custom README and output suffix
 * npx doc-tools generate helm-spec \\
 *   --chart-dir https://github.com/redpanda-data/helm-charts \\
 *   --tag v5.9.0 \\
 *   --readme docs/README.md \\
 *   --output-suffix -values.adoc
 *
 * @requirements
 * - For GitHub URLs: Git and internet connection
 * - For local charts: Chart directory must contain Chart.yaml
 * - README.md file in chart directory (optional but recommended)
 */
automation
  .command('helm-spec')
  .description(
    `Generate AsciiDoc documentation for one or more Helm charts (supports local dirs or GitHub URLs). When using GitHub URLs, requires either --tag or --branch to be specified.`
  )
  .option(
    '--chart-dir <dir|url>',
    'Chart directory (contains Chart.yaml) or a root containing multiple charts, or a GitHub URL',
    'https://github.com/redpanda-data/redpanda-operator/charts'
  )
  .option('-t, --tag <tag>', 'Git tag for released content when using GitHub URL (auto-prepends "operator/" for redpanda-operator repository)')
  .option('-b, --branch <branch>', 'Branch name for in-progress content when using GitHub URL')
  .option('--readme <file>', 'Relative README.md path inside each chart dir', 'README.md')
  .option('--output-dir <dir>', 'Where to write all generated AsciiDoc files', 'modules/reference/pages')
  .option('--output-suffix <suffix>', 'Suffix to append to each chart name (including extension)', '-helm-spec.adoc')
  .action((opts) => {
    verifyHelmDependencies();

    // Prepare chart-root (local or GitHub)
    let root = opts.chartDir;
    let tmpClone = null;

    if (/^https?:\/\/github\.com\//.test(root)) {
      // Validate tag/branch for GitHub URLs
      if (!opts.tag && !opts.branch) {
        console.error('❌ When using a GitHub URL you must pass either --tag or --branch');
        process.exit(1);
      }
      if (opts.tag && opts.branch) {
        console.error('❌ Cannot specify both --tag and --branch');
        process.exit(1);
      }

      let gitRef = opts.tag || opts.branch;

      // Normalize tag: add 'v' prefix if not present for tags
      if (opts.tag && !gitRef.startsWith('v')) {
        gitRef = `v${gitRef}`;
        console.log(`ℹ️  Auto-prepending "v" to tag: ${gitRef}`);
      }

      const u = new URL(root);
      const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
      if (parts.length < 2) {
        console.error(`❌ Invalid GitHub URL: ${root}`);
        process.exit(1);
      }
      const [owner, repo, ...sub] = parts;
      const repoUrl = `https://${u.host}/${owner}/${repo}.git`;

      // Auto-prepend "operator/" for tags in redpanda-operator repository
      if (opts.tag && owner === 'redpanda-data' && repo === 'redpanda-operator') {
        if (!gitRef.startsWith('operator/')) {
          gitRef = `operator/${gitRef}`;
          console.log(`ℹ️  Auto-prepending "operator/" to tag: ${gitRef}`);
        }
      }

      console.log(`⏳ Verifying ${repoUrl}@${gitRef}…`);
      const ok =
        spawnSync(
          'git',
          ['ls-remote', '--exit-code', repoUrl, `refs/heads/${gitRef}`, `refs/tags/${gitRef}`],
          { stdio: 'ignore' }
        ).status === 0;
      if (!ok) {
        console.error(`❌ ${gitRef} not found on ${repoUrl}`);
        process.exit(1);
      }

      tmpClone = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-'));
      console.log(`⏳ Cloning ${repoUrl}@${gitRef} → ${tmpClone}`);
      if (
        spawnSync('git', ['clone', '--depth', '1', '--branch', gitRef, repoUrl, tmpClone], {
          stdio: 'inherit',
        }).status !== 0
      ) {
        console.error('❌ git clone failed');
        process.exit(1);
      }
      root = sub.length ? path.join(tmpClone, sub.join('/')) : tmpClone;
    }

    // Discover charts
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      console.error(`❌ Chart root not found: ${root}`);
      process.exit(1);
    }
    let charts = [];
    if (fs.existsSync(path.join(root, 'Chart.yaml'))) {
      charts = [root];
    } else {
      charts = fs
        .readdirSync(root)
        .map((n) => path.join(root, n))
        .filter((p) => fs.existsSync(path.join(p, 'Chart.yaml')));
    }
    if (charts.length === 0) {
      console.error(`❌ No charts found under: ${root}`);
      process.exit(1);
    }

    // Ensure output-dir exists
    const outDir = path.resolve(opts.outputDir);
    fs.mkdirSync(outDir, { recursive: true });

    // Process each chart
    for (const chartPath of charts) {
      const name = path.basename(chartPath);
      console.log(`⏳ Processing chart "${name}"…`);

      // Regenerate README.md
      console.log(`⏳ helm-docs in ${chartPath}`);
      let r = spawnSync('helm-docs', { cwd: chartPath, stdio: 'inherit' });
      if (r.status !== 0) process.exit(r.status);

      // Convert Markdown → AsciiDoc
      const md = path.join(chartPath, opts.readme);
      if (!fs.existsSync(md)) {
        console.error(`❌ README not found: ${md}`);
        process.exit(1);
      }
      const outFile = path.join(outDir, `k-${name}${opts.outputSuffix}`);
      console.log(`⏳ pandoc ${md} → ${outFile}`);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      r = spawnSync('pandoc', [md, '-t', 'asciidoc', '-o', outFile], { stdio: 'inherit' });
      if (r.status !== 0) process.exit(r.status);

      // Post-process tweaks
      let doc = fs.readFileSync(outFile, 'utf8');
      const xrefRe = /https:\/\/docs\.redpanda\.com[^\s\]\[\)"]+(?:\[[^\]]*\])?/g;
      doc = doc
        .replace(/(\[\d+\])\]\./g, '$1\\].')
        .replace(/(\[\d+\])\]\]/g, '$1\\]\\]')
        .replace(/^=== +(https?:\/\/[^\[]*)\[([^\]]*)\]/gm, '=== link:++$1++[$2]')
        .replace(/^== # (.*)$/gm, '= $1')
        .replace(/^== description: (.*)$/gm, ':description: $1')
        .replace(xrefRe, (match) => {
          let urlPart = match;
          let bracketPart = '';
          const m = match.match(/^([^\[]+)(\[[^\]]*\])$/);
          if (m) {
            urlPart = m[1];
            bracketPart = m[2];
          }
          if (urlPart.endsWith('#')) {
            return match;
          }
          try {
            const xref = urlToXref(urlPart);
            return bracketPart ? `${xref}${bracketPart}` : `${xref}[]`;
          } catch (err) {
            console.warn(`⚠️ urlToXref failed on ${urlPart}: ${err.message}`);
            return match;
          }
        });
      fs.writeFileSync(outFile, doc, 'utf8');

      console.log(`✅ Wrote ${outFile}`);
    }

    // Cleanup
    if (tmpClone) fs.rmSync(tmpClone, { recursive: true, force: true });
  });

/**
 * Generate Markdown table of cloud regions and tiers from master-data.yaml
 */
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
 * npx doc-tools generate cloud-regions \\
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
    const { generateCloudRegions } = require('../tools/cloud-regions/generate-cloud-regions.js');

    try {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.REDPANDA_GITHUB_TOKEN;
      if (!token) {
        throw new Error('GITHUB_TOKEN, GH_TOKEN, or REDPANDA_GITHUB_TOKEN environment variable is required to fetch from private cloudv2-infra repo.');
      }
      const fmt = (options.format || 'md').toLowerCase();
      let templatePath = undefined;
      if (options.template) {
        const repoRoot = findRepoRoot();
        templatePath = path.resolve(repoRoot, options.template);
        if (!fs.existsSync(templatePath)) {
          throw new Error(`Custom template not found: ${templatePath}`);
        }
      }
      const out = await generateCloudRegions({
        owner: options.owner,
        repo: options.repo,
        path: options.path,
        ref: options.ref,
        format: fmt,
        token,
        template: templatePath,
      });
      if (options.dryRun) {
        process.stdout.write(out);
        console.log(`\n✅ (dry-run) ${fmt === 'adoc' ? 'AsciiDoc' : 'Markdown'} output printed to stdout.`);
      } else {
        // Always resolve output relative to repo root
        const repoRoot = findRepoRoot();
        const absOutput = path.resolve(repoRoot, options.output);
        fs.mkdirSync(path.dirname(absOutput), { recursive: true });
        fs.writeFileSync(absOutput, out, 'utf8');
        console.log(`✅ Wrote ${absOutput}`);
      }
    } catch (err) {
      console.error(`❌ Failed to generate cloud regions: ${err.message}`);
      process.exit(1);
    }
  });

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
 * npx doc-tools generate crd-spec \\
 *   --tag operator/v2.2.6-25.3.1 \\
 *   --templates-dir custom/templates \\
 *   --output modules/reference/pages/operator-crd.adoc
 *
 * @requirements
 * - For GitHub URLs: Git and internet connection
 * - crd-ref-docs tool (automatically installed if missing)
 * - Go toolchain for running crd-ref-docs
 */
automation
  .command('crd-spec')
  .description('Generate Asciidoc documentation for Kubernetes CRD references. Requires either --tag or --branch to be specified.')
  .option('-t, --tag <operatorTag>', 'Operator release tag for GA/beta content (for example operator/v2.2.6-25.3.1 or v25.1.2). Auto-prepends "operator/" if not present.')
  .option('-b, --branch <branch>', 'Branch name for in-progress content (for example release/v2.2.x, main, dev)')
  .option(
    '-s, --source-path <src>',
    'CRD Go types dir or GitHub URL',
    'https://github.com/redpanda-data/redpanda-operator/operator/api/redpanda/v1alpha2'
  )
  .option('-d, --depth <n>', 'How many levels deep', '10')
  .option('--templates-dir <dir>', 'Asciidoctor templates dir', '.github/crd-config/templates/asciidoctor/operator')
  .option('--output <file>', 'Where to write the generated AsciiDoc file', 'modules/reference/pages/k-crd.adoc')
  .action(async (opts) => {
    verifyCrdDependencies();

    // Validate that either --tag or --branch is provided (but not both)
    if (!opts.tag && !opts.branch) {
      console.error('❌ Error: Either --tag or --branch must be specified');
      process.exit(1);
    }
    if (opts.tag && opts.branch) {
      console.error('❌ Error: Cannot specify both --tag and --branch');
      process.exit(1);
    }

    // Determine the git ref to use
    let configRef;
    if (opts.branch) {
      // Branch - use as-is
      configRef = opts.branch;
    } else {
      // Tag - auto-prepend operator/ if needed
      configRef = opts.tag.startsWith('operator/') ? opts.tag : `operator/${opts.tag}`;
    }

    const configTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-config-'));
    console.log(`⏳ Fetching crd-ref-docs-config.yaml from redpanda-operator@${configRef}…`);
    await fetchFromGithub(
      'redpanda-data',
      'redpanda-operator',
      'operator/crd-ref-docs-config.yaml',
      configTmp,
      'crd-ref-docs-config.yaml',
      configRef
    );
    const configPath = path.join(configTmp, 'crd-ref-docs-config.yaml');

    // Detect docs repo context
    const repoRoot = findRepoRoot();
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const inDocs =
      pkg.name === 'redpanda-docs-playbook' ||
      (pkg.repository && pkg.repository.url.includes('redpanda-data/docs'));
    let docsBranch = null;

    if (!inDocs) {
      console.warn('⚠️ Not inside redpanda-data/docs; skipping branch suggestion.');
    } else {
      try {
        docsBranch = await determineDocsBranch(configRef);
        console.log(`✅ Detected docs repo; you should commit to branch '${docsBranch}'.`);
      } catch (err) {
        console.error(`❌ Unable to determine docs branch: ${err.message}`);
        process.exit(1);
      }
    }

    // Validate templates
    if (!fs.existsSync(opts.templatesDir)) {
      console.error(`❌ Templates directory not found: ${opts.templatesDir}`);
      process.exit(1);
    }

    // Prepare source (local folder or GitHub URL)
    let localSrc = opts.sourcePath;
    let tmpSrc;
    if (/^https?:\/\/github\.com\//.test(opts.sourcePath)) {
      const u = new URL(opts.sourcePath);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length < 2) {
        console.error(`❌ Invalid GitHub URL: ${opts.sourcePath}`);
        process.exit(1);
      }
      const [owner, repo, ...subpathParts] = parts;
      const repoUrl = `https://${u.host}/${owner}/${repo}`;
      const subpath = subpathParts.join('/');
      console.log(`⏳ Verifying "${configRef}" in ${repoUrl}…`);
      const ok =
        spawnSync('git', ['ls-remote', '--exit-code', repoUrl, `refs/tags/${configRef}`, `refs/heads/${configRef}`], {
          stdio: 'ignore',
        }).status === 0;
      if (!ok) {
        console.error(`❌ Tag or branch "${configRef}" not found on ${repoUrl}`);
        process.exit(1);
      }
      tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-src-'));
      console.log(`⏳ Cloning ${repoUrl}@${configRef} → ${tmpSrc}`);
      if (
        spawnSync('git', ['clone', '--depth', '1', '--branch', configRef, repoUrl, tmpSrc], {
          stdio: 'inherit',
        }).status !== 0
      ) {
        console.error(`❌ git clone failed`);
        process.exit(1);
      }
      localSrc = subpath ? path.join(tmpSrc, subpath) : tmpSrc;
      if (!fs.existsSync(localSrc)) {
        console.error(`❌ Subdirectory not found in repo: ${subpath}`);
        process.exit(1);
      }
    }

    // Ensure output directory exists
    const outputDir = path.dirname(opts.output);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Run crd-ref-docs
    const args = [
      '--source-path',
      localSrc,
      '--max-depth',
      opts.depth,
      '--templates-dir',
      opts.templatesDir,
      '--config',
      configPath,
      '--renderer',
      'asciidoctor',
      '--output-path',
      opts.output,
    ];
    console.log(`⏳ Running crd-ref-docs ${args.join(' ')}`);
    if (spawnSync('crd-ref-docs', args, { stdio: 'inherit' }).status !== 0) {
      console.error(`❌ crd-ref-docs failed`);
      process.exit(1);
    }

    let doc = fs.readFileSync(opts.output, 'utf8');
    const xrefRe = /https:\/\/docs\.redpanda\.com[^\s\]\[\)"]+(?:\[[^\]]*\])?/g;
    doc = doc.replace(xrefRe, (match) => {
      let urlPart = match;
      let bracketPart = '';
      const m = match.match(/^([^\[]+)(\[[^\]]*\])$/);
      if (m) {
        urlPart = m[1];
        bracketPart = m[2];
      }
      if (urlPart.endsWith('#')) {
        return match;
      }
      try {
        const xref = urlToXref(urlPart);
        return bracketPart ? `${xref}${bracketPart}` : `${xref}[]`;
      } catch (err) {
        console.warn(`⚠️ urlToXref failed on ${urlPart}: ${err.message}`);
        return match;
      }
    });
    fs.writeFileSync(opts.output, doc, 'utf8');

    // Cleanup
    if (tmpSrc) fs.rmSync(tmpSrc, { recursive: true, force: true });
    fs.rmSync(configTmp, { recursive: true, force: true });

    console.log(`✅ CRD docs generated at ${opts.output}`);
    if (inDocs) {
      console.log(`ℹ️ Don't forget to commit your changes on branch '${docsBranch}'.`);
    }
  });

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
 * npx doc-tools generate bundle-openapi \\
 *   --tag v25.3.1 \\
 *   --surface both
 *
 * # Bundle only Admin API
 * npx doc-tools generate bundle-openapi \\
 *   --tag v25.3.1 \\
 *   --surface admin
 *
 * # Use custom output paths
 * npx doc-tools generate bundle-openapi \\
 *   --tag v25.3.1 \\
 *   --surface both \\
 *   --out-admin api/admin-api.yaml \\
 *   --out-connect api/connect-api.yaml
 *
 * # Use major version for Admin API version field
 * npx doc-tools generate bundle-openapi \\
 *   --tag v25.3.1 \\
 *   --surface admin \\
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
  .description('Bundle Redpanda OpenAPI fragments for admin and connect APIs into complete OpenAPI 3.1 documents. Requires either --tag or --branch to be specified.')
  .option('-t, --tag <tag>', 'Git tag for released content (e.g., v24.3.2 or 24.3.2)')
  .option('-b, --branch <branch>', 'Branch name for in-progress content (e.g., dev, main)')
  .option('--repo <url>', 'Repository URL', 'https://github.com/redpanda-data/redpanda.git')
  .addOption(new Option('-s, --surface <surface>', 'Which API surface(s) to bundle').choices(['admin', 'connect', 'both']).makeOptionMandatory())
  .option('--out-admin <path>', 'Output path for admin API', 'admin/redpanda-admin-api.yaml')
  .option('--out-connect <path>', 'Output path for connect API', 'connect/redpanda-connect-api.yaml')
  .option('--admin-major <string>', 'Admin API major version', 'v2.0.0')
  .option('--use-admin-major-version', 'Use admin major version for info.version instead of git tag', false)
  .option('--quiet', 'Suppress logs', false)
  .action(async (options) => {
    // Validate that either tag or branch is provided (but not both)
    if (!options.tag && !options.branch) {
      console.error('❌ Error: Either --tag or --branch must be specified');
      process.exit(1);
    }
    if (options.tag && options.branch) {
      console.error('❌ Error: Cannot specify both --tag and --branch');
      process.exit(1);
    }

    // Determine the git ref to use
    const gitRef = options.tag || options.branch;
    // Verify dependencies
    requireCmd('git', 'Install Git: https://git-scm.com/downloads');
    requireCmd('buf', 'buf should be automatically available after npm install');
    
    // Check for OpenAPI bundler using the existing detectBundler function
    try {
      const { detectBundler } = require('../tools/bundle-openapi.js');
      detectBundler(true); // quiet mode to avoid duplicate output
    } catch (err) {
      fail(err.message);
    }

    try {
      const { bundleOpenAPI } = require('../tools/bundle-openapi.js');
      await bundleOpenAPI({
        tag: gitRef,
        repo: options.repo,
        surface: options.surface,
        outAdmin: options.outAdmin,
        outConnect: options.outConnect,
        adminMajor: options.adminMajor,
        useAdminMajorVersion: options.useAdminMajorVersion,
        quiet: options.quiet
      });
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exit(err.message.includes('Validation failed') ? 2 : 1);
    }
  });

programCli.addCommand(automation);
programCli.parse(process.argv);
