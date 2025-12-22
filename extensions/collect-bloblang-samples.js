const yaml = require('js-yaml');

module.exports.register = function () {
  const logger = this.getLogger('collect-bloblang-samples');

  this.on('contentClassified', ({ contentCatalog }) => {

    const collectExamples = (examples, componentName) => {
      const bloblangSamples = [];
      const seenTitles = new Set();

      examples
        .filter((example) => example.src.relative.startsWith('playground/')) // Only include files in the 'playground' subdirectory
        .forEach((example) => {
          try {
            const content = example.contents.toString('utf8');
            const parsedContent = yaml.load(content);

            if (!parsedContent.title) {
              logger.warn(`Skipping example '${example.src.basename}' in '${componentName}': Missing title.`);
              return;
            }

            if (seenTitles.has(parsedContent.title)) {
              logger.warn(
                `Duplicate title found: '${parsedContent.title}' in '${example.src.basename}' (${componentName}). Skipping.`
              );
              return;
            }

            if (!parsedContent.input || !parsedContent.mapping) {
              logger.warn(
                `Skipping example '${example.src.basename}' in '${componentName}': Missing input or mapping.`
              );
              return;
            }

            logger.info(`Loaded example: ${example.src.basename} with title: '${parsedContent.title}'`);
            seenTitles.add(parsedContent.title);

            bloblangSamples.push({ filename: example.src.basename, ...parsedContent });
          } catch (error) {
            logger.error(`Error processing example '${example.src.basename}' in '${componentName}':`, error);
          }
        });

      bloblangSamples.sort((a, b) => a.title.localeCompare(b.title));

      return bloblangSamples.reduce((acc, sample) => {
        acc[sample.filename] = sample;
        return acc;
      }, {});
    };

    // Fetch examples from both components
    const examples = contentCatalog.findBy({ component: 'redpanda-connect', family: 'example' });
    const previewExamples = contentCatalog.findBy({ component: 'preview', family: 'example' });

    if (!examples.length) logger.warn(`No examples found in the 'redpanda-connect' component.`);

    // Get components
    const connect = contentCatalog.getComponents().find((c) => c.name === 'redpanda-connect');
    const preview = contentCatalog.getComponents().find((c) => c.name === 'preview');

    if (connect) {
      const connectSamples = collectExamples(examples, 'redpanda-connect');
      connect.latest.asciidoc.attributes['page-bloblang-samples'] = JSON.stringify(connectSamples);
      logger.debug(`Bloblang samples added to 'redpanda-connect': ${JSON.stringify(connectSamples, null, 2)}`);
    } else {
      logger.warn(`Component 'redpanda-connect' not found.`);
    }

    if (preview) {
      const previewSamples = collectExamples(previewExamples, 'preview');
      preview.latest.asciidoc.attributes['page-bloblang-samples'] = JSON.stringify(previewSamples);
      logger.debug(`Bloblang samples added to 'preview': ${JSON.stringify(previewSamples, null, 2)}`);
    }
  });
};
