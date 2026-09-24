// Copyright 2026 Redpanda Data, Inc.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

// writeModule writes an arbitrary set of files (keyed by path relative to
// the module root) plus a go.mod, for regression tests that need a shape
// writeFixture doesn't cover.
func writeModule(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for rel, content := range files {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok := files["go.mod"]; !ok {
		if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module example.com/rpk\n\ngo 1.21\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// A function returning different cobra.Command literals from different
// branches is genuinely ambiguous: which one executes depends on runtime
// arguments this static analysis never sees. Regression for a bug where
// findOwnCommandLiteral picked whichever literal ast.Inspect visited first
// instead of bailing out, silently attributing a location to the wrong
// branch's description.
func TestBranchAmbiguityBailsOutRatherThanGuessing(t *testing.T) {
	repo := writeModule(t, map[string]string{
		"pkg/cli/root.go": `package cli

import "github.com/spf13/cobra"

func NewRoot() *cobra.Command {
	root := &cobra.Command{Use: "rpk", Long: "rpk long description"}
	root.AddCommand(newBranchy(false))
	return root
}

func newBranchy(cloud bool) *cobra.Command {
	if cloud {
		return &cobra.Command{Use: "branchy", Long: "cloud branch description"}
	}
	return &cobra.Command{Use: "branchy", Long: "self-managed branch description"}
}
`,
	})
	a := newAnalyzer()
	if err := a.analyze(repo); err != nil {
		t.Fatalf("analyze: %v", err)
	}
	if got := byPath(a.locations, "rpk branchy"); got != nil {
		t.Errorf("expected 'rpk branchy' to stay unresolved (ambiguous branches), got: %+v", got)
	}
}

// Two files in the same package are free to alias two different import
// paths to the same short name. Regression for a bug where the import
// alias map was shared across a whole package (last file processed wins),
// so a qualified call in one file could resolve against an import only a
// DIFFERENT file in the same package declared.
func TestImportAliasIsScopedPerFileNotPerPackage(t *testing.T) {
	repo := writeModule(t, map[string]string{
		"pkg/cli/root.go": `package cli

import config "example.com/rpk/pkg/cli/cluster/config"
import "github.com/spf13/cobra"

func NewRoot() *cobra.Command {
	root := &cobra.Command{Use: "rpk", Long: "rpk long description"}
	root.AddCommand(config.NewCommand())
	return root
}
`,
		// A second file in the SAME package aliases a DIFFERENT import path
		// to the same default name "config". Before the fix, whichever file
		// filepath.WalkDir visited last would win for the whole package.
		"pkg/cli/zzz_other.go": `package cli

import config "example.com/rpk/pkg/config"

var _ = config.Unrelated
`,
		"pkg/cli/cluster/config/config.go": `package config

import "github.com/spf13/cobra"

func NewCommand() *cobra.Command {
	return &cobra.Command{Use: "config", Long: "cluster config description"}
}
`,
		"pkg/config/config.go": `package config

var Unrelated = 1
`,
	})
	a := newAnalyzer()
	if err := a.analyze(repo); err != nil {
		t.Fatalf("analyze: %v", err)
	}
	got := byPath(a.locations, "rpk config")
	if got == nil {
		t.Fatalf("expected 'rpk config' to resolve via root.go's own import, got none. locations: %+v", a.locations)
	}
	if got.Description == nil || got.Description.File != "pkg/cli/cluster/config/config.go" {
		t.Errorf("expected root.go's alias (pkg/cli/cluster/config) to win for root.go's own call, got: %+v", got.Description)
	}
}

// A command literal returned directly (no local variable) has no
// identifier to scope an AddCommand receiver check to. Regression for a bug
// where the receiver check was skipped entirely in that case, so ANY
// .AddCommand(...) call anywhere else in the function body -- on a
// completely unrelated command -- was misattributed as this command's own
// child.
func TestNoSelfVarSkipsAddCommandScanEntirely(t *testing.T) {
	repo := writeModule(t, map[string]string{
		"pkg/cli/root.go": `package cli

import "github.com/spf13/cobra"

func NewRoot() *cobra.Command {
	root := &cobra.Command{Use: "rpk", Long: "rpk long description"}
	root.AddCommand(newFoo())
	return root
}

func newFoo() *cobra.Command {
	helper := &cobra.Command{Use: "helper-only-for-something-else"}
	helper.AddCommand(newBar())
	return &cobra.Command{Use: "foo", Long: "foo command description"}
}

func newBar() *cobra.Command {
	return &cobra.Command{Use: "bar", Long: "bar command description"}
}
`,
	})
	a := newAnalyzer()
	if err := a.analyze(repo); err != nil {
		t.Fatalf("analyze: %v", err)
	}
	if byPath(a.locations, "rpk foo") == nil {
		t.Errorf("expected 'rpk foo' itself to still resolve")
	}
	if got := byPath(a.locations, "rpk foo bar"); got != nil {
		t.Errorf("expected 'bar' NOT to be misattributed as a child of the unrelated 'foo' (it belongs to 'helper-only-for-something-else'), got: %+v", got)
	}
}

// A shared factory function legitimately reused across many parents (a
// common cobra pattern) must resolve at every attachment point, not just
// the first few. Regression for a bug where a global visit counter
// (mistaken for cycle detection) silently truncated resolution past a
// small fixed number of reuses, with no signal in either unresolved
// counter.
func TestSharedFactoryReusedManyTimesAllResolve(t *testing.T) {
	var b strings.Builder
	b.WriteString("package cli\n\nimport \"github.com/spf13/cobra\"\n\nfunc NewRoot() *cobra.Command {\n\troot := &cobra.Command{Use: \"rpk\", Long: \"rpk long description\"}\n\troot.AddCommand(\n")
	const n = 12
	for i := 0; i < n; i++ {
		b.WriteString("\t\tnewParent" + itoa(i) + "(),\n")
	}
	b.WriteString("\t)\n\treturn root\n}\n\n")
	for i := 0; i < n; i++ {
		name := "newParent" + itoa(i)
		b.WriteString("func " + name + "() *cobra.Command {\n\tcmd := &cobra.Command{Use: \"parent" + itoa(i) + "\", Long: \"parent description\"}\n\tcmd.AddCommand(sharedChild())\n\treturn cmd\n}\n\n")
	}
	b.WriteString("func sharedChild() *cobra.Command {\n\treturn &cobra.Command{Use: \"shared\", Long: \"shared child description\"}\n}\n")

	repo := writeModule(t, map[string]string{"pkg/cli/root.go": b.String()})
	a := newAnalyzer()
	if err := a.analyze(repo); err != nil {
		t.Fatalf("analyze: %v", err)
	}
	resolved := 0
	for _, l := range a.locations {
		if strings.HasSuffix(l.Path, " shared") {
			resolved++
		}
	}
	if resolved != n {
		t.Errorf("expected the shared factory to resolve at all %d attachment points, got %d", n, resolved)
	}
}

func itoa(i int) string {
	return fmt.Sprintf("%d", i)
}

// `var cmd *cobra.Command = &cobra.Command{...}` builds the same command as
// `cmd := &cobra.Command{...}`. Regression for a bug where commandVarName
// only recognized the := / = assignment form, so a command built via a var
// declaration resolved (findOwnCommandLiteral doesn't care how it's
// assigned) but silently lost every flag registered on it, since
// findFlagLocations requires a non-empty self variable name.
func TestVarDeclarationCommandStillResolvesFlags(t *testing.T) {
	repo := writeModule(t, map[string]string{
		"pkg/cli/root.go": `package cli

import "github.com/spf13/cobra"

func NewRoot() *cobra.Command {
	root := &cobra.Command{Use: "rpk", Long: "rpk long description"}
	root.AddCommand(newFoo())
	return root
}

func newFoo() *cobra.Command {
	var cmd *cobra.Command = &cobra.Command{Use: "foo", Long: "foo command description"}
	cmd.Flags().String("bar", "", "the bar flag usage")
	return cmd
}
`,
	})
	a := newAnalyzer()
	if err := a.analyze(repo); err != nil {
		t.Fatalf("analyze: %v", err)
	}
	got := byPath(a.locations, "rpk foo")
	if got == nil {
		t.Fatalf("expected 'rpk foo' to resolve")
	}
	if len(got.Flags) != 1 || got.Flags[0].Flag != "bar" {
		t.Errorf("expected the 'bar' flag to resolve even though 'cmd' was built via a var declaration, got flags: %+v", got.Flags)
	}
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
