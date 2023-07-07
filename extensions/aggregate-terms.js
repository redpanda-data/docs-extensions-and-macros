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
          if (component == 'shared') continue;
          const glossaryPage = contentCatalog.resolvePage(`${version?version +'@':''}${component}:reference:glossary.adoc`);
          if (glossaryPage) {
            asciidoc.attributes['glossary-page'] = 'reference:glossary.adoc'
            const glossaryContent = glossaryPage.contents.toString('utf8');
            let newContent = glossaryContent;
            const sortedTerms = Object.keys(siteCatalog.terms).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            for (i = 0; i < sortedTerms.length; i++) {
              const termName = sortedTerms[i];
              let termContent = siteCatalog.terms[termName];
              const hoverTextMatch = termContent.match(/:hover-text: (.*)/);
              const hoverText = hoverTextMatch ? hoverTextMatch[1] : '';
              const linkMatch = termContent.match(/:link: (.*)/);
              const link = linkMatch ? linkMatch[1] : '';
              // If the hover-text attribute is found and the content does not already contain {hover-text}, append it as a new line after the first newline
              if (hoverText && !termContent.includes('{hover-text}')) {
                const firstNewlineIndex = termContent.indexOf('\n\n');
                if (firstNewlineIndex !== -1) {
                  termContent = termContent.slice(0, firstNewlineIndex + 1) + hoverText + '\n' + termContent.slice(firstNewlineIndex + 1);
                } else {
                  // If there's no newline, just append at the end
                  termContent += '\n' + hoverText;
                }
              }
              // If the link attribute is found, append it at the end of the term content
              if (link) {
                termContent += `\n\nFor more details, see ${link}`;
              }
              newContent += '\n\n' + termContent;
            }
            glossaryPage.contents = Buffer.from(newContent, 'utf8');

            console.log(chalk.green(`Merged terms into glossary for ${component} component${version? version: ''}.`));
          } else {
            logger.warn(`Skipping ${title} ${version} - No glossary page (reference:glossary.adoc) found`)
          }
        }
      }
    } catch (error) {
      logger.error(`Error merging terms: ${error.message}`);
    }
  });
}