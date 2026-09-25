'use strict';

/**
 * Shared utilities for llms.txt generation and markdown processing.
 * Used by both convert-to-markdown.js and convert-llms-to-txt.js.
 */

/**
 * The base directive text that appears in markdown files pointing to llms.txt.
 * This is the canonical source of truth used for both rendering and stripping.
 */
const LLMS_DIRECTIVE_BASE = 'For the complete documentation index, see [llms.txt](/llms.txt)';

/**
 * Format the llms directive blockquote for a page.
 * @param {string} componentName - Optional component name for component-specific link
 * @returns {string} Formatted markdown blockquote directive
 */
function formatLlmsDirective(componentName) {

  if (componentName) {
    return `> ${LLMS_DIRECTIVE_BASE}. Component-specific: [${componentName}-full.txt](/${componentName}-full.txt)`;
  }
  return `> ${LLMS_DIRECTIVE_BASE}`;
}

/**
 * Helper to escape regex metacharacters in a string.
 * @param {string} str - String to escape
 * @returns {string} Escaped string safe for use in RegExp
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex pattern to match and strip the llms directive from markdown content.
 * Dynamically derived from LLMS_DIRECTIVE_BASE to stay in sync.
 * Matches the blockquote format with optional component-specific suffix.
 * The directive is written with a root-relative link, but links are made
 * absolute before the exports strip it, so any prefix before /llms.txt matches.
 */
const LLMS_DIRECTIVE_REGEX = new RegExp(
  `^> ${escapeRegExp(LLMS_DIRECTIVE_BASE).replace(
    escapeRegExp('(/llms.txt)'),
    '\\([^)\\s]*/llms\\.txt\\)'
  )}.*$`,
  'gm'
);

/**
 * Regex pattern to match and strip only injected metadata HTML comments from markdown content.
 * Only matches comments that start with known markers: "Source:" or "Note for AI:"
 * This preserves any user-authored HTML comments in the markdown.
 */
const SOURCE_COMMENT_REGEX = /^<!--\s*(?:Source:|Note for AI:)[\s\S]*?-->\s*/gm;

/**
 * Strip metadata added by convert-to-markdown extension from page content.
 * This removes:
 * 1. HTML comments (source URLs)
 * 2. llms.txt directive blockquotes (redundant in aggregated exports)
 *
 * @param {string|Buffer} content - The markdown content to strip
 * @returns {string} Cleaned markdown content
 */
function stripMarkdownMetadata(content) {
  let text = typeof content === 'string' ? content : content.toString('utf8');

  // Strip HTML comments (source URLs)
  text = text.replace(SOURCE_COMMENT_REGEX, '');

  // Strip llms.txt directive blockquotes
  text = text.replace(LLMS_DIRECTIVE_REGEX, '');

  return text.trim();
}

/**
 * Return the subset of `components` that have at least one page in `pages` —
 * i.e. the components that actually get a generated `<name>-full.txt` export.
 *
 * A `<name>-full.txt` file is only written for components that have pages, so
 * advertising an export for a corpus-less landing/utility component (e.g.
 * `data-platform`, `self-managed`, `search`) links the AI index to a 404.
 * Filtering the advertised list through this helper keeps it in sync with the
 * files that are actually produced. Input order is preserved.
 *
 * @param {Array<{name: string}>} components - All components from the content catalog
 * @param {Array<{src?: {component?: string}}>} pages - Pages that will be exported
 * @returns {Array<{name: string}>} Components that have at least one page
 */
function componentsWithExports(components, pages) {
  const componentNames = new Set(
    (pages || [])
      .map((page) => page && page.src && page.src.component)
      .filter(Boolean)
  );
  return (components || []).filter((component) =>
    componentNames.has(component.name)
  );
}

/**
 * Maximum characters per page index file. The Agent-Friendly Documentation
 * Spec passes an llms.txt index at 50,000 characters or less and recommends
 * splitting a large index into section-level files that each stay under that
 * limit. Leave a buffer below 50K.
 */
