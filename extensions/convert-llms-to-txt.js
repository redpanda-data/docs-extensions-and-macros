'use strict';

const { toMarkdownUrl } = require('../extension-utils/url-utils');

/**
 * Extracts markdown from llms.adoc page and generates AI-friendly documentation exports.
 *
 * This extension:
 * 1. Adds site-url attribute to home component:
 *    - In preview builds (PREVIEW=true): Uses DEPLOY_PRIME_URL
 *    - In production builds: Uses playbook.site.url
 * 2. Finds llms page in home component (after AsciiDoc processing)
 * 3. Gets the markdown content from page.markdownContents (set by convert-to-markdown extension)
 * 4. Unpublishes the HTML page
 * 5. Places llms.txt (markdown) at site root
 * 6. Generates llms-full.txt with markdown from latest versions of all components
 * 7. Generates component-specific full.txt files (e.g., redpanda-full.txt, cloud-full.txt)
 *
 * Must run after convert-to-markdown extension to access page.markdownContents.
 */
module.exports.register = function () {
  const logger = this.getLogger('convert-llms-to-txt-extension');
  let siteUrl = '';

  // Add site-url attribute to home component
  this.on('playbookBuilt', ({ playbook }) => {
    // In preview builds, always use the deploy preview URL
    if (process.env.PREVIEW === 'true' && process.env.DEPLOY_PRIME_URL) {
      siteUrl = process.env.DEPLOY_PRIME_URL;
      logger.info(`Using deploy preview URL: ${siteUrl}`);
    } else {
      siteUrl = playbook.site?.url || 'https://docs.redpanda.com';
      logger.info(`Using site URL: ${siteUrl}`);
    }
  });

  this.on('contentClassified', ({ contentCatalog }) => {
    // Add site-url attribute to home component
    const homeComponent = contentCatalog.getComponents().find(c => c.name === 'home');
    if (homeComponent && homeComponent.versions) {
      homeComponent.versions.forEach(version => {
        if (!version.asciidoc) version.asciidoc = {};
        if (!version.asciidoc.attributes) version.asciidoc.attributes = {};
        version.asciidoc.attributes['site-url'] = siteUrl;
        logger.debug(`Added site-url attribute to home component: ${siteUrl}`);
      });
    }
  });

  // Run after pagesComposed so convert-to-markdown has already run
  this.on('beforePublish', ({ contentCatalog, siteCatalog }) => {
    // Find llms.adoc page in home component (after markdown conversion)
    const llmsPage = contentCatalog.findBy({
      component: 'home',
      family: 'page',
    }).find(page => page.src.stem === 'llms');

    if (!llmsPage) {
      logger.warn('No llms page found, skipping llms.txt generation');
    } else {
      logger.info(`Found llms page: ${llmsPage.src.path}`);
      logger.info(`Has markdownContents: ${!!llmsPage.markdownContents}`);
      logger.info(`Has out: ${!!llmsPage.out}`);
      try {
        // The convert-to-markdown extension has already processed this page
        // and stored the markdown in page.markdownContents
        if (!llmsPage.markdownContents) {
          throw new Error('No markdown content found on llms page. Ensure convert-to-markdown extension runs before this extension.');
        }

        let content = llmsPage.markdownContents.toString('utf8');
        logger.info(`Extracted ${content.length} bytes of markdown content`);

        // Strip HTML comments added by convert-to-markdown extension
        // These reference the unpublished /home/llms/ URL which doesn't make sense for llms.txt
        content = content.replace(/^<!--[\s\S]*?-->\s*/gm, '').trim();
        logger.debug(`Stripped HTML comments, now ${content.length} bytes`);

        // Fix URLs: convert em dashes back to double hyphens and remove invisible characters
        // The markdown converter applies smart typography that turns -- into — (em dash)
        // and inserts zero-width spaces (U+200B) and other invisible Unicode characters
        // This breaks URLs like deploy-preview-159--redpanda-documentation.netlify.app
        // Fix URLs in parentheses (actual hrefs)
        content = content.replace(/\(https?:\/\/[^)]*[—\u200B-\u200D\uFEFF][^)]*\)/g, (match) => {
          return match
            .replace(/—/g, '--')
            .replace(/[\u200B-\u200D\uFEFF]/g, '');
        });
        // Fix URLs in square brackets (link text)
        content = content.replace(/\[https?:\/\/[^\]]*[—\u200B-\u200D\uFEFF][^\]]*\]/g, (match) => {
          return match
            .replace(/—/g, '--')
            .replace(/[\u200B-\u200D\uFEFF]/g, '');
        });
        logger.debug('Fixed em dashes and invisible characters in URLs');

        // Unpublish the HTML page FIRST (following unpublish-pages pattern)
        if (llmsPage.out) {
          if (!siteCatalog.unpublishedPages) siteCatalog.unpublishedPages = [];
          if (llmsPage.pub?.url) {
            siteCatalog.unpublishedPages.push(llmsPage.pub.url);
          }
          delete llmsPage.out;
          logger.info('Unpublished llms HTML page');
        }

        // Store cleaned markdown content for adding after llms-full.txt
        llmsPage.llmsTxtContent = content;

      } catch (err) {
        logger.error(`Failed to extract markdown from llms page: ${err.message}`);
        logger.debug(err.stack);
      }
    }

    // Generate llms-full.txt - aggregate markdown from latest version of each component
    logger.info('Generating llms-full.txt from latest version pages with markdown...');

    // Get all components and identify latest versions
    const components = contentCatalog.getComponents();
    const latestVersions = new Set();

    components.forEach(component => {
      // Find the latest version (non-prerelease if available, otherwise the first version)
      const latest = component.latest || component.versions[0];
      if (latest) {
        latestVersions.add(`${component.name}@${latest.version}`);
        logger.debug(`Latest version for ${component.name}: ${latest.version}`);
      }
    });

    // Filter pages to only include latest versions
    const allPages = contentCatalog.getPages((p) => p.markdownContents);
    const pages = allPages.filter(page => {
      const pageKey = `${page.src.component}@${page.src.version}`;
      return latestVersions.has(pageKey);
    });

    if (!pages.length) {
      logger.warn('No pages with markdown content found in latest versions, skipping llms-full.txt generation');
      return;
    }

    logger.info(`Filtered to ${pages.length} pages from ${latestVersions.size} latest component versions (from ${allPages.length} total pages)`);

    let fullContent = `# Redpanda Documentation - Full Markdown Export\n\n`;
    fullContent += `> This file contains all documentation pages in markdown format for AI agent consumption.\n`;
    fullContent += `> Generated from ${pages.length} pages on ${new Date().toISOString()}\n`;
    fullContent += `> Site: ${siteUrl}\n\n`;
    fullContent += `## About This Export\n\n`;
    fullContent += `This export includes only the **latest version** of each component's documentation:\n`;
    components.forEach(component => {
      const latest = component.latest || component.versions[0];
      if (latest) {
        fullContent += `- **${component.title}**: version ${latest.version}\n`;
      }
    });
    fullContent += `\n`;
    fullContent += `### AI-Friendly Documentation Formats\n\n`;
    fullContent += `We provide multiple formats optimized for AI consumption:\n\n`;
    fullContent += `- **${siteUrl}/llms.txt**: Curated overview following the llms.txt standard - start here for a quick introduction\n`;
    fullContent += `- **${siteUrl}/llms-full.txt**: Complete documentation export (this file) - comprehensive reference with all pages\n`;
    fullContent += `- **Component-specific exports**: Focused documentation for individual products:\n`;
    components.forEach(component => {
      fullContent += `  - \`${siteUrl}/${component.name}-full.txt\`: ${component.title}\n`;
    });
    fullContent += `- **Individual markdown pages**: Each HTML page has a corresponding .md file (e.g., \`/docs/page.html\` → \`/docs/page.md\`)\n\n`;
    fullContent += `### Accessing Versioned Content\n\n`;
    fullContent += `For components with versioned documentation (like Redpanda Self-Managed), older versions can be accessed by replacing the version segment in the URL:\n`;
    fullContent += `- Latest: \`${siteUrl}/current/page-path\`\n`;
    fullContent += `- Specific version: \`${siteUrl}/24.3/page-path\`, \`${siteUrl}/25.1/page-path\`, etc.\n\n`;
    fullContent += `Available versioned components: ${components.filter(c => c.versions.length > 1).map(c => c.name).join(', ')}\n\n`;
    fullContent += `---\n\n`;

    // Sort pages by URL for consistent ordering
    pages.sort((a, b) => {
      const urlA = a.pub?.url || '';
      const urlB = b.pub?.url || '';
      return urlA.localeCompare(urlB);
    });

    pages.forEach((page, index) => {
      const mdUrl = page.pub?.url ? toMarkdownUrl(page.pub.url) : '';
      const pageUrl = mdUrl ? `${siteUrl}${mdUrl}` : 'unknown';
      const pageTitle = page.asciidoc?.doctitle || page.src?.stem || 'Untitled';

      fullContent += `# Page ${index + 1}: ${pageTitle}\n\n`;
      fullContent += `**URL**: ${pageUrl}\n\n`;
      fullContent += `---\n\n`;
      fullContent += page.markdownContents.toString('utf8');
      fullContent += `\n\n---\n\n`;
    });

    // Add llms-full.txt to site root
    siteCatalog.addFile({
      contents: Buffer.from(fullContent, 'utf8'),
      out: { path: 'llms-full.txt' },
    });
    logger.info(`Generated llms-full.txt with ${pages.length} pages`);

    // Generate component-specific full.txt files
    logger.info('Generating component-specific full.txt files...');
    const componentGroups = new Map();

    // Group pages by component
    pages.forEach(page => {
      const componentName = page.src.component;
      if (!componentGroups.has(componentName)) {
        componentGroups.set(componentName, []);
      }
      componentGroups.get(componentName).push(page);
    });

    // Generate a full.txt file for each component
    componentGroups.forEach((componentPages, componentName) => {
      const component = components.find(c => c.name === componentName);
      if (!component) return;

      const latest = component.latest || component.versions[0];
      if (!latest) return;

      // Sort pages by URL for consistent ordering
      componentPages.sort((a, b) => {
        const urlA = a.pub?.url || '';
        const urlB = b.pub?.url || '';
        return urlA.localeCompare(urlB);
      });

      let componentContent = `# ${component.title} - Full Markdown Export\n\n`;
      componentContent += `> This file contains all ${component.title} documentation pages in markdown format for AI agent consumption.\n`;
      componentContent += `> Generated from ${componentPages.length} pages on ${new Date().toISOString()}\n`;
      componentContent += `> Component: ${component.name} | Version: ${latest.version}\n`;
      componentContent += `> Site: ${siteUrl}\n\n`;
      componentContent += `## About This Export\n\n`;
      componentContent += `This export includes the **latest version** (${latest.version}) of the ${component.title} documentation.\n\n`;
      componentContent += `### AI-Friendly Documentation Formats\n\n`;
      componentContent += `We provide multiple formats optimized for AI consumption:\n\n`;
      componentContent += `- **${siteUrl}/llms.txt**: Curated overview of all Redpanda documentation\n`;
      componentContent += `- **${siteUrl}/llms-full.txt**: Complete documentation export with all components\n`;
      componentContent += `- **${siteUrl}/${componentName}-full.txt**: This file - ${component.title} documentation only\n`;
      componentContent += `- **Individual markdown pages**: Each HTML page has a corresponding .md file\n\n`;

      if (component.versions.length > 1) {
        componentContent += `### Accessing Older Versions\n\n`;
        componentContent += `This component has versioned documentation. Older versions can be accessed by replacing the version segment in the URL:\n`;
        componentContent += `- Latest: \`${siteUrl}/current/page-path\`\n`;
        componentContent += `- Specific version: \`${siteUrl}/24.3/page-path\`, \`${siteUrl}/25.1/page-path\`, etc.\n\n`;
      }

      componentContent += `---\n\n`;

      // Add all pages
      componentPages.forEach((page, index) => {
        const mdUrl = page.pub?.url ? toMarkdownUrl(page.pub.url) : '';
        const pageUrl = mdUrl ? `${siteUrl}${mdUrl}` : 'unknown';
        const pageTitle = page.asciidoc?.doctitle || page.src?.stem || 'Untitled';

        componentContent += `# Page ${index + 1}: ${pageTitle}\n\n`;
        componentContent += `**URL**: ${pageUrl}\n\n`;
        componentContent += `---\n\n`;
        componentContent += page.markdownContents.toString('utf8');
        componentContent += `\n\n---\n\n`;
      });

      // Add component-specific full.txt file to site root
      siteCatalog.addFile({
        contents: Buffer.from(componentContent, 'utf8'),
        out: { path: `${componentName}-full.txt` },
      });
      logger.info(`Generated ${componentName}-full.txt with ${componentPages.length} pages`);
    });

    // Add llms.txt to site root (using content extracted earlier)
    if (llmsPage && llmsPage.llmsTxtContent) {
      logger.info('Adding llms.txt to site root');

      siteCatalog.addFile({
        contents: Buffer.from(llmsPage.llmsTxtContent, 'utf8'),
        out: { path: 'llms.txt' },
      });
      logger.info('Successfully added llms.txt');

      // Add llms.txt to sitemap with git dates
      try {
        // Build a map of filename -> most recent git modified date
        const gitDates = new Map();

        // llms.txt uses the llms page's git modified date
        if (llmsPage.asciidoc?.attributes?.['page-git-modified-date']) {
          gitDates.set('llms.txt', llmsPage.asciidoc.attributes['page-git-modified-date']);
        }

        // llms-full.txt uses the most recent modified date from all pages
        if (pages.length > 0) {
          const mostRecent = getMostRecentGitDate(pages);
          if (mostRecent) {
            gitDates.set('llms-full.txt', mostRecent);
          }
        }

        // Component-specific files use most recent from that component
        componentGroups.forEach((componentPages, componentName) => {
          const mostRecent = getMostRecentGitDate(componentPages);
          if (mostRecent) {
            gitDates.set(`${componentName}-full.txt`, mostRecent);
          }
        });

        addToSitemap(contentCatalog, siteCatalog, siteUrl, gitDates, logger);
      } catch (err) {
        logger.warn(`Failed to add llms.txt to sitemap: ${err.message}`);
      }
    } else {
      logger.warn('llms.txt not generated - page not found or no content extracted');
    }
  });
};

