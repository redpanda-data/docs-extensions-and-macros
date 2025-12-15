/**
 * Prompt Discovery and Caching
 *
 * Automatically discovers prompts from the mcp/prompts directory.
 * Caches prompt content and metadata for performance.
 * Supports file watching in development mode.
 */

const fs = require('fs');
const path = require('path');
const { parsePromptFile, validateFrontmatter } = require('./frontmatter');
const { validatePromptName } = require('./mcp-validation');

/**
 * In-memory prompt cache
 */
class PromptCache {
  constructor() {
    this.prompts = new Map(); // name -> { metadata, content, filePath }
    this.watchers = [];
  }

  /**
   * Set prompt in cache
   * @param {string} name - Prompt name
   * @param {Object} data - Prompt data
   */
  set(name, data) {
    this.prompts.set(name, data);
  }

  /**
   * Get prompt from cache
   * @param {string} name - Prompt name
   * @returns {Object|null} Prompt data or null
   */
  get(name) {
    return this.prompts.get(name) || null;
  }

  /**
   * Get all prompts
   * @returns {Array} Array of prompt objects
   */
  getAll() {
    return Array.from(this.prompts.values());
  }

  /**
   * Get all prompt names
   * @returns {Array} Array of prompt names
   */
  getNames() {
    return Array.from(this.prompts.keys());
  }

  /**
   * Check if prompt exists
   * @param {string} name - Prompt name
   * @returns {boolean}
   */
  has(name) {
    return this.prompts.has(name);
  }

  /**
   * Clear all prompts
   */
  clear() {
    this.prompts.clear();
  }

  /**
   * Stop all file watchers
   */
  stopWatching() {
    this.watchers.forEach(watcher => watcher.close());
    this.watchers = [];
  }

  /**
   * Add a file watcher
   * @param {FSWatcher} watcher - File system watcher
   */
  addWatcher(watcher) {
    this.watchers.push(watcher);
  }
}

/**
 * Default argument formatters for different types
 */
const argumentFormatters = {
  'content-append': (args, schema) => {
    if (!args) return '';

    let result = '\n\n---\n\n';

    // If there's a 'content' argument, add it specially
    if (args.content) {
      result += `**Content to review:**\n\n${args.content}`;
      return result;
    }

    // Otherwise, format all arguments
    Object.entries(args).forEach(([key, value]) => {
      const argDef = schema?.find(a => a.name === key);
      const label = argDef?.name || key;
      result += `**${label.charAt(0).toUpperCase() + label.slice(1)}:** ${value}\n`;
    });

    return result;
  },

  'structured': (args, schema) => {
    if (!args) return '';

    let result = '\n\n---\n\n';
    Object.entries(args).forEach(([key, value]) => {
      result += `**${key}:** ${value}\n`;
    });

    return result;
  }
};

/**
 * Discover all prompts in the prompts directory
 * @param {string} promptsDir - Path to prompts directory
 * @returns {Array} Array of discovered prompts
 */
function discoverPrompts(promptsDir) {
  if (!fs.existsSync(promptsDir)) {
    throw new Error(`Prompts directory not found: ${promptsDir}`);
  }

  const files = fs.readdirSync(promptsDir).filter(f => f.endsWith('.md'));
  const prompts = [];

  for (const file of files) {
    try {
      const name = path.basename(file, '.md');
      validatePromptName(name); // Ensure safe name

      const filePath = path.join(promptsDir, file);
      const fileContent = fs.readFileSync(filePath, 'utf8');

      const { metadata, content } = parsePromptFile(fileContent, file);

      // Build prompt object
      const prompt = {
        name,
        description: metadata.description || `Prompt: ${name}`,
        version: metadata.version || '1.0.0',
        arguments: metadata.arguments || [],
        argumentFormat: metadata.argumentFormat || 'content-append',
        content,
        filePath,
        _rawMetadata: metadata
      };

      prompts.push(prompt);
    } catch (err) {
      console.error(`Error loading prompt ${file}: ${err.message}`);
      // Continue loading other prompts
    }
  }

  return prompts;
}

/**
 * Load all prompts into cache
 * @param {string} baseDir - Base directory (repo root)
 * @param {PromptCache} cache - Prompt cache instance
 * @returns {Array} Loaded prompts
 */
function loadAllPrompts(baseDir, cache) {
  const promptsDir = path.join(baseDir, 'mcp', 'prompts');
  const prompts = discoverPrompts(promptsDir);

  // Clear and reload cache
  cache.clear();

  prompts.forEach(prompt => {
    cache.set(prompt.name, prompt);
  });

  return prompts;
}

/**
 * Watch prompts directory for changes (development mode)
 * @param {string} baseDir - Base directory
 * @param {PromptCache} cache - Prompt cache instance
 * @param {Function} onChange - Callback when prompts change
 */
function watchPrompts(baseDir, cache, onChange) {
  const promptsDir = path.join(baseDir, 'mcp', 'prompts');

  if (!fs.existsSync(promptsDir)) {
    console.error(`Cannot watch prompts directory (not found): ${promptsDir}`);
    return;
  }

  const watcher = fs.watch(promptsDir, (eventType, filename) => {
    if (!filename || !filename.endsWith('.md')) {
      return;
    }

    console.error(`Prompt file changed: ${filename} (${eventType})`);
    console.error('Reloading all prompts...');

    try {
      const prompts = loadAllPrompts(baseDir, cache);
      console.error(`Reloaded ${prompts.length} prompts`);

      if (onChange) {
        onChange(prompts);
      }
    } catch (err) {
      console.error(`Error reloading prompts: ${err.message}`);
    }
  });

  cache.addWatcher(watcher);
  console.error('File watching enabled for prompts (dev mode)');
}

/**
 * Build prompt text with arguments
 * @param {Object} prompt - Prompt object from cache
 * @param {Object} args - Arguments provided by user
 * @returns {string} Complete prompt text
 */
function buildPromptWithArguments(prompt, args) {
  let promptText = prompt.content;

  if (!args || Object.keys(args).length === 0) {
    return promptText;
  }

  // Use the formatter specified by the prompt
  const formatter = argumentFormatters[prompt.argumentFormat];
  if (!formatter) {
    console.error(
      `Unknown argument format: ${prompt.argumentFormat} for prompt ${prompt.name}`
    );
    return promptText;
  }

  const formattedArgs = formatter(args, prompt.arguments);
  promptText += formattedArgs;

  return promptText;
}

/**
 * Convert prompts to MCP protocol format
 * @param {Array} prompts - Discovered prompts
 * @returns {Array} Prompts in MCP format
 */
function promptsToMcpFormat(prompts) {
  return prompts.map(prompt => ({
    name: prompt.name,
    description: prompt.description,
    arguments: prompt.arguments.map(arg => ({
      name: arg.name,
      description: arg.description,
      required: arg.required
    }))
  }));
}

module.exports = {
  PromptCache,
  discoverPrompts,
  loadAllPrompts,
  watchPrompts,
  buildPromptWithArguments,
  promptsToMcpFormat,
  argumentFormatters
};
