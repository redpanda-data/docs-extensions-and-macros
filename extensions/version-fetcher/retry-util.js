/**
 * Retry utility with exponential backoff
 *
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retries (default: 3)
 * @param {number} options.initialDelay - Initial delay in ms (default: 1000)
 * @param {number} options.maxDelay - Maximum delay in ms (default: 10000)
 * @param {Function} options.shouldRetry - Function to determine if error is retryable (default: all errors)
 * @param {string} options.operationName - Name for logging
 * @returns {Promise<*>} Result of the function
 */
async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    shouldRetry = () => true,
    operationName = 'operation'
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if this is the last attempt or error is not retryable
      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const baseDelay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
      const jitter = Math.random() * 0.3 * baseDelay; // Add up to 30% jitter
      const delay = Math.floor(baseDelay + jitter);

      console.error(`⚠️  ${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}`);
      console.error(`   Retrying in ${delay}ms...`);

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Determine if a GitHub API error is retryable
 * @param {Error} error - The error to check
 * @returns {boolean} True if the error is retryable
 */
function isRetryableGitHubError(error) {
  // Retry on network errors
  if (error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'EAI_AGAIN') {
    return true;
  }

  // Retry on rate limit errors (though they should have a retry-after)
  if (error.status === 403 && error.message?.includes('rate limit')) {
    return true;
  }

  // Retry on 5xx server errors
  if (error.status >= 500 && error.status < 600) {
    return true;
  }

  // Retry on specific 4xx errors that might be transient
  if (error.status === 408 || // Request Timeout
      error.status === 429) {  // Too Many Requests
    return true;
  }

  // Don't retry on other errors (4xx client errors, auth issues, etc.)
  return false;
}

module.exports = {
  retryWithBackoff,
  isRetryableGitHubError
};
