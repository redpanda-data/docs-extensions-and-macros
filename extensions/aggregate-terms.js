const { raiseListenerLimit } = require('./util/raise-listener-limit')
/* Example use in the playbook
* antora:
    extensions:
 *    - require: ./extensions/aggregate-terms.js
*/

const fs = require('fs');
const path = require('path');
const { parseTermFile, validateTerms, toTermsJson, termAnchor, TERMS_COMPONENT, TERMS_JSON } = require('../extension-utils/glossary-terms');

const TERMS_PATH = 'modules/terms/partials/';  // Default path within the 'shared' component

module.exports.register = function ({ config }) {
  raiseListenerLimit(this)
  const logger = this.getLogger('term-aggregation-extension');

  /**
   * Function to process term content, extracting hover text and links.
   */
  // The term's section title, the first non-empty line without its '=' marks.
  function termTitle (termContent) {
    const first = termContent.split('\n').map(l => l.trim()).find(l => l.length > 0) || ''
    return first.replace(/^=+\s*/, '')
  }

  function processTermContent(termContent) {
    const hoverTextMatch = termContent.match(/:hover-text: (.*)/);
    const hoverText = hoverTextMatch ? hoverTextMatch[1] : '';
    if (hoverText && !termContent.includes('{hover-text}')) {
      const firstNewlineIndex = termContent.indexOf('\n\n');
      termContent = firstNewlineIndex !== -1
        ? termContent.slice(0, firstNewlineIndex + 1) + hoverText + '\n' + termContent.slice(firstNewlineIndex + 1)
        : termContent += '\n' + hoverText;
    }

    // Other names readers use, so the glossary page (and its Markdown twin,
    // which agents read) says what else a term is called.
    const altMatch = termContent.match(/^:alt-labels:[ \t]*(.+)$/m);
    const altLabels = altMatch ? altMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [];
    if (altLabels.length) {
      termContent += `\n\nAlso called: ${altLabels.join(', ')}.`;
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

  /**
   * Add terms.json to the shared component's attachments, next to
   * taxonomy.yml. Each term's `url` points at its entry on the site glossary
   * page when `glossarypage` is set.
   */
  function publishTermsJson (contentCatalog, terms) {
    const shared = typeof contentCatalog.getComponent === 'function' && contentCatalog.getComponent(TERMS_COMPONENT)
    if (!shared) return
    let glossaryUrl
    if (config.glossarypage) {
      const page = contentCatalog.resolvePage(config.glossarypage)
      if (page && page.pub) glossaryUrl = page.pub.url
    }
    let generatedBy
    try { generatedBy = `doc-tools ${require('../package.json').version}` } catch (_) {}
    const data = toTermsJson(terms, { glossaryUrl, generatedBy })
    contentCatalog.addFile({
      contents: Buffer.from(JSON.stringify(data, null, 2) + '\n'),
      src: { component: TERMS_COMPONENT, version: shared.latest.version, module: 'ROOT', family: 'attachment', relative: TERMS_JSON },
    })
    logger.info(`Published ${data.terms.length} glossary terms to ${TERMS_COMPONENT}/_attachments/${TERMS_JSON}.`)
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
    // Appends every term, by category, to a glossary page.
    function mergeTerms (glossaryPage) {
      let glossaryContent = glossaryPage.contents.toString('utf8');
      // Every term heading gets an explicit ID, the anchor glossterm links and
      // terms.json use. A category heading whose auto ID would be one of those
      // (category Schema Registry, term Schema Registry) gets a -terms suffix,
      // so the term keeps its anchor.
      const termAnchors = new Set()
      Object.values(siteCatalog.termsByCategory).forEach(list => list.forEach(t => termAnchors.add(termAnchor(termTitle(t.content)))))
      Object.keys(siteCatalog.termsByCategory).sort().forEach(category => {
        const categoryId = termAnchor(category)
        const categoryAttr = termAnchors.has(categoryId) ? `[#${categoryId}-terms]\n` : ''
        let categoryContent = `\n\n${categoryAttr}== ${category}\n`;
        siteCatalog.termsByCategory[category].sort((a, b) => a.name.localeCompare(b.name)).forEach(term => {
          categoryContent += `\n\n[#${termAnchor(termTitle(term.content))}]\n${processTermContent(term.content).replace(/^\s+/, '')}`;
        });
        glossaryContent += categoryContent;
      });
      glossaryPage.contents = Buffer.from(glossaryContent, 'utf8');
    }

    // Validate the glossary as one data set and publish it for agents and
    // tools at /shared/_attachments/terms.json. An ambiguous glossary (a
    // label that names two terms, a form a term both uses and avoids) fails
    // the build, like an invalid taxonomy does.
    const terms = []
    Object.values(siteCatalog.termsByCategory || {}).forEach((list) => list.forEach((t) => {
      const parsed = parseTermFile(t.content, { path: `shared/modules/terms/partials/${t.name}` })
      if (parsed) terms.push(parsed)
    }))
    const problems = validateTerms(terms)
    if (problems.length) {
      throw new Error(`The glossary (shared/modules/terms/partials) is ambiguous:\n  - ${problems.join('\n  - ')}`)
    }
    if (terms.length && config.publishjson !== false) publishTermsJson(contentCatalog, terms)

    try {
      // With `glossarypage`, one page holds the glossary for the whole site,
      // and every component's glossterm links point at it. Glossary pages
      // components still have are filled too, so they stay complete until
      // they are removed.
      let sitePage = null;
      if (config.glossarypage) {
        sitePage = contentCatalog.resolvePage(config.glossarypage);
        if (sitePage) {
          mergeTerms(sitePage);
          logger.info(`Merged terms into the site glossary ${config.glossarypage}.`);
        } else {
          logger.warn(`The glossarypage ${config.glossarypage} does not exist, so each component links to its own reference:glossary.adoc instead.`);
        }
      }

      contentCatalog.getComponents().forEach(({ versions }) => {
        versions.forEach(({ name: component, version, asciidoc, title }) => {
          if (component == 'shared') return;
          if (sitePage) asciidoc.attributes['glossary-page'] = config.glossarypage;

          const glossaryPage = contentCatalog.resolvePage(`${version ? version + '@' : ''}${component}:reference:glossary.adoc`);
          if (glossaryPage && glossaryPage !== sitePage) {
            if (!sitePage) asciidoc.attributes['glossary-page'] = 'reference:glossary.adoc';
            mergeTerms(glossaryPage);
            logger.info(`Merged terms into glossary for ${component} component${version ? ' version ' + version : ''}.`);
          } else if (!glossaryPage && !sitePage) {
            logger.info(`Skipping ${title} ${version ? ' version ' + version : ''} - No glossary page (reference:glossary.adoc) found`);
          }
        });
      });
    } catch (error) {
      logger.error(`Error merging terms: ${error.message}`);
    }
  });
};
