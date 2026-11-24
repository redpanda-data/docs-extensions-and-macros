'use strict'

/**
 * Whether a macro call acknowledges that it names something deprecated:
 * `deprecated=ok`, as in `prop:cloud_topics_enabled[deprecated=ok]` or
 * `rpkcmd:[rpk redpanda admin,deprecated=ok]`.
 *
 * Every reference macro (prop:, propval:, rpkcmd:, rpkval:, connect:,
 * connectval:, blobl:, bloblval:) warns when it names a deprecated property,
 * command, component, field or Bloblang call, because a page that recommends
 * one is out of date. Some pages mention them on purpose: the deprecated
 * features page, release notes, upgrade and migration guides. On those, the
 * writer adds deprecated=ok, and the macro renders exactly as it would
 * without it, but drops the deprecation warning and never fails the build
 * because of the deprecation. Every other check still runs: an unknown name,
 * an alias, a missing page or a value the data does not have is reported as
 * usual.
 *
 * Only the exact value `ok` counts, so a typo such as deprecated=true is not
 * silently taken as an acknowledgement.
 *
 * @param {object} [attributes] - The macro's parsed attributes.
 * @returns {boolean}
 */
function deprecationAcknowledged (attributes) {
  if (!attributes) return false
  const value = attributes.deprecated
  return typeof value === 'string' && value.trim().toLowerCase() === 'ok'
}

module.exports = { deprecationAcknowledged }
