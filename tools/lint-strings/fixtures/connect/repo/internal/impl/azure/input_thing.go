package azure

import (
	"github.com/redpanda-data/benthos/v4/public/service"

	"github.com/redpanda-data/connect/v4/internal/retries"
)

func thingInputSpec() *service.ConfigSpec {
	spec := azureComponentSpec().
		Summary("Reads things from " + thingProduct + ".").
		Description(thingDescription()).
		Footnotes("== Throughput\n\nThe input reads one page of things per request.").
		Example("Read every thing", "Reads each thing once and stops.", `input: {}`).

		// A blank line and a comment inside the chain do not end it.
		Field(accountField("Azure Thing input")).
		Fields(retries.CommonRetryBackOffFields(3, "1s", "5s", "30s")...)
	spec = spec.Field(service.NewStringAnnotatedEnumField("mode", map[string]string{
		"once":   "Reads each thing once.",
		"follow": "Keeps reading new things as they arrive.",
	}))
	// Documented by reassignment: not a missing description.
	f := service.NewStringField("prefix")
	f = f.Description("Only things whose name starts with this prefix are read.")
	spec = spec.Field(f)
	return spec
}

func init() {
	service.MustRegisterInput("azure_thing", thingInputSpec(), nil)
}
