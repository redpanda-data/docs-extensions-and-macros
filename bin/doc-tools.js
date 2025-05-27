#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
const os                    = require('os');
const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const {determineDocsBranch} = require('../cli-utils/self-managed-docs-branch.js')
const fetchFromGithub = require('../tools/fetch-from-github.js');
const { urlToXref } = require('../cli-utils/convert-doc-links.js');


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
    // marker could be a .git folder or package.json or anything you choose
    if (fs.existsSync(path.join(dir, '.git')) ||
        fs.existsSync(path.join(dir, 'package.json'))) {
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
 * @param {string} [versionFlag='--help'] - The flag to use when checking if the tool is installed.
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
  const candidates = ['python3', 'python'];
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
  fail(`Python ${minMajor}.${minMinor}+ not found or too old.
→ Install from your package manager or https://python.org`);
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
  requireCmd('git',             'Install Git: https://git-scm.com/downloads');
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
    requireCmd('pandoc',     'brew install pandoc or https://pandoc.org');
  requireCmd('git',             'install Git: https://git-scm.com/downloads');
}

/**
 * Ensures all dependencies required for generating property documentation are installed.
 *
 * Checks for the presence of `make`, Python 3.10 or newer, and at least one C++ compiler (`gcc` or `clang`). Exits the process with an error message if any dependency is missing.
 */
function verifyPropertyDependencies() {
  requireCmd('make',       'your OS package manager');
  requirePython();
  // at least one compiler:
  try { execSync('gcc --version', { stdio: 'ignore' }); }
  catch {
    try { execSync('clang --version', { stdio: 'ignore' }); }
    catch { fail('A C++ compiler (gcc or clang) is required.'); }
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

programCli
  .name('doc-tools')
  .description('Redpanda Document Automation CLI')
  .version('1.1.0');

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
      console.error(err);
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
      console.error(err);
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
    const pagesDir   = path.join(repoRoot, 'docs', 'modules', moduleName, 'pages');
    const sourceFile = path.join(projectDir, 'README.adoc');
    const destLink   = path.join(pagesDir, options.target);

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
      console.log(`✔️  Linked ${relPath} → ${destLink}`);
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
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
});

// Create an "automation" subcommand group.
const automation = new Command('generate')
  .description('Run docs automations (properties, metrics, rpk docs, and Kubernetes)');

// --------------------------------------------------------------------
// Automation subcommands
// --------------------------------------------------------------------

// Common options for both automation tasks.
const commonOptions = {
  dockerRepo: 'redpanda',
  consoleTag: 'latest',
  consoleDockerRepo: 'console'
};

