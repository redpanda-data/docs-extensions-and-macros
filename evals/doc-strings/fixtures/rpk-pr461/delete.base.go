// Package lintfixture is a lint-strings test fixture: the help text of
// rpk topic delete before and after a change whose new wording came from a
// docs reviewer's comments. It only needs to parse as Go text for the
// scanner; it is never compiled.
package lintfixture

import (
	"github.com/spf13/cobra"
)

func newDeleteCommand() *cobra.Command {
	var re bool
	cmd := &cobra.Command{
		Use:   "delete [TOPICS...]",
		Short: "Delete topics",
		Long: `Delete topics.

This command deletes all requested topics, printing the success or fail status
per topic.

The --regex flag (-r) opts into parsing the input topics as regular expressions
and deleting any non-internal topic that matches any of expressions. The input
expressions are wrapped with ^ and $ so that the expression must match the
whole topic name (which also prevents accidental delete-everything mistakes).

The topic list command accepts the same input regex format as this delete
command. If you want to check what your regular expressions will delete before
actually deleting them, you can check the output of 'rpk topic list -r'.

For example,

    delete foo bar            # deletes topics foo and bar
    delete -r '^f.*' '.*r$'   # deletes any topic starting with f and any topics ending in r
    delete -r '.*'            # deletes all topics
    delete -r .               # deletes any one-character topics

`,
		Run: func(cmd *cobra.Command, topics []string) {},
	}
	cmd.Flags().BoolVarP(&re, "regex", "r", false, "Parse topics as regex; delete any topic that matches any input topic expression")
	return cmd
}
