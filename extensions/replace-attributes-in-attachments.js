module.exports.register = function ({ config }) {
  const { family = 'attachment' } = config;
  const logger = this.getLogger('attributes-in-attachments-extension');

  const sanitizeAttributeValue = (value) => String(value).replace("@", "");

  this.on('documentsConverted', ({contentCatalog}) => {
    for (const { versions } of contentCatalog.getComponents()) {
      for (const { name: component, version } of versions) {
        if (component !== 'ROOT') continue;
        const attachments = contentCatalog.findBy({ component, version, family });
        for (const attachment of attachments) {
          let contentString = String.fromCharCode(...attachment['_contents']);
          const attributes = attachment.src.origin.descriptor.asciidoc.attributes;
          for (const key in attributes) {
            const placeholder = "{" + key + "}";
            const sanitizedValue = sanitizeAttributeValue(attributes[key]);
            contentString = contentString.replace(new RegExp(placeholder, 'g'), sanitizedValue);
          }
          attachment['_contents'] = Buffer.from(contentString, "utf-8");
        }
      }
    }
  });
}
