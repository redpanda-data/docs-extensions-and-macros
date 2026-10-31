'use strict'

/* Old names in check-reference-values: a macro or a prose span that names
 * something by an alias, a former name, or a deprecated name, where the data
 * names what to write instead.
 *
 *   alias (status alias, a warning)  an rpk command written with an alias
 *       (rpk cluster status for rpk cluster info), or a Connect component
 *       written with a name its page now aliases (outputs/kafka_migrator for
 *       outputs/redpanda_migrator). The macros render and link these
 *       correctly, so they never fail the build; the docs still write the
 *       main name.
 *   deprecated (status reference, a warning)  the existing reference
 *       warnings (deprecated-command, deprecated-component, deprecated-field,
 *       deprecated-function, deprecated-method), now also for macros, with
 *       the replacement when the data names one.
 *
 * Both fail only at --fail-on any or links. --write rewrites one when the
 * finding is writable: the data names one replacement, it has the
 * equivalent of everything else in the call (a flag, a field), and the line
 * is not about the name itself (SENTENCE_ABOUT_NAME_RX: "is an alias of",
 * "deprecated", "use X instead", "migrate from"), where a rewrite would say
 * something else. The render guard then checks that the line renders as
 * before, with only the written text's rendering replaced by the proposed
 * text's (render-check.js).
 */

const STATUS = 'alias'

// A line that talks about the name: rewriting it would change what it says.
const SENTENCE_ABOUT_NAME_RX = /\b(?:alias(?:es|ed)?|deprecat\w*|replac\w*|instead|migrat\w*|formerly|renamed|rename|legacy|no\s+longer|in\s+favou?r\s+of|supersede\w*|successor|previous(?:ly)?|old(?:er)?\s+name)\b/i

/**
 * Whether a finding on this line may be written, and the note when it may
 * not.
 *
 * @returns {{writable: boolean, note?: string}}
 */
function lineAllowsRewrite (line) {
  if (SENTENCE_ABOUT_NAME_RX.test(line)) return { writable: false, note: 'the line is about the name itself, so --write leaves it; change it by hand' }
  return { writable: true }
}

/**
 * Counts of the old-name findings, for the report: aliases, and deprecated
 * names by reason, with how many are writable.
 */
function nameCounts (findings) {
  const out = { aliases: 0, deprecatedNames: 0, namesWritable: 0, namesApplied: 0 }
  for (const f of findings) {
    if (f.check !== 'name') continue
    if (f.status === STATUS) out.aliases++
    else out.deprecatedNames++
    if (f.writable) out.namesWritable++
    if (f.applied) out.namesApplied++
  }
  return out
}

module.exports = { STATUS, SENTENCE_ABOUT_NAME_RX, lineAllowsRewrite, nameCounts }
