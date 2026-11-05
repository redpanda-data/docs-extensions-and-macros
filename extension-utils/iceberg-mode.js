'use strict';

/**
 * Strict parser and formatter for the `redpanda.iceberg.mode` topic property,
 * for every Redpanda release that has it.
 *
 * This is a port of Redpanda's own parser, so a string this module accepts for
 * a release is one that release accepts, and from v26.2.1 (the first release
 * whose parser reports a reason) a string it rejects fails with the broker's
 * own error message. The upstream code lives in streaming-enterprise (private):
 *
 * - `parse_iceberg_mode`, `parse_extended_iceberg_mode`, `parse_section_opts`,
 *   `parse_legacy_schema_latest` and `iceberg_mode::format_to` in
 *   src/v/model/model.cc (`operator>>` and `parse_config_options` before
 *   v26.2.1)
 * - `value_config::is_legacy_compatible` in src/v/model/metadata.h
 * - the accept, reject, error-message and format cases in
 *   src/v/model/tests/iceberg_mode_test.cc, which the tests replay from
 *   __tests__/fixtures/iceberg-mode/upstream-vectors.js
 *
 * WHICH RELEASE ACCEPTS WHAT IS DATA, NOT CODE. iceberg-mode-releases.json is
 * generated from those sources at every release tag by
 * tools/iceberg-mode/generate.js, and a scheduled drift job fails when it
 * falls behind. It records, per release series, the legacy names the parser
 * compares against, whether value_schema_latest takes options, and whether
 * (and with which section, option and enum names) the section format exists.
 * This module reads those lists; nothing here names a release.
 *
 * What the data cannot express is the parser's structure: that subject needs
 * mode=schema_latest, say, or that layout belongs to the value section. That
 * is code below, so each distinct parser source carries a fingerprint, and
 * PORTED_PARSERS lists the ones this code was checked against. The tests fail
 * when the generated data names a parser that is not in it.
 *
 * Where upstream iterates a hash map (so which of several bad options it
 * reports is unspecified), this port reports the first one in source order.
 */

const RELEASES = require('./iceberg-mode-releases.json');

// Upstream parser sources (by fingerprint, see tools/iceberg-mode/upstream.js)
// that this port has been reviewed against, with the first tag of each. A new
// fingerprint means Redpanda changed its parser: compare the new model.cc with
// the code below, port any change, and add the fingerprint here.
const PORTED_PARSERS = {
  d655eb0a6c7b6f32bcae0e6a433b49db11418487624e384d3bccec470fa74d25: 'v24.3.1',
  '5455269040b60b1bd3116e589f47e51e32743c75e0a16a6097bae9023deadf2f': 'v25.1.1',
  ea6aabd8cbf190286bd166b9c7d96556051586d0d1428d318a5364145cf158ba: 'v26.2.1',
};

// What each legacy name means. The generated data says which names a release
// accepts; this says what they parse to.
const LEGACY_NAMES = {
  disabled: () => disabledMode(),
  key_value: () => defaultEnabled(),
  value_schema_id_prefix: () => {
    const m = defaultEnabled();
    m.value.mode = 'schema_id_prefix';
    return m;
  },
};

function defaultEnabled () {
  return {
    disabled: false,
    key: { mode: 'binary', subject: '', protobuf_name: '' },
    value: { mode: 'binary', subject: '', protobuf_name: '', layout: 'flat' },
    headers: { value_type: 'binary' },
  };
}

function disabledMode () {
  return { disabled: true };
}

function fail (error, reason) {
  return reason ? { ok: false, error, reason } : { ok: false, error };
}

