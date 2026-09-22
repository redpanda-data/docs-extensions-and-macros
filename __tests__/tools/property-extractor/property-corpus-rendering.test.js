'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const asciidoctor = require('@asciidoctor/core')();

const generate = require('../../../tools/property-extractor/generate-handlebars-docs');
const applyPropertyLinks = require('../../../tools/property-extractor/helpers/applyPropertyLinks');
const { findGluedConditionals } = require('../../../tools/property-extractor/helpers/audienceScope');
const classify = require('../../../tools/overrides-audit/classify');

// The real overrides file from the docs repo and a reduced snapshot of the real
// extracted properties, not hand-written fixtures. A fixture passes while the
// live 438-entry corpus breaks, and it cannot tell you whether a Cloud link
// points at a property Cloud actually publishes -- cloud_supported in the
// snapshot is what makes that assertion real.
const CORPUS_DIR = path.join(__dirname, '..', '..', 'docs-data');
const OVERRIDES = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'property-overrides.json'), 'utf8'));
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'property-snapshot.json'), 'utf8'));

/**
 * Build the property map the generator consumes, the way the Python stage does:
 * override fields land on the extracted property, and an override key with no
 * extracted property becomes a stub whose scope comes from config_scope or,
 * failing that, from whether the name is dotted.
 */
function buildCorpus (overridesDoc) {
  const properties = {};
  for (const [name, snap] of Object.entries(SNAPSHOT.properties)) {
    properties[name] = { ...snap, name };
  }
  for (const [name, override] of Object.entries(overridesDoc.properties)) {
    const existing = properties[name];
    const base = existing || {
      name,
      config_scope: override.config_scope || (name.includes('.') ? 'topic' : 'cluster'),
      type: 'string',
    };
    const merged = { ...base, name };
    for (const field of ['description', 'links', 'includes', 'admonitions', 'related_topics', 'see_also', 'example', 'category', 'version']) {
      if (override[field] !== undefined) merged[field] = override[field];
    }
    // property_extractor.py's _process_example_override joins an example array
    // into a string before the generator runs, so the attachment JSON the
    // generator actually reads carries strings (97 of them, no arrays). Mirror
    // that here: handing the template an array would collapse the YAML block
    // onto one comma-joined line, which is a harness artefact, not a real
    // failure mode.
    if (Array.isArray(merged.example)) merged.example = merged.example.join('\n');
    if (override.config_scope !== undefined) merged.config_scope = override.config_scope;
    if (override.accepted_values !== undefined) merged.enum = override.accepted_values;
    properties[name] = merged;
  }
  return properties;
}

/**
 * Render the four partials the way the generator actually does.
 *
 * Through generateAllDocs, not generatePropertyPartials: the link pass, the
 * description flattening and the config_ref rewrite all live in generateAllDocs,
 * so calling the inner function skips them. This test file did exactly that at
 * first, and every assertion about links and conditionals was passing against
 * partials that had neither applied.
 */