const MAX_INDEX_CHARS = 45000;

/**
 * Descriptions longer than this are cut at a word boundary so that one verbose
 * page doesn't force an extra split.
 */
const MAX_INDEX_DESCRIPTION_CHARS = 200;

function oneLine(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateDescription(text) {
  const clean = oneLine(text);
  if (clean.length <= MAX_INDEX_DESCRIPTION_CHARS) return clean;
  const cut = clean.slice(0, MAX_INDEX_DESCRIPTION_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:]+$/, '')}...`;
}

// Square brackets in link text end the link early in markdown.
function escapeLinkText(text) {
  return oneLine(text).replace(/([[\]])/g, '\\$1');
}

/**
 * Longest shared directory of a set of URL paths, always ending in `/`.
 * `/streaming/26.1/manage/a/` and `/streaming/26.1/deploy/b/` share `/streaming/26.1/`.
 */
function commonDirectory(urls) {
  const dirs = urls.map((url) => url.replace(/[^/]*\/?$/, '').split('/').filter(Boolean));
  if (!dirs.length) return '/';
  const shared = [];
  for (let i = 0; i < dirs[0].length; i++) {
    const segment = dirs[0][i];
    if (!dirs.every((d) => d[i] === segment)) break;
    shared.push(segment);
  }
  return shared.length ? `/${shared.join('/')}/` : '/';
}

/**
 * URL of the component version's root, derived from how Antora built the page
 * URL: the version root, then the module name (omitted for ROOT), then the
 * page's relative path (index pages drop their own segment). Works for both
 * indexified (`/a/b/`) and `.html` URLs, since the page is one segment either way.
 * Returns null when the page lacks the source fields needed.
 */
function versionRootOf(page) {
  const { module: moduleName, relative } = page.src || {};
  if (!relative || !moduleName) return null;
  const relSegments = relative.replace(/\.adoc$/, '').split('/').filter(Boolean);
  if (relSegments[relSegments.length - 1] === 'index') relSegments.pop();
  const tailCount = relSegments.length + (moduleName === 'ROOT' ? 0 : 1);
  const urlSegments = page.pub.url.split('/').filter(Boolean);
  if (tailCount > urlSegments.length) return null;
  const rootSegments = urlSegments.slice(0, urlSegments.length - tailCount);
  return rootSegments.length ? `/${rootSegments.join('/')}/` : '/';
}

function mostCommon(values) {
  const counts = new Map();
  values.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  let best = null;
  counts.forEach((count, value) => {
    if (best === null || count > counts.get(best)) best = value;
  });
  return best;
}

/**
 * The directory segment directly under `dir` that contains `url`, or null when
 * the page sits in `dir` itself. With indexified URLs a page `/a/b/` lives in
 * `/a/`, so the last segment is the page, not a directory.
 */
function childSegment(url, dir) {
  const rest = url.slice(dir.length).replace(/\/$/, '').replace(/\/index\.html$/, '');
  const segments = rest.split('/').filter(Boolean);
  return segments.length > 1 ? segments[0] : null;
}

function latestDate(dates) {
  const times = dates.filter(Boolean).map((d) => new Date(d)).filter((d) => !isNaN(d));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function renderIndexFile({ heading, intro, entries }) {
  let out = `# ${heading}\n\n`;
  intro.forEach((line) => {
    out += `> ${line}\n`;
  });
  out += `\n## Pages\n\n`;
  entries.forEach((entry) => {
    out += `${entry.line}\n`;
  });
  return out;
}

/**
 * Pack entries into chunks whose rendered size stays under the limit.
 * Used only when a single directory holds more pages than one file allows.
 */
