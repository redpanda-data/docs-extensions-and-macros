'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const connect = require('../../../tools/lint-strings/surfaces/connect')
const { runRules } = require('../../../tools/lint-strings/engine')
const { rulesFor } = require('../../../tools/lint-strings')

// Snippets copied from redpanda-data/benthos: shared config blocks built
// with the internal docs.Field API rather than service.New*Field.

// internal/httpserver/cors.go
const CORS = `package httpserver

import (
	"errors"
	"net/http"

	"github.com/gorilla/handlers"

	"github.com/redpanda-data/benthos/v4/internal/docs"
)

const (
	fieldCORS               = "cors"
	fieldCORSEnabled        = "enabled"
	fieldCORSAllowedOrigins = "allowed_origins"
)

// ServerCORSFieldSpec returns a field spec for an http server CORS component.
func ServerCORSFieldSpec() docs.FieldSpec {
	return docs.FieldObject(fieldCORS, "Adds Cross-Origin Resource Sharing headers.").WithChildren(
		docs.FieldBool(fieldCORSEnabled, "Whether to allow CORS requests.").HasDefault(false),
		docs.FieldString(fieldCORSAllowedOrigins, "An explicit list of origins that are allowed for CORS requests.").Array().HasDefault([]any{}),
	).AtVersion("3.63.0").Advanced()
}

// CORSConfigFromParsed extracts the CORS fields from the parsed config and returns a CORS config.
func CORSConfigFromParsed(pConf *docs.ParsedConfig) (conf CORSConfig, err error) {
	pConf = pConf.Namespace(fieldCORS)
	if conf.Enabled, err = pConf.FieldBool(fieldCORSEnabled); err != nil {
		return
	}
	return
}
`

// internal/batch/policy/docs.go (multi-line arguments, raw-string concatenation)
const BATCHING = `package policy

import "github.com/redpanda-data/benthos/v4/internal/docs"

func FieldSpec() docs.FieldSpec {
	return docs.FieldSpec{
		Name: "batching",
		Children: docs.FieldSpecs{
			docs.FieldInt(
				"count",
				"The number of messages at which the batch is flushed. Set to ` + '`0`' + ` to disable count-based batching.",
			).HasDefault(0),
			docs.FieldInt(
				"byte_size",
				\`The maximum total size (in bytes) that a batch can reach before it is flushed.

Set to \`+"\`"+\`0\`+"\`"+\` to disable size-based batching.\`,
			).HasDefault(0),
		},
	}
}
`

// internal/docs/metrics_mapping.go and internal/docs/config.go: inside the
// docs package the constructors are unqualified.
const IN_PACKAGE_MAPPING = `package docs

func MetricsMappingFieldSpec(name string) FieldSpec {
	summary := "An optional xref:guides:bloblang/about.adoc[Bloblang mapping] that allows you to rename or prevent certain metrics paths from being exported."
	return FieldBloblang(name, summary, examples...).HasDefault("")
}
`
const IN_PACKAGE_CONFIG = `package docs

var metaField = FieldAnything("meta", "An optional object containing unstructured metadata.").Map().Advanced().Optional()

func ReservedFieldsByType(t Type) map[string]FieldSpec {
	m := map[string]FieldSpec{
		"type":   FieldString("type", ""),
		"plugin": FieldObject("plugin", ""),
		"meta":   metaField,
	}
	return m
}

// FieldString is not a call.
func FieldString(name, description string, examples ...any) FieldSpec {
	return newField(name, description, examples...)
}

func (p *ParsedConfig) Lookup() {
	_, _ = p.FieldString("type")
}
`

const fields = (decls) => decls.filter((d) => String(d.meta.ctor || '').startsWith('docs.'))

