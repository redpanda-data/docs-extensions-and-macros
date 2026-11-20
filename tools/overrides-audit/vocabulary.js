'use strict'

/**
 * The words each audit surface uses for the thing it audits, so the shared
 * triage prompt and report read correctly for every surface.
 *
 * The default is the property wording, exactly as the prompt and report had
 * it before surfaces could differ. Rows from the properties and rpk surfaces
 * carry no surface, so their text does not change, and the pinned prompts
 * that were evaluated for them stay the prompts that run.
 */
const DEFAULT = {
  // "one <description> for a documentation team"
  description: 'property description',
  descriptions: 'property descriptions',
  // "reference docs for a <thing> named ..."
  thing: 'configuration property',
  // "for the same <short>", "of this <short>"
  short: 'property',
  // Extra guidance for the triage model, or ''.
  triageNote: ''
}

const SURFACES = {
  metrics: {
    description: 'metric description',
    descriptions: 'metric descriptions',
    thing: 'metric',
    short: 'metric',
    triageNote: 'In engineering source this description is the metric\'s help string. A help string takes no terminal period, so do not count a missing or extra terminal period for or against either text.\n\n'
  }
}

/**
 * @param {string} [surface] - A surface name, or nothing for the default.
 * @returns {Object} The vocabulary for that surface.
 */
function vocabulary (surface) {
  return SURFACES[surface] || DEFAULT
}

module.exports = { vocabulary, DEFAULT }
