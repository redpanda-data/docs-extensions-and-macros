'use strict';

const semver = require('semver');
const micromatch = require('micromatch');
const formatVersion = require('./util/format-version.js');
const sanitize = require('./util/sanitize-attributes.js');

module.exports.register = function ({ config }) {
  const logger = this.getLogger('replace-attributes-extension');

  // Retrieve and validate configuration
  const filePatterns = config.data?.files || [];
  const userReplacements = config.data?.custom_replacements || [];

  if (filePatterns.length === 0) {
    logger.warn('No `files` patterns provided. Skipping replacement.');
    return;
  }

  // Precompile glob matchers for performance
  const matchers = micromatch.matcher(filePatterns, { dot: true });

  // Precompile user replacements
  const compiledUserReplacements = userReplacements.map(({ search, replace }) => ({
    regex: new RegExp(search, 'g'),
    replace,
  }));

  this.on('contentClassified', ({ contentCatalog }) => {
    // Build a lookup table: [componentName][version] -> componentVersion
    const componentVersionTable = contentCatalog.getComponents().reduce((componentMap, component) => {
      componentMap[component.name] = component.versions.reduce((versionMap, compVer) => {
        versionMap[compVer.version] = compVer;
        return versionMap;
      }, {});
      return componentMap;
    }, {});

    // Fetch all attachments
    const attachments = contentCatalog.findBy({ family: 'attachment' });
    logger.debug(`Found ${attachments.length} attachments to process.`);

    attachments.forEach((attachment) => {
      const { component, version } = attachment.src;
      const componentVer = componentVersionTable[component]?.[version];

      if (!componentVer?.asciidoc?.attributes) {
        // Skip attachments without asciidoc attributes
        return;
      }

      const filePath = attachment.out.path;

      if (!matchers(filePath)) {
        // Skip files that don't match the patterns
        return;
      }

      logger.debug(`Processing attachment: ${filePath}`);

      // Compute dynamic replacements specific to this componentVersion
      const dynamicReplacements = getDynamicReplacements(componentVer, logger);

      // Precompile dynamic replacements for this attachment
      const compiledDynamicReplacements = dynamicReplacements.map(({ search, replace }) => ({
        regex: new RegExp(search, 'g'),
        replace,
      }));

      // Combine dynamic and user replacements
      const allReplacements = [...compiledDynamicReplacements, ...compiledUserReplacements];

      // Convert buffer to string once
      let contentStr = attachment.contents.toString('utf8');

      // Apply all replacements in a single pass
      contentStr = applyAllReplacements(contentStr, allReplacements);

      // Expand AsciiDoc attributes
      contentStr = expandAsciiDocAttributes(contentStr, componentVer.asciidoc.attributes);

      // Convert back to buffer
      attachment.contents = Buffer.from(contentStr, 'utf8');
    });
  });
};

/* -----------------------------
   Helper: Build dynamic placeholders
----------------------------- */
function getDynamicReplacements(componentVersion, logger) {
  const attrs = componentVersion.asciidoc.attributes;
  const isPrerelease = attrs['page-component-version-is-prerelease'];
  const versionNum = formatVersion(componentVersion.version || '', semver);
  const is24_3plus =
    versionNum && semver.gte(versionNum, '24.3.0') && componentVersion.title === 'Self-Managed';
  const useTagAttributes = isPrerelease || is24_3plus;

  // Derive Redpanda / Console versions
  const redpandaVersion = isPrerelease
    ? sanitize(attrs['redpanda-beta-tag'] || '')
    : useTagAttributes
    ? sanitize(attrs['latest-redpanda-tag'] || '')
    : sanitize(attrs['full-version'] || '');
  const consoleVersion = isPrerelease
    ? sanitize(attrs['console-beta-tag'] || '')
    : useTagAttributes
    ? sanitize(attrs['latest-console-tag'] || '')
    : sanitize(attrs['latest-console-version'] || '');

  const redpandaRepo = isPrerelease ? 'redpanda-unstable' : 'redpanda';
  const consoleRepo = 'console';

  return [
    { search: '\\$\\{REDPANDA_DOCKER_REPO:[^}]*\\}', replace: redpandaRepo },
    { search: '\\$\\{CONSOLE_DOCKER_REPO:[^}]*\\}', replace: consoleRepo },
    { search: '\\$\\{REDPANDA_VERSION[^}]*\\}', replace: redpandaVersion },
    { search: '\\$\\{REDPANDA_CONSOLE_VERSION[^}]*\\}', replace: consoleVersion },
  ];
}

/* -----------------------------
   Helper: Apply an array of { regex, replace } to a string in a single pass
----------------------------- */
function applyAllReplacements(content, replacements) {
  replacements.sort((a, b) => b.regex.source.length - a.regex.source.length);

  replacements.forEach(({ regex, replace }) => {
    content = content.replace(regex, replace);
  });

  return content;
}

/* -----------------------------
   Helper: Expand {my-attribute}
----------------------------- */
function expandAsciiDocAttributes(content, attributes) {
  return content.replace(/\{([a-z][\p{Alpha}\d_-]*)\}/gu, (match, name) => {
    if (!(name in attributes)) return match;
    return sanitize(attributes[name]);
  });
}
