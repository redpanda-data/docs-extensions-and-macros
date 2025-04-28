#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
const { Command } = require('commander');
const path = require('path');

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
    execSync(`${command} --version`, { stdio: 'ignore' });
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
    console.error('Error: Python 3.10 or higher is required but not found.\nPlease install Python and ensure `python3 --version` or `python --version` returns at least 3.10.');
    process.exit(1);
  }
}

function checkCompiler() {
  const gccInstalled = checkCommandExists('gcc');
  const clangInstalled = checkCommandExists('clang');
  if (!gccInstalled && !clangInstalled) {
    console.error('Error: A C++ compiler (such as gcc or clang) is required but not found. Please install one.');
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
  checkCommandExists('curl');
  checkCommandExists('tar');
  checkDocker();
}

// --------------------------------------------------------------------
// Main CLI Definition
// --------------------------------------------------------------------
const programCli = new Command();

programCli
  .name('doc-tools')
  .description('Redpanda Document Automation CLI')
  .version('1.0.0');

// Top-level commands.
programCli
  .command('install-test-dependencies')
  .description('Install packages for doc test workflows')
  .action(() => {
    const scriptPath = path.join(__dirname, '../utils/install-test-dependencies.sh');
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

// Subcommand: generate-metrics-docs.
automation
  .command('metrics-docs')
  .description('Extract Redpanda metrics and generate JSON/AsciiDoc docs')
  .option('--tag <tag>', 'Redpanda tag (default: latest)', commonOptions.tag)
  .option('--docker-repo <repo>', 'Redpanda Docker repository (default: redpanda or redpanda-unstable when --tag is an RC version)', commonOptions.dockerRepo)
  .option('--console-tag <tag>', 'Redpanda Console tag (default: latest)', commonOptions.consoleTag)
  .option('--console-docker-repo <repo>', 'Redpanda Console Docker repository (default: console)', commonOptions.consoleDockerRepo)
  .action((options) => {
    // Verify dependencies common to these automations.
    verifyMetricsDependencies();
    // Build argument array for the Bash automation script.
    const args = [
      'metrics',
      options.tag,
      options.dockerRepo,
      options.consoleTag,
      options.consoleDockerRepo
    ];
    const scriptPath = path.join(__dirname, '../utils/generate-cluster-docs.sh');
    console.log(`Running ${scriptPath} with arguments: ${args.join(' ')}`);
    const result = spawnSync('bash', [scriptPath, ...args], { stdio: 'inherit', shell: true });
    process.exit(result.status);
  });

// Subcommand: generate-property-docs.
automation
  .command('property-docs')
  .description('Extract properties from Redpanda source')
  .option('--tag <tag>', 'Git tag or branch of Redpanda to extract from (default: dev)', 'dev')
  .action((options) => {
    verifyPropertyDependencies();
    const cwd = path.resolve(__dirname, '../tools/property-extractor');
    const tag = options.tag || 'dev';
    const result = spawnSync('make', ['build', `TAG=${tag}`], {
      cwd,
      stdio: 'inherit'
    });
    if (result.error) {
      console.error('Failed to run `make build`:', result.error.message);
      process.exit(1);
    }
    process.exit(result.status);
    });

// Subcommand: generate-rpk-docs.
automation
  .command('rpk-docs')
  .description('Generate documentation for rpk commands')
  .option('--tag <tag>', 'Redpanda tag (default: latest)', commonOptions.tag)
  .option('--docker-repo <repo>', 'Redpanda Docker repository (default: redpanda or redpanda-unstable when --tag is an RC version)', commonOptions.dockerRepo)
  .option('--console-tag <tag>', 'Redpanda Console tag (default: latest)', commonOptions.consoleTag)
  .option('--console-docker-repo <repo>', 'Redpanda Console Docker repository (default: console)', commonOptions.consoleDockerRepo)
  .action((options) => {
    verifyMetricsDependencies();
    const args = [
      'rpk',
      options.tag,
      options.dockerRepo,
      options.consoleTag,
      options.consoleDockerRepo
    ];
    const scriptPath = path.join(__dirname, '../utils/generate-cluster-docs.sh');
    console.log(`Running ${scriptPath} with arguments: ${args.join(' ')}`);
    const result = spawnSync('bash', [scriptPath, ...args], { stdio: 'inherit', shell: true });
    process.exit(result.status);
  });

// Attach the automation group to the main program.
programCli.addCommand(automation);

programCli.parse(process.argv);

