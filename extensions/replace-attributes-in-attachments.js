module.exports.register = function ({ config }) {
  const { family = 'attachment' } = config;
  const logger = this.getLogger('replace-attributes-in-attachments-extension');

  const sanitizeAttributeValue = (value) => String(value).replace("@", "");

  this.on('documentsConverted', ({contentCatalog}) => {
    for (const { versions } of contentCatalog.getComponents()) {
      for (const { name: component, version, asciidoc } of versions) {
        const attachments = contentCatalog.findBy({ component, version, family });
        if (component == 'api') continue
        for (const attachment of attachments) {
          let contentString = attachment['_contents'].toString('utf8');
          if (!asciidoc.attributes) continue
          for (const key in asciidoc.attributes) {
            const placeholder = "{" + key + "}";
            const sanitizedValue = sanitizeAttributeValue(asciidoc.attributes[key]);
            contentString = contentString.replace(new RegExp(placeholder, 'g'), sanitizedValue);
          }
          attachment['_contents'] = Buffer.from(contentString, "utf-8");
        }
      }
    }
  });
}
