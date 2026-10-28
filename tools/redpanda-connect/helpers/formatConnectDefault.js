'use strict';

/**
 * How the Connect field reference prints a field's type and default.
 *
 * Shared by renderConnectFields (the *Type*: and *Default*: lines of every
 * component page) and the connectval: macro, so a value written with the
 * macro is always the value the reference shows. Changing either function
 * changes both.
 */

/**
 * The *Type*: text of a field: `array<string>`, `object`, `array<array<string>>`.
 *
 * @param {Object} field - One entry of a component's config children.
 * @returns {string}
 */
function connectDisplayType(field) {
  const isArrayTitle = typeof field.name === 'string' && field.name.endsWith('[]');
  if (isArrayTitle) return 'array<object>';
  // Maps always render as `object`, regardless of value type.
  if (field.kind === 'map') return 'object';
  if (field.kind === 'array' || field.kind === 'list' || field.kind === '2darray') {
    // Arrays render as `array<element>` when the element type is known,
    // for example `array<string>`. 2D arrays nest the element type, for
    // example `array<array<string>>`. Unknown element types render as
    // plain `array`. A `type` of `array` (used by some overrides to force
    // the old plain-array display) is treated as unknown so the field
    // renders as `array` rather than the degenerate `array<array>`.
    const elementType = (typeof field.type === 'string' && field.type !== '' && field.type !== 'unknown' && field.type !== 'array')
      ? field.type
      : null;
    if (!elementType) return 'array';
    return field.kind === '2darray' ? `array<array<${elementType}>>` : `array<${elementType}>`;
  }
  return field.type;
}

/**
 * The inline *Default*: text for a default value, or undefined when the
 * reference prints it as a YAML block instead (any non-empty object or array,
 * and null).
 *
 * @param {*} value - A field's default, which must be present.
 * @returns {string|undefined}
 */
function inlineConnectDefault(value) {
  if (Array.isArray(value) && value.length === 0) return '[]';
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return '{}';
  if (typeof value === 'object') return undefined;
  if (typeof value === 'string') {
    if (value.startsWith('"') && value.endsWith('"')) return value;
    return value === '' ? '""' : value;
  }
  return String(value);
}

/**
 * A field's default as the reference prints it inline, for connectval:.
 *
 * @param {Object} field
 * @returns {{ok: true, text: string} | {ok: false, reason: 'missing'|'complex'|'imprecise'}}
 *   missing: no default (or null, which the macro cannot state); complex: the
 *   reference prints a YAML block; imprecise: an integer JavaScript cannot
 *   represent exactly.
 */
function formatConnectDefault(field) {
  if (!field || !Object.prototype.hasOwnProperty.call(field, 'default') || field.default === undefined || field.default === null) {
    return { ok: false, reason: 'missing' };
  }
  const value = field.default;
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return { ok: false, reason: 'imprecise' };
  }
  const text = inlineConnectDefault(value);
  if (text === undefined) return { ok: false, reason: 'complex' };
  return { ok: true, text };
}

module.exports = formatConnectDefault;
module.exports.formatConnectDefault = formatConnectDefault;
module.exports.connectDisplayType = connectDisplayType;
module.exports.inlineConnectDefault = inlineConnectDefault;
