function addLineNumbersAndCodeHighlightingAttributes() {
  this.process((doc) => {
    for (const listingBlock of doc.findBy({ context: 'listing' })) {
      const attributes = listingBlock.getAttributes();

      // Iterate through all attributes of the listing block
      for (let key in attributes) {
        if (key.startsWith('lines')) {
            if (attributes.role) {
              listingBlock.setAttribute('role', attributes.role + ' ' + `${key}-${attributes[key]}`);
            } else {
              listingBlock.setAttribute('role', `${key}-${attributes[key]} line-numbers`);
            }
        }
      }
    }
  });
}

function register(registry, { file }) {
  registry.treeProcessor(addLineNumbersAndCodeHighlightingAttributes)
}

module.exports.register = register;