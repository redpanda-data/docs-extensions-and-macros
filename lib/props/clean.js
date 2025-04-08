const { spawnSync } = require('child_process');
const path = require('path');

module.exports = function runClean() {
  const cwd = path.resolve(__dirname, '../../tools/property-extractor');

  const result = spawnSync('make', ['clean'], {
    cwd,
    stdio: 'inherit'
  });

  if (result.error) {
    console.error('Failed to run `make clean`:', result.error.message);
    process.exit(1);
  }

  process.exit(result.status);
};
