'use strict'

/**
 * Git credential helper environment
 *
 * Every doc-tools code path that clones or fetches a private Redpanda repo
 * with the git CLI needs the same thing: hand git a GitHub token without the
 * token ever becoming visible outside the process. This module is the single
 * implementation of that.
 *
 * The token travels through a per-invocation credential helper registered
 * with GIT_CONFIG_* environment variables, so:
 *
 * - It is never a `git -c` argument or part of the remote URL, so it cannot
 *   be read out of argv (`ps`, /proc/<pid>/cmdline) for the length of a
 *   multi-minute clone, and git cannot echo it back in an error message.
 * - It is never written into the clone's .git/config, where it would sit
 *   readable on disk for every later step that reads the checkout.
 * - Nothing goes through a shell the caller has to quote for.
 *
 * Use getGitHubToken() from ./github-token to resolve the token, then pass
 * the result here. Pair it with redactCredentials() on any git stderr that
 * reaches an Error message or a CI log.
 */

// The variable the helper reads the token from at callback time. Only the
// name appears in the (static, secret-free) helper command string.
const TOKEN_ENV_VAR = 'DOC_TOOLS_GIT_CREDENTIAL_TOKEN'

/**
 * Environment for a git subprocess that must authenticate to github.com.
 *
 * With no token, `baseEnv` is returned unchanged rather than half-configured:
 * git then falls back to the host's own credential helpers, which is what a
 * local run relies on and all a public repo needs. Callers that require a
 * token should check for one and fail with their own message first.
 *
 * The helper is scoped to `credential.https://github.com.helper`, so no other
 * host is ever offered the token, and entry 0 clears inherited helpers so a
 * system credential manager cannot intercept (or prompt) before ours answers.
 * Any GIT_CONFIG_* entries already in `baseEnv` are replaced.
 *
 * @param {string|null|undefined} token - GitHub token, or falsy for no auth
 * @param {NodeJS.ProcessEnv} [baseEnv=process.env] - Environment to extend
 * @returns {NodeJS.ProcessEnv} Environment to pass as a spawn/exec `env`
 */
function gitAuthEnv(token, baseEnv = process.env) {
  if (!token) return baseEnv
  return {
    ...baseEnv,
    [TOKEN_ENV_VAR]: token,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: `!f() { echo "username=x-access-token"; echo "password=$${TOKEN_ENV_VAR}"; }; f`
  }
}

/**
 * Strip anything credential-shaped out of text before it is surfaced
 * anywhere that gets logged -- an Error message ends up in plain CI logs.
 *
 * Covers a credential in a remote URL's userinfo (https://<token>@github.com/...),
 * which git echoes back verbatim on common failures (a private repo it cannot
 * see, a bad ref), and a Basic-auth header in case git ever echoes failing
 * config back. Defense in depth: gitAuthEnv() already keeps the token out of
 * argv and URLs, so this covers credentials that came from somewhere else,
 * such as a URL the caller was handed.
 *
 * @param {string} text - Text to scrub (nullish becomes '')
 * @returns {string} Text with credentials replaced by ***
 */
function redactCredentials(text) {
  return String(text || '')
    .replace(/\/\/[^/@\s]+@/g, '//***@')
    .replace(/(authorization:\s*basic\s+)\S+/gi, '$1***')
}

module.exports = {
  gitAuthEnv,
  redactCredentials,
  TOKEN_ENV_VAR
}
