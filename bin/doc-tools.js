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
programCli
  .command('install-test-dependencies')
  .description('Install packages for doc test workflows')
  .action(() => {
    const scriptPath = path.join(__dirname, '../cli-utils/install-test-dependencies.sh');
    const result = spawnSync(scriptPath, { stdio: 'inherit', shell: true });
    process.exit(result.status);
  });

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
    
  // Look for the property JSON files in outputDir/examples
  const repoRoot = findRepoRoot();
  const examplesDir = path.join(repoRoot, outputDir, 'examples');
  const oldJsonPath = path.join(examplesDir, `${oldTag}-properties.json`);
  const newJsonPath = path.join(examplesDir, `${newTag}-properties.json`);
    
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
    const reportFilename = `property-changes-${oldTag}-to-${newTag}.json`;
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

automation
  .command('metrics-docs')
  .description('Generate JSON and AsciiDoc documentation for Redpanda metrics')
  .requiredOption('-t, --tag <tag>', 'Redpanda version to use when starting Redpanda in Docker')
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

    const newTag = options.tag;
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
  .option('--overrides <path>', 'Optional JSON file with overrides')
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
        let section = `\n== Version ${diff.comparison.newVersion}\n\n=== Component updates\n\n`;
        // Add link to full release notes for this connector version after version heading and before component updates
        let releaseNotesLink = '';
        if (diff.comparison && diff.comparison.newVersion) {
          releaseNotesLink = `link:https://github.com/redpanda-data/connect/releases/tag/v${diff.comparison.newVersion}[See the full release notes^].\n\n`;
        }
        section = `\n== Version ${diff.comparison.newVersion}\n\n${releaseNotesLink}=== Component updates\n\n`;
        // New components
        if (diff.details.newComponents && diff.details.newComponents.length) {
          section += 'This release adds the following new components:\n\n';
          // Group by type
          const byType = {};
          for (const comp of diff.details.newComponents) {
            if (!byType[comp.type]) byType[comp.type] = [];
            byType[comp.type].push(comp);
          }
          for (const [type, comps] of Object.entries(byType)) {
            section += `* ${type.charAt(0).toUpperCase() + type.slice(1)}:\n`;
            for (const comp of comps) {
              section += `** xref:components:${type}/${comp.name}.adoc[\`${comp.name}\`]`;
              if (comp.status) section += ` (${comp.status})`;
              if (comp.description) section += `: ${comp.description}`;
              section += '\n';
            }
          }
        }

        // New fields
        if (diff.details.newFields && diff.details.newFields.length) {
          section += '\nThis release adds support for the following new fields:\n\n';
          // Group new fields by component type
          const fieldsByType = {};
          for (const field of diff.details.newFields) {
            // component: "inputs:kafka", field: "timely_nacks_maximum_wait"
            const [type, compName] = field.component.split(':');
            if (!fieldsByType[type]) fieldsByType[type] = [];
            fieldsByType[type].push({
              compName,
              field: field.field,
              description: field.description || '',
            });
          }
          for (const [type, fields] of Object.entries(fieldsByType)) {
            section += `* ${type.charAt(0).toUpperCase() + type.slice(1)} components\n`;
            // Group by component name
            const byComp = {};
            for (const f of fields) {
              if (!byComp[f.compName]) byComp[f.compName] = [];
              byComp[f.compName].push(f);
            }
            for (const [comp, compFields] of Object.entries(byComp)) {
              section += `** xref:components:${type}/${comp}.adoc['${comp}']`;
              if (compFields.length === 1) {
                const f = compFields[0];
                section += `: xref:components:${type}/${comp}.adoc#${f.field}['${f.field}']`;
                if (f.description) section += ` - ${f.description}`;
                section += '\n';
              } else {
                section += '\n';
                for (const f of compFields) {
                  section += `*** xref:components:${type}/${comp}.adoc#${f.field}['${f.field}']`;
                  if (f.description) section += ` - ${f.description}`;
                  section += '\n';
                }
              }
            }
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

automation
  .command('property-docs')
  .description(
    'Generate JSON and consolidated AsciiDoc partials for Redpanda configuration properties. ' +
    'By default, only extracts properties to JSON. Use --generate-partials to create consolidated ' +
    'AsciiDoc partials (including deprecated properties).'
  )
  .option('--tag <tag>', 'Git tag or branch to extract from', 'dev')
  .option('--diff <oldTag>', 'Also diff autogenerated properties from <oldTag> to <tag>')
  .option('--overrides <path>', 'Optional JSON file with property description overrides')
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

    const newTag = options.tag;
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
      env.OUTPUT_JSON_DIR = path.resolve(outDir, 'examples');
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
      generatePropertyComparisonReport(oldTag, newTag, outputDir);
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

automation
  .command('rpk-docs')
  .description('Generate AsciiDoc documentation for rpk CLI commands')
  .requiredOption('-t, --tag <tag>', 'Redpanda version to use when starting Redpanda in Docker')
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

    const newTag = options.tag;
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

automation
  .command('helm-spec')
  .description(
    `Generate AsciiDoc documentation for one or more Helm charts (supports local dirs or GitHub URLs)`
  )
  .option(
    '--chart-dir <dir|url>',
    'Chart directory (contains Chart.yaml) or a root containing multiple charts, or a GitHub URL',
    'https://github.com/redpanda-data/redpanda-operator/charts'
  )
  .requiredOption('-t, --tag <tag>', 'Branch or tag to clone when using a GitHub URL for the chart-dir')
  .option('--readme <file>', 'Relative README.md path inside each chart dir', 'README.md')
  .option('--output-dir <dir>', 'Where to write all generated AsciiDoc files', 'modules/reference/pages')
  .option('--output-suffix <suffix>', 'Suffix to append to each chart name (including extension)', '-helm-spec.adoc')
  .action((opts) => {
    verifyHelmDependencies();

    // Prepare chart-root (local or GitHub)
    let root = opts.chartDir;
    let tmpClone = null;

    if (/^https?:\/\/github\.com\//.test(root)) {
      if (!opts.tag) {
        console.error('❌ When using a GitHub URL you must pass --tag');
        process.exit(1);
      }
      const u = new URL(root);
      const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
      if (parts.length < 2) {
        console.error(`❌ Invalid GitHub URL: ${root}`);
        process.exit(1);
      }
      const [owner, repo, ...sub] = parts;
      const repoUrl = `https://${u.host}/${owner}/${repo}.git`;
      const ref = opts.tag;

      console.log(`⏳ Verifying ${repoUrl}@${ref}…`);
      const ok =
        spawnSync(
          'git',
          ['ls-remote', '--exit-code', repoUrl, `refs/heads/${ref}`, `refs/tags/${ref}`],
          { stdio: 'ignore' }
        ).status === 0;
      if (!ok) {
        console.error(`❌ ${ref} not found on ${repoUrl}`);
        process.exit(1);
      }

      tmpClone = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-'));
      console.log(`⏳ Cloning ${repoUrl}@${ref} → ${tmpClone}`);
      if (
        spawnSync('git', ['clone', '--depth', '1', '--branch', ref, repoUrl, tmpClone], {
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

automation
  .command('crd-spec')
  .description('Generate Asciidoc documentation for Kubernetes CRD references')
  .requiredOption('-t, --tag <operatorTag>', 'Operator release tag or branch, such as operator/v25.1.2')
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

    // Fetch upstream config
    const configTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-config-'));
    console.log(`⏳ Fetching crd-ref-docs-config.yaml from redpanda-operator@main…`);
    await fetchFromGithub(
      'redpanda-data',
      'redpanda-operator',
      'operator/crd-ref-docs-config.yaml',
      configTmp,
      'crd-ref-docs-config.yaml'
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
        docsBranch = await determineDocsBranch(opts.tag);
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
      console.log(`⏳ Verifying "${opts.tag}" in ${repoUrl}…`);
      const ok =
        spawnSync('git', ['ls-remote', '--exit-code', repoUrl, `refs/tags/${opts.tag}`, `refs/heads/${opts.tag}`], {
          stdio: 'ignore',
        }).status === 0;
      if (!ok) {
        console.error(`❌ Tag or branch "${opts.tag}" not found on ${repoUrl}`);
        process.exit(1);
      }
      tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-src-'));
      console.log(`⏳ Cloning ${repoUrl}@${opts.tag} → ${tmpSrc}`);
      if (
        spawnSync('git', ['clone', '--depth', '1', '--branch', opts.tag, repoUrl, tmpSrc], {
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

automation
  .command('bundle-openapi')
  .description('Bundle Redpanda OpenAPI fragments for admin and connect APIs into complete OpenAPI 3.1 documents')
  .requiredOption('-t, --tag <tag>', 'Branch or tag to clone from the repository (for example v24.3.2 or 24.3.2 or dev)')
  .option('--repo <url>', 'Repository URL', 'https://github.com/redpanda-data/redpanda.git')
  .addOption(new Option('-s, --surface <surface>', 'Which API surface(s) to bundle').choices(['admin', 'connect', 'both']).makeOptionMandatory())
  .option('--out-admin <path>', 'Output path for admin API', 'admin/redpanda-admin-api.yaml')
  .option('--out-connect <path>', 'Output path for connect API', 'connect/redpanda-connect-api.yaml')
  .option('--admin-major <string>', 'Admin API major version', 'v2.0.0')
  .option('--use-admin-major-version', 'Use admin major version for info.version instead of git tag', false)
  .option('--quiet', 'Suppress logs', false)
  .action(async (options) => {
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
        tag: options.tag,
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
