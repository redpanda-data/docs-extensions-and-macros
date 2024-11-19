/* Example use in the playbook
* antora:
    extensions:
 *    - require: ./extensions/aggregate-terms.js
*/

const fs = require('fs');
const path = require('path');

const TERMS_PATH = 'modules/terms/partials/';  // Default path within the 'shared' component

module.exports.register = function ({ config }) {
  const logger = this.getLogger('term-aggregation-extension');

  /**
   * Function to process term content, extracting hover text and links.
   */
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

  /**
   * Load terms from a specified local path if provided.
   */
  function loadLocalTerms(siteCatalog, termsPath) {
    try {
      const resolvedPath = path.resolve(termsPath);
      if (!fs.existsSync(resolvedPath)) {
        logger.warn(`Local terms path "${termsPath}" does not exist.`);
        return false;
      }

      const termFiles = fs.readdirSync(resolvedPath).filter(file => file.endsWith('.adoc'));
      if (!termFiles.length) {
        logger.warn(`No term files found in local path "${termsPath}".`);
        return false;
      }

      termFiles.forEach(file => {
        const filePath = path.join(resolvedPath, file);
        const termContent = fs.readFileSync(filePath, 'utf8');
        const categoryMatch = /:category: (.*)/.exec(termContent);
        const category = categoryMatch ? categoryMatch[1] : 'Miscellaneous';

        const formattedCategory = category.charAt(0).toUpperCase() + category.slice(1);

        if (!siteCatalog.termsByCategory[formattedCategory]) {
          siteCatalog.termsByCategory[formattedCategory] = [];
        }

        siteCatalog.termsByCategory[formattedCategory].push({ name: file, content: termContent });
      });

      logger.info(`Categorized terms from local terms path "${termsPath}".`);
      return true;

    } catch (error) {
      logger.error(`Error loading local terms from "${termsPath}": ${error.message}`);
      return false;
    }
  }

  this.on('contentAggregated', ({ siteCatalog, contentAggregate }) => {
    try {
      siteCatalog.termsByCategory = {};
      let termsLoaded = false;

      // Try to load terms from the local path if provided
      if (config.termspath) {
        termsLoaded = loadLocalTerms(siteCatalog, config.termspath);
      }

      // If no local terms were loaded, fallback to the 'shared' component
      if (!termsLoaded) {
        let sharedComponentFound = false;

        for (const component of contentAggregate) {
          if (component.name === 'shared') {
            sharedComponentFound = true;
            const termFiles = component.files.filter(file => file.path.includes(TERMS_PATH));

            termFiles.forEach(file => {
              const termContent = file.contents.toString('utf8');
              const categoryMatch = /:category: (.*)/.exec(termContent);
              const category = categoryMatch ? categoryMatch[1] : 'Miscellaneous';

              const formattedCategory = category.charAt(0).toUpperCase() + category.slice(1);

              if (!siteCatalog.termsByCategory[formattedCategory]) {
                siteCatalog.termsByCategory[formattedCategory] = [];
              }

              siteCatalog.termsByCategory[formattedCategory].push({ name: file.basename, content: termContent });
            });

            logger.info('Categorized terms from shared component.');
            break;
          }
        }

        // If no 'shared' component is found, log a warning
        if (!sharedComponentFound) {
          logger.warn(`No component named 'shared' found in the content and no valid local terms path provided. Terms will not be added to the glossary.`);
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
            logger.info(`Merged terms into glossary for ${component} component${version ? ' version ' + version : ''}.`);
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
