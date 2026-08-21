// Package lintfixture is a lint-strings test fixture: known-bad rpk
// declarations with conforming counterparts. It only needs to parse as Go
// text for the scanner; it is never compiled.
package lintfixture

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
)

// cobra.Command mentioned in a comment must never match: cobra.Command{Use: "fake"}.

func newLowercaseShortCommand(fs afero.Fs) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "badshort",
		Short: "queries cluster for health overview.",
		Long: `Query the cluster.

USAGE DETAILS

This section heading above is intended.

Some detail text here that is not a heading.
====

The ==== line above breaks the generated page.
`,
		Run: func(cmd *cobra.Command, _ []string) {
			// A paren ) and brace } in a string: "don't break (the) scanner".
		},
	}
	cmd.Flags().BoolVarP(&watch, "watch", "w", false, "Blocks and writes out all changes")
	cmd.Flags().StringVar(&dest, "trailing-period", "", "Writes the output to the given path.")
	cmd.Flags().String("verbose-output", "", "verbose output")
	return cmd
}

const conformingLong = `Manage widgets.

This is a conforming Long description with no heading-shaped lines,
resolved through a package-level constant.
`

func newConformingCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "widget [NAME]",
		Aliases: []string{"widgets"},
		Short:   "Manage widgets in the cluster",
		Long:    conformingLong,
	}
	f := cmd.Flags()
	f.IntVar(&count, "retries", 3, "Number of retries before giving up")
	f.DurationVar(&timeout, "timeout", 0, "How long to wait for the cluster to respond, for example 30s")
	cmd.Flags().StringP("format", "f", "text", "Output format, one of text or json")
	// Dynamic usage strings stay unverifiable, never errors:
	cmd.Flags().BoolP("help", "h", false, "Help for "+cmd.Name())
	return cmd
}

// A multiline Short: the rpk convention is a one-line Short, so this is the
// known-bad counterpart for the rpk-short-multiline rule. Everything else
// about it conforms, so it isolates that one rule.
func newMultilineShortCommand() *cobra.Command {
	return &cobra.Command{
		Use: "multiline",
		Short: `Manage the widget cache
and everything attached to it`,
	}
}
