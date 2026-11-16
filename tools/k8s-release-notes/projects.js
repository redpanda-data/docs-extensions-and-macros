// The release surfaces this generator publishes notes for, keyed by the tag
// prefix the operator repository's changelog tool uses. Everything that differs
// between the Redpanda Operator and the Helm charts lives here: the chart name
// in the public Helm index, the default target page, and the command a reader
// copies to move to that version.

const INDEX_URL = 'https://charts.redpanda.com/index.yaml';

const PROJECTS = {
  operator: {
    label: 'Redpanda Operator',
    chart: 'operator',
    page: 'modules/reference/pages/releases/operator.adoc',
    command: (version) => [
      'helm repo update',
      'helm upgrade --install redpanda-controller redpanda/operator \\',
      '  --namespace <namespace> \\',
      '  --create-namespace \\',
      `  --version ${version} \\`,
      '  --set crds.enabled=true',
    ],
    after: 'Add your existing value overrides to the command. For the full procedure, see xref:upgrade:k-upgrade-operator.adoc[].',
    appVersionLine: null,
  },
  'charts/redpanda': {
    label: 'Redpanda Helm chart',
    chart: 'redpanda',
    page: 'modules/reference/pages/releases/redpanda-chart.adoc',
    command: (version) => [
      'helm repo update',
      'helm upgrade --install redpanda redpanda/redpanda \\',
      '  --namespace <namespace> \\',
      '  --create-namespace \\',
      `  --version ${version} \\`,
      '  --values <values-file>',
    ],
    after: 'Replace `<values-file>` with the file that holds your overrides. For the full procedure, see xref:upgrade:k-rolling-upgrade.adoc[].',
    appVersionLine: (appVersion) => `This chart deploys Redpanda ${appVersion} by default.`,
  },
  'charts/console': {
    label: 'Redpanda Console Helm chart',
    chart: 'console',
    page: 'modules/reference/pages/releases/console-chart.adoc',
    command: (version) => [
      'helm repo update',
      'helm upgrade --install redpanda-console redpanda/console \\',
      '  --namespace <namespace> \\',
      '  --create-namespace \\',
      `  --version ${version} \\`,
      '  --values <values-file>',
    ],
    after: 'Replace `<values-file>` with the file that holds your overrides.',
    appVersionLine: (appVersion) => `This chart deploys Redpanda Console ${appVersion} by default.`,
  },
};

const TAG_RE = /^(operator|charts\/redpanda|charts\/console)\/v(\d+\.\d+\.\d+)$/;

/**
 * Splits a release tag into its project and version. Only GA tags of the
 * published projects resolve; a prerelease (`operator/v26.2.1-beta.3`) or a
 * project with no customer-facing page (`gotohelm/v1.1.0`) returns null, which
 * callers treat as a clean no-op.
 *
 * @param {string} tag - A tag such as `operator/v26.2.6` or `charts/redpanda/v26.2.6`.
 * @return {{key: string, version: string, project: Object}|null}
 */
function parseTag(tag) {
  const m = String(tag || '').trim().match(TAG_RE);
  if (!m) return null;
  return { key: m[1], version: m[2], project: PROJECTS[m[1]] };
}

module.exports = { PROJECTS, INDEX_URL, parseTag };
