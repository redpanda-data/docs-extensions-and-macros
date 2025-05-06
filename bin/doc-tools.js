#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

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
// --------------------------------------------------------------------
function checkDependency(command, versionArg, name, helpURL) {
  try {
    execSync(`${command} ${versionArg}`, { stdio: 'ignore' });
  } catch (error) {
    console.error(`Error: ${name} is required but not found or not working properly.
Please install ${name} and try again.
For more info, see: ${helpURL}`);
    process.exit(1);
  }
}

function checkCommandExists(command) {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch (error) {
    console.error(`Error: \`${command}\` is required but not found. Please install \`${command}\` and try again.`);
    return false;
  }
}

function checkMake() {
  if (!checkCommandExists('make')) {
    console.error('Error: `make` is required but not found. Please install `make` to use the automation Makefile. For help, see: https://www.google.com/search?q=how+to+install+make');
    process.exit(1);
  }
}

function checkPython() {
  const candidates = ['python3', 'python'];
  let found = false;

  for (const cmd of candidates) {
    try {
      const versionOutput = execSync(`${cmd} --version`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      // versionOutput looks like "Python 3.x.y"
      const versionString = versionOutput.split(' ')[1];
      const [major, minor] = versionString.split('.').map(Number);
      if (major > 3 || (major === 3 && minor >= 10)) {
        found = true;
        break;
      } else {
        console.error(`Error: Python 3.10 or higher is required. Detected version: ${versionString}`);
        process.exit(1);
      }
    } catch {
      // this candidate didn’t exist or errored—try the next one
    }
  }
  if (!found) {
    console.error('Error: Python 3.10 or higher is required but not found.\nPlease install Python and ensure `python3 --version` or `python --version` returns at least 3.10: https://www.geeksforgeeks.org/how-to-install-python-on-mac/');
    process.exit(1);
  }
}

function checkCompiler() {
  const gccInstalled = checkCommandExists('gcc');
  const clangInstalled = checkCommandExists('clang');
  if (!gccInstalled && !clangInstalled) {
    console.error('Error: A C++ compiler (such as gcc or clang) is required but not found. Please install one: https://osxdaily.com/2023/05/02/how-install-gcc-mac/');
    process.exit(1);
  }
}

function checkDocker() {
  checkDependency('docker', '--version', 'Docker', 'https://docs.docker.com/get-docker/');
  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch (error) {
    console.error('Error: Docker daemon appears to be not running. Please start Docker.');
    process.exit(1);
  }
}

function verifyPropertyDependencies() {
  checkMake();
  checkPython();
  checkCompiler();
}

function verifyMetricsDependencies() {
  checkPython();
  if (!checkCommandExists('curl') || !checkCommandExists('tar')) {
    // `checkCommandExists` already prints a helpful message.
    process.exit(1);
  }
  checkDocker();
}
// --------------------------------------------------------------------
// Main CLI Definition
// --------------------------------------------------------------------
const programCli = new Command();

programCli
  .name('doc-tools')
  .description('Redpanda Document Automation CLI')
  .version('1.0.1');

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

// Create an "automation" subcommand group.
const automation = new Command('generate')
  .description('Run docs automations (properties, metrics, and rpk docs generation)');

// --------------------------------------------------------------------
// Automation Subcommands: Delegate to a unified Bash script internally.
// --------------------------------------------------------------------

// Common options for both automation tasks.
const commonOptions = {
  tag: 'latest',
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
  .description('Extract Redpanda metrics and generate JSON/AsciiDoc docs')
  .option('--tag <tag>', 'Redpanda tag (default: latest)', commonOptions.tag)
  .option('--docker-repo <repo>', '...', commonOptions.dockerRepo)
  .option('--console-tag <tag>', '...', commonOptions.consoleTag)
  .option('--console-docker-repo <repo>', '...', commonOptions.consoleDockerRepo)
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
  .description('Extract properties from Redpanda source')
  .option('--tag <tag>', 'Git tag or branch to extract from (default: dev)', 'dev')
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
  .description('Generate documentation for rpk commands')
  .option('--tag <tag>', 'Redpanda tag (default: latest)', commonOptions.tag)
  .option('--docker-repo <repo>', '...', commonOptions.dockerRepo)
  .option('--console-tag <tag>', '...', commonOptions.consoleTag)
  .option('--console-docker-repo <repo>', '...', commonOptions.consoleDockerRepo)
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

programCli
  .command('link-readme <subdir> <targetFilename>')
  .description('Symlink a README.adoc into docs/modules/<module>/pages/')
  .action((subdir, targetFilename) => {
    const repoRoot = findRepoRoot();
    const normalized = subdir.replace(/\/+$/, '');
    const moduleName = normalized.split('/')[0];

    const projectDir = path.join(repoRoot, normalized);
    const pagesDir   = path.join(repoRoot, 'docs', 'modules', moduleName, 'pages');
    const sourceFile = path.join(repoRoot, normalized, 'README.adoc');
    const destLink   = path.join(pagesDir, targetFilename);

    if (!fs.existsSync(projectDir)) {
      console.error(`❌ Project directory not found: ${projectDir}`);
      process.exit(1);
    }
    if (!fs.existsSync(sourceFile)) {
      console.error(`❌ README.adoc not found in ${normalized}`);
      process.exit(1);
    }

    fs.mkdirSync(pagesDir, { recursive: true });
    const relPath = path.relative(pagesDir, sourceFile);

    try {
      fs.symlinkSync(relPath, destLink);
      console.log(`✔️  Linked ${relPath} → ${destLink}`);
    } catch (err) {
      console.error(`❌ Failed to create symlink: ${err.message}`);
      process.exit(1);
    }
  });

programCli
.command('fetch')
.description('Fetch a file or directory from GitHub and save locally')
.requiredOption('-o, --owner <owner>', 'GitHub repo owner or org')
.requiredOption('-r, --repo <repo>', 'GitHub repo name')
.requiredOption('-p, --remote-path <path>', 'Path in the repo to fetch')
.requiredOption('-d, --save-dir <dir>', 'Local directory to save into')
.option('-f, --filename <name>', 'Custom filename to save as')
.action(async (options) => {
  try {
    const fetchFromGithub = await require('../tools/fetch-from-github.js');
    // options.owner, options.repo, options.remotePath, options.saveDir, options.filename
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


// Attach the automation group to the main program.
programCli.addCommand(automation);

programCli.parse(process.argv);