/**
 * Get the most recent git modified date from a collection of pages
 */
function getMostRecentGitDate(pages) {
  let mostRecent = null;

  for (const page of pages) {
    const gitDate = page.asciidoc?.attributes?.['page-git-modified-date'];
    if (gitDate) {
      const date = new Date(gitDate);
      if (!mostRecent || date > mostRecent) {
        mostRecent = date;
      }
    }
  }

  return mostRecent ? mostRecent.toISOString() : null;
}

/**
 * Add llms.txt and all -full.txt files to sitemap by creating a separate sitemap-llms.xml
 * and adding it to the main sitemap index
 *
 * @param {Object} contentCatalog - Antora content catalog (source pages)
 * @param {Object} siteCatalog - Antora site catalog (output files)
 * @param {string} siteUrl - Base site URL
 * @param {Map<string, string>} gitDates - Map of filename -> ISO date string from git history
 * @param {Object} logger - Logger instance
 */
function addToSitemap(contentCatalog, siteCatalog, siteUrl, gitDates, logger) {
  const now = new Date().toISOString();

  // Find all llms .txt files in the site catalog
  const llmsFiles = siteCatalog.getFiles()
    .filter(file => {
      const filename = file.out.path;
      return filename === 'llms.txt' ||
             filename === 'llms-full.txt' ||
             filename.endsWith('-full.txt');
    })
    .map(file => file.out.path)
    .sort(); // Sort for consistent ordering

  logger.info(`Found ${llmsFiles.length} llms files to add to sitemap: ${llmsFiles.join(', ')}`);

  // Create sitemap-llms.xml with all llms files
  const urlEntries = llmsFiles.map(filename => {
    // Use git date if available, otherwise fall back to build time
    const lastmod = gitDates.get(filename) || now;
    return `  <url>
    <loc>${siteUrl}/${filename}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`;
  }).join('\n');

  const llmsSitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;

  siteCatalog.addFile({
    contents: Buffer.from(llmsSitemapXml, 'utf8'),
    out: { path: 'sitemap-llms.xml' },
  });
  logger.info(`Created sitemap-llms.xml with ${llmsFiles.length} entries`);

  // Find and update the main sitemap index
  const sitemapIndex = siteCatalog.getFiles().find(file =>
    file.out.path === 'sitemap.xml'
  );

  if (!sitemapIndex) {
    logger.warn('Main sitemap.xml not found, cannot add llms sitemap to index');
    return;
  }

  // Parse and update the sitemap index
  let sitemapIndexXml = sitemapIndex.contents.toString('utf8');

  // Add lastmod to all existing component sitemaps for consistency
  sitemapIndexXml = addLastmodToComponentSitemaps(contentCatalog, siteCatalog, sitemapIndexXml, siteUrl, logger);

  // Check if sitemap-llms.xml is already in the index
  if (sitemapIndexXml.includes('sitemap-llms.xml')) {
    logger.debug('sitemap-llms.xml already in sitemap index');
    // Update the index with modified component sitemaps even if llms sitemap exists
    sitemapIndex.contents = Buffer.from(sitemapIndexXml, 'utf8');
    return;
  }

  // Find the most recent date from all llms files for the sitemap-llms.xml lastmod
  let sitemapLastmod = now;
  if (gitDates.size > 0) {
    const dates = Array.from(gitDates.values()).map(d => new Date(d));
    const mostRecent = new Date(Math.max(...dates));
    sitemapLastmod = mostRecent.toISOString();
  }

  // Add sitemap-llms.xml entry before the closing </sitemapindex> tag
  const llmsSitemapEntry = `  <sitemap>
    <loc>${siteUrl}/sitemap-llms.xml</loc>
    <lastmod>${sitemapLastmod}</lastmod>
  </sitemap>
</sitemapindex>`;

  sitemapIndexXml = sitemapIndexXml.replace('</sitemapindex>', llmsSitemapEntry);

  // Update the sitemap index in the catalog
  sitemapIndex.contents = Buffer.from(sitemapIndexXml, 'utf8');
  logger.info('Added sitemap-llms.xml to main sitemap index');
}

