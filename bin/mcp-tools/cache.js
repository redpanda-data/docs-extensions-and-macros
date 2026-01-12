/**
 * Simple in-memory cache for MCP tools
 *
 * Reduces costs by caching expensive operations like:
 * - Style guide loading
 * - Antora structure scanning
 * - Static content that rarely changes
 */

const cache = new Map();

/**
 * Get a cached value
 * @param {string} key - Cache key
 * @returns {any|null} Cached value or null if not found/expired
 */
function get(key) {
  const entry = cache.get(key);
  if (!entry) return null;

  // Check if expired
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

/**
 * Set a cached value
 * @param {string} key - Cache key
 * @param {any} value - Value to cache
 * @param {number} ttl - Time to live in milliseconds (default: 1 hour)
 */
function set(key, value, ttl = 60 * 60 * 1000) {
  cache.set(key, {
    value,
    expiresAt: ttl ? Date.now() + ttl : null
  });
}

/**
 * Clear all cached values
 */
function clear() {
  cache.clear();
}

/**
 * Clear expired entries
 */
function prune() {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt && now > entry.expiresAt) {
      cache.delete(key);
    }
  }
}

/**
 * Get or compute a value (cache aside pattern)
 * @param {string} key - Cache key
 * @param {Function} compute - Function to compute value if not cached
 * @param {number} ttl - Time to live in milliseconds
 * @returns {Promise<any>} Cached or computed value
 */
async function getOrCompute(key, compute, ttl = 60 * 60 * 1000) {
  const cached = get(key);
  if (cached !== null) {
    return cached;
  }

  const value = await compute();
  set(key, value, ttl);
  return value;
}

// Prune expired entries every 5 minutes
// Use .unref() to allow Node.js to exit if this is the only remaining timer
setInterval(prune, 5 * 60 * 1000).unref();

module.exports = {
  get,
  set,
  clear,
  prune,
  getOrCompute
};
