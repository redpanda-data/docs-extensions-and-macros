'use strict';

const fs = require('fs');
const path = require('path');

function redirectModifier(files, outputDir, logger) {
  files.forEach((file) => {
    const filePath = path.join(outputDir, file);
    if (!fs.existsSync(filePath)) return
    let content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    // Filter out redirects that point to themselves
    const modifiedLines = lines.filter((line) => {
      const parts = line.split(' ');
      if (parts[0] == parts[1]) logger.info(`Removed redirect that points to itself: ${line}`)
      return parts[0] !== parts[1]; // Ensure the source and target are not the same
    });

    // Join the array back into a string and write it back to the file
    const modifiedContent = modifiedLines.join('\n');
    fs.writeFileSync(filePath, modifiedContent, 'utf8');
    logger.info(`Processed and updated redirects in ${filePath}`);
  })
}

module.exports.register = function ({ config }) {
  const logger = this.getLogger('redirects-produced');
  this.on('sitePublished', async ({ publications }) => {
    publications.forEach(publication => {
      const outputDir = publication.resolvedPath;
      const redirectFile = ['_redirects'];
      redirectModifier(redirectFile, outputDir, logger);
    });
  });
};
