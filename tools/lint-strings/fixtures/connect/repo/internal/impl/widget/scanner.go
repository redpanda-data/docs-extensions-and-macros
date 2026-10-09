package widget

import "github.com/redpanda-data/benthos/v4/public/service"

func linesScannerSpec() *service.ConfigSpec {
	return service.NewConfigSpec().
		Summary("Splits a widget stream into lines.")
}

func init() {
	service.MustRegisterBatchScannerCreator("widget_lines", linesScannerSpec(), nil)
}
