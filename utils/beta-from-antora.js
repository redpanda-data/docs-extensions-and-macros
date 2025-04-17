const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Look for antora.yml in the current working directory
 * (the project's root), load it if present, and return
 * its `prerelease` value (boolean). If missing or on error,
 * returns false.
 */
function getPrereleaseFromAntora() {
  const antoraPath = path.join(process.cwd(), 'antora.yml');
  if (!fs.existsSync(antoraPath)) {
    return false;
  }

  try {
    const fileContents = fs.readFileSync(antoraPath, 'utf8');
    const antoraConfig = yaml.load(fileContents);
    return antoraConfig.prerelease === true;
  } catch (error) {
    console.error('Error reading antora.yml:', error.message);
    return false;
  }
}

module.exports = { getPrereleaseFromAntora };
