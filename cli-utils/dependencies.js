'use strict'

const { execSync } = require('child_process')
const { fail } = require('./doc-tools-utils')

/**
 * Ensures that a specified command-line tool is installed and operational.
 *
 * Attempts to execute the tool with a version flag to verify its presence. If the tool
 * is missing or fails to run, the process exits with an error message and optional
 * installation hint.
 *
 * @param {string} cmd - The name of the tool to check (for example, 'docker', 'helm-docs').
 * @param {object} [opts] - Optional settings.
 * @param {string} [opts.versionFlag='--version'] - The flag used to test the tool's execution.
 * @param {string} [opts.help] - An optional hint or installation instruction shown on failure.
 */
function requireTool (cmd, { versionFlag = '--version', help = '' } = {}) {
  try {
    execSync(`${cmd} ${versionFlag}`, { stdio: 'ignore' })
  } catch {
    const hint = help ? `\n→ ${help}` : ''
    fail(`'${cmd}' is required but not found.${hint}`)
  }
}

/**
 * Ensures that a command-line tool is installed by checking if it responds to a specified flag.
 *
 * @param {string} cmd - The name of the command-line tool to check.
 * @param {string} [help] - Optional help text to display if the tool is not found.
 * @param {string} [versionFlag='--version'] - The flag to use when checking if the tool is installed.
 */
function requireCmd (cmd, help, versionFlag = '--version') {
  requireTool(cmd, { versionFlag, help })
}

/**
 * Ensures that Python with a minimum required version is installed and available in the system PATH.
 *
 * Checks for either `python3` or `python` executables and verifies that the version is at least
 * the specified minimum (default: 3.10). Exits the process with an error message if the
 * requirement is not met.
 *
 * @param {number} [minMajor=3] - Minimum required major version of Python.
 * @param {number} [minMinor=10] - Minimum required minor version of Python.
 */
function requirePython (minMajor = 3, minMinor = 10) {
  const candidates = ['python3', 'python', 'python3.12', 'python3.11', 'python3.10']
  for (const p of candidates) {
    try {
      const out = execSync(`${p} --version`, { encoding: 'utf8' }).trim()
      const [maj, min] = out.split(' ')[1].split('.').map(Number)
      if (maj > minMajor || (maj === minMajor && min >= minMinor)) {
        return
      }
    } catch {
      /* ignore & try next */
    }
  }
  fail(
    `Python ${minMajor}.${minMinor}+ not found or too old.

**Quick Install (Recommended):**
Run the automated installer to set up all dependencies:
  npm run install-test-dependencies

Or install manually from your package manager or https://python.org`
  )
}

/**
 * Ensures that the Docker CLI is installed and the Docker daemon is running.
 */
function requireDockerDaemon () {
  requireTool('docker', { help: 'https://docs.docker.com/get-docker/' })
  try {
    execSync('docker info', { stdio: 'ignore' })
  } catch {
    fail(`Docker daemon does not appear to be running.

**Quick Install (Recommended):**
Run the automated installer to set up all dependencies:
  npm run install-test-dependencies

Or install and start Docker manually: https://docs.docker.com/get-docker/`)
  }
}

/**
 * Ensures that required dependencies for generating CRD documentation are installed.
 */
function verifyCrdDependencies () {
  requireCmd('git', 'Install Git: https://git-scm.com/downloads')
  requireCmd(
    'crd-ref-docs',
    `
The 'crd-ref-docs' command is required but was not found.

**Quick Install (Recommended):**
Run the automated installer to set up all dependencies:
  npm run install-test-dependencies

Or install manually (for macOS):

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
  )
  requireCmd(
    'go',
    `
The 'go' command (Golang) is required but was not found.

**Quick Install (Recommended):**
Run the automated installer to set up all dependencies:
  npm run install-test-dependencies

Or install manually on macOS:

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
  )
}

/**
 * Ensures that all required tools for Helm documentation generation are installed.
 */
function verifyHelmDependencies () {
  requireCmd(
    'helm-docs',
    `
The 'helm-docs' command is required but was not found.

**Quick Install (Recommended):**
Run the automated installer to set up all dependencies:
  npm run install-test-dependencies

Or install manually (for macOS):

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
  )
  requireCmd('pandoc', 'brew install pandoc or https://pandoc.org')
  requireCmd('git', 'Install Git: https://git-scm.com/downloads')
}

/**
 * Ensures all dependencies required for generating property documentation are installed.
 */
function verifyPropertyDependencies () {
  requireCmd('make', 'Your OS package manager')
  requirePython()

  // Check for Node.js (required for Handlebars templates)
  requireCmd('node', 'https://nodejs.org/en/download/ or use your package manager (for example, brew install node)')
  requireCmd('npm', 'Usually installed with Node.js')

  // Check for C++ compiler
  let cppCompiler = null
  try {
    execSync('gcc --version', { stdio: 'ignore' })
    cppCompiler = 'gcc'
  } catch {
    try {
      execSync('clang --version', { stdio: 'ignore' })
      cppCompiler = 'clang'
    } catch {
      fail(`A C++ compiler (gcc or clang) is required for tree-sitter compilation.

**Quick Install (Recommended):**
Run the automated installer to set up all dependencies:
  npm run install-test-dependencies

Or install manually:

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
  clang --version`)
    }
  }

  // Check for C++ standard library headers (critical for tree-sitter compilation)
  const fs = require('fs')
  const path = require('path')
  const os = require('os')

  let tempDir = null
  let compileCmd = cppCompiler === 'gcc' ? 'gcc' : 'clang++'
  try {
    const testProgram = '#include <functional>\nint main() { return 0; }'
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-test-'))
    const tempFile = path.join(tempDir, 'test.cpp')
    fs.writeFileSync(tempFile, testProgram)

    execSync(`${compileCmd} -x c++ -fsyntax-only "${tempFile}"`, { stdio: 'ignore' })
    fs.rmSync(tempDir, { recursive: true, force: true })
  } catch {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    }
    fail(`C++ standard library headers are missing or incomplete.

**Quick Install (Recommended):**
Run the automated installer to set up all dependencies:
  npm run install-test-dependencies

Or fix manually:

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
`)
  }
}

/**
 * Ensures all required dependencies for generating Redpanda metrics documentation are installed.
 */
function verifyMetricsDependencies () {
  requirePython()
  requireCmd('curl')
  requireCmd('tar')
  requireDockerDaemon()
}

module.exports = {
  requireTool,
  requireCmd,
  requirePython,
  requireDockerDaemon,
  verifyCrdDependencies,
  verifyHelmDependencies,
  verifyPropertyDependencies,
  verifyMetricsDependencies
}
