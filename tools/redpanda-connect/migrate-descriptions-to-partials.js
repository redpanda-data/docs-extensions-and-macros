'use strict';

/**
 * One-time migration that makes published connector pages consume the
 * regenerated description partial.
 *
 * Connector reference pages are one-time first drafts: the summary, the
 * "Introduced in version" line and the description prose were frozen into
 * `modules/components/pages/<type>/<name>.adoc` when the page was drafted, and
 * nothing has refreshed them since. The generator now writes the same content
 * to `modules/components/partials/descriptions/<type>/<name>.adoc` on every
 * run, with two tag regions. This script rewires existing pages to it:
 *
 *   header: include::...[tag=attrs]  inside the page's `// tag::meta[]` region
 *   body:   include::...[tag=body]   where the frozen prose is today
 *
 * The header rewire is mechanical and safe: it swaps one `:description:` line
 * for an include that sets the same attribute from the partial.
 *
 * The body rewire is a rewrite of published prose, so it is guarded. The page's
 * intro region is only replaced when every non-blank line of it also appears in
 * the partial's body region. Pages whose intro carries anything the partial does
 * not reproduce (hand-added prose, a hand-written config listing, an extra
 * admonition) are reported and left alone for a human, because migrating them
 * would silently delete published content.
 *
 * Usage (run from the docs repo root, after a generator run so the partials
 * exist):
 *   npx doc-tools generate migrate-rpcn-descriptions             # dry run
 *   npx doc-tools generate migrate-rpcn-descriptions --write     # apply
 *   npx doc-tools generate migrate-rpcn-descriptions --skip-body # headers only
 */

const fs = require('fs');
const path = require('path');
const { descriptionIncludeLine, normalizeTypeDir, flattenToAttributeValue } = require('./metadata-utils.js');

// The page's meta tag region: the block single-source stubs inherit
// :description: from, so the attrs include belongs inside it.
const META_TAG_OPEN = /^\/\/\s*tag::meta\[\]\s*$/;
const META_TAG_CLOSE = /^\/\/\s*end::meta\[\]\s*$/;

// The intro region starts after the component-type dropdown macro, which every
// connector page carries directly below its header.
const INTRO_START = /^component_type_dropdown::\[\]\s*$/;

// ...and ends at the first structural element after it. `include::` covers the
// metadata, fields and examples partials; `[tabs]` covers the generated config
// listing; `== ` covers the first real section. Fenced code blocks are
// deliberately NOT terminators: a hand-written config listing inside the intro
// has to stay inside the region so the content check below sees it and refuses.
const INTRO_END = /^(?:==\s+\S|include::|\[tabs\]|\/\/\s*end::single-source)/;

/** Index of the intro anchor, or the end of the file when there is none. */
function introOf (lines) {
  const at = lines.findIndex((l) => INTRO_START.test(l));
  return at === -1 ? lines.length : at;
}

/** Extract the lines of one tag region from a partial. */
function tagRegion (partial, tag) {
  const lines = partial.split('\n');
  const open = lines.findIndex((l) => new RegExp(`^//\\s*tag::${tag}\\[\\]\\s*$`).test(l));
  if (open === -1) return null;
  const close = lines.findIndex((l, i) => i > open && new RegExp(`^//\\s*end::${tag}\\[\\]\\s*$`).test(l));
  if (close === -1) return null;
  return lines.slice(open + 1, close);
}

/** Lines that carry content: blanks and AsciiDoc comments do not count. */
function contentLines (lines) {
  return lines.map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('//'));
}

/**
 * True when the partial's body region reproduces every content line of the
 * page's intro region. This is the guard that keeps the migration from
 * deleting published prose the generator does not know about.
 */
function bodyCoversIntro (introLines, bodyLines) {
  const body = new Set(contentLines(bodyLines));
  return contentLines(introLines).every((l) => body.has(l));
}