function renderPartials (properties) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-corpus-'));
  const inputFile = path.join(dir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ properties }));
  const quiet = ['log', 'warn', 'error'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
  const previous = { gen: process.env.GENERATE_PARTIALS, out: process.env.OUTPUT_PARTIALS_DIR };
  process.env.GENERATE_PARTIALS = '1';
  process.env.OUTPUT_PARTIALS_DIR = dir;
  try {
    generate.generateAllDocs(inputFile, dir);
  } finally {
    for (const [key, value] of [['GENERATE_PARTIALS', previous.gen], ['OUTPUT_PARTIALS_DIR', previous.out]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    quiet.forEach((s) => s.mockRestore());
  }
  const out = {};
  for (const file of fs.readdirSync(path.join(dir, 'properties'))) {
    out[file] = fs.readFileSync(path.join(dir, 'properties', file), 'utf8');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

/**
 * The prose region of each property entry: everything between the `=== name`
 * heading and the attribute table. That is where description text, declared
 * links and admonitions land, and it is the only region this feature emits
 * conditionals into. The table rows have carried their own `ifdef::env-cloud`
 * shape since long before this, with their own spacing rules.
 */
function proseRegions (adoc) {
  const regions = [];
  const lines = adoc.split('\n');
  let current = null;
  for (const line of lines) {
    const heading = /^=== (.+)$/.exec(line);
    if (heading) {
      current = { name: heading[1].trim(), lines: [] };
      regions.push(current);
      continue;
    }
    if (!current) continue;
    if (/^\[cols=/.test(line)) {
      current = null;
      continue;
    }
    current.lines.push(line);
  }
  return regions;
}

function render (adoc, { cloud }) {
  return asciidoctor.convert(adoc, {
    attributes: cloud ? { 'env-cloud': '' } : {},
    safe: 'safe',
  });
}

/** The text of every rendered paragraph, in document order. */
function paragraphs (html) {
  return [...html.matchAll(/<div class="paragraph">\s*<p>([\s\S]*?)<\/p>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
}

const partials = renderPartials(buildCorpus(OVERRIDES));
const PARTIAL_NAMES = Object.keys(partials);

describe('live overrides corpus', () => {
  it('renders every property partial', () => {
    expect(PARTIAL_NAMES).toEqual(
      expect.arrayContaining([
        'broker-properties.adoc',
        'cluster-properties.adoc',
        'object-storage-properties.adoc',
        'topic-properties.adoc',
      ])
    );
    expect(Object.keys(OVERRIDES.properties).length).toBeGreaterThan(400);
    expect(Object.keys(SNAPSHOT.properties).length).toBeGreaterThan(600);
  });

  describe.each(PARTIAL_NAMES)('%s', (file) => {
    const adoc = () => partials[file];

    it('leaks no preprocessor directive into either build', () => {
      for (const cloud of [true, false]) {
        const html = render(adoc(), { cloud });
        expect(html).not.toMatch(/ifdef::/);
        expect(html).not.toMatch(/ifndef::/);
        expect(html).not.toMatch(/endif::/);
      }
    });

    it('separates every prose conditional with a blank line on both sides', () => {
      const offenders = [];
      for (const region of proseRegions(adoc())) {
        for (const glued of findGluedConditionals(region.lines.join('\n'))) {
          offenders.push(`${region.name}: ${glued.directive} has "${glued.neighbour}" ${glued.side} it`);
        }
      }
      // Without the blank lines the preprocessor leaves the neighbouring lines
      // adjacent and Asciidoctor merges them into one paragraph. This is the
      // only check that sees the symmetric case, where both builds merge and so
      // the two renders agree with each other while both being wrong.
      expect(offenders).toEqual([]);
    });

    it('renders every example as a real block, never a comma-joined line', () => {
      // property.hbs renders the example with a bare {{{example}}}, so handing
      // it an array instead of a string makes Handlebars stringify it with
      // commas and the whole YAML block collapses onto one line. The rendered
      // page is the only place that shows up.
      for (const cloud of [true, false]) {
        const html = render(adoc(), { cloud });
        const collapsed = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)]
          .map((m) => m[1])
          .filter((block) => /\[,yaml\],----,|,----,|----,,/.test(block));
        expect(collapsed).toEqual([]);
        expect(html).not.toMatch(/\[,yaml\],----/);
      }
    });

    it('never merges paragraphs in one build that are separate in the other', () => {
      const cloud = paragraphs(render(adoc(), { cloud: true }));
      const self = paragraphs(render(adoc(), { cloud: false }));
      const merged = [];
      const check = (from, other) => {
        const otherSet = new Set(other);
        for (const paragraph of from) {
          if (!paragraph.includes('\n')) continue;
          const pieces = paragraph.split('\n').map((s) => s.trim()).filter(Boolean);
          if (pieces.length > 1 && pieces.every((piece) => otherSet.has(piece))) {
            merged.push(paragraph);
          }
        }
      };
      check(cloud, self);
      check(self, cloud);
      // This is the only assertion that can see a glued conditional. Nothing
      // errors and no text goes missing; the paragraphs just run together.
      expect(merged).toEqual([]);
    });
  });
});

describe('declared includes and glossary terms over the live corpus', () => {
  it('emits one include:: directive per declared include', () => {
    const declared = Object.values(OVERRIDES.properties)
      .filter((o) => o && o.includes)
      .reduce((n, o) => n + o.includes.length, 0);
    const emitted = PARTIAL_NAMES.reduce(
      (n, f) => n + (partials[f].match(/^include::/gm) || []).length,
      0
    );
    // Written into the description string these were markup the overrides audit
    // could not separate from the prose. As data they have to still reach the
    // page, in the same place.
    expect(emitted).toBe(declared);
  });

  it('gives every include:: its own line, with a blank line before it', () => {
    // A directive that is not at line start publishes as literal text, and one
    // glued to the prose above it lands inside that paragraph.
    for (const file of PARTIAL_NAMES) {
      const lines = partials[file].split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('include::')) return;
        expect(line).toMatch(/^include::/);
        expect(i === 0 || lines[i - 1].trim() === '' || /^if(n?)def::/.test(lines[i - 1].trim())).toBe(true);
      });
    }
  });

  it('emits a glossterm macro for every declared glossary term', () => {
    const declared = Object.values(OVERRIDES.properties)
      .filter((o) => o && o.links)
      .reduce((n, o) => n + Object.values(o.links).filter((t) => /(^|:\s*)glossterm/.test(t)).length, 0);
    const emitted = PARTIAL_NAMES.reduce(
      (n, f) => n + (partials[f].match(/glossterm:[^[]+\[\]/g) || []).length,
      0
    );
    expect(emitted).toBeGreaterThanOrEqual(declared);
  });

  it('leaves no description carrying docs-only markup', () => {
    // The point of links, includes, admonitions and the description array: with
    // the structure in its own fields, every description is prose the overrides
    // audit can compare against the C++ doc string, so none of them is pinned
    // as a permanent override any more.
    const offenders = [];
    for (const [name, o] of Object.entries(OVERRIDES.properties)) {
      if (!o || typeof o !== 'object') continue;
      const { prose } = classify.unconditionalProse(o.description);
      if (!prose) continue;
      const kinds = classify.detectDocsMarkup(prose, []);
      if (kinds.length) offenders.push(`${name}: ${kinds.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('declared links over the live corpus', () => {
  it('applies every declared link and leaves none unmatched', () => {
    const corpus = buildCorpus(OVERRIDES);
    // A links-only override (no description of its own) targets the
    // property's real extracted description, which the snapshot deliberately
    // excludes -- see the corpus refresh instructions in README.adoc, "a full
    // copy would be 695 KB of text that rots." This harness has no ground
    // truth for that case, so it is excluded from both the count and the
    // unmatched assertion below: asserting on it would be testing this
    // harness's own gap, not whether the real generator applies the link.
    // The real generator always has the extracted description, so this never
    // widens what actually ships unlinked.
    const hasDescription = (name) => typeof corpus[name]?.description === 'string';
    const declared = Object.entries(OVERRIDES.properties)
      .filter(([name, o]) => o.links && hasDescription(name))
      .reduce((n, [, o]) => n + Object.keys(o.links).length, 0);

    const result = applyPropertyLinks(corpus);
    const unmatched = result.unmatched.filter(({ property }) => hasDescription(property));

    // A link key that matches no prose is silent link rot: the override looks
    // maintained and the rendered page has no link.
    expect(unmatched).toEqual([]);
    // "First occurrence" is per surface, not per property, so a key naming a
    // property in both the description and an example bullet links in both.
    // That is what the pre-#1965 pages did: advertised_kafka_api carried the
    // `kafka_api` anchor in its sentence and again in its example.
    expect(result.applied).toBeGreaterThanOrEqual(declared);
  });

  it('never links a Cloud-published property to one Cloud cannot reach', () => {
    // This filter must match applyPropertyLinks.js's actual wording
    // ("which Cloud cannot reach"), or it silently matches nothing and this
    // assertion can never fail regardless of what warnings.js says. The
    // blanket "reports no other link warnings" test below would still
    // catch a real cross-audience warning, so this was a naming defect,
    // not a coverage gap -- but a filter that can never match is worth
    // fixing on sight.
    const result = applyPropertyLinks(buildCorpus(OVERRIDES));
    const crossAudience = result.warnings.filter((w) => /which Cloud cannot reach/.test(w));
    // Such a link renders as plain code in the Cloud build and makes the prop
    // macro warn on every build. The fix is a self-managed-only: prefix.
    expect(crossAudience).toEqual([]);
  });

  it('reports no other link warnings', () => {
    const result = applyPropertyLinks(buildCorpus(OVERRIDES));
    expect(result.warnings).toEqual([]);
  });
});
