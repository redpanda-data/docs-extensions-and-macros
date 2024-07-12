'use strict';

module.exports.register = function () {
  const sanitizeAttributeValue = (value) => String(value).replace("@", "");
  this.on('contentClassified', ({ contentCatalog }) => {
    const componentVersionTable = contentCatalog.getComponents().reduce((componentMap, component) => {
      componentMap[component.name] = component.versions.reduce((versionMap, componentVersion) => {
        versionMap[componentVersion.version] = componentVersion;
        return versionMap;
      }, {});
      return componentMap;
    }, {});

    contentCatalog.findBy({ family: 'attachment' }).forEach((attachment) => {
      const componentVersion = componentVersionTable[attachment.src.component][attachment.src.version];
      let attributes = componentVersion.asciidoc?.attributes;
      if (!attributes) return;
      attributes = Object.entries(attributes).reduce((accum, [name, val]) => {
        const stringValue = String(val); // Ensure val is a string
        accum[name] = stringValue.endsWith('@') ? stringValue.slice(0, stringValue.length - 1) : stringValue;
        return accum;
      }, {});
      let modified;
      let contentString = attachment.contents.toString();
      // Specific replacements for YAML files
      if (attachment.out.path.endsWith('.yaml') || attachment.out.path.endsWith('.yml')) {
        const redpandaVersionRegex = /(\$\{REDPANDA_VERSION[^\}]*\})/g;
        const redpandaConsoleVersionRegex = /(\$\{REDPANDA_CONSOLE_VERSION[^\}]*\})/g;
        let fullVersion = attributes['full-version'] ? sanitizeAttributeValue(attributes['full-version']) : '';
        const latestConsoleVersion = attributes['latest-console-version'] ? sanitizeAttributeValue(attributes['latest-console-version']) : '';
        if (attributes['page-component-version-is-prerelease']) {
          fullVersion = attributes['redpanda-beta-version'] ? sanitizeAttributeValue(attributes['redpanda-beta-version']) : fullVersion;
        }
        contentString = contentString.replace(redpandaVersionRegex, fullVersion);
        contentString = contentString.replace(redpandaConsoleVersionRegex, latestConsoleVersion);
        modified = true;
      }

      const result = contentString.replace(/\{([\p{Alpha}\d_][\p{Alpha}\d_-]*)\}/gu, (match, name) => {
        if (!(name in attributes)) return match;
        modified = true;
        let value = attributes[name];
        if (value.endsWith('@')) value = value.slice(0, value.length - 1);
        return value;
      });

      if (modified) attachment.contents = Buffer.from(result);
    });
  });
};
