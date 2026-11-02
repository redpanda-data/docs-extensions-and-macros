function addLineNumbersAndCodeHighlightingAttributes() {
  this.process((doc) => {
    for (const listingBlock of doc.findBy({ context: 'listing' })) {
      const attributes = listingBlock.getAttributes();

      // Iterate through all attributes of the listing block
      for (let key in attributes) {
        if (key.startsWith('lines')) {
          let newRoleValue = `${key}-${attributes[key]}`;

          if (attributes.role) {
            if (!attributes.role.includes('line-numbers')) {
              newRoleValue += ' line-numbers';
            }
            listingBlock.setAttribute('role', attributes.role + ' ' + newRoleValue);
          } else {
            newRoleValue += ' line-numbers';
            listingBlock.setAttribute('role', newRoleValue);
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