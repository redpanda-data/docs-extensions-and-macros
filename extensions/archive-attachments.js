'use strict';

const fs = require('fs');
const path = require('path');
const tar = require('tar');
const micromatch = require('micromatch');
const { PassThrough } = require('stream');

/**
 * Utility function to create a tar.gz archive in memory.
 * @param {string} tempDir - The temporary directory containing files to archive.
 * @returns {Promise<Buffer>} - A promise that resolves to the tar.gz buffer.
 */
function createTarInMemory(tempDir) {
  return new Promise((resolve, reject) => {
    const pass = new PassThrough();
    const chunks = [];

    pass.on('data', (chunk) => chunks.push(chunk));
    pass.on('error', (error) => reject(error));
    pass.on('end', () => resolve(Buffer.concat(chunks)));

    tar
      .create(
        {
          gzip: true,
          cwd: tempDir,
        },
        ['.']
      )
      .pipe(pass)
      .on('error', (err) => reject(err));
  });
}

module.exports.register = function ({ config }) {
  const logger = this.getLogger('archive-attachments-extension');
  const outputArchive = config.data?.output_archive;
  const filePatterns = config.data?.file_patterns || [];

  // Validate configuration
  if (!outputArchive) {
    logger.info('No `output_archive` provided. Archive creation skipped.');
    return;
  }
  if (!filePatterns.length) {
    logger.info('No `file_patterns` provided. Archive creation skipped.');
    return;
  }

  this.on('beforePublish', async ({ contentCatalog, siteCatalog }) => {
    logger.info('Starting archive creation process');

    const components = contentCatalog.getComponents();

    for (const comp of components) {
      for (const compVer of comp.versions) {
        const compName = comp.name;
        const compVersion = compVer.version;
        const latest = comp.latest?.version || 0;

        const isLatest = latest === compVersion ? true : false

        logger.debug(`Processing component: ${compName}, version: ${compVersion}`);

        // Gather attachments for this component version
        const attachments = contentCatalog.findBy({
          component: compName,
          version: compVersion,
          family: 'attachment',
        });

        logger.debug(`Found ${attachments.length} attachments for ${compName}@${compVersion}`);

        if (!attachments.length) {
          logger.debug(`No attachments found for ${compName}@${compVersion}, skipping.`);
          continue;
        }

        // Filter attachments based on filePatterns
        const matched = attachments.filter((attachment) =>
          micromatch.isMatch(attachment.out.path, filePatterns)
        );

        logger.debug(`Matched ${matched.length} attachments for ${compName}@${compVersion}`);

        if (!matched.length) {
          logger.debug(`No attachments matched patterns for ${compName}@${compVersion}, skipping.`);
          continue;
        }

        // Create a temporary directory and write matched attachments
        const tempDir = path.join('/tmp', `${compName}-${compVersion}-${Date.now()}`);
        try {
          fs.mkdirSync(tempDir, { recursive: true });
          logger.debug(`Created temporary directory: ${tempDir}`);

          for (const attachment of matched) {
            const relPath = attachment.out.path;
            // Include only the part of the path after '_attachments/'
            const attachmentsSegment = '_attachments/';
            const attachmentsIndex = relPath.indexOf(attachmentsSegment);

            if (attachmentsIndex === -1) {
              logger.warn(`'_attachments/' segment not found in path: ${relPath}. Skipping this file.`);
              continue;
            }

            // Extract the path starting after '_attachments/'
            const relativePath = relPath.substring(attachmentsIndex + attachmentsSegment.length);

            const destPath = path.join(tempDir, relativePath);
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.writeFileSync(destPath, attachment.contents);
            logger.debug(`Written file to tempDir: ${destPath}`);
          }

          // Asynchronously create the tar.gz archive in memory
          logger.debug(`Starting tar creation for ${compName}@${compVersion}`);
          const archiveBuffer = await createTarInMemory(tempDir);
          logger.debug(`Tar creation completed for ${compName}@${compVersion}`);

          // Define the output path for the archive in the site
          const archiveOutPath = `${compVer.title}${compVersion?'-' + compVersion:''}-${outputArchive}`.toLowerCase()

          // Add the archive to siteCatalog
          siteCatalog.addFile({
            contents: archiveBuffer,
            out: { path: archiveOutPath },
          });

          if (isLatest) {
            siteCatalog.addFile({
              contents: archiveBuffer,
              out: { path: path.basename(outputArchive) },
            });
          }

          logger.info(`Archive added to site at: ${archiveOutPath}`);

        } catch (error) {
          logger.error(`Error processing ${compName}@${compVersion}:`, error);
        } finally {
          // Clean up the temporary directory
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
            logger.debug(`Cleaned up temporary directory: ${tempDir}`);
          } catch (cleanupError) {
            logger.error(`Error cleaning up tempDir ${tempDir}:`, cleanupError);
          }
        }
      }
    }
    logger.info('Archive creation process completed');
  });
};
