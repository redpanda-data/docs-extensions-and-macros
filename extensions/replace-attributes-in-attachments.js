module.exports.register = function ({ config }) {
  const { family = 'attachment' } = config;
  const logger = this.getLogger('replace-attributes-in-attachments-extension');

  const sanitizeAttributeValue = (value) => String(value).replace("@", "");

  this.on('contentClassified', ({contentCatalog}) => {
    for (const { versions } of contentCatalog.getComponents()) {
      for (const { name: component, version, asciidoc } of versions) {
        const attachments = contentCatalog.findBy({ component, version, family });
        if (component == 'api') continue;
        for (const attachment of attachments) {
          let contentString = attachment['_contents'].toString('utf8');
          if (!asciidoc.attributes) continue;

          // Replace general attributes
          for (const key in asciidoc.attributes) {
            const placeholder = "{" + key + "}";
            const sanitizedValue = sanitizeAttributeValue(asciidoc.attributes[key]);
            contentString = contentString.replace(new RegExp(placeholder, 'g'), sanitizedValue);
          }


          // Specific replacements for YAML files
          if (attachment.out.path.endsWith('.yaml') || attachment.out.path.endsWith('.yml')) {
            const redpandaVersionRegex = /(\$\{REDPANDA_VERSION[^\}]*\})/g;
            const redpandaConsoleVersionRegex = /(\$\{REDPANDA_CONSOLE_VERSION[^\}]*\})/g;
            const fullVersion = asciidoc.attributes['full-version'] ? sanitizeAttributeValue(asciidoc.attributes['full-version']) : '';
            const latestConsoleVersion = asciidoc.attributes['latest-console-version'] ? sanitizeAttributeValue(asciidoc.attributes['latest-console-version']) : '';

            contentString = contentString.replace(redpandaVersionRegex, fullVersion);
            contentString = contentString.replace(redpandaConsoleVersionRegex, latestConsoleVersion);
          }

          attachment['_contents'] = Buffer.from(contentString, "utf-8");
        }
      }
    }
  });
}
