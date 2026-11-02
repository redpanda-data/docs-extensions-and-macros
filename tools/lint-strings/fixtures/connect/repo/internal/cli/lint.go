package cli

import "github.com/urfave/cli/v2"

var lintCommand = &cli.Command{
	Name:        "lint",
	Usage:       "Parse configs and report any linting errors",
	Description: "Exits with a status code 1 if any linting errors are detected.",
	Flags: []cli.Flag{
		&cli.BoolFlag{
			Name:  "deprecated",
			Usage: "Print linting errors for the presence of deprecated fields.",
		},
		&cli.StringFlag{
			Name:  "format",
			Usage: "Output format",
		},
	},
}
