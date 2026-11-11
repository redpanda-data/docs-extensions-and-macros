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

The --regex flag (-r) treats each argument as a regular expression and deletes
every topic whose full name matches any of them. rpk wraps each expression in
^ and $, so it must match the whole name.

Regex mode never deletes internal topics: the topics Redpanda reports as internal,
which rpk topic list shows only with -i. To delete an internal topic, name it
exactly, without -r.

The topic list command accepts the same input regex format as this delete
command. If you want to check what your regular expressions will delete before
actually deleting them, you can check the output of 'rpk topic list -r'.

For example,

    delete foo bar            # deletes topics foo and bar
    delete -r '^f.*' '.*r$'   # deletes any topic starting with f and any topics ending in r
    delete -r '.*'            # deletes all non-internal topics
    delete -r .               # deletes any one-character topics

`,
		Run: func(cmd *cobra.Command, topics []string) {},
	}
	cmd.Flags().BoolVarP(&re, "regex", "r", false, "Treat the topic arguments as regular expressions and delete every matching topic except internal topics")
	return cmd
}
