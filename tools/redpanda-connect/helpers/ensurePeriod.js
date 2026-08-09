/**
 * Ensures a text string ends with a period (or other terminal punctuation).
 * Used for normalizing Bloblang descriptions.
 *
 * @param {string} text - The text to process
 * @returns {string} Text ending with appropriate punctuation
 */
function ensurePeriod(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }

  // Check if already ends with terminal punctuation
  if (trimmed.endsWith('.') || trimmed.endsWith('!') || trimmed.endsWith('?')) {
    return text;
  }

  // Add period
  return text.trim() + '.';
}

module.exports = ensurePeriod;
