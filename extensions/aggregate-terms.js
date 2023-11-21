/* Example use in the playbook
* antora:
    extensions:
 *    - require: './extensions/aggregate-terms.js'
*/

module.exports.register = function ({ config }) {
  const logger = this.getLogger('term-aggregation-extension');
  const chalk = require('chalk');

  function processTermContent(termContent) {
    const hoverTextMatch = termContent.match(/:hover-text: (.*)/);
    const hoverText = hoverTextMatch ? hoverTextMatch[1] : '';
    if (hoverText && !termContent.includes('{hover-text}')) {
      const firstNewlineIndex = termContent.indexOf('\n\n');
      termContent = firstNewlineIndex !== -1
        ? termContent.slice(0, firstNewlineIndex + 1) + hoverText + '\n' + termContent.slice(firstNewlineIndex + 1)
        : termContent += '\n' + hoverText;
    }

    const linkMatch = termContent.match(/:link: (.*)/);
    const link = linkMatch ? linkMatch[1] : '';
    if (link) {
      termContent += `\n\nFor more details, see ${link}`;
    }

    return termContent;
  }

  this.on('contentAggregated', ({ siteCatalog, contentAggregate }) => {
    try {
      siteCatalog.termsByCategory = {};

      for (const component of contentAggregate) {
        if (component.name === 'shared') {
          const termFiles = component.files.filter(file => file.path.includes('modules/terms/partials/'));

          termFiles.forEach(file => {
            const termContent = file.contents.toString('utf8');
            const categoryMatch = /:category: (.*)/.exec(termContent);
            var category = categoryMatch ? categoryMatch[1] : 'Miscellaneous'; // Default category

            category = category.charAt(0).toUpperCase() + category.slice(1);

            if (!siteCatalog.termsByCategory[category]) {
              siteCatalog.termsByCategory[category] = [];
            }

            siteCatalog.termsByCategory[category].push({ name: file.basename, content: termContent });
          });

          console.log(chalk.green('Categorized terms from shared component.'));
          break;
        }
      }
    } catch (error) {
      logger.error(`Error categorizing terms: ${error.message}`);
    }
  })

  .on('contentClassified', ({ siteCatalog, contentCatalog }) => {
    const components = contentCatalog.getComponents();
    try {
      components.forEach(({ versions }) => {
        versions.forEach(({ name: component, version, asciidoc, title }) => {
          if (component == 'shared') return;

          const glossaryPage = contentCatalog.resolvePage(`${version ? version + '@' : ''}${component}:reference:glossary.adoc`);

          if (glossaryPage) {
            asciidoc.attributes['glossary-page'] = 'reference:glossary.adoc';
            let glossaryContent = glossaryPage.contents.toString('utf8');

            Object.keys(siteCatalog.termsByCategory).sort().forEach(category => {
              let categoryContent = `\n\n== ${category}\n`;

              siteCatalog.termsByCategory[category].sort((a, b) => a.name.localeCompare(b.name)).forEach(term => {
                let processedContent = processTermContent(term.content);
                categoryContent += `\n\n${processedContent}`;
              });

              glossaryContent += categoryContent;
            });

            glossaryPage.contents = Buffer.from(glossaryContent, 'utf8');
            console.log(chalk.green(`Merged terms into glossary for ${component} component${version ? ' version ' + version : ''}.`));
          } else {
            logger.info(`Skipping ${title} ${version ? ' version ' + version : ''} - No glossary page (reference:glossary.adoc) found`);
          }
        });
      });
    } catch (error) {
      logger.error(`Error merging terms: ${error.message}`);
    }
  });
};