function chunkEntries(entries, overhead, maxChars) {
  const chunks = [];
  let current = [];
  let size = overhead;
  entries.forEach((entry) => {
    const lineSize = entry.line.length + 1;
    if (current.length && size + lineSize > maxChars) {
      chunks.push(current);
      current = [];
      size = overhead;
    }
    current.push(entry);
    size += lineSize;
  });
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Build page index files for every published component version.
 *
 * Each component version gets an index at `<version root>/llms.txt` listing
 * every page as a markdown link to its .md URL. When a version's index would
 * exceed `maxChars`, it is split by URL directory, recursively, so each file
 * stays under the limit. The root llms.txt links to every file this returns,
 * which keeps every page one hop from the root index.
 *
 * @param {Object} options
 * @param {Array} options.pages - Antora pages that have markdown (page.markdownContents)
 * @param {Array} options.components - Antora components
 * @param {string} options.siteUrl - Absolute site URL without a trailing slash
 * @param {Function} options.toMarkdownUrl - Maps a page's HTML URL to its .md URL
 * @param {number} [options.maxChars] - Size limit per file
 * @returns {Array<{path: string, url: string, title: string, component: string,
 *   version: string, isLatest: boolean, pageCount: number, contents: string}>}
 */
function buildPageIndexes({ pages, components, siteUrl, toMarkdownUrl, maxChars = MAX_INDEX_CHARS }) {
  const componentsByName = new Map((components || []).map((c) => [c.name, c]));
  const groups = new Map();

  (pages || []).forEach((page) => {
    const url = page.pub && page.pub.url;
    if (!url || !page.out || !page.src) return;
    const key = `${page.src.version}@${page.src.component}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(page);
  });

  const indexes = [];

  groups.forEach((groupPages) => {
    const { component: componentName, version } = groupPages[0].src;
    const component = componentsByName.get(componentName);
    if (!component) return;
    const componentVersion = (component.versions || []).find((v) => v.version === version) || {};
    const latest = component.latest || (component.versions || [])[0] || {};
    const isLatest = latest.version === version;
    const versioned = (component.versions || []).length > 1;
    const displayVersion = componentVersion.displayVersion || version;
    const baseTitle = versioned
      ? `${component.title} ${displayVersion}`
      : component.title;

    const entries = groupPages
      .map((page) => {
        const title = page.asciidoc && (page.asciidoc.doctitle || page.asciidoc.navtitle);
        const description = page.asciidoc && page.asciidoc.attributes && page.asciidoc.attributes.description;
        const mdUrl = `${siteUrl}${toMarkdownUrl(page.pub.url)}`;
        let line = `- [${escapeLinkText(title || page.src.stem)}](${mdUrl})`;
        if (description) line += `: ${truncateDescription(description)}`;
        const modified = page.asciidoc && page.asciidoc.attributes && page.asciidoc.attributes['page-git-modified-date'];
        return { url: page.pub.url, line, modified };
      })
      .sort((a, b) => a.url.localeCompare(b.url));

    const roots = groupPages.map(versionRootOf).filter(Boolean);
    const versionRoot = roots.length ? mostCommon(roots) : commonDirectory(entries.map((e) => e.url));

    const intro = (scope) => {
      const lines = [
        `Index of ${scope} documentation pages. Each link points to the page's markdown version.`,
      ];
      if (versioned && !isLatest) {
        lines.push(`This is version ${displayVersion}. The latest version is ${latest.displayVersion || latest.version}.`);
      }
      lines.push(`For the full documentation index, see ${siteUrl}/llms.txt`);
      return lines;
    };

    const makeIndex = (dir, dirEntries, label, part) => {
      const heading = label ? `${baseTitle}: ${label}` : baseTitle;
      const title = part > 1 ? `${heading} (part ${part})` : heading;
      const path = `${dir.replace(/^\//, '')}${part > 1 ? `llms-${part}.txt` : 'llms.txt'}`;
      return {
        path,
        url: `${siteUrl}/${path}`,
        title,
        component: componentName,
        version,
        isLatest,
        pageCount: dirEntries.length,
        lastModified: latestDate(dirEntries.map((e) => e.modified)),
        contents: renderIndexFile({
          heading: title,
          intro: intro(label ? `${baseTitle} ${label}` : baseTitle),
          entries: dirEntries,
        }),
      };
    };

    const split = (dir, dirEntries) => {
      const label = dir.slice(versionRoot.length).replace(/\/$/, '');
      const whole = makeIndex(dir, dirEntries, label, 1);
      if (whole.contents.length <= maxChars) {
        indexes.push(whole);
        return;
      }

      const children = new Map();
      dirEntries.forEach((entry) => {
        const child = childSegment(entry.url, dir);
        if (child === null) return;
        if (!children.has(child)) children.set(child, []);
        children.get(child).push(entry);
      });

      // Peel off the largest subdirectories into their own indexes until the
      // rest fits. Small subdirectories stay in this directory's index, so the
      // split produces as few files as the limit allows.
      const fits = (list) => makeIndex(dir, list, label, 1).contents.length <= maxChars;
      const bySize = [...children.entries()].sort((a, b) => b[1].length - a[1].length);
      const kept = new Set(bySize.map(([child]) => child));
      const remaining = () => dirEntries.filter((entry) => {
        const child = childSegment(entry.url, dir);
        return child === null || kept.has(child);
      });
      for (const [child, childEntries] of bySize) {
        if (fits(remaining())) break;
        kept.delete(child);
        split(`${dir}${child}/`, childEntries);
      }

      const rest = remaining();
      if (!rest.length) return;
      // A directory whose own pages still exceed the limit is split into numbered parts.
      // Header size of the largest possible part, so no chunk overflows once rendered.
      const overhead = makeIndex(dir, [], label, 99).contents.length;
      chunkEntries(rest, overhead, maxChars).forEach((chunk, i) => indexes.push(makeIndex(dir, chunk, label, i + 1)));
    };

    split(versionRoot, entries);
  });

  // Latest versions first, then older versions newest first, each in URL order.
  return indexes.sort((a, b) => {
    if (a.component !== b.component) return a.component.localeCompare(b.component);
    if (a.isLatest !== b.isLatest) return a.isLatest ? -1 : 1;
    if (a.version !== b.version) return b.version.localeCompare(a.version, undefined, { numeric: true });
    return a.path.localeCompare(b.path);
  });
}