function ok (mode, format) {
  return { ok: true, mode, format };
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

const TAG_RX = /^v(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/;
const tagParts = (tag) => {
  const m = TAG_RX.exec(tag);
  return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : null;
};
const compareTags = (a, b) => {
  const x = tagParts(a);
  const y = tagParts(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};
const isGa = (tag) => tagParts(tag)[3] === Infinity;

/**
 * Parse a docs component version ("26.2", "v26.1", "26.2.1") into its series.
 * Anything else (unversioned components, "master", "beta") returns null.
 * @param {string} version
 * @returns {{major: number, minor: number, patch: number|null}|null}
 */
function releaseSeries (version) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(version || '').trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: m[3] === undefined ? null : Number(m[3]) } : null;
}

const SERIES = Object.keys(RELEASES.series).sort((a, b) => {
  const [a1, a2] = a.split('.').map(Number);
  const [b1, b2] = b.split('.').map(Number);
  return (b1 - a1) || (b2 - a2);
});

/** A history entry plus its grammar. */
function withGrammar (series, entry) {
  return { series, since: entry.since, parser: entry.parser, clusterGate: entry.clusterGate, grammar: RELEASES.parsers[entry.parser] };
}

// The newest series with a GA release: what a page with no release series
// (Cloud, an unversioned component) documents, because Cloud runs released
// Redpanda.
const LATEST = (() => {
  for (const series of SERIES) {
    const history = RELEASES.series[series];
    const last = history[history.length - 1];
    if (last && isGa(last.since)) return withGrammar(series, last);
  }
  throw new Error('iceberg-mode-releases.json has no GA release');
})();

/**
 * The release whose grammar a docs version documents.
 *
 * - A release series ("26.1") gets that series' newest parser; a version with a
 *   patch ("26.2.1") gets the parser that patch shipped.
 * - No release series ("master", "beta", empty, as on Cloud) gets the newest
 *   series with a GA release.
 * - A series with no iceberg_mode parser returns {series, grammar: null}.
 * - A series (or patch) the data does not cover returns null: the caller says
 *   it could not check rather than borrowing a neighbouring release's grammar.
 *
 * @param {string} version
 * @returns {null|{series: string, since?: string, grammar: object|null, clusterGate?: string|null}}
 */
function releaseFor (version) {
  const s = releaseSeries(version);
  if (!s) return LATEST;
  const series = `${s.major}.${s.minor}`;
  const history = RELEASES.series[series];
  if (!history) return null;
  if (!history.length) return { series, grammar: null };
  let entry = history[history.length - 1];
  if (s.patch !== null) {
    const tag = `v${series}.${s.patch}`;
    const shipped = history.filter((h) => compareTags(h.since, tag) <= 0);
    // Not a release (v26.2.0 is a branch point, not a tag).
    if (!shipped.length) return null;
    entry = shipped[shipped.length - 1];
  }
  return withGrammar(series, entry);
}

/**
 * The first GA tag whose parser has a feature, oldest series first.
 * @param {function(object): boolean} has
 * @returns {string|null}
 */
function firstReleaseWith (has) {
  for (const series of [...SERIES].reverse()) {
    for (const entry of RELEASES.series[series]) {
      if (isGa(entry.since) && has(RELEASES.parsers[entry.parser])) return entry.since;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Port of `parse_section_opts` (and of the option loop in
 * `parse_config_options` before v26.2.1): "opt1=val1,opt2=val2" into an
 * ordered map. Duplicate keys, empty keys and empty values are errors. An
 * empty string is an empty map (all defaults).
 * @returns {{opts: Map<string,string>}|{reason: string}}
 */
function parseOpts (str) {
  const opts = new Map();
  if (str === '') return { opts };
  for (const pair of str.split(',')) {
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : pair.slice(eq + 1);
    if (opts.has(k)) return { reason: `duplicate option '${k}'` };
    opts.set(k, v);
    if (k === '') return { reason: `option '${pair}' has no name` };
    if (v === '') return { reason: `option '${k}' has no value` };
  }
  return { opts };
}

/** Port of `parse_extended_iceberg_mode`. */
function parseSections (str, sections) {
  const parsed = {};
  for (const sec of str.split(';')) {
    if (sec === '') return fail('empty section in iceberg_mode config');
    const colon = sec.indexOf(':');
    if (colon < 0) return fail(`missing ':' in section '${sec}'`);
    const name = sec.slice(0, colon);
    const opts = parseOpts(sec.slice(colon + 1));
    if (!opts.opts) return fail(`malformed options in section '${name}'`, opts.reason);
    if (!sections.names.includes(name)) return fail(`unknown section '${name}'`);
    if (parsed[name]) return fail(`duplicate section '${name}'`);
    parsed[name] = opts.opts;
  }

  const result = defaultEnabled();
  const known = (option) => sections.options.includes(option);

  const schemaOpts = (opts, cfg, name) => {
    for (const [k, v] of opts) {
      if (k === 'mode' && known(k)) {
        if (!sections.schemaModes.includes(v)) return `unknown mode '${v}' in section '${name}'`;
        cfg.mode = v;
      } else if (k === 'subject' && known(k)) {
        cfg.subject = v;
      } else if (k === 'protobuf_name' && known(k)) {
        cfg.protobuf_name = v;
      } else if (k === 'layout' && known(k)) {
        if (!('layout' in cfg)) return `layout is only valid in the value section, not '${name}'`;
        if (!sections.layouts.includes(v)) return `unknown layout '${v}' in section '${name}'`;
        cfg.layout = v;
      } else {
        return `unknown option '${k}' in section '${name}'`;
      }
    }
    if (cfg.mode !== 'schema_latest' && (cfg.subject || cfg.protobuf_name)) {
      return `subject and protobuf_name require mode=schema_latest in section '${name}'`;
    }
    if ('layout' in cfg && cfg.layout === 'nested' &&
        cfg.mode !== 'schema_id_prefix' && cfg.mode !== 'schema_latest') {
      return `layout=nested requires a schema mode (schema_id_prefix or schema_latest) in section '${name}'`;
    }
    return null;
  };

  // Upstream checks key, then value, then headers, whatever the source order.
  if (parsed.key) {
    const err = schemaOpts(parsed.key, result.key, 'key');
    if (err) return fail(err);
  }
  if (parsed.value) {
    const err = schemaOpts(parsed.value, result.value, 'value');
    if (err) return fail(err);
  }
  if (parsed.headers) {
    for (const [k, v] of parsed.headers) {
      if (k !== 'value_type' || !known(k)) return fail(`unknown option '${k}' in section 'headers'`);
      if (!sections.headerValueTypes.includes(v)) return fail(`unknown value_type '${v}' in section 'headers'`);
      result.headers.value_type = v;
    }
  }
  return ok(result, 'sections');
}

/** Port of `parse_legacy_schema_latest` (the text after "value_schema_latest"). */
function parseLegacySchemaLatest (suffix, { prefix, options }) {
  const result = defaultEnabled();
  result.value.mode = 'schema_latest';
  if (suffix === '') return ok(result, 'legacy');
  if (!suffix.startsWith(':')) {
    return fail(`expected ':' or end of string after '${prefix}'`);
  }
  const rest = suffix.slice(1);
  if (rest === '') return fail(`expected options after ':' in ${prefix}`);
  const parsed = parseOpts(rest);
  if (!parsed.opts) return fail(`malformed options in ${prefix}`, parsed.reason);
  for (const [k, v] of parsed.opts) {
    if (k === 'protobuf_name' && options.includes(k)) result.value.protobuf_name = v;
    else if (k === 'subject' && options.includes(k)) result.value.subject = v;
    else return fail(`unknown option '${k}' in ${prefix}`);
  }
  return ok(result, 'legacy');
}

/**
 * Port of `parse_iceberg_mode` (`operator>>` before v26.2.1), for one
 * release's grammar.
 * @param {string} str
 * @param {object} [grammar] A grammar from iceberg-mode-releases.json, as
 *   returned by releaseFor(version).grammar. Defaults to the newest GA release.
 * @returns {{ok: true, mode: object, format: 'disabled'|'legacy'|'sections'}
 *   | {ok: false, error: string, reason?: string}}
 *   For a grammar with `messages`, `error` is Redpanda's message, verbatim, and
 *   `reason` narrows it where upstream's message is generic (for example,
 *   which option was malformed). Older releases report no reason at all, so
 *   for them `error` is this port's description of the problem.
 */
function parseIcebergMode (str, grammar = LATEST.grammar) {
  if (grammar.legacyNames.includes(str)) {
    const make = LEGACY_NAMES[str];
    if (!make) throw new Error(`iceberg-mode: the generated grammar accepts '${str}', which this port does not implement`);
    return ok(make(), str === 'disabled' ? 'disabled' : 'legacy');
  }
  const latest = grammar.legacySchemaLatest;
  if (latest && str.startsWith(latest.prefix)) {
    return parseLegacySchemaLatest(str.slice(latest.prefix.length), latest);
  }
  if (grammar.sections) return parseSections(str, grammar.sections);
  return fail(`'${str}' is not one of the values this release accepts`);
}

/** Port of `value_config::is_legacy_compatible`. */
function isLegacyCompatibleValue (value) {
  return value.layout === 'flat' && value.mode !== 'string';
}

/**
 * Port of `iceberg_mode::format_to` (`operator<<` before v26.2.1): the
 * canonical string Redpanda stores and reports. A config expressible as a
 * legacy name is written as one; anything else is written in the section
 * format with every section and option.
 * @param {object} mode A `mode` from parseIcebergMode.
 * @returns {string}
 */
function formatIcebergMode (mode) {
  if (mode.disabled) return 'disabled';
  const { key, value, headers } = mode;
  const keyDefault = key.mode === 'binary' && !key.subject && !key.protobuf_name;
  if (keyDefault && headers.value_type === 'binary' && isLegacyCompatibleValue(value)) {
    if (value.mode === 'binary') return 'key_value';
    if (value.mode === 'schema_id_prefix') return 'value_schema_id_prefix';
    if (value.mode === 'schema_latest') {
      const opts = [];
      if (value.protobuf_name) opts.push(`protobuf_name=${value.protobuf_name}`);
      if (value.subject) opts.push(`subject=${value.subject}`);
      return opts.length ? `value_schema_latest:${opts.join(',')}` : 'value_schema_latest';
    }
  }
  const schemaSection = (name, cfg) => {
    let s = `${name}:mode=${cfg.mode}`;
    if (cfg.subject) s += `,subject=${cfg.subject}`;
    if (cfg.protobuf_name) s += `,protobuf_name=${cfg.protobuf_name}`;
    return s;
  };
  return [
    schemaSection('key', key),
    `${schemaSection('value', value)},layout=${value.layout}`,
    `headers:value_type=${headers.value_type}`,
  ].join(';');
}

// ---------------------------------------------------------------------------
// Validation for a docs version
// ---------------------------------------------------------------------------

/** The legacy forms a grammar accepts, for error messages. */
function legacyForms (grammar) {
  const forms = [...grammar.legacyNames];
  const latest = grammar.legacySchemaLatest;
  if (latest) {
    forms.push(`${latest.prefix} with optional :${latest.options.map((o) => `${o}=<name>`).join(',')}`);
  }
  return forms.length > 1 ? `${forms.slice(0, -1).join(', ')}, or ${forms[forms.length - 1]}` : forms[0];
}

/**
 * Whether pages of this docs version may use the section format, according to
 * the generated release data.
 * @param {string} version
 * @returns {boolean}
 */
function supportsSectionFormat (version) {
  const release = releaseFor(version);
  return Boolean(release && release.grammar && release.grammar.sections);
}

/**
 * Validate a `redpanda.iceberg.mode` value against the grammar of the release
 * the docs version documents.
 * @param {string} str
 * @param {{version?: string}} [options]
 * @returns {{ok: true, mode: object, format: string, canonical: string, release: string}
 *   | {ok: false, error: string, reason?: string, unverified?: true}}
 *   `unverified` means no release data covers the version, so the value was
 *   not checked at all.
 */
function validateIcebergMode (str, { version } = {}) {
  const input = String(str);
  const release = releaseFor(version);
  const v = String(version || '').trim();
  if (!release) {
    return {
      ok: false,
      unverified: true,
      error: `extension-utils/iceberg-mode-releases.json has no Redpanda release for version ${v}, so the value was not checked. ` +
        'Regenerate it with node tools/iceberg-mode/generate.js',
    };
  }
  if (!release.grammar) return fail(`Redpanda ${v} has no redpanda.iceberg.mode property`);

  const parsed = parseIcebergMode(input, release.grammar);
  if (parsed.ok) return { ...parsed, canonical: formatIcebergMode(parsed.mode), release: release.since };

  // Rejected here: say so in terms of what this release lacks when a newer
  // release accepts the value.
  const newer = parseIcebergMode(input, LATEST.grammar);
  if (newer.ok && newer.format === 'sections' && !release.grammar.sections) {
    const since = firstReleaseWith((g) => g.sections);
    return fail(
      `the section format (key:, value:, headers:) requires Redpanda ${since} or later, ` +
      `and this page documents ${v}. Use one of: ${legacyForms(release.grammar)}`
    );
  }
  const latest = LATEST.grammar.legacySchemaLatest;
  if (newer.ok && latest && input.startsWith(latest.prefix) && !release.grammar.legacySchemaLatest) {
    const since = firstReleaseWith((g) => g.legacySchemaLatest);
    return fail(
      `${latest.prefix} requires Redpanda ${since} or later, and this page documents ${v}. ` +
      `Use one of: ${legacyForms(release.grammar)}`
    );
  }
  if (release.grammar.messages) return parsed;
  // Releases before v26.2.1 reject a bad value without saying why.
  const reason = parsed.reason ? `${parsed.error}: ${parsed.reason}` : parsed.error;
  return fail(`not a value Redpanda ${v || release.series} accepts. Use one of: ${legacyForms(release.grammar)}`, reason);
}

module.exports = {
  parseIcebergMode,
  formatIcebergMode,
  validateIcebergMode,
  supportsSectionFormat,
  releaseSeries,
  releaseFor,
  firstReleaseWith,
  LEGACY_NAMES,
  PORTED_PARSERS,
  RELEASES,
};
