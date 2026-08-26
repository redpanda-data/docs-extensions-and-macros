// Package lintfixture is a lint-strings test fixture mirroring connect
// ConfigSpec shapes. It only needs to parse as Go text for the scanner.
package lintfixture

import (
	"github.com/redpanda-data/benthos/v4/public/service"
)

const (
	// Field name constants resolve like the kfc* pattern in franz_client.go.
	fixFieldSeedBrokers = "seed_brokers"
	fixFieldClientID    = "client_id"

	fixFieldSeedBrokersDescription = "A list of broker addresses to connect to in order to establish the connection."
)

func fixtureInputConfig() *service.ConfigSpec {
	return service.NewConfigSpec().
		Categories("Services").
		Summary(`A fixture input using the https://example.com[example client library^].`).
		Description(`
When a consumer group is specified this input consumes one or more topics.

This fixture exercises the ` + "`raw` + interpreted + `raw`" + ` concatenation idiom.

== Metadata

This heading and the table below are legitimate AsciiDoc:

|===
| kafka_key | The record key
|===
`).
		Fields(fixtureConfigFields()...)
}

func fixtureConfigFields() []*service.ConfigField {
	return []*service.ConfigField{
		service.NewStringListField(fixFieldSeedBrokers).
			Description(fixFieldSeedBrokersDescription + " When omitted the global block is referenced.").
			Example([]string{"localhost:9092"}),
		service.NewStringField(fixFieldClientID).
			Description("An identifier for the client connection.").
			Default("fixture").
			Advanced(),
		// Composite helper with built-in docs: never flagged.
		service.NewTLSToggledField("tls"),
		// Known-bad: a bare constructor with no Description ships blank.
		service.NewStringField("naked_field").
			Default(""),
		// Known-bad: description merely restates the field name.
		service.NewDurationField("poll_interval").
			Description("Poll interval."),
		// Deprecated fields are exempt from the missing-description rule.
		service.NewStringField("old_token").Deprecated().Default(""),
		// Dynamic description: skipped silently, never guessed at.
		service.NewStringField("dynamic_field").
			Description(dynamicDescription()),
	}
}

func init() {
	service.MustRegisterBatchInput("fixture_input", fixtureInputConfig(),
		func(conf *service.ParsedConfig, mgr *service.Resources) (service.BatchInput, error) {
			return nil, nil
		})
}
