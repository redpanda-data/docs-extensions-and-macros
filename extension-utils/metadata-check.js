'use strict'

/**
 * The taxonomy metadata rules, in one place. `doc-tools check-metadata` runs
 * them on page headers in a PR, validate-attributes runs them on Product Docs
 * pages in the build, and solutions-catalog runs them on solution overviews,
 * so the PR check and the build can never disagree about a value.
 *
 * Rules (severity for a Product Docs page / a solution overview):
 *
 *   unknown-value       the value names no concept                 warning / error
 *   deprecated-value    the concept is deprecated                  warning / warning
 *   not-in-taxonomy     a legacy category taxonomy.yml lacks       warning / warning
 *   wrong-facet         a solution facet value from another facet  - / warning
 *   duplicate-concept   two values on the page are one concept     warning / error
 *
 * `:page-topic-type:` is checked against the content-type scheme, as a
 * warning only. Every message names the replacement when there is one.
 */

// Attributes the rules read, with the scheme a value must belong to (null:
// any scheme, as page-categories mixes topics, use cases, technologies, ...).
const CATEGORY_ATTRIBUTE = 'page-categories'
const TOPIC_TYPE_ATTRIBUTE = 'page-topic-type'
const SOLUTION_FACETS = Object.freeze({
  'page-solution-use-cases': 'use-case',
  'page-solution-industries': 'industry',
  'page-solution-technologies': 'technology',
  'page-solution-platforms': 'deployment',
})
const SOLUTION_LAYOUT = 'solution'

const SEVERITY = Object.freeze({
  'unknown-value': { docs: 'warning', solution: 'error' },
  'deprecated-value': { docs: 'warning', solution: 'warning' },
  'not-in-taxonomy': { docs: 'warning', solution: 'warning' },
  'wrong-facet': { docs: 'warning', solution: 'warning' },
  'duplicate-concept': { docs: 'warning', solution: 'error' },
  'unknown-topic-type': { docs: 'warning', solution: 'warning' },
})

/** Split a comma-separated attribute value. */
function splitValues (value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (value === undefined || value === null || value === true) return []
  return String(value).split(',').map((v) => v.trim()).filter(Boolean)
}

/** Is this the overview page of a solution? */
function isSolutionPage (attributes) {
  return Boolean(attributes) && attributes['page-layout'] === SOLUTION_LAYOUT
}

function labelsOf (taxonomy, ids) {
  return ids.map((id) => taxonomy.label(id))
}

function describe (taxonomy, id) {
  const concept = taxonomy.get(id)
  return concept ? `${concept.prefLabel} (${concept.scheme})` : id
}

/**
 * Check one page's taxonomy metadata.
 *
 * @param {Object} attributes - attribute name (without colons) -> value. Values
 *   are strings as AsciiDoc holds them, or arrays.
 * @param {Object} options
 * @param {import('./taxonomy').Taxonomy} options.taxonomy
 * @param {boolean} [options.solution] - a solution overview; default from page-layout
 * @param {(label: string) => boolean} [options.isLegacyCategory] - valid-categories.yml
 *   membership, so a legacy category the taxonomy lacks is a gap, not unknown
 * @returns {Array<{attribute: string, value: string, severity: string, rule: string, message: string, replacement: string|null, replacementIds: string[], conceptIds: string[]}>}
 */
