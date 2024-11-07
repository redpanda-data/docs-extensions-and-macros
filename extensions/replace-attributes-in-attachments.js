'use strict';
const semver = require('semver');

module.exports.register = function () {
  this.on('contentClassified', ({ contentCatalog }) => {
    const componentVersionTable = contentCatalog.getComponents().reduce((componentMap, component) => {
      componentMap[component.name] = component.versions.reduce((versionMap, componentVersion) => {
        versionMap[componentVersion.version] = componentVersion;
        return versionMap;
      }, {});
      return componentMap;
    }, {});

    contentCatalog.findBy({ family: 'attachment' }).forEach((attachment) => {
      const componentVersion = componentVersionTable[attachment.src.component]?.[attachment.src.version];
      if (!componentVersion?.asciidoc?.attributes) return;

      const attributes = Object.entries(componentVersion.asciidoc.attributes).reduce((accum, [name, val]) => {
        const stringValue = String(val);
        accum[name] = stringValue.endsWith('@') ? sanitizeAttributeValue(stringValue) : stringValue;
        return accum;
      }, {});

      let contentString = attachment.contents.toString();
      let modified = false;

    // Determine if we're using the tag or version attributes
    // We introduced tag attributes in Self-Managed 24.3
    const isPrerelease = attributes['page-component-version-is-prerelease'];
    const componentVersionNumber = formatVersion(componentVersion.version || '');
    const useTagAttributes = isPrerelease || (componentVersionNumber && semver.gte(componentVersionNumber, '24.3.0') && componentVersion.title === 'Self-Managed');

    // Set replacements based on the condition
    const redpandaVersion = isPrerelease
      ? sanitizeAttributeValue(attributes['redpanda-beta-tag'] || '')
      : (useTagAttributes
      ? sanitizeAttributeValue(attributes['latest-redpanda-tag'] || '')
      : sanitizeAttributeValue(attributes['full-version'] || ''));

      const consoleVersion = isPrerelease
      ? sanitizeAttributeValue(attributes['console-beta-tag'] || '')
      : (useTagAttributes
      ? sanitizeAttributeValue(attributes['latest-console-tag'] || '')
      : sanitizeAttributeValue(attributes['latest-console-version'] || ''));

      const redpandaRepo = isPrerelease ? 'redpanda-unstable' : 'redpanda';
      const consoleRepo = 'console';

      // YAML-specific replacements
      if (attachment.out.path.endsWith('.yaml') || attachment.out.path.endsWith('.yml')) {
        contentString = replacePlaceholder(contentString, /\$\{REDPANDA_DOCKER_REPO:[^\}]*\}/g, redpandaRepo);
        contentString = replacePlaceholder(contentString, /\$\{CONSOLE_DOCKER_REPO:[^\}]*\}/g, consoleRepo);
        contentString = replacePlaceholder(contentString, /\$\{REDPANDA_VERSION[^\}]*\}/g, redpandaVersion);
        contentString = replacePlaceholder(contentString, /\$\{REDPANDA_CONSOLE_VERSION[^\}]*\}/g, consoleVersion);
        modified = true;
      }

      // General attribute replacements (excluding uppercase with underscores)
      const result = contentString.replace(/\{([a-z][\p{Alpha}\d_-]*)\}/gu, (match, name) => {
        if (!(name in attributes)) return match;
        modified = true;
        return attributes[name];
      });

      if (modified) attachment.contents = Buffer.from(result);
    });
  });

  // Helper function to replace placeholders with attribute values
  function replacePlaceholder(content, regex, replacement) {
    return content.replace(regex, replacement);
  }

  const sanitizeAttributeValue = (value) => String(value).replace('@', '');

  const formatVersion = (version) => {
    if (!version) return null;
    return semver.valid(version) ? version : `${version}.0`;
  };
};
