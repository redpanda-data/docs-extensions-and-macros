/**
 * Frontmatter Parser for MCP Prompts
 *
 * Parses YAML frontmatter from markdown files to extract metadata.
 * Supports validation against JSON schemas.
 */

const yaml = require('js-yaml');

/**
 * Parse frontmatter from markdown content
 * @param {string} content - Markdown content with optional frontmatter
 * @returns {{ metadata: Object, content: string }} Parsed frontmatter and remaining content
 */
function parseFrontmatter(content) {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    // No frontmatter found - return empty metadata and full content
    return {
      metadata: {},
      content: content
    };
  }

  try {
    const metadata = yaml.load(match[1]) || {};
    const remainingContent = match[2];

    return {
      metadata,
      content: remainingContent
    };
  } catch (err) {
    throw new Error(`Failed to parse YAML frontmatter: ${err.message}`);
  }
}

/**
 * JSON Schema for prompt frontmatter
 */
const promptFrontmatterSchema = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      minLength: 10,
      description: 'Description of what this prompt does'
    },
    version: {
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+$',
      description: 'Semantic version (for example, 1.0.0)'
    },
    arguments: {
      type: 'array',
      description: 'Arguments this prompt accepts',
      items: {
        type: 'object',
        required: ['name', 'description', 'required'],
        properties: {
          name: {
            type: 'string',
            pattern: '^[a-z_][a-z0-9_]*$',
            description: 'Argument name (lowercase, underscores allowed)'
          },
          description: {
            type: 'string',
            minLength: 5,
            description: 'What this argument is for'
          },
          required: {
            type: 'boolean',
            description: 'Whether this argument is required'
          }
        },
        additionalProperties: false
      }
    },
    argumentFormat: {
      type: 'string',
      enum: ['content-append', 'structured'],
      description: 'How to format arguments when building the prompt'
    }
  },
  additionalProperties: false
};

/**
 * Validate frontmatter against schema
 * @param {Object} metadata - Parsed frontmatter metadata
 * @param {string} filename - File name (for error messages)
 * @param {Object} schema - JSON schema to validate against
 * @throws {Error} If validation fails
 */
function validateFrontmatter(metadata, filename, schema = promptFrontmatterSchema) {
  const Ajv = require('ajv');
  const ajv = new Ajv({ allErrors: true });

  const valid = ajv.validate(schema, metadata);

  if (!valid) {
    const errors = ajv.errors.map(err => {
      const path = err.instancePath || 'root';
      return `  - ${path}: ${err.message}`;
    }).join('\n');

    throw new Error(`Invalid frontmatter in ${filename}:\n${errors}`);
  }
}

/**
 * Parse and validate prompt file
 * @param {string} content - File content
 * @param {string} filename - File name
 * @returns {{ metadata: Object, content: string }} Validated metadata and content
 */
function parsePromptFile(content, filename) {
  const { metadata, content: promptContent } = parseFrontmatter(content);

  // If metadata exists, validate it
  if (Object.keys(metadata).length > 0) {
    validateFrontmatter(metadata, filename);
  }

  return {
    metadata,
    content: promptContent
  };
}

module.exports = {
  parseFrontmatter,
  parsePromptFile,
  validateFrontmatter,
  promptFrontmatterSchema
};
