package widget

import "github.com/redpanda-data/benthos/v4/public/bloblang"

func init() {
	spec := bloblang.NewPluginSpec().
		Category("Encoding").
		Description("Encodes a widget as a string.").
		Param(bloblang.NewStringParam("format").Description("The format to encode the widget in.")).
		Example("Encode a widget as JSON.", `root = this.encode_widget("json")`, [2]string{`{}`, `"{}"`})
	bloblang.MustRegisterMethodV2("encode_widget", spec, nil)
}

type note struct{}

// Description on a type that is not a benthos spec.
func (n note) Description(s string) note { return n }

func init() {
	_ = note{}.Description("Not a published string.")
}
