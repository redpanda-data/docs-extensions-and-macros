/**
 * Renders the children of a configuration object into Markdown table format (flattened).
 *
 * @param {Array<Object>} children - An array of child objects.
 * @param {string} [prefix=''] - The prefix path for nested fields.
 * @returns {string} The rendered markdown table containing the configuration details.
 */
function renderMarkdownFieldsTable(children, prefix = '') {
  if (!children || !Array.isArray(children) || children.length === 0) {
    return '';
  }

  const rows = [];

  function collectFields(fieldsList, pathPrefix = '') {
    if (!Array.isArray(fieldsList)) return;

    fieldsList.forEach(child => {
      if (child.is_deprecated || !child.name) return;

      // Normalize types
      let displayType;
      const isArrayTitle = typeof child.name === 'string' && child.name.endsWith('[]');
      if (isArrayTitle) {
        displayType = 'array<object>';
      } else if (child.type === 'string' && child.kind === 'array') {
        displayType = 'array';
      } else if (child.type === 'unknown' && child.kind === 'map') {
        displayType = 'object';
      } else if (child.type === 'unknown' && child.kind === 'array') {
        displayType = 'array';
      } else if (child.type === 'unknown' && child.kind === 'list') {
        displayType = 'array';
      } else {
        displayType = child.type;
      }

      const isArray = child.kind === 'array';
      const nameWithArray = (typeof child.name === 'string' && isArray && !child.name.endsWith('[]'))
        ? `${child.name}[]`
        : child.name;
      const currentPath = pathPrefix
        ? `${pathPrefix}.${nameWithArray}`
        : `${nameWithArray}`;

      // Format default value for table
      let defaultValue = '';
      if (child.default !== undefined) {
        if (Array.isArray(child.default) && child.default.length === 0) {
          defaultValue = '`[]`';
        } else if (
          child.default !== null &&
          typeof child.default === 'object' &&
          !Array.isArray(child.default) &&
          Object.keys(child.default).length === 0
        ) {
          defaultValue = '`{}`';
        } else if (typeof child.default === 'string') {
          defaultValue = `\`"${child.default}"\``;
        } else if (typeof child.default === 'number' || typeof child.default === 'boolean') {
          defaultValue = `\`${child.default}\``;
        } else if (child.default === null) {
          defaultValue = '`null`';
        } else {
          defaultValue = '_(complex)_';
        }
      }

      // Clean description for table (remove newlines, keep it brief)
      let desc = (child.description || '').replace(/\n+/g, ' ').trim();
      if (desc.length > 150) {
        desc = desc.substring(0, 147) + '...';
      }

      // Add badges/notes inline
      const notes = [];
      if (child.is_beta) notes.push('**Beta**');
      if (child.is_secret) notes.push('**Secret**');
      if (child.interpolated) notes.push('_Interpolation supported_');
      if (child.advanced) notes.push('_Advanced_');
      if (child.version) notes.push(`_v${child.version}+_`);

      if (notes.length > 0) {
        desc = `${notes.join(', ')}. ${desc}`;
      }

      rows.push({
        field: `\`${currentPath}\``,
        type: `\`${displayType}\``,
        default: defaultValue || '-',
        description: desc || '-'
      });

      // Recurse for children
      if (child.children && Array.isArray(child.children) && child.children.length > 0) {
        collectFields(child.children, currentPath);
      }
    });
  }

  collectFields(children, prefix);

  if (rows.length === 0) return '';

  // Build markdown table
  let table = '| Field | Type | Default | Description |\n';
  table += '|-------|------|---------|-------------|\n';
  rows.forEach(row => {
    // Escape pipe characters in content
    const escapePipes = (str) => str.replace(/\|/g, '\\|');
    table += `| ${escapePipes(row.field)} | ${escapePipes(row.type)} | ${escapePipes(row.default)} | ${escapePipes(row.description)} |\n`;
  });

  return table;
}

module.exports = renderMarkdownFieldsTable;
