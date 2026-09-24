// Copyright 2026 Redpanda Data, Inc.
package main

import (
	"os"
	"path/filepath"
	"testing"
)

// writeFixture builds a minimal synthetic module exercising every pattern
// this analyzer is meant to resolve: a root command, a same-package
// unqualified child call, a cross-package qualified child call, a child
// reached through a local variable rather than a direct AddCommand argument,
// both Var and non-Var flag registration forms, and one deliberately
// unresolvable child (added through a loop-built slice) to confirm the
// analyzer leaves it out rather than guessing.
func writeFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write("go.mod", "module example.com/rpk\n\ngo 1.21\n")

	write("pkg/cli/root.go", `package cli

import (
	"example.com/rpk/pkg/cli/topic"
	"github.com/spf13/cobra"
)

func NewRoot() *cobra.Command {
	root := &cobra.Command{
		Use:   "rpk",
		Short: "rpk short",
		Long:  "rpk long description",
	}
	child := newLocalCommand()
	root.AddCommand(
		newDirectCommand(),
		topic.NewCommand(),
		child,
		looped()...,
	)
	return root
}

func newDirectCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:  "direct",
		Long: "direct command description",
	}
	cmd.Flags().StringVar(new(string), "name", "", "the name flag usage")
	cmd.Flags().Bool("verbose", false, "the verbose flag usage")
	return cmd
}

func newLocalCommand() *cobra.Command {
	return &cobra.Command{
		Use:  "local",
		Long: "local command description",
	}
}

func looped() []*cobra.Command {
	var out []*cobra.Command
	for _, name := range []string{"a", "b"} {
		out = append(out, &cobra.Command{Use: name})
	}
	return out
}
`)

	write("pkg/cli/topic/topic.go", `package topic

import "github.com/spf13/cobra"

func NewCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:  "topic",
		Long: "topic command description",
	}
	cmd.AddCommand(newCreateCommand())
	return cmd
}

func newCreateCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:  "create",
		Long: "create command description",
	}
	cmd.Flags().StringVarP(new(string), "config", "c", "", "the config flag usage")
	return cmd
}
`)

	return root
}

func run(t *testing.T, repo string) []CommandLocation {
	t.Helper()
	a := newAnalyzer()
	if err := a.analyze(repo); err != nil {
		t.Fatalf("analyze: %v", err)
	}
	return a.locations
}

func byPath(locs []CommandLocation, path string) *CommandLocation {
	for i := range locs {
		if locs[i].Path == path {
			return &locs[i]
		}
	}
	return nil
}

func TestResolvesDirectAndCrossPackageAndLocalVarChildren(t *testing.T) {
	repo := writeFixture(t)
	locs := run(t, repo)

	for _, path := range []string{"rpk", "rpk direct", "rpk topic", "rpk topic create", "rpk local"} {
		if byPath(locs, path) == nil {
			t.Errorf("expected %q to resolve, got: %+v", path, locs)
		}
	}
}

func TestRootDescriptionPrefersLongOverShort(t *testing.T) {
	repo := writeFixture(t)
	locs := run(t, repo)
	root := byPath(locs, "rpk")
	if root == nil || root.Description == nil {
		t.Fatalf("expected rpk root to have a description location")
	}
	if root.Description.File != "pkg/cli/root.go" {
		t.Errorf("expected root.go, got %s", root.Description.File)
	}
}

func TestFlagResolutionHandlesVarAndNonVarForms(t *testing.T) {
	repo := writeFixture(t)
	locs := run(t, repo)
	direct := byPath(locs, "rpk direct")
	if direct == nil {
		t.Fatalf("expected rpk direct to resolve")
	}
	byFlag := map[string]FlagLocation{}
	for _, f := range direct.Flags {
		byFlag[f.Flag] = f
	}
	if _, ok := byFlag["name"]; !ok {
		t.Errorf("expected a Var-form flag 'name' to resolve, got %+v", direct.Flags)
	}
	if _, ok := byFlag["verbose"]; !ok {
		t.Errorf("expected a non-Var-form flag 'verbose' to resolve, got %+v", direct.Flags)
	}
}

func TestFlagShorthandFormResolvesNameNotShorthand(t *testing.T) {
	repo := writeFixture(t)
	locs := run(t, repo)
	create := byPath(locs, "rpk topic create")
	if create == nil || len(create.Flags) != 1 {
		t.Fatalf("expected rpk topic create to resolve exactly one flag, got: %+v", create)
	}
	if create.Flags[0].Flag != "config" {
		t.Errorf("StringVarP's name is argument 1, not the shorthand at argument 2; got flag name %q", create.Flags[0].Flag)
	}
}

func TestLoopBuiltChildrenAreLeftUnresolvedNotGuessed(t *testing.T) {
	repo := writeFixture(t)
	locs := run(t, repo)
	if byPath(locs, "rpk a") != nil || byPath(locs, "rpk b") != nil {
		t.Errorf("expected loop-built AddCommand children to stay unresolved, got: %+v", locs)
	}
}
