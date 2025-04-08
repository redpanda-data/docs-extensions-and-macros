#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const [command, ...restArgs] = process.argv.slice(2);

function runScript(script, isNode = false) {
  const finalArgs = isNode ? ['node', script, ...commandArgs] : [script, ...commandArgs];
  const result = spawnSync(finalArgs[0], finalArgs.slice(1), { stdio: 'inherit', shell: true });
  process.exit(result.status);
}

switch (command) {
  case 'install-test-dependencies':
    runScript(path.join(__dirname, '../scripts/install-test-dependencies.sh'));
    break;
  case 'get-redpanda-version':
    runScript(path.join(__dirname, '../scripts/get-redpanda-version.js'), true);
    break;
  case 'get-console-version':
    runScript(path.join(__dirname, '../scripts/get-console-version.js'), true);
    break;
  case 'props':
    require('../lib/props')(restArgs);
    break;
  default:
    console.log(`Unknown command: ${command}`);
    console.log(`Usage: doc-tools <command>

Commands:
  install-test-dependencies   Install packages for doc test workflows
  get-redpanda-version        Print the latest Redpanda version
  get-console-version         Print the latest Console version`);
    process.exit(1);
}
