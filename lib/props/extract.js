const { spawnSync } = require('child_process');
const path = require('path');

module.exports = function runExtractor(options) {
  if (options.help) {
    console.log(`
Usage: doc-tools props extract [--tag <version>]

Options:
  --tag <version>   Specify a Redpanda version or tag to extract from (default: dev)
  --help            Show this help message
`);
    process.exit(0);
  }

  const cwd = path.resolve(__dirname, '../../tools/property-extractor');
  const tag = options.tag || 'dev';

  const result = spawnSync('make', ['build', `TAG=${tag}`], {
    cwd,
    stdio: 'inherit'
  });

  process.exit(result.status);
};
