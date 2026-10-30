'use strict'

const { PLACEHOLDER_RULE, unexplainedPlaceholders } = require('../../../tools/lint-strings/rules/placeholders')
const connect = require('../../../tools/lint-strings/surfaces/connect')
const { runRules } = require('../../../tools/lint-strings/engine')
const { rulesFor } = require('../../../tools/lint-strings')

const names = (text) => unexplainedPlaceholders(text).map((x) => x.name)

// From connect internal/impl/snowflake/output_snowflake_streaming_pipe.go,
// before and after the placeholder was renamed and explained.
const SNOWFLAKE_BEFORE = `*For a partitioned Kafka/Redpanda input*, scope the channel per partition:

[source,yaml]
----
channel_name: "<pipe>-p\${! @kafka_partition }"
----

This is safe at any \`max_in_flight\` only if the input dispatches one batch per partition at a time. The \`redpanda\` input does (unless \`unordered.enabled\` is set).`

const SNOWFLAKE_AFTER = `*For a partitioned Kafka/Redpanda input*, scope the channel per partition:

[source,yaml]
----
channel_name: "<pipe-name>-p\${! @kafka_partition }"
----

Replace \`<pipe-name>\` with the name of your Snowflake pipe, the \`pipe\` value. Each partition then writes through its own channel, such as \`MY_PIPE-p0\`.

This is safe at any \`max_in_flight\` only if the input dispatches one batch per partition at a time.`

// From connect internal/impl/postgresql/input_pg_stream.go (signal_table_name).
const PG_SIGNAL = `Create the table with:

\`\`\`sql
CREATE TABLE <schema>.<signal_table_name> (
    id   SERIAL PRIMARY KEY,
    type VARCHAR(32),
    data TEXT
);
\`\`\`

Signal rows are published as regular output messages (\`operation=insert\`, \`table=<signal_table_name>\`).`

describe('unexplained-placeholder: what the docs UI makes editable', () => {
  test('a placeholder nothing explains is reported; the explained rename is not', () => {
    expect(names(SNOWFLAKE_BEFORE)).toEqual(['pipe'])
    expect(unexplainedPlaceholders(SNOWFLAKE_BEFORE)[0].line).toBe(5)
    expect(names(SNOWFLAKE_AFTER)).toEqual([])
  })

  test('``` fences count, and a placeholder named in the text after the block is explained', () => {
    expect(names(PG_SIGNAL)).toEqual(['schema'])
  })

  test('blocks the docs UI skips: no-placeholders role, skipped languages, plain listings, literal blocks, <none>', () => {
    expect(names('[,bash,role="no-placeholders"]\n----\nrpk topic create <topic-name>\n----\n')).toEqual([])
    expect(names('[source.no-placeholders,bash]\n----\nrpk topic create <topic-name>\n----\n')).toEqual([])
    expect(names('[,text]\n----\n<topic-name>\n----\n')).toEqual([])
    expect(names('[source,bloblang]\n----\nroot = <topic-name>\n----\n')).toEqual([])
    expect(names('----\nrpk topic create <topic-name>\n----\n')).toEqual([])
    expect(names('....\nrpk topic create <topic-name>\n....\n')).toEqual([])
    expect(names('[,yaml]\n----\nvalue: <none>\n----\n')).toEqual([])
  })

  test('the language match is exact, as in the docs UI: Text is not text', () => {
    expect(names('[,Text]\n----\n<topic-name>\n----\n')).toEqual(['topic-name'])
  })

  test('a role in curly quotes does not apply, so the block stays editable', () => {
    // From cloud-docs develop/pages/connect/configuration/resource-management.adoc.
    expect(names('[,bash,role=“no-placeholders”]\n----\ncurl -X PUT "https://<data-plane-api-url>/v1/redpanda-connect/pipelines/xxx..."\n----\n')).toEqual(['data-plane-api-url'])
  })

  test('callout markers are not placeholders; a callout list explains the line it marks', () => {
    const text = '[,yaml]\n----\ncloud_storage_bucket: <your-bucket> # <1>\ncloud_storage_region: <your-region>\n----\n<1> The name of the bucket.\n'
    expect(names(text)).toEqual(['your-region'])
    // <10> would match the docs UI's pattern, but Asciidoctor renders it as a callout first.
    expect(names('[,console]\n----\nrpk cluster info <10>\n----\n')).toEqual([])
  })

  test('a "where" list naming the field, a code comment, and an earlier block explain a placeholder', () => {
    expect(names('```yaml\nmetadata:\n  name: <cluster-name>\n```\n\n- `metadata.name`: Name to assign the Redpanda cluster.\n')).toEqual([])
    expect(names('[,bash]\n----\n# Store your cluster ID in a variable.\nexport RP_CLUSTER_ID=<cluster-id>\n----\n')).toEqual([])
    const twice = `${SNOWFLAKE_AFTER}\n\n[source,yaml]\n----\nchannel_name: "<pipe-name>-\${! @kafka_topic }"\n----\n`
    expect(names(twice)).toEqual([])
  })

  test('text matched by accident is reported with the no-placeholders fix', () => {
    // From docs manage/pages/iceberg/specify-iceberg-schema.adoc.
    const [issue] = PLACEHOLDER_RULE.check({ string: '[,sql]\n----\n    headers:        array<struct<key: string, value: binary>>,\n----\n', convention: {} })
    expect(issue.message).toContain('role="no-placeholders"')
  })

  test('strings that are not AsciiDoc are skipped', () => {
    expect(PLACEHOLDER_RULE.check({ string: SNOWFLAKE_BEFORE, convention: { verbatim_asciidoc: false } })).toEqual([])
  })
})

describe('unexplained-placeholder on the connect surface', () => {
  // Inside a Go raw string, a backtick is written as `+"`"+`, as connect's specs do.
  const goRaw = (text) => text.replace(/`/g, '`+"`"+`')
  const source = `package phfixture

import "github.com/redpanda-data/benthos/v4/public/service"

func phOutputConfig() *service.ConfigSpec {
	return service.NewConfigSpec().
		Summary("Writes rows.").
		Description(\`
` + goRaw(SNOWFLAKE_BEFORE) + `
\`).
		Fields(
			service.NewStringField("signal_table_name").
				Description(\`The signal table.

` + goRaw(PG_SIGNAL) + `\`),
			service.NewStringField("channel_name").
				Description(\`
` + goRaw(SNOWFLAKE_AFTER) + `\`),
		)
}

func init() {
	service.MustRegisterOutput("ph_output", phOutputConfig(), nil)
}
`
  const declarations = connect.scanFile(source, 'internal/impl/phfixture/output.go')
  const { findings } = runRules(declarations, rulesFor(connect), { onlyRules: ['unexplained-placeholder'] })
  const flagged = (name) => (findings.find((f) => f.name === name) || { rules: [] }).rules

  test('the rule is enabled for connect and warns, never errors', () => {
    expect(rulesFor(connect).map((r) => r.name)).toContain('unexplained-placeholder')
    expect(findings.flatMap((f) => f.rules).every((r) => r.severity === 'warning')).toBe(true)
  })

  test('the component description and the field description are each checked on their own text', () => {
    expect(flagged('ph_output').map((r) => r.message)).toEqual([expect.stringContaining('"<pipe>"')])
    expect(flagged('signal_table_name').map((r) => r.message)).toEqual([expect.stringContaining('"<schema>"')])
    expect(flagged('channel_name')).toEqual([])
  })
})
