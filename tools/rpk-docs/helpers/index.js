'use strict'

/**
 * Handlebars helpers for rpk documentation generation
 */

/**
 * Convert string to dash-separated format
 * @param {string} str - Input string
 * @returns {string} Dashified string
 */
function dashify(str) {
  if (!str) return ''
  return str.replace(/\s+/g, '-')
}

/**
 * Ensure string ends with a period
 * @param {string} str - Input string
 * @returns {string} String ending with period
 */
function ensurePeriod(str) {
  if (!str) return ''
  const trimmed = str.trim()
  if (!trimmed) return ''
  if (/[.!?]$/.test(trimmed)) return trimmed
  return trimmed + '.'
}

/**
 * Cap description to two sentences
 * @param {string} str - Full description
 * @returns {string} Shortened description
 */
function shortDescription(str) {
  if (!str) return ''
  if (typeof str !== 'string') return String(str)

  // Normalize newlines to spaces for inline use
  const singleLine = str.replace(/\s*\n+\s*/g, ' ').trim()

  const abbrevs = ['e.g.', 'i.e.', 'etc.', 'vs.']
  let normalized = singleLine
  const placeholders = []

  for (const abbrev of abbrevs) {
    const regex = new RegExp(abbrev.replace(/\./g, '\\.'), 'gi')
    normalized = normalized.replace(regex, match => {
      const ph = `__ABBREV${placeholders.length}__`
      placeholders.push({ ph, original: match })
      return ph
    })
  }

  const sentences = normalized.match(/[^.!?]+[.!?]+(?:\s|$)/g)
  if (!sentences || sentences.length === 0) {
    let result = normalized
    placeholders.forEach(({ ph, original }) => {
      result = result.replace(ph, original)
    })
    return result.trim()
  }

  let result = sentences.slice(0, 2).join('')
  placeholders.forEach(({ ph, original }) => {
    result = result.replace(ph, original)
  })

  return result.trim()
}

/**
 * Get flag type display value
 * @param {Object} flag - Flag object
 * @returns {string} Type string
 */
function flagType(flag) {
  if (!flag) return '-'
  return flag.type || '-'
}

/**
 * Check equality
 * @param {*} a - First value
 * @param {*} b - Second value
 * @returns {boolean}
 */
function eq(a, b) {
  return a === b
}

/**
 * Check inequality
 * @param {*} a - First value
 * @param {*} b - Second value
 * @returns {boolean}
 */
function ne(a, b) {
  return a !== b
}

/**
 * Logical OR (for any number of arguments)
 * @param {...*} args - Values to OR (last arg is Handlebars options)
 * @returns {boolean}
 */
function or(...args) {
  // Remove Handlebars options object (last argument)
  const values = args.slice(0, -1)
  return values.some(Boolean)
}

/**
 * Logical AND
 * @param {...*} args - Values to AND (last arg is Handlebars options)
 * @returns {boolean}
 */
function and(...args) {
  const values = args.slice(0, -1)
  return values.every(Boolean)
}

/**
 * Logical NOT
 * @param {*} value - Value to negate
 * @returns {boolean}
 */
function not(value) {
  return !value
}

/**
 * Join array elements
 * @param {Array} arr - Array to join
 * @param {string} sep - Separator
 * @returns {string}
 */
function join(arr, sep) {
  if (!Array.isArray(arr)) return arr
  return arr.join(sep)
}

/**
 * Get array length
 * @param {Array} arr - Array
 * @returns {number}
 */
function length(arr) {
  if (!arr) return 0
  if (Array.isArray(arr)) return arr.length
  if (typeof arr === 'string') return arr.length
  return 0
}

/**
 * Check if value is greater than
 * @param {number} a - First value
 * @param {number} b - Second value
 * @returns {boolean}
 */
function gt(a, b) {
  return a > b
}

/**
 * Check if value is less than
 * @param {number} a - First value
 * @param {number} b - Second value
 * @returns {boolean}
 */
function lt(a, b) {
  return a < b
}

/**
 * Check if value is in array
 * @param {*} value - Value to find
 * @param {Array} arr - Array to search
 * @returns {boolean}
 */
function includes(value, arr) {
  if (!Array.isArray(arr)) return false
  return arr.includes(value)
}

/**
 * Convert to uppercase
 * @param {string} str - Input string
 * @returns {string}
 */
function uppercase(str) {
  if (!str) return ''
  return str.toUpperCase()
}

/**
 * Convert to lowercase
 * @param {string} str - Input string
 * @returns {string}
 */
function lowercase(str) {
  if (!str) return ''
  return str.toLowerCase()
}

/**
 * Capitalize first letter
 * @param {string} str - Input string
 * @returns {string}
 */
