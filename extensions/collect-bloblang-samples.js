const yaml = require('js-yaml');

module.exports.register = function () {
  const logger = this.getLogger('collect-bloblang-samples-extension');

  this.on('documentsConverted', ({ contentCatalog }) => {
    const examples = contentCatalog.findBy({ component: 'redpanda-connect', family: 'example' });

    if (!examples.length) {
      logger.warn(`No examples found in the 'redpanda-connect' component.`);
      return;
    }

    const connect = contentCatalog.getComponents().find(component => component.name === 'redpanda-connect');

    const bloblangSamples = [];
    const seenTitles = new Set();

    examples.forEach((example) => {
      try {
        const content = example.contents.toString('utf8');
        const parsedContent = yaml.load(content);

        if (!parsedContent.title) {
          logger.warn(`Skipping example '${example.src.basename}': Missing title.`);
          return;
        }

        if (seenTitles.has(parsedContent.title)) {
          logger.warn(`Duplicate title found: '${parsedContent.title}' in '${example.src.basename}'. Skipping.`);
          return;
        }

        if (!parsedContent.input || !parsedContent.mapping) {
          logger.warn(`Skipping example '${example.src.basename}': Missing input or mapping.`);
          return;
        }

        logger.info(`Loaded example: ${example.src.basename} with title: '${parsedContent.title}'`);
        seenTitles.add(parsedContent.title);

        bloblangSamples.push({ filename: example.src.basename, ...parsedContent });
      } catch (error) {
        logger.error(`Error processing example '${example.src.basename}':`, error);
      }
    });

    bloblangSamples.sort((a, b) => {
      return a.title.localeCompare(b.title);
    });

    const sortedSamplesObject = bloblangSamples.reduce((acc, sample) => {
      acc[sample.filename] = sample;
      return acc;
    }, {});

    // Add the sorted bloblang samples to the latest version of the component
    connect.latest.asciidoc.attributes['page-bloblang-samples'] = JSON.stringify(sortedSamplesObject);

    logger.debug(`Final bloblang samples added: ${JSON.stringify(sortedSamplesObject, null, 2)}`);
  });
};
