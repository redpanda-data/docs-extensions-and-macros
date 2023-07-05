/* Example use in the playbook
* antora:
    extensions:
 *    - require: ./extensions/aggregate-terms.js
*/

module.exports.register = function ({ config }) {
  const logger = this.getLogger('term-aggregation-extension');
  const chalk = require('chalk')

  this.on('contentAggregated', ({ siteCatalog, contentAggregate }) => {
    try {
      for (const component of contentAggregate) {
        if (component.name === 'shared') {
          const termFiles = component.files.filter(file => file.path.includes('modules/terms/partials/'));
          siteCatalog.terms = {}
          termFiles.forEach(file => {
            const termContent = file.contents.toString('utf8');
            siteCatalog.terms[file.basename] = termContent;
          });
          console.log(chalk.green('Loaded terms from shared component.'));
          break
        }
      }
    } catch (error) {
      logger.error(`Error loading terms: ${error.message}`);
    }
  })

  .on('contentClassified', ({ siteCatalog, contentCatalog }) => {
    const components = contentCatalog.getComponents()
    try {
      for (const { versions } of components) {
        for (const { name: component, version, asciidoc, title } of versions) {
          // TODO: will need a better way to filter when we have more content components
          if (component !== 'ROOT') continue;
          const glossaryPage = contentCatalog.resolvePage(`${version?version +'@':''}${component}:reference:glossary.adoc`);
          if (glossaryPage) {
            asciidoc.attributes['glossary-page'] = 'reference:glossary.adoc'
            const glossaryContent = glossaryPage.contents.toString('utf8');
            let newContent = glossaryContent;
            const sortedTerms = Object.keys(siteCatalog.terms).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            for (i = 0; i < sortedTerms.length; i++) {
              const termName = sortedTerms[i];
              const termContent = siteCatalog.terms[termName];
              newContent += '\n\n' + termContent;
            }
            glossaryPage.contents = Buffer.from(newContent, 'utf8');

            console.log(chalk.green(`Transposed terms into glossary for ${component}.`));
          } else {
            logger.warn(`Skipping ${title} ${version} - No glossary page (reference:glossary.adoc) found`)
          }
        }
      }
    } catch (error) {
      logger.error(`Error transposing terms: ${error.message}`);
    }
  });
}