const yaml = require('yaml');

/**
 * Renders the children of a configuration object into Markdown (nested heading format).
 *
 * @param {Array<Object>} children - An array of child objects.
 * @param {string} [prefix=''] - The prefix path for nested fields.
 * @param {number} [level=2] - The heading level (2-6).
 * @returns {string} The rendered markdown containing the configuration details.
 */
function renderMarkdownFieldsNested(children, prefix = '', level = 2) {
  if (!children || !Array.isArray(children) || children.length === 0) {
    return '';
  }

  const sorted = [...children].sort((a, b) => {
    const an = a.name || '';
    const bn = b.name || '';
    return an.localeCompare(bn, undefined, { sensitivity: 'base' });
  });

  let output = '';
  prefix = typeof prefix === 'string' ? prefix : '';

  sorted.forEach(child => {
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
    const currentPath = prefix
      ? `${prefix}.${nameWithArray}`
      : `${nameWithArray}`;

    // Create heading
    const headingLevel = Math.min(Math.max(level, 2), 6); // Clamp between 2 and 6
    const headingMarker = '#'.repeat(headingLevel);
    output += `${headingMarker} \`${currentPath}\`\n\n`;

    // Description
    let desc = child.description || '';
    if (child.is_beta) {
      desc = '**Beta**: ' + desc.replace(/^\s*BETA:\s*/i, '');
    }

    if (child.interpolated === true) {
      const interpolationNotice = '_This field supports [interpolation functions](xref:configuration:interpolation.adoc#bloblang-queries)._';
      const descLower = desc.toLowerCase();
      if (!descLower.includes('interpolation')) {
        desc = desc.trim() + (desc.trim() ? '\n\n' : '') + interpolationNotice;
      }
    }

    if (desc) {
      output += `${desc}\n\n`;
    }

    if (child.is_secret) {
      output += `> **Warning**: This field contains sensitive data. Do not expose this value in logs or unsecured locations.\n\n`;
    }

    if (child.version) {
      output += `_Requires version ${child.version} or later._\n\n`;
    }

    // Type
    output += `**Type**: \`${displayType}\`\n\n`;

    // Default value
    if (child.default !== undefined) {
      if (Array.isArray(child.default) && child.default.length === 0) {
        output += `**Default**: \`[]\`\n\n`;
      } else if (
        child.default !== null &&
        typeof child.default === 'object' &&
        !Array.isArray(child.default) &&
        Object.keys(child.default).length === 0
      ) {
        output += `**Default**: \`{}\`\n\n`;
      } else if (typeof child.default === 'string') {
        output += `**Default**: \`"${child.default}"\`\n\n`;
      } else if (typeof child.default === 'number' || typeof child.default === 'boolean') {
        output += `**Default**: \`${child.default}\`\n\n`;
      } else if (child.default === null) {
        output += `**Default**: \`null\`\n\n`;
      } else {
        try {
          const yamlStr = yaml.stringify(child.default).trim();
          output += `**Default**:\n\n\`\`\`yaml\n${yamlStr}\n\`\`\`\n\n`;
        } catch (err) {
          output += `**Default**: \`${JSON.stringify(child.default)}\`\n\n`;
        }
      }
    }

    // Enum/Options
    if (child.annotated_options && Array.isArray(child.annotated_options) && child.annotated_options.length > 0) {
      output += `**Options**:\n\n`;
      child.annotated_options.forEach(([optValue, optDesc]) => {
        const cleanDesc = (optDesc || '').replace(/\n/g, ' ').trim();
        output += `- \`${optValue}\``;
        if (cleanDesc) {
          output += `: ${cleanDesc}`;
        }
        output += `\n`;
      });
      output += `\n`;
    }

    // Advanced fields notice
    if (child.advanced) {
      output += `_Advanced field (optional)._\n\n`;
    }

    // Recurse for children
    if (child.children && Array.isArray(child.children) && child.children.length > 0) {
      output += renderMarkdownFieldsNested(child.children, currentPath, headingLevel + 1);
    }
  });

  return output;
}

module.exports = renderMarkdownFieldsNested;
