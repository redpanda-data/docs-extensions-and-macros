const handlebars = require('handlebars');

/**
 * Helper function to format a value (used in object/array formatting)
 */
function formatValue(val) {
  if (typeof val === 'string') {
    return `"${val}"`;
  } else if (typeof val === 'boolean') {
    return val ? 'true' : 'false';
  } else if (val === null || val === undefined) {
    return 'null';
  } else {
    return String(val);
  }
}

/**
 * Process C++ internal representations and convert them to user-friendly formats
 * This matches the Python process_defaults function logic
 */
function processDefaults(inputString, suffix) {
  if (typeof inputString !== 'string') {
    return inputString;
  }

  // Test for ip:port in vector: std::vector<net::unresolved_address>({{...}})
  const vectorMatch = inputString.match(/std::vector<net::unresolved_address>\(\{\{("([\d.]+)",\s*(\d+))\}\}\)/);
  if (vectorMatch) {
    const ip = vectorMatch[2];
    const port = vectorMatch[3];
    return [`${ip}:${port}`];
  }

  // Test for ip:port in single-string: net::unresolved_address("127.0.0.1", 9092)
  const brokerMatch = inputString.match(/net::unresolved_address\("([\d.]+)",\s*(\d+)\)/);
  if (brokerMatch) {
    const ip = brokerMatch[1];
    const port = brokerMatch[2];
    return `${ip}:${port}`;
  }

  // Handle std::nullopt
  if (inputString.includes('std::nullopt')) {
    return inputString.replace(/std::nullopt/g, 'null');
  }

  // Handle time units and other patterns would go here...
  // For now, return the original string
  return inputString;
}

/**
 * Formats a property value for display, matching Python legacy format exactly
 * @param {*} value - The value to format
 * @param {string} type - The property type
 * @returns {handlebars.SafeString} Formatted value
 */
module.exports = function formatPropertyValue(value, type) {
  if (value === null || value === undefined || value === '') {
    return new handlebars.SafeString('null');
  }

  if (typeof value === 'boolean') {
    return new handlebars.SafeString(value ? 'true' : 'false');
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    // Format object defaults with Python-style syntax: {key: "value", key2: value2}
    const pairs = [];
    for (const [k, v] of Object.entries(value)) {
      // Process each value for C++ representations
      let processedValue = v;
      if (typeof v === 'string') {
        processedValue = processDefaults(v, null);
      }
      pairs.push(`${k}: ${formatValue(processedValue)}`);
    }
    return new handlebars.SafeString(`{${pairs.join(', ')}}`);
  }

  if (Array.isArray(value)) {
    // Handle array defaults to match Python format
    if (value.length === 0) {
      return new handlebars.SafeString('[]');
    } else {
      // Format each array element
      const formattedElements = [];
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          // Format object within array
          const pairs = [];
          for (const [k, v] of Object.entries(item)) {
            // Process each value for C++ representations
            let processedValue = v;
            if (typeof v === 'string') {
              processedValue = processDefaults(v, null);
            }
            pairs.push(`${k}: ${formatValue(processedValue)}`);
          }
          formattedElements.push(`{${pairs.join(', ')}}`);
        } else {
          formattedElements.push(String(item));
        }
      }
      return new handlebars.SafeString(`[${formattedElements.join(', ')}]`);
    }
  }

  // For other types, convert to string and apply Python-style processing
  let result = String(value).replace(/'/g, '').toLowerCase();
  
  // Apply C++ processing
  result = processDefaults(result, null);
  
  return new handlebars.SafeString(result);
};
