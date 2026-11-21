'use strict'

/**
 * Whether a component version is past its end of life, decided the same way
 * the docs UI decides to show the "no longer supported" banner (docs-ui
 * src/helpers/is-eol.js):
 *
 * 1. page-is-past-eol, which the compute-end-of-life extension sets from
 *    page-release-date and the playbook's support window.
 * 2. page-eol, which an EOL branch can set in its antora.yml.
 * 3. Otherwise page-release-date plus page-support-months (default 12).
 *
 * @param {Object} attributes A component version's asciidoc.attributes.
 * @param {Date} [now] The current time, for tests.
 * @returns {boolean}
 */
module.exports = function isPastEol (attributes, now = new Date()) {
  if (!attributes || typeof attributes !== 'object') return false
  const isTrue = (value) => value === true || value === 'true'
  if (isTrue(attributes['page-is-past-eol'])) return true
  if (isTrue(attributes['page-eol'])) return true
  const releaseDate = attributes['page-release-date']
  if (!releaseDate) return false
  const release = new Date(releaseDate)
  if (isNaN(release.getTime())) return false
  const months = parseInt(attributes['page-support-months'], 10)
  const eol = new Date(release)
  eol.setMonth(eol.getMonth() + (isNaN(months) ? 12 : months))
  return now >= eol
}
