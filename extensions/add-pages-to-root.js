module.exports.register = function ({ config }) {
  this.on('beforePublish', ({ siteCatalog, contentCatalog }) => {
    const logger = this.getLogger('add-pages-to-site-root');
    if (!config || !config.files || !config.files.length) {
      logger.debug('No files configured to be added to the root directory.');
      return;
    }

    logger.debug('Files to process:', config.files);

    config.files.forEach(filePath => {
      const resource = contentCatalog.resolveResource(filePath);
      if (resource) {
        const basename = resource.src.basename; // Get the file's basename
        const contentsBuffer = resource.contents; // Access the file's contents as a Buffer
        logger.debug(`Processing file: ${basename}`);
        // Add the file to the root directory in the site catalog
        siteCatalog.addFile({
          contents: contentsBuffer,
          out: {
            path: basename, // Add the file to the root directory
          },
        });
      } else {
        logger.warn(`File not resolved: ${filePath}`);
      }
    });
  });
};
