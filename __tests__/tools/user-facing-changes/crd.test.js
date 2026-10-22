'use strict'

const { detect, kinds } = require('./helpers')
const { parseStructs } = require('../../../tools/user-facing-changes/detectors/crd')

const FILE = 'operator/api/redpanda/v1alpha2/redpanda_types.go'

// Synthetic operator API types in the shapes crd-ref-docs reads.
const SOURCE = `package v1alpha2

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

// RedpandaSpec defines the desired state.
type RedpandaSpec struct {
	// ChartRef references the chart.
	ChartRef ChartRef \`json:"chartRef,omitempty"\`
	// Replicas is the number of brokers.
	// +kubebuilder:default=3
	Replicas *int32 \`json:"replicas,omitempty"\`
	// +hidefromdoc
	Internal string \`json:"internal,omitempty"\`
	Embedded \`json:",inline"\`
	Skipped string \`json:"-"\`
}

// ChartRef references a Helm chart.
type ChartRef struct {
	// ChartVersion is the chart version.
	ChartVersion string \`json:"chartVersion,omitempty"\`
	// Timeout for the install.
	// +kubebuilder:default="15m"
	Timeout *metav1.Duration \`json:"timeout,omitempty"\`
}
`

const base = { [FILE]: SOURCE }
const edit = (from, to) => ({ [FILE]: SOURCE.replace(from, to) })

describe('parseStructs', () => {
  test('reads published fields with their json name, default and markers; skips hidden, inline and dash', () => {
    const fields = parseStructs([{ startLine: 1, text: SOURCE }])
    expect([...fields.keys()]).toEqual(['RedpandaSpec.chartRef', 'RedpandaSpec.replicas', 'ChartRef.chartVersion', 'ChartRef.timeout'])
    expect(fields.get('RedpandaSpec.replicas')).toMatchObject({ goName: 'Replicas', default: '3', deprecated: false, line: 11 })
    expect(fields.get('ChartRef.timeout').default).toBe('"15m"')
  })
})

describe('crd detector', () => {
  test('a new field is added with its default; a removed field is high', () => {
    const r = detect(base, edit('\tReplicas *int32 `json:"replicas,omitempty"`', '\tReplicas *int32 `json:"replicas,omitempty"`\n\t// Image overrides the broker image.\n\t// +kubebuilder:default="redpanda:latest"\n\tImage string `json:"image,omitempty"`'))
    expect(kinds(r)).toEqual([['added', 'RedpandaSpec.image']])
    expect(r.findings[0]).toMatchObject({ surface: 'crd', severity: 'medium', file: FILE, line: 14 })
    expect(r.findings[0].summary).toMatch(/default `"redpanda:latest"`/)
    expect(r.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/streaming/current/reference/k-crd/'])
    const r2 = detect(base, edit('\t// ChartVersion is the chart version.\n\tChartVersion string `json:"chartVersion,omitempty"`\n', ''))
    expect(kinds(r2)).toEqual([['removed', 'ChartRef.chartVersion']])
    expect(r2.findings[0].severity).toBe('high')
  })

  test('the same Go field under a new json name is a rename', () => {
    const r = detect(base, edit('`json:"chartVersion,omitempty"`', '`json:"version,omitempty"`'))
    expect(kinds(r)).toEqual([['renamed', 'ChartRef.version']])
  })

  test('a changed +kubebuilder:default is a default change (high)', () => {
    const r = detect(base, edit('// +kubebuilder:default=3', '// +kubebuilder:default=5'))
    expect(kinds(r)).toEqual([['default-changed', 'RedpandaSpec.replicas']])
    expect(r.findings[0].summary).toMatch(/from `3` to `5`/)
    const r2 = detect(base, edit('\t// +kubebuilder:default=3\n', ''))
    expect(kinds(r2)).toEqual([['default-changed', 'RedpandaSpec.replicas']])
    expect(r2.findings[0].summary).toMatch(/from `3` to `none`/)
  })

  test('a Deprecated comment is a deprecation', () => {
    const r = detect(base, edit('\t// Replicas is the number of brokers.', '\t// Replicas is the number of brokers.\n\t// Deprecated: set statefulset.replicas in clusterSpec instead.'))
    expect(kinds(r)).toEqual([['deprecated', 'RedpandaSpec.replicas']])
  })
})

describe('crd detector: negative controls', () => {
  test('a doc comment change is the lint\'s and yields nothing', () => {
    expect(detect(base, edit('// ChartVersion is the chart version.', '// The version of the chart to install.')).findings).toEqual([])
  })

  test('a hidden field, an inline embed, a Go type change and a validation marker yield nothing', () => {
    expect(detect(base, edit('Internal string `json:"internal,omitempty"`', 'Internal int `json:"internal,omitempty"`')).findings).toEqual([])
    expect(detect(base, edit('\tEmbedded `json:",inline"`\n', '\tOther `json:",inline"`\n')).findings).toEqual([])
    expect(detect(base, edit('Replicas *int32', 'Replicas *int64')).findings).toEqual([])
    expect(detect(base, edit('\t// +kubebuilder:default=3', '\t// +kubebuilder:validation:Minimum=1\n\t// +kubebuilder:default=3')).findings).toEqual([])
  })

  test('reordering fields yields nothing', () => {
    const a = '\t// ChartRef references the chart.\n\tChartRef ChartRef `json:"chartRef,omitempty"`\n'
    const b = '\t// Replicas is the number of brokers.\n\t// +kubebuilder:default=3\n\tReplicas *int32 `json:"replicas,omitempty"`\n'
    expect(detect(base, { [FILE]: SOURCE.replace(a + b, b + a) }).findings).toEqual([])
  })

  test('test files and files outside operator/api are not routed', () => {
    const T = 'operator/api/redpanda/v1alpha2/redpanda_types_test.go'
    expect(detect({ [T]: SOURCE }, { [T]: SOURCE.replace('default=3', 'default=4') }).findings).toEqual([])
    const O = 'operator/internal/controller/types.go'
    expect(detect({ [O]: SOURCE }, { [O]: SOURCE.replace('default=3', 'default=4') }).findings).toEqual([])
  })
})