/**
 * Replace markdown links to the root llms.txt with their plain link text.
 * A root index that links to itself is read as a nested index by tools that
 * walk llms.txt, which pushes every page index one level deeper than intended.
 */
function unlinkSelfReferences(content, siteUrl) {
  const self = new RegExp(`\\[([^\\]]*)\\]\\((?:${escapeRegExp(siteUrl)})?/llms\\.txt\\)`, 'g');
  return content.replace(self, '$1');
}

/**
 * Render the root llms.txt section that links to every page index file.
 * Every index must be linked from the root so agents, and tools that follow
 * one level of nested indexes, can reach every page.
 */
function renderPageIndexSection(indexes, components) {
  const titles = new Map((components || []).map((c) => [c.name, c.title]));
  let out = `## Page indexes\n\n`;
  out += `Each file below lists pages as links to their markdown versions. Start with the latest version of a product unless you need a specific older version.\n\n`;
  let currentComponent = null;
  let olderHeadingShown = false;
  indexes.forEach((index) => {
    if (index.component !== currentComponent) {
      currentComponent = index.component;
      olderHeadingShown = false;
      out += `${currentComponent === indexes[0].component ? '' : '\n'}### ${titles.get(index.component) || index.component}\n\n`;
    }
    if (!index.isLatest && !olderHeadingShown) {
      olderHeadingShown = true;
      out += `\nOlder versions:\n\n`;
    }
    out += `- [${escapeLinkText(index.title)}](${index.url}): ${index.pageCount} ${index.pageCount === 1 ? 'page' : 'pages'}\n`;
  });
  return out;
}

module.exports = {
  LLMS_DIRECTIVE_BASE,
  LLMS_DIRECTIVE_REGEX,
  SOURCE_COMMENT_REGEX,
  MAX_INDEX_CHARS,
  formatLlmsDirective,
  stripMarkdownMetadata,
  componentsWithExports,
  buildPageIndexes,
  renderPageIndexSection,
  unlinkSelfReferences,
};
