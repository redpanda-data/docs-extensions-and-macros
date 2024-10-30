'use strict';

module.exports.register = function () {
  const sanitizeAttributeValue = (value) => String(value).replace('@', '');

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
        const stringValue = String(val); // Convert val to a string
        accum[name] = stringValue.endsWith('@') ? sanitizeAttributeValue(stringValue) : stringValue;
        return accum;
      }, {});

      let contentString = attachment.contents.toString();
      let modified = false;

      // Set replacements for Docker repos based on prerelease status
      const isPrerelease = attributes['page-component-version-is-prerelease'];
      const consoleRepo = isPrerelease ? 'console-unstable' : 'console';
      const redpandaRepo = isPrerelease ? 'redpanda-unstable' : 'redpanda';

      // YAML-specific Replacements
      if (attachment.out.path.endsWith('.yaml') || attachment.out.path.endsWith('.yml')) {
        const fullVersion = isPrerelease && attributes['redpanda-beta-version']
          ? sanitizeAttributeValue(attributes['redpanda-beta-version'])
          : sanitizeAttributeValue(attributes['full-version'] || '');
        const latestConsoleVersion = sanitizeAttributeValue(attributes['latest-console-version'] || '');

        // Replace the Docker repo placeholders based on the prerelease status
        contentString = replacePlaceholder(contentString, /\$\{REDPANDA_DOCKER_REPO:[^\}]*\}/g, redpandaRepo);
        contentString = replacePlaceholder(contentString, /\$\{CONSOLE_DOCKER_REPO:[^\}]*\}/g, consoleRepo);
        contentString = replacePlaceholder(contentString, /\$\{REDPANDA_VERSION[^\}]*\}/g, fullVersion);
        contentString = replacePlaceholder(contentString, /\$\{REDPANDA_CONSOLE_VERSION[^\}]*\}/g, latestConsoleVersion);
        modified = true;
      }

      // General attribute replacements (excluding uppercase)
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
};