function runClusterDocs(mode, tag, options) {
  const script = path.join(__dirname, '../cli-utils/generate-cluster-docs.sh');
  const args   = [ mode, tag, options.dockerRepo, options.consoleTag, options.consoleDockerRepo ];
  console.log(`Running ${script} with arguments: ${args.join(' ')}`);
  const r = spawnSync('bash', [ script, ...args ], { stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status);
}

// helper to diff two autogenerated directories
function diffDirs(kind, oldTag, newTag) {
  const oldDir  = path.join('autogenerated', oldTag, kind);
  const newDir  = path.join('autogenerated', newTag, kind);
  const diffDir = path.join('autogenerated', 'diffs', kind, `${oldTag}_to_${newTag}`);
  const patch   = path.join(diffDir, 'changes.patch');

  if (!fs.existsSync(oldDir)) {
    console.error(`❌ Cannot diff: missing ${oldDir}`);
    process.exit(1);
  }
  if (!fs.existsSync(newDir)) {
    console.error(`❌ Cannot diff: missing ${newDir}`);
    process.exit(1);
  }

  fs.mkdirSync(diffDir, { recursive: true });

  const cmd = `diff -ru "${oldDir}" "${newDir}" > "${patch}" || true`;
  const res = spawnSync(cmd, { stdio: 'inherit', shell: true });

  if (res.error) {
    console.error(`❌ diff failed: ${res.error.message}`);
    process.exit(1);
  }
  console.log(`✅ Wrote patch: ${patch}`);
}

automation
  .command('metrics-docs')
  .description('Generate JSON and AsciiDoc documentation for Redpanda metrics')
  .requiredOption('-t, --tag <tag>',
    'Redpanda version to use when starting Redpanda in Docker')
  .option('--docker-repo <repo>', 'Docker repository to use when starting Redpanda in Docker', commonOptions.dockerRepo)
  .option('--console-tag <tag>', 'Redpanda Console version to use when starting Redpanda Console in Docker', commonOptions.consoleTag)
  .option('--console-docker-repo <repo>', 'Docker repository to use when starting Redpanda Console in Docker', commonOptions.consoleDockerRepo)
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
  .command('property-docs')
  .description('Generate JSON and AsciiDoc documentation for Redpanda configuration properties')
  .option('--tag <tag>', 'Git tag or branch to extract from', 'dev')
  .option('--diff <oldTag>', 'Also diff autogenerated properties from <oldTag> → <tag>')
  .action((options) => {
    verifyPropertyDependencies();

    const newTag = options.tag;
    const oldTag = options.diff;
    const cwd    = path.resolve(__dirname, '../tools/property-extractor');
    const make   = (tag) => {
      console.log(`⏳ Building property docs for ${tag}…`);
      const r = spawnSync('make', ['build', `TAG=${tag}`], { cwd, stdio: 'inherit' });
      if (r.error  ) { console.error(r.error); process.exit(1); }
      if (r.status !== 0) process.exit(r.status);
    };

    if (oldTag) {
      const oldDir = path.join('autogenerated', oldTag, 'properties');
      if (!fs.existsSync(oldDir)) make(oldTag);
    }

    make(newTag);

    if (oldTag) {
      diffDirs('properties', oldTag, newTag);
    }

    process.exit(0);
  });

automation
  .command('rpk-docs')
  .description('Generate AsciiDoc documentation for rpk CLI commands')
  .requiredOption('-t, --tag <tag>',
    'Redpanda version to use when starting Redpanda in Docker')
  .option('--docker-repo <repo>', 'Docker repository to use when starting Redpanda in Docker', commonOptions.dockerRepo)
  .option('--console-tag <tag>', 'Redpanda Console version to use when starting Redpanda Console in Docker', commonOptions.consoleTag)
  .option('--console-docker-repo <repo>', 'Docker repository to use when starting Redpanda Console in Docker', commonOptions.consoleDockerRepo)
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
  .description(`Generate AsciiDoc documentation for one or more Helm charts (supports local dirs or GitHub URLs)`)
  .option(
    '--chart-dir <dir|url>',
    'Chart directory (contains Chart.yaml) or a root containing multiple charts, or a GitHub URL',
    'https://github.com/redpanda-data/redpanda-operator/charts'
  )
  .requiredOption('-t, --tag <tag>',
    'Branch or tag to clone when using a GitHub URL for the chart-dir')
  .option(
    '--readme <file>',
    'Relative README.md path inside each chart dir',
    'README.md'
  )
  .option(
    '--output-dir <dir>',
    'Where to write all generated AsciiDoc files',
    'modules/reference/pages'
  )
  .option(
    '--output-suffix <suffix>',
    'Suffix to append to each chart name (including extension)',
    '-helm-spec.adoc'
  )
  .action(opts => {
    verifyHelmDependencies()

    // Prepare chart-root (local or GitHub) ───────────────────────
    let root = opts.chartDir
    let tmpClone = null

    if (/^https?:\/\/github\.com\//.test(root)) {
      if (!opts.tag) {
        console.error('❌ When using a GitHub URL you must pass --tag')
        process.exit(1)
      }
      const u     = new URL(root)
      const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
      if (parts.length < 2) {
        console.error(`❌ Invalid GitHub URL: ${root}`)
        process.exit(1)
      }
      const [owner, repo, ...sub] = parts
      const repoUrl = `https://${u.host}/${owner}/${repo}.git`
      const ref     = opts.tag

      console.log(`🔎 Verifying ${repoUrl}@${ref}…`)
      const ok = spawnSync('git', [
        'ls-remote','--exit-code', repoUrl,
        `refs/heads/${ref}`, `refs/tags/${ref}`
      ], { stdio:'ignore' }).status === 0
      if (!ok) {
        console.error(`❌ ${ref} not found on ${repoUrl}`)
        process.exit(1)
      }

      tmpClone = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-'))
      console.log(`⏳ Cloning ${repoUrl}@${ref} → ${tmpClone}`)
      if (spawnSync('git', [
        'clone','--depth','1','--branch',ref,
        repoUrl, tmpClone
      ], { stdio:'inherit' }).status !== 0) {
        console.error('❌ git clone failed')
        process.exit(1)
      }
      root = sub.length ? path.join(tmpClone, sub.join('/')) : tmpClone
    }

    // Discover charts ─────────────────────────────────────────────
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      console.error(`❌ Chart root not found: ${root}`)
      process.exit(1)
    }
    // single-chart?
    let charts = []
    if (fs.existsSync(path.join(root,'Chart.yaml'))) {
      charts = [root]
    } else {
      charts = fs.readdirSync(root)
        .map(n => path.join(root,n))
        .filter(p => fs.existsSync(path.join(p,'Chart.yaml')))
    }
    if (charts.length === 0) {
      console.error(`❌ No charts found under: ${root}`)
      process.exit(1)
    }

    // Ensure output-dir exists ────────────────────────────────────
    const outDir = path.resolve(opts.outputDir)
    fs.mkdirSync(outDir, { recursive: true })

    // Process each chart ─────────────────────────────────────────
    for (const chartPath of charts) {
      const name = path.basename(chartPath)
      console.log(`\n🔨 Processing chart "${name}"…`)

      // Regenerate README.md
      console.log(`  ⏳ helm-docs in ${chartPath}`)
      let r = spawnSync('helm-docs', { cwd: chartPath, stdio: 'inherit' })
      if (r.status !== 0) process.exit(r.status)

      // Convert Markdown → AsciiDoc
      const md = path.join(chartPath, opts.readme)
      if (!fs.existsSync(md)) {
        console.error(`❌ README not found: ${md}`)
        process.exit(1)
      }
      const outFile = path.join(outDir, `k-${name}${opts.outputSuffix}`)
      console.log(`  ⏳ pandoc ${md} → ${outFile}`)
      fs.mkdirSync(path.dirname(outFile), { recursive: true })
      r = spawnSync('pandoc', [ md, '-t', 'asciidoc', '-o', outFile ], { stdio:'inherit' })
      if (r.status !== 0) process.exit(r.status)

      // Post-process tweaks
      let doc = fs.readFileSync(outFile, 'utf8')
      const xrefRe = /https:\/\/docs\.redpanda\.com[^\s\]\[\)"]+(?:\[[^\]]*\])?/g;
      doc = doc
        .replace(/(\[\d+\])\]\./g, '$1\\].')
        .replace(/^== # (.*)$/gm, '= $1')
        .replace(/^== description: (.*)$/gm, ':description: $1')
        .replace(xrefRe, match => {
          // split off any [bracketed text]
          let urlPart = match;
          let bracketPart = '';
          const m = match.match(/^([^\[]+)(\[[^\]]*\])$/);
          if (m) {
            urlPart = m[1];         // the pure URL
            bracketPart = m[2];     // the “[text]”
          }
          // if it ends in “#” we leave it alone
          if (urlPart.endsWith('#')) {
            return match;
          }
          try {
            const xref = urlToXref(urlPart);
            // re-attach the bracket text, or append empty [] for bare URLs
            return bracketPart
              ? `${xref}${bracketPart}`
              : `${xref}[]`;
          } catch (err) {
            console.warn(`⚠️ urlToXref failed on ${urlPart}: ${err.message}`);
            return match;
          }
        });
      fs.writeFileSync(outFile, doc, 'utf8')

      console.log(`✅ Wrote ${outFile}`)
    }

    // Cleanup ───────────────────────────────────────────────────
    if (tmpClone) fs.rmSync(tmpClone, { recursive: true, force: true })
  })