/**
 * Migrate published connector pages onto the regenerated description partial.
 * @param {object} [options]
 * @param {boolean} [options.write=false] Apply changes (otherwise dry run).
 * @param {boolean} [options.skipBody=false] Only rewire page headers.
 * @param {string} [options.pagesRoot]
 * @param {string} [options.partialsRoot]
 * @returns {{headers:string[], bodies:string[], skipped:Array<{page:string, reason:string}>}}
 */
function migrateDescriptionsToPartials ({
  write = false,
  skipBody = false,
  pagesRoot,
  partialsRoot,
} = {}) {
  const pages = pagesRoot || path.resolve(process.cwd(), 'modules/components/pages');
  const partials = partialsRoot || path.resolve(process.cwd(), 'modules/components/partials/descriptions');
  const results = { headers: [], bodies: [], skipped: [] };
  if (!fs.existsSync(pages)) return results;

  for (const typeDirName of fs.readdirSync(pages).sort()) {
    const typeDirPath = path.join(pages, typeDirName);
    if (!fs.statSync(typeDirPath).isDirectory()) continue;
    // The pages directory and the partials directory can spell a component
    // family differently (pages/rate_limits vs the rate-limits data key), so
    // resolve the partial through the same normalizer the generator writes
    // with rather than by string equality.
    const partialTypeDir = normalizeTypeDir(typeDirName);

    for (const file of fs.readdirSync(typeDirPath).sort()) {
      if (!file.endsWith('.adoc')) continue;
      const name = file.slice(0, -'.adoc'.length);
      const key = `${typeDirName}/${name}`;
      const pagePath = path.join(typeDirPath, file);
      const partialPath = path.join(partials, partialTypeDir, file);

      if (!fs.existsSync(partialPath)) {
        results.skipped.push({ page: key, reason: 'no generated description partial' });
        continue;
      }
      const partial = fs.readFileSync(partialPath, 'utf8');
      const attrs = tagRegion(partial, 'attrs');
      const body = tagRegion(partial, 'body');
      if (!attrs || !body || contentLines(body).length === 0) {
        // A blanked partial (description removed upstream) has both regions
        // but no content. Wiring a page to it would publish an empty page.
        results.skipped.push({ page: key, reason: 'description partial is empty' });
        continue;
      }

      const includeAttrs = descriptionIncludeLine({ typeDir: partialTypeDir, name }, 'attrs');
      const includeBody = descriptionIncludeLine({ typeDir: partialTypeDir, name }, 'body');

      let lines = fs.readFileSync(pagePath, 'utf8').split('\n');
      let changed = false;

      // --- header ---------------------------------------------------------
      if (!lines.some((l) => l.trim() === includeAttrs)) {
        const open = lines.findIndex((l) => META_TAG_OPEN.test(l));
        const close = lines.findIndex((l, i) => i > open && META_TAG_CLOSE.test(l));
        const attrValue = contentLines(attrs)
          .find((l) => l.startsWith(':description:'));
        const pageAttr = lines.slice(0, introOf(lines)).find((l) => l.startsWith(':description:'));
        if (!attrValue) {
          // The connector has no summary, so the attrs region sets nothing.
          // Replacing a hand-written :description: with it would drop the
          // page's meta description.
          results.skipped.push({ page: key, reason: 'attrs region sets no :description:' });
        } else if (pageAttr && flattenToAttributeValue(pageAttr) !== flattenToAttributeValue(attrValue)) {
          // The page's meta description is not the connector summary, so it
          // was authored by hand (often tuned for search) and swapping in the
          // include would silently discard that editorial work. 13 pages in
          // rp-connect-docs are in this state. A human decides these: either
          // move the wording upstream into the summary, or leave the page
          // header alone.
          results.skipped.push({ page: key, reason: 'hand-authored :description: differs from the summary (needs a human)' });
        } else if (open !== -1 && close > open) {
          lines.splice(open + 1, close - open - 1, includeAttrs);
          results.headers.push(key);
          changed = true;
        } else {
          // Header = everything above the dropdown macro, not "up to the
          // first blank line": a handful of pages carry a blank line inside
          // their attribute list, which is how they ended up with two
          // :description: lines in the first place.
          const attrLine = lines.findIndex((l) => l.startsWith(':description:'));
          if (attrLine !== -1 && attrLine < introOf(lines)) {
            lines.splice(attrLine, 1, '// tag::meta[]', includeAttrs, '// end::meta[]');
            results.headers.push(key);
            changed = true;
          } else {
            results.skipped.push({ page: key, reason: 'no header :description: to replace' });
          }
        }
      }

      // A handful of pages carry a blank line inside their header, so the
      // page-header backfill inserted its meta block above a `:description:`
      // it could not see and the page ended up with two. AsciiDoc takes the
      // last assignment, so leaving the literal one there would make the
      // include a no-op and the page would keep publishing frozen text.
      if (lines.some((l) => l.trim() === includeAttrs)) {
        for (let i = introOf(lines) - 1; i >= 0; i--) {
          if (lines[i].startsWith(':description:')) {
            lines.splice(i, 1);
            changed = true;
          }
        }
      }

      // --- body -----------------------------------------------------------
      if (!skipBody && !lines.some((l) => l.trim() === includeBody)) {
        const start = lines.findIndex((l) => INTRO_START.test(l));
        if (start === -1) {
          results.skipped.push({ page: key, reason: 'no component_type_dropdown to anchor the intro' });
        } else {
          let end = lines.length;
          for (let i = start + 1; i < lines.length; i++) {
            if (INTRO_END.test(lines[i])) { end = i; break; }
          }
          const intro = lines.slice(start + 1, end);
          if (contentLines(intro).length === 0) {
            results.skipped.push({ page: key, reason: 'intro region is empty' });
          } else if (!bodyCoversIntro(intro, body)) {
            results.skipped.push({
              page: key,
              reason: 'intro prose is not reproduced by the partial (needs a human)',
            });
          } else {
            // The page's own metadata include is emitted by the partial body
            // too, so consume it rather than leaving a duplicate behind.
            let tail = end;
            const metaInclude = `include::connect:components:partial$metadata/${partialTypeDir}/${name}.adoc[]`;
            if (lines[tail] && lines[tail].trim() === metaInclude &&
                contentLines(body).includes(metaInclude)) {
              tail++;
            }
            // Some pages carry the rest of the description BELOW the generated
            // config listing, so replacing the intro alone would leave the
            // include and the surviving prose both rendering it. Measured on
            // caches/redpanda, where an Antora build reported the same xref
            // twice after the naive rewrite. Anything outside the region that
            // the partial body also renders means the description is split
            // across the page, which a human has to untangle.
            const outside = contentLines(lines.slice(0, start + 1).concat(lines.slice(tail)));
            const inBody = new Set(contentLines(body));
            if (outside.some((l) => inBody.has(l))) {
              results.skipped.push({
                page: key,
                reason: 'description prose continues past the config listing (needs a human)',
              });
            } else {
              lines.splice(start + 1, tail - start - 1, '', includeBody, '');
              results.bodies.push(key);
              changed = true;
            }
          }
        }
      }

      if (changed) {
        console.log(`${write ? 'MIGRATE' : 'WOULD MIGRATE'}: ${key}`);
        if (write) fs.writeFileSync(pagePath, lines.join('\n'), 'utf8');
      }
    }
  }

  console.log(
    `\n${write ? 'Migrated' : 'Would migrate'} ${results.headers.length} page header(s) and ` +
    `${results.bodies.length} page body/bodies; ${results.skipped.length} left alone.`
  );
  const byReason = new Map();
  for (const s of results.skipped) byReason.set(s.reason, (byReason.get(s.reason) || 0) + 1);
  for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count} ${reason}`);
  }
  if (!write) console.log('Dry run only. Re-run with --write to apply.');

  return results;
}

module.exports = { migrateDescriptionsToPartials, tagRegion, bodyCoversIntro };

// Allow direct execution for local development; the supported entry point is
// `npx doc-tools generate migrate-rpcn-descriptions`.
if (require.main === module) {
  migrateDescriptionsToPartials({
    write: process.argv.includes('--write'),
    skipBody: process.argv.includes('--skip-body'),
  });
}