/**
 * Add lastmod to all component sitemaps in the sitemap index for consistency
 * Also updates the component sitemaps themselves to use git dates instead of build time
 *
 * @param {Object} contentCatalog - Antora content catalog (source pages with git dates)
 * @param {Object} siteCatalog - Antora site catalog (output files including sitemaps)
 * @param {string} sitemapIndexXml - The sitemap index XML content
 * @param {string} siteUrl - Base site URL for matching URLs
 * @param {Object} logger - Logger instance
 */
function addLastmodToComponentSitemaps(contentCatalog, siteCatalog, sitemapIndexXml, siteUrl, logger) {
  // Build a map of URL -> git date from all pages
  const urlToGitDate = new Map();
  const allPages = contentCatalog.getPages();

  allPages.forEach(page => {
    if (page.pub?.url && page.asciidoc?.attributes?.['page-git-modified-date']) {
      const gitDate = page.asciidoc.attributes['page-git-modified-date'];
      const url = `${siteUrl}${page.pub.url}`;
      urlToGitDate.set(url, gitDate);
    }
  });

  logger.info(`Built URL -> git date map with ${urlToGitDate.size} entries`);
  if (urlToGitDate.size > 0 && urlToGitDate.size < 20) {
    urlToGitDate.forEach((date, url) => {
      logger.debug(`  ${url} -> ${date}`);
    });
  }

  // Find all component sitemap XML files
  const componentSitemaps = siteCatalog.getFiles()
    .filter(file => {
      const path = file.out.path;
      return path.startsWith('sitemap-') &&
             path.endsWith('.xml') &&
             path !== 'sitemap-llms.xml';
    });

  logger.debug(`Found ${componentSitemaps.length} component sitemaps to update with git dates`);

  // For each component sitemap, update URLs with git dates and find the most recent
  componentSitemaps.forEach(sitemapFile => {
    const filename = sitemapFile.out.path;
    let xml = sitemapFile.contents.toString('utf8');
    const dates = [];
    let updatedCount = 0;

    // Update each URL in the sitemap with its git date if available
    xml = xml.replace(
      /<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>\s*<\/url>/g,
      (match, url, oldDate) => {
        const gitDate = urlToGitDate.get(url);
        if (gitDate) {
          updatedCount++;
          dates.push(new Date(gitDate));
          return `<url>\n<loc>${url}</loc>\n<lastmod>${gitDate}</lastmod>\n</url>`;
        } else {
          // Keep original date
          try {
            dates.push(new Date(oldDate));
          } catch (e) {
            // Skip invalid dates
          }
          return match;
        }
      }
    );

    // Update the sitemap file in the catalog
    sitemapFile.contents = Buffer.from(xml, 'utf8');
    logger.info(`Updated sitemap ${filename}: ${updatedCount} URLs with git dates, ${dates.length} total dates`);

    if (dates.length === 0) {
      logger.debug(`No dates found in ${filename}`);
      return;
    }

    // Find the most recent date
    const mostRecent = new Date(Math.max(...dates));
    const lastmod = mostRecent.toISOString();

    // Update the sitemap index entry to include/update lastmod
    // Match various patterns since Antora might have different formatting
    const locPattern = new RegExp(
      `(<loc>[^<]*/${filename.replace(/\./g, '\\.')}</loc>)(?:\\s*<lastmod>[^<]*</lastmod>)?\\s*</sitemap>`,
      'g'
    );

    sitemapIndexXml = sitemapIndexXml.replace(
      locPattern,
      `$1\n    <lastmod>${lastmod}</lastmod>\n  </sitemap>`
    );

    logger.debug(`Updated lastmod to ${lastmod} for ${filename} in index`);
  });

  return sitemapIndexXml;
}