automation
  .command('crd-spec')
  .description('Generate Asciidoc documentation for Kubernetes CRD references')
  .requiredOption('-t, --tag <operatorTag>',
    'Operator release tag or branch, such as operator/v25.1.2')
  .option('-s, --source-path <src>',
    'CRD Go types dir or GitHub URL',
    'https://github.com/redpanda-data/redpanda-operator/operator/api/redpanda/v1alpha2')
  .option('-d, --depth <n>',
    'How many levels deep',
    '10')
  .option('--templates-dir <dir>',
    'Asciidoctor templates dir',
    '.github/crd-config/templates/asciidoctor/operator')
  .option('--output <file>',
    'Where to write the generated AsciiDoc file',
    'modules/reference/pages/k-crd.adoc')
  .action(async opts => {
    verifyCrdDependencies();

    // Fetch upstream config ──────────────────────────────────────────
    const configTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-config-'));
    console.log('🔧 Fetching crd-ref-docs-config.yaml from redpanda-operator@main…');
    await fetchFromGithub(
      'redpanda-data',
      'redpanda-operator',
      'operator/crd-ref-docs-config.yaml',
      configTmp,
      'crd-ref-docs-config.yaml'
    );
    const configPath = path.join(configTmp, 'crd-ref-docs-config.yaml');

    // Detect docs repo context ───────────────────────────────────────
    const repoRoot = findRepoRoot();
    const pkg      = JSON.parse(fs.readFileSync(path.join(repoRoot,'package.json'),'utf8'));
    const inDocs   = pkg.name === 'redpanda-docs-playbook'
                   || (pkg.repository && pkg.repository.url.includes('redpanda-data/docs'));
    let docsBranch = null;

    if (!inDocs) {
      console.warn('⚠️  Not inside redpanda-data/docs; skipping branch suggestion.');
    } else {
      try {
        docsBranch = await determineDocsBranch(opts.tag);
        console.log(`Detected docs repo; you should commit to branch '${docsBranch}'.`);
      } catch (err) {
        console.error(`❌ Unable to determine docs branch: ${err.message}`);
        process.exit(1);
      }
    }

    // Validate templates ─────────────────────────────────────────────
    if (!fs.existsSync(opts.templatesDir)) {
      console.error(`❌ Templates directory not found: ${opts.templatesDir}`);
      process.exit(1);
    }

    // Prepare source (local folder or GitHub URL) ───────────────────
    let localSrc = opts.sourcePath;
    let tmpSrc;
    if (/^https?:\/\/github\.com\//.test(opts.sourcePath)) {
      const u     = new URL(opts.sourcePath);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length < 2) {
        console.error(`❌ Invalid GitHub URL: ${opts.sourcePath}`);
        process.exit(1);
      }
      const [owner, repo, ...subpathParts] = parts;
      const repoUrl = `https://${u.host}/${owner}/${repo}`;
      const subpath = subpathParts.join('/');
      // Verify tag/branch exists
      console.log(`🔎 Verifying "${opts.tag}" in ${repoUrl}…`);
      const ok = spawnSync('git', [
        'ls-remote','--exit-code', repoUrl,
        `refs/tags/${opts.tag}`, `refs/heads/${opts.tag}`
      ], { stdio:'ignore' }).status === 0;
      if (!ok) {
        console.error(`❌ Tag or branch "${opts.tag}" not found on ${repoUrl}`);
        process.exit(1);
      }
      // Clone
      tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-src-'));
      console.log(`⏳ Cloning ${repoUrl}@${opts.tag} → ${tmpSrc}`);
      if (spawnSync('git', ['clone','--depth','1','--branch',opts.tag,repoUrl,tmpSrc],{stdio:'inherit'}).status !== 0) {
        console.error('❌ git clone failed'); process.exit(1);
      }
      // Point at subfolder if any
      localSrc = subpath ? path.join(tmpSrc, subpath) : tmpSrc;
      if (!fs.existsSync(localSrc)) {
        console.error(`❌ Subdirectory not found in repo: ${subpath}`); process.exit(1);
      }
    }

    // Ensure output directory exists ────────────────────────────────
    const outputDir = path.dirname(opts.output);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Run crd-ref-docs ───────────────────────────────────────────────
    const args = [
      '--source-path',   localSrc,
      '--max-depth',     opts.depth,
      '--templates-dir', opts.templatesDir,
      '--config',        configPath,
      '--renderer',      'asciidoctor',
      '--output-path',   opts.output
    ];
    console.log(`⏳ Running crd-ref-docs ${args.join(' ')}`);
    if (spawnSync('crd-ref-docs', args, { stdio:'inherit' }).status !== 0) {
      console.error('❌ crd-ref-docs failed'); process.exit(1);
    }

    let doc = fs.readFileSync(opts.output, 'utf8')
    // this regex matches:
    //  - a docs.redpanda.com URL
    //  - optionally followed immediately by [some text]
    // It will not include trailing ] in the URL match itself.
    const xrefRe = /https:\/\/docs\.redpanda\.com[^\s\]\[\)"]+(?:\[[^\]]*\])?/g;

    doc = doc.replace(xrefRe, match => {
      // split off any [bracketed text]
      let urlPart = match;
      let bracketPart = '';
      const m = match.match(/^([^\[]+)(\[[^\]]*\])$/);
      if (m) {
        urlPart = m[1];         // the pure URL
        bracketPart = m[2];     // the “[text]”
      }

      // if it ends in “#” we leave it alone
      if (urlPart.endsWith('#')) {
        return match;
      }

      try {
        const xref = urlToXref(urlPart);
        // re-attach the bracket text, or append empty [] for bare URLs
        return bracketPart
          ? `${xref}${bracketPart}`
          : `${xref}[]`;
      } catch (err) {
        console.warn(`⚠️ urlToXref failed on ${urlPart}: ${err.message}`);
        return match;
      }
    });
    fs.writeFileSync(opts.output, doc, 'utf8')

    // Cleanup ────────────────────────────────────────────────────────
    if (tmpSrc)    fs.rmSync(tmpSrc,    { recursive: true, force: true });
    fs.rmSync(configTmp, { recursive: true, force: true });

    console.log(`✅ CRD docs generated at ${opts.output}`);
    if (inDocs) {
      console.log(`➡️  Don't forget to commit your changes on branch '${docsBranch}'.`);
    }
  });


// Attach the automation group to the main program.
programCli.addCommand(automation);

programCli.parse(process.argv);

