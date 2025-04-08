const { spawnSync } = require('child_process');
const path = require('path');

module.exports = function runExtractor(options) {
  const cwd = path.resolve(__dirname, '../../tools/property-extractor');
  const tag = options.tag || 'dev';

  const result = spawnSync('make', ['build', `TAG=${tag}`], {
    cwd,
    stdio: 'inherit'
  });

  process.exit(result.status);
};