function capitalize(str) {
  if (!str) return ''
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * Convert to sentence case (capitalize first letter of each sentence)
 * @param {string} str - Input string
 * @returns {string}
 */
function toSentenceCase(str) {
  if (!str) return ''
  return str.replace(/(^\s*\w|[.!?]\s*\w)/g, c => c.toUpperCase())
}

/**
 * Format flag name with dashes
 * @param {Object} flag - Flag object
 * @returns {string} Formatted flag name
 */
function formatFlagName(flag) {
  if (!flag) return ''
  if (flag.shorthand) {
    return `-${flag.shorthand}, --${flag.name}`
  }
  return `--${flag.name}`
}

/**
 * Format default value for display
 * @param {*} value - Default value
 * @param {string} type - Value type
 * @returns {string}
 */
function formatDefault(value, type) {
  if (value === undefined || value === null) return ''
  if (value === '') return '""'
  if (type === 'bool' || type === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${value.join(', ')}]`
  }
  return String(value)
}

/**
 * Check if flag has a default value worth showing
 * @param {Object} flag - Flag object
 * @returns {boolean}
 */
function hasDefaultValue(flag) {
  if (!flag) return false
  const value = flag.default
  if (value === undefined || value === null) return false
  if (value === '' || value === false) return false
  if (Array.isArray(value) && value.length === 0) return false
  return true
}

/**
 * Get parent command path
 * @param {string} commandPath - Full command path
 * @returns {string} Parent path
 */
function parentPath(commandPath) {
  if (!commandPath) return ''
  const parts = commandPath.split(' ')
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join(' ')
}

/**
 * Check if command is a plugin command
 * @param {string} commandPath - Full command path
 * @param {Object} pluginVersions - Plugin versions map
 * @returns {boolean}
 */
function isPluginCommand(commandPath, pluginVersions) {
  if (!commandPath || !pluginVersions) return false
  const parts = commandPath.split(' ')
  if (parts.length < 2) return false
  return !!pluginVersions[parts[1]]
}

/**
 * Convert ALL CAPS section name to title case for display
 * @param {string} name - ALL CAPS section name
 * @returns {string} Title case name
 */
function sectionTitle(name) {
  if (!name) return ''

  // Acronyms that should remain ALL CAPS
  const acronyms = new Set([
    'id', 'ip', 'api', 'url', 'uri', 'cpu', 'gpu', 'ram', 'io',
    'tls', 'ssl', 'mtls', 'sasl', 'oauth', 'oidc', 'jwt',
    'json', 'yaml', 'xml', 'csv', 'http', 'https', 'grpc', 'rpc',
    'aws', 'gcp', 'azure', 's3', 'eos'
  ])

  // Product names that should be title cased
  const properNouns = new Set([
    'redpanda', 'kafka', 'kubernetes', 'schema', 'registry'
  ])

  // Split on spaces/hyphens but keep & as its own token
  // "PRODUCER ID & EPOCH" -> ["producer", "id", "&", "epoch"]
  const words = name.toLowerCase().split(/[\s-]+/)

  return words.map((word, index) => {
    // Preserve ampersand as-is
    if (word === '&') {
      return '&'
    }

    // Handle words with slashes (e.g., "enabled/disabled")
    if (word.includes('/')) {
      const parts = word.split('/')
      return parts.map((part, partIndex) => {
        if (acronyms.has(part)) {
          return part.toUpperCase()
        }
        if (index === 0 && partIndex === 0) {
          return part.charAt(0).toUpperCase() + part.slice(1)
        }
        if (properNouns.has(part)) {
          return part.charAt(0).toUpperCase() + part.slice(1)
        }
        return part
      }).join('/')
    }

    // Acronyms: ALL CAPS
    if (acronyms.has(word)) {
      return word.toUpperCase()
    }

    // First word: always capitalize
    if (index === 0) {
      return word.charAt(0).toUpperCase() + word.slice(1)
    }

    // Proper nouns: capitalize
    if (properNouns.has(word)) {
      return word.charAt(0).toUpperCase() + word.slice(1)
    }

    // All other words in title: capitalize (standard title case)
    return word.charAt(0).toUpperCase() + word.slice(1)
  }).join(' ')
}

/**
 * Add two numbers
 * @param {number} a - First number
 * @param {number} b - Second number
 * @returns {number} Sum
 */
function add(a, b) {
  return (a || 0) + (b || 0)
}

/**
 * Return first truthy value or default
 * @param {*} value - Value to check
 * @param {*} defaultValue - Default if value is falsy
 * @returns {*} Value or default
 */
function defaultHelper(value, defaultValue) {
  return value !== undefined && value !== null ? value : defaultValue
}

/**
 * Repeat a string n times (used for generating heading levels)
 * @param {number} n - Number of repetitions
 * @param {Object} options - Handlebars options
 * @returns {string} Repeated content
 */
function repeat(n, options) {
  if (!n || n <= 0) return ''
  let result = ''
  for (let i = 0; i < n; i++) {
    result += options.fn(this)
  }
  return result
}

/**
 * Escape pipe characters for use in AsciiDoc table cells
 * @param {string} str - Input string
 * @returns {string} String with escaped pipes
 */
function escapePipes(str) {
  if (!str) return ''
  // Escape literal pipe characters that would break AsciiDoc tables
  // Use {vbar} which is an AsciiDoc attribute for the pipe character
  return str.replace(/\|/g, '{vbar}')
}

/**
 * Wrap description in pass:q[] if it contains inline AsciiDoc formatting
 * This is needed for :description: attributes to properly render backticks
 * @param {string} str - Input string
 * @returns {string} String wrapped in pass:q[] if contains formatting
 */
function wrapDescriptionPassthrough(str) {
  if (!str) return ''
  // Check if contains backticks (inline code) or other formatting markers
  if (/`/.test(str)) {
    return `pass:q[${str}]`
  }
  return str
}

module.exports = {
  dashify,
  ensurePeriod,
  shortDescription,
  flagType,
  eq,
  ne,
  or,
  and,
  not,
  join,
  length,
  gt,
  lt,
  includes,
  uppercase,
  lowercase,
  capitalize,
  toSentenceCase,
  formatFlagName,
  formatDefault,
  hasDefaultValue,
  parentPath,
  isPluginCommand,
  sectionTitle,
  add,
  repeat,
  default: defaultHelper,
  escapePipes,
  wrapDescriptionPassthrough,
  isObject: (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
}
