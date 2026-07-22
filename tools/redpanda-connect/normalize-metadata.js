'use strict';

/**
 * Normalize the formatting of an extracted `== Metadata` block so the generated
 * metadata partials are consistent regardless of how each connector authored
 * its metadata section upstream.
 *
 * Two inconsistencies are normalized:
 *   1. Some connectors wrap their field list in a fenced code block
 *      (```text ... ``` or ``` ... ```) of bare names; others use an AsciiDoc
 *      bullet list with the field name in inline code. We strip the fences
 *      around a field list and render the fields as a plain bullet list.
 *   2. Within a field bullet, the field name (a lowercase snake_case
 *      identifier) is wrapped in inline code. Descriptive bullets such as
 *      "All headers (only first values are taken)" are left as prose, and
 *      bullets that already contain inline code are left untouched.
 *
 * Everything else (intro sentences, notes, `===` subheadings that legitimately
 * group metadata by operation, and non-field-list fenced blocks) is preserved
 * verbatim.
 */

const FENCE_OPEN = /^(\s*)(```|~~~)(.*)$/;
const FENCE_CLOSE = /^(\s*)(```|~~~)\s*$/;
const BULLET = /^(\s*[-*]\s+)(.*)$/;
// A metadata field bullet: the leading token is a lowercase snake_case
// identifier (gcs_key, http_server_verb, header), optionally followed by a
// parenthetical annotation (for example "(RFC3339)"), and optionally a
// description separated by ":" or " - ". This distinguishes real field bullets
// from descriptive ones like "All headers ..." (which start with a capital).
// The description may itself contain inline code, so it is matched loosely.
const FIELD_BULLET = /^([a-z][a-z0-9_]*)((?:\s*\([^)]*\))?(?:\s*(?::|-)\s.*)?)$/s;

function normalizeBullet (prefix, content) {
  // Skip only when the field name itself is already inline-coded; a backtick
  // later in the description must not prevent coding the field name.
  if (content.startsWith('`')) return prefix + content;
  const m = content.match(FIELD_BULLET);
  if (!m) return prefix + content;                     // descriptive, leave as prose
  return `${prefix}\`${m[1]}\`${m[2]}`;                 // inline-code the field name
}

/** True when a fenced block's info string and content are a bare field list. */
function isFieldListFence (infoString, contentLines) {
  const info = infoString.trim();
  if (info !== '' && info !== 'text') return false;
  const nonBlank = contentLines.filter((l) => l.trim() !== '');
  return nonBlank.length > 0 && nonBlank.every((l) => BULLET.test(l));
}

/**
 * @param {string} block the extracted `== Metadata` block
 * @returns {string} the block with consistent field-list formatting
 */
function normalizeMetadataBlock (block) {
  if (!block || typeof block !== 'string') return block;
  const lines = block.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(FENCE_OPEN);
    if (fence) {
      // Collect the fenced content up to the closing fence.
      const content = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (FENCE_CLOSE.test(lines[j])) { closed = true; break; }
        content.push(lines[j]);
      }
      if (closed && isFieldListFence(fence[3], content)) {
        // Drop the fences and render the fields as a normal bullet list.
        for (const c of content) {
          const b = c.match(BULLET);
          out.push(b ? normalizeBullet(b[1], b[2]) : c);
        }
      } else {
        // Not a field list (e.g. a YAML example) — keep verbatim.
        out.push(lines[i]);
        for (const c of content) out.push(c);
        if (closed) out.push(lines[j]);
      }
      i = closed ? j : lines.length;
    } else {
      // Bare bullet outside a fence: normalize the field name too.
      const b = lines[i].match(BULLET);
      out.push(b ? normalizeBullet(b[1], b[2]) : lines[i]);
    }
  }

  return out.join('\n');
}

module.exports = { normalizeMetadataBlock };