function checkPageMetadata (attributes, { taxonomy, solution, isLegacyCategory } = {}) {
  const attrs = attributes || {}
  const kind = (solution === undefined ? isSolutionPage(attrs) : solution) ? 'solution' : 'docs'
  const findings = []
  const seen = new Map() // concept id -> { attribute, value }
  const push = (rule, attribute, value, message, { replacementIds = [], conceptIds = [] } = {}) => {
    findings.push({
      attribute,
      value,
      severity: SEVERITY[rule][kind],
      rule,
      message,
      replacement: replacementIds.length ? labelsOf(taxonomy, replacementIds).join(', ') : null,
      replacementIds,
      conceptIds,
    })
  }
  const noteConcepts = (attribute, value, ids) => {
    for (const id of ids) {
      const first = seen.get(id)
      if (first && !(first.attribute === attribute && first.value === value)) {
        push('duplicate-concept', attribute, value,
          `${attribute} value '${value}' is the same concept as ${first.attribute} value '${first.value}': ${describe(taxonomy, id)}. Keep one`,
          { conceptIds: [id] })
      } else if (!first) {
        seen.set(id, { attribute, value })
      }
    }
  }

  // page-categories: any scheme.
  for (const value of splitValues(attrs[CATEGORY_ATTRIBUTE])) {
    const hit = taxonomy.resolve(value)
    if (!hit) {
      if (isLegacyCategory && isLegacyCategory(value)) {
        push('not-in-taxonomy', CATEGORY_ATTRIBUTE, value, `${CATEGORY_ATTRIBUTE} value '${value}' is in valid-categories.yml but not in taxonomy.yml; add it to the taxonomy`)
      } else {
        push('unknown-value', CATEGORY_ATTRIBUTE, value, `${CATEGORY_ATTRIBUTE} value '${value}' is not in the taxonomy; use an existing label, or add a concept to taxonomy.yml`)
      }
      continue
    }
    if (hit.deprecated) {
      push('deprecated-value', CATEGORY_ATTRIBUTE, value, deprecatedMessage(CATEGORY_ATTRIBUTE, value, hit, taxonomy), { replacementIds: hit.ids, conceptIds: [hit.concept.id] })
    }
    noteConcepts(CATEGORY_ATTRIBUTE, value, hit.ids)
  }

  // Solution facets: each within its own scheme.
  if (kind === 'solution') {
    for (const [attribute, scheme] of Object.entries(SOLUTION_FACETS)) {
      const prefer = scheme === 'deployment' ? 'id' : 'label'
      for (const value of splitValues(attrs[attribute])) {
        const hit = taxonomy.resolve(value, { prefer })
        if (!hit) {
          push('unknown-value', attribute, value, `${attribute} value '${value}' is not in the taxonomy; use an existing ${scheme}, or add it to taxonomy.yml in the docs repository first`)
          continue
        }
        // Only replacements in this facet's scheme count: a deprecated topic
        // replaced by another topic says nothing about a technology, so it
        // must not be suggested here or collide with a category.
        const ids = hit.ids.filter((id) => taxonomy.get(id) && taxonomy.get(id).scheme === scheme)
        if (hit.deprecated && (ids.length || hit.concept.scheme === scheme)) {
          push('deprecated-value', attribute, value, deprecatedMessage(attribute, value, { ...hit, ids }, taxonomy), { replacementIds: ids, conceptIds: [hit.concept.id] })
        } else if (hit.concept.scheme !== scheme) {
          push('wrong-facet', attribute, value, `${attribute} value '${value}' is ${describe(taxonomy, hit.concept.id)}${hit.deprecated ? ', deprecated' : ''}, not a ${scheme}`, { conceptIds: [hit.concept.id] })
          continue
        }
        noteConcepts(attribute, value, ids)
      }
    }
  }

  // Content type: one value, warning only.
  const topicType = splitValues(attrs[TOPIC_TYPE_ATTRIBUTE])
  for (const value of topicType) {
    const hit = taxonomy.resolve(value, { schemes: ['content-type'], prefer: 'id' })
    if (!hit) {
      push('unknown-topic-type', TOPIC_TYPE_ATTRIBUTE, value, `${TOPIC_TYPE_ATTRIBUTE} '${value}' is not a content type in the taxonomy; use one of ${taxonomy.conceptIds('content-type').join(', ')}`)
    } else if (hit.deprecated) {
      push('deprecated-value', TOPIC_TYPE_ATTRIBUTE, value, deprecatedMessage(TOPIC_TYPE_ATTRIBUTE, value, hit, taxonomy), { replacementIds: hit.ids, conceptIds: [hit.concept.id] })
    } else if (hit.via !== 'id') {
      push('unknown-topic-type', TOPIC_TYPE_ATTRIBUTE, value, `${TOPIC_TYPE_ATTRIBUTE} '${value}' should be the ID ${hit.concept.id}`, { replacementIds: [hit.concept.id], conceptIds: [hit.concept.id] })
    }
  }

  return findings
}

function deprecatedMessage (attribute, value, hit, taxonomy) {
  const instead = hit.ids.length
    ? `use ${hit.ids.map((id) => `'${taxonomy.label(id)}'`).join(', ')} instead`
    : 'no single value replaces it; see its definition in taxonomy.yml and choose per page'
  return `${attribute} value '${value}' is deprecated; ${instead}`
}

module.exports = {
  CATEGORY_ATTRIBUTE,
  TOPIC_TYPE_ATTRIBUTE,
  SOLUTION_FACETS,
  SEVERITY,
  splitValues,
  isSolutionPage,
  checkPageMetadata,
}
