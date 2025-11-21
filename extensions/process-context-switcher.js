/* Example use in the playbook
* antora:
    extensions:
 *    - require: ./extensions/process-context-switcher.js
 *
 * This extension processes the `page-context-switcher` attribute and:
 * 1. Replaces "current" references with the full resource ID of the current page
 * 2. Injects context switchers into target pages with proper bidirectional linking
 * 3. Automatically adds the current page's version to resource IDs that don't specify one
 *
 * Example context switcher attribute:
 * :page-context-switcher: [{"name": "Version 2.x", "to": "ROOT:console:config/security/authentication.adoc"}, {"name": "Version 3.x", "to": "current"}]
 *
 * Note: You can omit the version from resource IDs - the extension will automatically
 * use the current page's version. So "ROOT:console:file.adoc" becomes "current@ROOT:console:file.adoc"
*/

'use strict';

module.exports.register = function ({ config }) {
  const logger = this.getLogger('context-switcher-extension');

  this.on('documentsConverted', async ({ contentCatalog }) => {
    // Find all pages with context-switcher attribute
    const pages = contentCatalog.findBy({ family: 'page' });
    const pagesToProcess = pages.filter(page =>
      page.asciidoc.attributes['page-context-switcher']
    );

    if (pagesToProcess.length === 0) {
      logger.debug('No pages found with page-context-switcher attribute');
      return;
    }

    logger.info(`Processing context-switcher attribute for ${pagesToProcess.length} pages`);

    // Process each page with context-switcher
    for (const page of pagesToProcess) {
      processContextSwitcher(page, contentCatalog, logger);
    }
  });

  /**
   * Process the context-switcher attribute for a page
   * @param {Object} page - The page object
   * @param {Object} contentCatalog - The content catalog
   * @param {Object} logger - Logger instance
   */
  function processContextSwitcher(page, contentCatalog, logger) {
    const contextSwitcherAttr = page.asciidoc.attributes['page-context-switcher'];

    try {
      // Parse the JSON attribute
      const contextSwitcher = JSON.parse(contextSwitcherAttr);

      if (!Array.isArray(contextSwitcher)) {
        logger.warn(`Invalid context-switcher format in ${page.src.path}: expected array`);
        return;
      }

      // Get current page's full resource ID
      const currentResourceId = buildResourceId(page);
      logger.debug(`Processing context-switcher for page: ${currentResourceId}`);

      // Make a copy for processing target pages (before modifying "current")
      const originalContextSwitcher = JSON.parse(JSON.stringify(contextSwitcher));

      // Track if we made any changes
      let hasChanges = false;

      // Process each context switcher item
      for (let item of contextSwitcher) {
        if (item.to === 'current') {
          item.to = currentResourceId;
          hasChanges = true;
          logger.debug(`Replaced 'current' with '${currentResourceId}' in context-switcher`);
        } else if (item.to !== currentResourceId) {
          // For non-current items, find and update the target page
          const targetPage = findPageByResourceId(item.to, contentCatalog, page);
          if (targetPage) {
            injectContextSwitcherToTargetPage(targetPage, originalContextSwitcher, currentResourceId, logger);
          } else {
            logger.warn(`Target page not found for resource ID: '${item.to}'. Check that the component, module, and path exist. Enable debug logging to see available pages.`);
          }
        }
      }

      // Update the current page's attribute if we made changes
      if (hasChanges) {
        page.asciidoc.attributes['page-context-switcher'] = JSON.stringify(contextSwitcher);
      }

    } catch (error) {
      logger.error(`Error parsing context-switcher attribute in ${page.src.path}: ${error.message}`);
    }
  }

  /**
   * Build a full resource ID for a page (component:module:relative-path)
   * @param {Object} page - The page object
   * @returns {string} The full resource ID
   */
  function buildResourceId(page) {
    const component = page.src.component;
    const version = page.src.version;
    const module = page.src.module || 'ROOT';
    const relativePath = page.src.relative;

    // Format: version@component:module:relative-path
    return `${version}@${component}:${module}:${relativePath}`;
  }

  /**
   * Normalize a resource ID by adding the current page's version if missing
   * @param {string} resourceId - The resource ID to normalize
   * @param {Object} currentPage - The current page (for context)
   * @returns {string} The normalized resource ID
   */
  function normalizeResourceId(resourceId, currentPage) {
    // Sanitize input to avoid syntax errors
    if (!resourceId || typeof resourceId !== 'string') {
      throw new Error('Resource ID must be a non-empty string');
    }

    if (!currentPage || !currentPage.src || !currentPage.src.version) {
      throw new Error('Current page must have a valid src.version property');
    }

    // Trim whitespace and remove any dangerous characters
    const sanitizedResourceId = resourceId.trim();
    if (!sanitizedResourceId) {
      throw new Error('Resource ID cannot be empty or whitespace-only');
    }

    // Validate basic resource ID format (component:module:path or version@component:module:path)
    if (!/^([^@]+@)?[^:]+:[^:]+:.+$/.test(sanitizedResourceId)) {
      throw new Error(`Invalid resource ID format: '${sanitizedResourceId}'. Expected format: [version@]component:module:path`);
    }

    // If the resource ID already contains a version (has @), return as-is
    if (sanitizedResourceId.includes('@')) {
      return sanitizedResourceId;
    }

    // Add the current page's version to the resource ID
    const currentVersion = currentPage.src.version;
    return `${currentVersion}@${sanitizedResourceId}`;
  }

  /**
   * Find a page by its resource ID using Antora's built-in resolution
   * @param {string} resourceId - The resource ID to find
   * @param {Object} contentCatalog - The content catalog
   * @param {Object} currentPage - The current page (for context)
   * @returns {Object|null} The found page or null
   */
  function findPageByResourceId(resourceId, contentCatalog, currentPage) {
    try {
      // Normalize the resource ID by adding version if missing
      const normalizedResourceId = normalizeResourceId(resourceId, currentPage);

      if (normalizedResourceId !== resourceId) {
        logger.debug(`Normalized resource ID '${resourceId}' to '${normalizedResourceId}' using current page version`);
      }

      try {
        // Use Antora's built-in resource resolution
        const resource = contentCatalog.resolveResource(normalizedResourceId, currentPage.src);

        if (resource) {
          logger.debug(`Resolved resource ID '${normalizedResourceId}' to: ${buildResourceId(resource)}`);
          return resource;
        } else {
          logger.warn(`Could not resolve resource ID: '${normalizedResourceId}'. Check that the component, module, and path exist.`);

          // Provide some debugging help by showing available pages in the current component
          const currentComponentPages = contentCatalog.findBy({
            family: 'page',
            component: currentPage.src.component
          }).slice(0, 10);

          logger.debug(`Available pages in current component '${currentPage.src.component}' (first 10):`,
            currentComponentPages.map(p => `${p.src.version}@${p.src.component}:${p.src.module || 'ROOT'}:${p.src.relative}`));

          return null;
        }
      } catch (error) {
        logger.debug(`Error resolving resource ID '${normalizedResourceId}': ${error.message}`);
        return null;
      }
    } catch (error) {
      // Handle normalization errors (invalid resource ID format)
      logger.warn(`Invalid resource ID '${resourceId}': ${error.message}`);
      return null;
    }
  }

  /**
   * Inject context-switcher attribute to target page
   * @param {Object} targetPage - The target page to inject to
   * @param {Array} contextSwitcher - The context switcher configuration
   * @param {string} currentPageResourceId - The current page's resource ID
   * @param {Object} logger - Logger instance
   */
  function injectContextSwitcherToTargetPage(targetPage, contextSwitcher, currentPageResourceId, logger) {
    // Check if target page already has context-switcher attribute
    if (targetPage.asciidoc.attributes['page-context-switcher']) {
      logger.info(`Target page ${buildResourceId(targetPage)} already has context-switcher attribute. Skipping injection to avoid overwriting existing configuration: ${targetPage.asciidoc.attributes['page-context-switcher']}`);
      return;
    }

    const targetPageResourceId = buildResourceId(targetPage);

    logger.debug(`Injecting context switcher to target page: ${targetPageResourceId}`);

    // Create a copy of the context switcher for the target page
    // Simply replace "current" with the original page's resource ID
    const targetContextSwitcher = contextSwitcher.map(item => {
      if (item.to === 'current') {
        logger.debug(`Replacing 'current' with original page: ${currentPageResourceId}`);
        return {
          ...item,
          to: currentPageResourceId
        };
      }
      // All other items stay the same
      return { ...item };
    });

    logger.debug(`Target context switcher:`, JSON.stringify(targetContextSwitcher, null, 2));

    // Inject the attribute
    targetPage.asciidoc.attributes['page-context-switcher'] = JSON.stringify(targetContextSwitcher);
    logger.debug(`Successfully injected context-switcher to target page: ${targetPageResourceId}`);
  }
};
