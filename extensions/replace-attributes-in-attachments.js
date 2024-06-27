'use strict';

module.exports.register = function () {
  this.on('contentClassified', ({ contentCatalog }) => {
    // Create a lookup table for component versions
    const componentVersionTable = contentCatalog.getComponents().reduce((componentMap, component) => {
      componentMap[component.name] = component.versions.reduce((versionMap, componentVersion) => {
        versionMap[componentVersion.version] = componentVersion;
        return versionMap;
      }, {});
      return componentMap;
    }, {});

    // Process each attachment
    contentCatalog.findBy({ family: 'attachment' }).forEach((attachment) => {
      // Get the corresponding component version
      const componentVersion = componentVersionTable[attachment.src.component]?.[attachment.src.version];
      if (!componentVersion) return;

      let attributes = componentVersion.asciidoc?.attributes;
      if (!attributes) return;

      // Remove trailing '@' from attribute values
      attributes = Object.entries(attributes).reduce((accum, [name, val]) => {
        accum[name] = val && val.endsWith('@') ? val.slice(0, val.length - 1) : val;
        return accum;
      }, {});

      let modified;
      const result = attachment.contents.toString().replace(/\{([\p{Alpha}\d_][\p{Alpha}\d_-]*)\}/gu, (match, name) => {
        if (!(name in attributes)) return match;
        modified = true;
        let value = attributes[name];
        if (value.endsWith('@')) value = value.slice(0, value.length - 1);
        return value;
      });

      // Update the attachment contents if modified
      if (modified) attachment.contents = Buffer.from(result);
    });
  });
};
