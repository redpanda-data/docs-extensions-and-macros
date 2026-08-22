'use strict';

const anchorName = require('./anchorName.js');

// Strip every separator so `redpanda.storage.mode.impl`, `redpanda-storage-mode-impl`
// and `redpandastoragemodeimpl` all collapse to one key.
function squash(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Repair intra-page anchors (`<<anchor,text>>`) that name a property but use the
 * wrong ID shape.
 *
 * Descriptions come from three places -- Redpanda's own doc strings, the
 * overrides file, and hand-edits -- and each has at some point written a
 * property anchor by deleting the dots (`<<redpandastoragemodeimpl>>`) or by
 * hyphenating only part of the name (`<<redpandastorage-mode>>`). Asciidoctor
 * derives the real heading ID from the heading text, so those render as links to
 * nothing. Rather than hand-correct each one and wait for the next author to
 * reintroduce it, resolve any anchor that unambiguously names a known property
 * back to that property's real anchor.
 *
 * Only rewrites when the anchor is not already correct and the match is
 * unambiguous, so an anchor pointing at a genuine non-property section is left
 * alone. Names from different scopes can collide once separators are gone --
 * `retention.bytes` and `retention_bytes` both squash to `retentionbytes` -- so
 * a collision is resolved in favour of the scope the referring property is in,
 * which is where a cross-reference nearly always points, and refused outright if
 * that still leaves two candidates.
 *
 * @param {string} text - AsciiDoc source that may contain `<<anchor,label>>` references.
 * @param {Iterable<string>|Object<string, Object>} properties - Known property names, or the property map.
 * @param {string} [scope] - config_scope of the property that owns this text.
 * @returns {{text: string, rewrites: Array<{from: string, to: string}>}}
 */
function normalizePropertyAnchors(text, properties, scope) {
  if (typeof text !== 'string' || !text.includes('<<')) {
    return { text, rewrites: [] };
  }

  const isMap = properties && !Array.isArray(properties) && typeof properties === 'object'
    && !(typeof properties[Symbol.iterator] === 'function');
  const names = isMap ? Object.keys(properties) : Array.from(properties || []);
  const scopeOf = (name) => (isMap && properties[name] ? properties[name].config_scope : undefined);

  const bySquashed = new Map();
  const validAnchors = new Set();
  for (const name of names) {
    if (typeof name !== 'string' || !name) continue;
    let anchor;
    try {
      anchor = anchorName(name);
    } catch {
      continue;
    }
    validAnchors.add(anchor);
    const key = squash(name);
    const entry = bySquashed.get(key);
    if (entry) entry.push({ anchor, scope: scopeOf(name) });
    else bySquashed.set(key, [{ anchor, scope: scopeOf(name) }]);
  }

  const resolve = (key) => {
    const candidates = bySquashed.get(key);
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].anchor;
    const sameScope = scope ? candidates.filter((c) => c.scope === scope) : [];
    return sameScope.length === 1 ? sameScope[0].anchor : null;
  };

  const rewrites = [];
  const rewritten = text.replace(/<<([^<>,\]]+?)(,|>>)/g, (match, anchor, tail) => {
    const trimmed = anchor.trim();
    if (validAnchors.has(trimmed)) return match;
    const target = resolve(squash(trimmed));
    if (!target || target === trimmed) return match;
    rewrites.push({ from: trimmed, to: target });
    return `<<${target}${tail}`;
  });

  return { text: rewritten, rewrites };
}

module.exports = normalizePropertyAnchors;
module.exports.squash = squash;
