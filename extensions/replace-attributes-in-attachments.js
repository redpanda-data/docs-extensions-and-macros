'use strict';

const semver = require('semver');
const micromatch = require('micromatch');
const formatVersion = require('./util/format-version.js');
const sanitize = require('./util/sanitize-attributes.js');

/**
 * Registers the replace attributes extension with support for multiple replacements.
 * Each replacement configuration can target specific components and file patterns.
 *
 * Configuration Structure:
 * data:
 *   replacements:
 *     - components:
 *         - 'ComponentName1'
 *         - 'ComponentName2'
 *       file_patterns:
 *         - 'path/to/attachments/**'
 *         - '/another/path/*.adoc'
 *       custom_replacements:
 *         - search: 'SEARCH_REGEX_PATTERN'
 *           replace: 'Replacement String'
 *         - ...
 */
module.exports.register = function ({ config }) {
  const logger = this.getLogger('replace-attributes-extension');
  const replacements = config.data?.replacements || [];

  // Validate configuration
  if (!replacements.length) {
    logger.info('No `replacements` configurations provided. Replacement process skipped.');
    return;
  }

  // Precompile all glob matchers for performance
  replacements.forEach((replacementConfig, index) => {
    const { components, file_patterns } = replacementConfig;

    if (!components || !Array.isArray(components) || !components.length) {
      logger.warn(`Replacement configuration at index ${index} is missing 'components'. Skipping this replacement configuration.`);
      replacementConfig.matchers = null;
      return;
    }

    if (!file_patterns || !file_patterns.length) {
      logger.warn(`Replacement configuration at index ${index} is missing 'file_patterns'. Skipping this replacement configuration.`);
      replacementConfig.matchers = null;
      return;
    }

    replacementConfig.matchers = micromatch.matcher(file_patterns, { dot: true });
  });

  // Precompile all user replacements for each replacement configuration
  replacements.forEach((replacementConfig, index) => {
    const { custom_replacements } = replacementConfig;
    if (!custom_replacements || !custom_replacements.length) {
      replacementConfig.compiledCustomReplacements = [];
      return;
    }
    replacementConfig.compiledCustomReplacements = custom_replacements.map(({ search, replace }) => {
      try {
        return {
          regex: new RegExp(search, 'g'),
          replace,
        };
      } catch (err) {
        logger.error(`Invalid regex pattern in custom_replacements for replacement configuration at index ${index}: "${search}"`, err);
        return null;
      }
    }).filter(Boolean); // Remove any null entries due to invalid regex
  });

  this.on('contentClassified', ({ contentCatalog }) => {
    // Build a lookup table: [componentName][version] -> componentVersion
    const componentVersionTable = contentCatalog.getComponents().reduce((componentMap, component) => {
      componentMap[component.name] = component.versions.reduce((versionMap, compVer) => {
        versionMap[compVer.version] = compVer;
        return versionMap;
      }, {});
      return componentMap;
    }, {});

    // Iterate over each replacement configuration
    replacements.forEach((replacementConfig, replacementIndex) => {
      const { components, matchers, compiledCustomReplacements } = replacementConfig;

      if (!components || !matchers) {
        // Already logged and skipped in precompilation
        return;
      }

      components.forEach((componentName) => {
        const comp = contentCatalog.getComponents().find(c => c.name === componentName);
        if (!comp) {
          logger.warn(`Component "${componentName}" not found. Skipping replacement configuration at index ${replacementIndex}.`);
          return;
        }

        comp.versions.forEach((compVer) => {
          const compName = comp.name;
          const compVersion = compVer.version;

          logger.debug(`Processing component version: ${compName}@${compVersion} for replacement configuration at index ${replacementIndex}`);

          // Gather attachments for this component version
          const attachments = contentCatalog.findBy({
            component: compName,
            version: compVersion,
            family: 'attachment',
          });

          logger.debug(`Found ${attachments.length} attachments for ${compName}@${compVersion}`);

          if (!attachments.length) {
            logger.debug(`No attachments found for ${compName}@${compVersion}, skipping.`);
            return;
          }

          // Filter attachments based on file_patterns
          const matched = attachments.filter((attachment) => {
            const filePath = attachment.out.path;
            return matchers(filePath);
          });

          logger.debug(`Matched ${matched.length} attachments for ${compName}@${compVersion} in replacement configuration at index ${replacementIndex}`);

          if (!matched.length) {
            logger.debug(`No attachments matched patterns for ${compName}@${compVersion} in replacement configuration at index ${replacementIndex}, skipping.`);
            return;
          }

          // Process each matched attachment
          matched.forEach((attachment) => {
            const { component: attComponent, version: attVersion } = attachment.src;
            const componentVer = componentVersionTable[attComponent]?.[attVersion];

            if (!componentVer?.asciidoc?.attributes) {
              // Skip attachments without asciidoc attributes
              return;
            }

            const filePath = attachment.out.path;

            logger.debug(`Processing attachment: ${filePath} for replacement configuration at index ${replacementIndex}`);

            // Compute dynamic replacements specific to this componentVersion
            const dynamicReplacements = getDynamicReplacements(componentVer, logger);

            // Precompile dynamic replacements for this attachment
            const compiledDynamicReplacements = dynamicReplacements.map(({ search, replace }) => ({
              regex: new RegExp(search, 'g'),
              replace,
            }));

            // Combine dynamic and user replacements
            const allReplacements = [...compiledDynamicReplacements, ...compiledCustomReplacements];

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
      });
    });
  })
};

// Build dynamic placeholder replacements
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

// Apply an array of { regex, replace } to a string in a single pass
function applyAllReplacements(content, replacements) {
  // Sort replacements by descending length of regex source to handle overlapping patterns
  replacements.sort((a, b) => b.regex.source.length - a.regex.source.length);

  replacements.forEach(({ regex, replace }) => {
    content = content.replace(regex, replace);
  });

  return content;
}

// Expand all existing attributes
function expandAsciiDocAttributes(content, attributes) {
  return content.replace(/\{([a-z][\p{Alpha}\d_-]*)\}/gu, (match, name) => {
    if (!(name in attributes)) return match;
    return sanitize(attributes[name]);
  });
}
