/**
 * Formats units for display based on property name suffix
 * @param {string} name - Property name that might contain unit suffixes
 * @returns {string} Formatted unit description
 */
module.exports = function formatUnits(name) {
  const suffixToUnit = {
    'ms': 'milliseconds',
    'sec': 'seconds',
    'seconds': 'seconds',
    'bytes': 'bytes',
    'buf': 'bytes',
    'partitions': 'number of partitions per topic',
    'percent': 'percent',
    'bps': 'bytes per second',
    'fraction': 'fraction'
  };

  if (!name) return '';

  // Extract the last part after splitting on underscores (like Python implementation)
  const parts = name.split('_');
  const suffix = parts[parts.length - 1];
  
  return suffixToUnit[suffix] || '';
};