describe('connect surface: benthos internal docs.Field declarations', () => {
  test('cors.go: every docs.Field description is read, named from its constant', () => {
    const decls = fields(connect.scanFile(CORS, 'internal/httpserver/cors.go'))
    expect(decls.map((d) => [d.name, d.meta.ctor, d.string])).toEqual([
      ['cors', 'docs.FieldObject', 'Adds Cross-Origin Resource Sharing headers.'],
      ['enabled', 'docs.FieldBool', 'Whether to allow CORS requests.'],
      ['allowed_origins', 'docs.FieldString', 'An explicit list of origins that are allowed for CORS requests.']
    ])
    expect(decls.every((d) => d.meta.kind === 'field')).toBe(true)
    expect(decls[1].line_start).toBe(CORS.split('\n').findIndex((l) => l.includes('docs.FieldBool(fieldCORSEnabled')) + 1)
  })

  test('ParsedConfig accessors such as pConf.FieldBool are not declarations', () => {
    const decls = fields(connect.scanFile(CORS, 'internal/httpserver/cors.go'))
    expect(decls.some((d) => d.meta.ctor === 'docs.FieldBool' && d.name === 'enabled' && d.string === null)).toBe(false)
    expect(decls).toHaveLength(3)
  })

  test('multi-line arguments and raw-string concatenation resolve to the shipped text', () => {
    const decls = fields(connect.scanFile(BATCHING, 'internal/batch/policy/docs.go'))
    const byName = new Map(decls.map((d) => [d.name, d]))
    expect(byName.get('count').string).toBe('The number of messages at which the batch is flushed. Set to `0` to disable count-based batching.')
    expect(byName.get('byte_size').string).toBe('The maximum total size (in bytes) that a batch can reach before it is flushed.\n\nSet to `0` to disable size-based batching.')
  })

  test('a broken description is flagged by the common rules', () => {
    const broken = CORS.replace('"Whether to allow CORS requests."', '"whether to allow CORS requests"')
    const { findings } = runRules(fields(connect.scanFile(broken, 'internal/httpserver/cors.go')), rulesFor(connect))
    const enabled = findings.find((f) => f.name === 'enabled')
    expect(enabled.rules.map((r) => r.id)).toContain('starts-lowercase')
    expect(findings.filter((f) => f.name !== 'enabled')).toEqual([])
  })

  test('a file that does not import internal/docs is not read for docs.Field calls', () => {
    const other = CORS.replace('"github.com/redpanda-data/benthos/v4/internal/docs"', '"example.com/other/docs"')
    expect(fields(connect.scanFile(other, 'internal/httpserver/cors.go'))).toEqual([])
  })

  describe('inside the internal/docs package', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-connect-docs-'))
    beforeAll(() => {
      fs.writeFileSync(path.join(repo, 'go.mod'), 'module github.com/redpanda-data/benthos/v4\n\ngo 1.22\n')
      fs.mkdirSync(path.join(repo, 'internal', 'docs'), { recursive: true })
      fs.writeFileSync(path.join(repo, 'internal', 'docs', 'metrics_mapping.go'), IN_PACKAGE_MAPPING)
      fs.writeFileSync(path.join(repo, 'internal', 'docs', 'config.go'), IN_PACKAGE_CONFIG)
    })
    afterAll(() => fs.rmSync(repo, { recursive: true, force: true }))

    test('unqualified constructors are read; empty descriptions, declarations and methods are not', () => {
      const decls = fields(connect.extract({ repo, external: false }))
      const got = decls.map((d) => [d.file, d.name, d.meta.ctor]).sort()
      expect(got).toEqual([
        ['internal/docs/config.go', 'meta', 'docs.FieldAnything'],
        [path.join('internal', 'docs', 'metrics_mapping.go'), null, 'docs.FieldBloblang']
      ].map(([f, n, c]) => [f.split('/').join(path.sep), n, c]).sort())
      const mapping = decls.find((d) => d.meta.ctor === 'docs.FieldBloblang')
      expect(mapping.string).toMatch(/^An optional xref:guides:bloblang\/about\.adoc\[Bloblang mapping\]/)
    })
  })
})
