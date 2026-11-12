// Copyright 2026 Redpanda Data, Inc.
//
// locate-strings statically maps every rpk cobra command's full path (e.g.
// "rpk topic create") and flag (e.g. "rpk topic create --partitions") to the
// file:line where its description/usage string literal is declared in
// source.
//
// Why this exists: `rpk --print-tree` (see fetchRpkTreeFromSource in
// rpk-docs-handler.js) dumps the runtime command tree, which carries no
// source location at all -- cobra.Command values don't remember where they
// were built. Without a location, an automated upstreaming step has no
// deterministic way to find the string it should edit; it would have to
// grep per candidate, the same turn-budget problem the property-overrides
// upstreaming workflow hit before switching to a real AST-based extractor.
// This tool is that extractor's rpk equivalent: it never executes rpk, only
// parses its Go source with go/parser, so it can run against any checkout
// without building anything.
//
// Method: cobra command trees are built through a small number of
// mechanical patterns everywhere in this codebase (confirmed by reading
// pkg/cli/root.go and pkg/cli/topic/create.go): a factory function assigns
// exactly one `&cobra.Command{...}` (or `cobra.Command{...}`) literal to a
// local variable, optionally registers flags on it via
// `<var>.Flags().<Method>(...)` / `<var>.PersistentFlags().<Method>(...)`,
// and attaches children via `<var>.AddCommand(<call-expr>, ...)` where each
// argument is a call to another such factory (same-package, cross-package
// qualified, or through a local variable assigned from one). This tool
// rebuilds that same call graph statically, starting from whichever
// composite literal has Use == "rpk", and walks it exactly the way cobra
// would at runtime to reconstruct each node's full path.
//
// It also follows a helper that takes the command as a parameter and calls
// AddCommand on it (addPlatformDependentCmds in pkg/cli), and reads only the
// files in the linux/amd64 build (--goos/--goarch), the platform the docs
// snapshot comes from. A string held in a constant with a literal value
// resolves to the constant's declaration.
//
// Deliberately conservative: any construct outside these patterns (a Long
// set to a variable, call or concatenation, an AddCommand argument that
// isn't a resolvable call or literal, a flag registered through a helper or
// on two lines, a non-registration call such as MarkHidden) is left
// unresolved rather than guessed. Every emitted location is either exactly
// right or absent -- there is no third, approximate case.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/build"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

// Location is a file:line pair, relative to the scanned repo root.
type Location struct {
	File string `json:"file"`
	Line int    `json:"line"`
}

// FlagLocation is one flag's resolved usage-string location.
type FlagLocation struct {
	Flag string `json:"flag"`
	Location
}

// CommandLocation is one resolved command-tree node.
type CommandLocation struct {
	Path        string         `json:"path"` // "rpk topic create"
	Description *Location      `json:"description,omitempty"`
	Flags       []FlagLocation `json:"flags,omitempty"`
}

// funcInfo is one parsed top-level function declaration, indexed by the
// (import path, name) callers use to reach it.
type funcInfo struct {
	decl       *ast.FuncDecl
	file       *ast.File
	fset       *token.FileSet
	importPath string
	repoPath   string // file path relative to the scanned repo root
}

// constLit is one package-level string constant with a literal value.
type constLit struct {
	lit      *ast.BasicLit
	repoPath string // file the declaration is in, relative to the repo root
}

// pkgInfo is everything gathered about one Go package directory.
type pkgInfo struct {
	importPath string
	files      []*ast.File
}

type analyzer struct {
	fset        *token.FileSet
	build       build.Context // which files are in the build (GOOS/GOARCH and build tags)
	repoRoot    string
	modulePath  string
	funcsByPath map[string]map[string]*funcInfo // importPath -> funcName -> info
	pkgs        map[string]*pkgInfo             // importPath -> info
	fileImports map[*ast.File]map[string]string // alias -> import path, PER FILE.
	// Two files in the same package are free to alias two different import
	// paths to the same short name (a real, observed pattern: e.g. one file
	// importing a sibling "config" subpackage while another imports the
	// top-level "config" package under the same default alias). A map
	// shared across a whole package would let the file processed last by
	// parseAll silently win for every file, misresolving or dropping
	// qualified calls in every OTHER file of that package. Scoped per file
	// instead, matching how Go's own compiler resolves imports.

	// Package-level `const name = "literal"` declarations: importPath ->
	// name -> literal. A Long, flag name or usage string that names one of
	// these has a known value and a known line (the const declaration).
	consts map[string]map[string]constLit

	callStack map[*ast.FuncDecl]bool // functions on the CURRENT DFS path; a true cycle re-enters one of these
	locations []CommandLocation

	unresolvedAddCommandArgs int
	unresolvedUseFields      int
}

// newAnalyzer builds an empty analyzer ready for analyze().
// buildContext returns the go/build context for goos/goarch with cgo off.
// Files outside it (root_darwin.go on linux, a //go:build windows file) are
// skipped, the same as the compiler does, so a function defined once per
// platform resolves to the one --print-tree ran.
func buildContext(goos, goarch string) build.Context {
	ctx := build.Default
	ctx.GOOS = goos
	ctx.GOARCH = goarch
	ctx.CgoEnabled = false
	return ctx
}

func newAnalyzer() *analyzer {
	return &analyzer{
		fset:        token.NewFileSet(),
		build:       buildContext("linux", "amd64"),
		funcsByPath: map[string]map[string]*funcInfo{},
		pkgs:        map[string]*pkgInfo{},
		fileImports: map[*ast.File]map[string]string{},
		consts:      map[string]map[string]constLit{},
		callStack:   map[*ast.FuncDecl]bool{},
	}
}

// analyze runs the full pipeline (parse, find root, walk) against repo,
// populating a.locations. Split out from main() so tests can drive it
// directly against a synthetic fixture module.
func (a *analyzer) analyze(repo string) error {
	repoRoot, err := filepath.Abs(repo)
	if err != nil {
		return fmt.Errorf("resolving repo path: %w", err)
	}
	a.repoRoot = repoRoot

	a.modulePath, err = readModulePath(filepath.Join(repoRoot, "go.mod"))
	if err != nil {
		return fmt.Errorf("reading go.mod: %w", err)
	}

	if err := a.parseAll(); err != nil {
		return fmt.Errorf("parsing source: %w", err)
	}

	rootFunc := a.findRootFunc()
	if rootFunc == nil {
		return fmt.Errorf("could not find a cobra.Command literal with Use == \"rpk\"; nothing resolved")
	}

	a.walk(rootFunc, "")
	return nil
}

func main() {
	repo := flag.String("repo", "", "Path to a streaming-enterprise src/go/rpk checkout")
	goos := flag.String("goos", "linux", "GOOS whose build-constrained files to read; match the platform the --print-tree snapshot came from")
	goarch := flag.String("goarch", "amd64", "GOARCH whose build-constrained files to read")
	flag.Parse()
	if *repo == "" {
		fmt.Fprintln(os.Stderr, "usage: locate-strings --repo <path to src/go/rpk>")
		os.Exit(2)
	}

	a := newAnalyzer()
	a.build = buildContext(*goos, *goarch)
	if err := a.analyze(*repo); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "resolved %d command node(s); %d AddCommand argument(s) and %d Use field(s) left unresolved\n",
		len(a.locations), a.unresolvedAddCommandArgs, a.unresolvedUseFields)

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(a.locations); err != nil {
		fmt.Fprintf(os.Stderr, "encoding output: %v\n", err)
		os.Exit(1)
	}
}

// readModulePath reads the `module ...` line of a go.mod file.
func readModulePath(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "module ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "module")), nil
		}
	}
	return "", fmt.Errorf("no module line found in %s", path)
}

// parseAll walks the repo, parses every non-test .go file, and populates
// a.pkgs and a.funcsByPath.
func (a *analyzer) parseAll() error {
	return filepath.WalkDir(a.repoRoot, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			base := d.Name()
			if base == "vendor" || base == "node_modules" || strings.HasPrefix(base, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		if match, err := a.build.MatchFile(filepath.Dir(path), filepath.Base(path)); err != nil || !match {
			return nil
		}
		file, err := parser.ParseFile(a.fset, path, nil, parser.ParseComments)
		if err != nil {
			// A source file that fails to parse is a real problem, but not
			// one worth aborting the whole run over: skip it and note why.
			fmt.Fprintf(os.Stderr, "skipping %s: parse error: %v\n", path, err)
			return nil
		}

		dir := filepath.Dir(path)
		relDir, err := filepath.Rel(a.repoRoot, dir)
		if err != nil {
			return err
		}
		importPath := a.modulePath
		if relDir != "." {
			importPath = a.modulePath + "/" + filepath.ToSlash(relDir)
		}

		pkg := a.pkgs[importPath]
		if pkg == nil {
			pkg = &pkgInfo{importPath: importPath}
			a.pkgs[importPath] = pkg
		}
		pkg.files = append(pkg.files, file)
		fileImports := map[string]string{}
		for _, imp := range file.Imports {
			p := strings.Trim(imp.Path.Value, `"`)
			alias := lastSegment(p)
			if imp.Name != nil {
				alias = imp.Name.Name
			}
			if alias == "_" || alias == "." {
				continue
			}
			fileImports[alias] = p
		}
		a.fileImports[file] = fileImports

		relPath, err := filepath.Rel(a.repoRoot, path)
		if err != nil {
			return err
		}
		for _, decl := range file.Decls {
			gd, ok := decl.(*ast.GenDecl)
			if !ok || gd.Tok != token.CONST {
				continue
			}
			for _, spec := range gd.Specs {
				vs, ok := spec.(*ast.ValueSpec)
				if !ok || len(vs.Names) != len(vs.Values) {
					continue
				}
				for i, name := range vs.Names {
					if bl, ok := vs.Values[i].(*ast.BasicLit); ok && bl.Kind == token.STRING {
						if a.consts[importPath] == nil {
							a.consts[importPath] = map[string]constLit{}
						}
						a.consts[importPath][name.Name] = constLit{lit: bl, repoPath: filepath.ToSlash(relPath)}
					}
				}
			}
		}
		for _, decl := range file.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok || fd.Recv != nil || fd.Body == nil {
				continue // methods are excluded; every factory observed in this codebase is a free function
			}
			if a.funcsByPath[importPath] == nil {
				a.funcsByPath[importPath] = map[string]*funcInfo{}
			}
			a.funcsByPath[importPath][fd.Name.Name] = &funcInfo{
				decl: fd, file: file, fset: a.fset, importPath: importPath, repoPath: filepath.ToSlash(relPath),
			}
		}
		return nil
	})
}

func lastSegment(importPath string) string {
	parts := strings.Split(importPath, "/")
	return parts[len(parts)-1]
}

// findRootFunc locates the function whose body directly builds a
// cobra.Command composite literal with Use == "rpk".
func (a *analyzer) findRootFunc() *ast.FuncDecl {
	for _, funcs := range a.funcsByPath {
		for _, fi := range funcs {
			lit := findOwnCommandLiteral(fi.decl)
			if lit == nil {
				continue
			}
			use, _ := stringField(lit, "Use")
			if firstToken(use) == "rpk" {
				return fi.decl
			}
		}
	}
	return nil
}

// findOwnCommandLiteral returns the single cobra.Command composite literal
// this function builds for itself (assigned to a local var, or directly
// returned), or nil if none or more than one candidate is ambiguous.
func findOwnCommandLiteral(fd *ast.FuncDecl) *ast.CompositeLit {
	var found []*ast.CompositeLit
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		lit, ok := n.(*ast.CompositeLit)
		if !ok {
			return true
		}
		if isCobraCommandType(lit.Type) {
			found = append(found, lit)
		}
		return true
	})
	if len(found) == 0 {
		return nil
	}
	if len(found) == 1 {
		return found[0]
	}
	// More than one: unambiguous only when EXACTLY one is part of a `return
	// &cobra.Command{...}` / `return cobra.Command{...}` statement. Two or
	// more directly-returned literals means different branches return
	// different commands (e.g. a cloud vs. self-hosted variant) -- which
	// one a caller actually gets depends on runtime arguments this static
	// analysis never sees, so picking either one would silently attribute
	// a location to the wrong branch's string. Bail out rather than guess.
	var directlyReturned []*ast.CompositeLit
	for _, lit := range found {
		if isReturnedDirectly(fd, lit) {
			directlyReturned = append(directlyReturned, lit)
		}
	}
	if len(directlyReturned) == 1 {
		return directlyReturned[0]
	}
	return nil
}

func isReturnedDirectly(fd *ast.FuncDecl, lit *ast.CompositeLit) bool {
	found := false
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		ret, ok := n.(*ast.ReturnStmt)
		if !ok || len(ret.Results) != 1 {
			return true
		}
		expr := ret.Results[0]
		if u, ok := expr.(*ast.UnaryExpr); ok && u.Op == token.AND {
			expr = u.X
		}
		if expr == ast.Node(lit) {
			found = true
		}
		return true
	})
	return found
}

func isCobraCommandType(t ast.Expr) bool {
	sel, ok := t.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	ident, ok := sel.X.(*ast.Ident)
	return ok && ident.Name == "cobra" && sel.Sel.Name == "Command"
}

// stringField returns the literal string value of a composite literal's
// named field, and whether it was a plain string literal at all.
func stringField(lit *ast.CompositeLit, name string) (string, *ast.BasicLit) {
	for _, elt := range lit.Elts {
		kv, ok := elt.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		key, ok := kv.Key.(*ast.Ident)
		if !ok || key.Name != name {
			continue
		}
		if bl, ok := kv.Value.(*ast.BasicLit); ok && bl.Kind == token.STRING {
			val, err := unquoteGoString(bl.Value)
			if err != nil {
				return "", bl
			}
			return val, bl
		}
		return "", nil // present but not a plain literal
	}
	return "", nil
}

// fieldValue returns the value expression of a composite literal's named
// field, or nil when the field is absent.
func fieldValue(lit *ast.CompositeLit, name string) ast.Expr {
	for _, elt := range lit.Elts {
		kv, ok := elt.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		if key, ok := kv.Key.(*ast.Ident); ok && key.Name == name {
			return kv.Value
		}
	}
	return nil
}

// resolvedString is a string expression whose value is known statically,
// with the literal that holds it and the file that literal is in.
type resolvedString struct {
	value    string
	lit      *ast.BasicLit
	repoPath string
}

// resolveString resolves expr, used in fi, to the string literal that holds
// its value: a string literal itself, or an identifier naming a constant
// whose value is a string literal (`Long: helpProduce` with
// `const helpProduce = "..."`, in any file of the package, or a qualified
// pkg.Name). Anything else (a variable, a concatenation, a call) returns
// nil, because its value is not known without running the code.
func (a *analyzer) resolveString(fi *funcInfo, expr ast.Expr) *resolvedString {
	fromLit := func(bl *ast.BasicLit, repoPath string) *resolvedString {
		if bl == nil || bl.Kind != token.STRING {
			return nil
		}
		val, err := unquoteGoString(bl.Value)
		if err != nil {
			return nil
		}
		return &resolvedString{value: val, lit: bl, repoPath: repoPath}
	}
	switch e := expr.(type) {
	case *ast.BasicLit:
		return fromLit(e, fi.repoPath)
	case *ast.Ident:
		if e.Obj != nil {
			// Declared in this file: only a constant with a literal value.
			if e.Obj.Kind != ast.Con {
				return nil
			}
			vs, ok := e.Obj.Decl.(*ast.ValueSpec)
			if !ok || len(vs.Names) != len(vs.Values) {
				return nil
			}
			for i, name := range vs.Names {
				if name.Name == e.Name {
					bl, _ := vs.Values[i].(*ast.BasicLit)
					return fromLit(bl, fi.repoPath)
				}
			}
			return nil
		}
		// Unresolved in this file: a package-level constant in another file
		// of the same package, if any.
		if c, ok := a.consts[fi.importPath][e.Name]; ok {
			return fromLit(c.lit, c.repoPath)
		}
	case *ast.SelectorExpr:
		pkgIdent, ok := e.X.(*ast.Ident)
		if !ok || pkgIdent.Obj != nil {
			return nil
		}
		importPath, ok := a.fileImports[fi.file][pkgIdent.Name]
		if !ok {
			return nil
		}
		if c, ok := a.consts[importPath][e.Sel.Name]; ok {
			return fromLit(c.lit, c.repoPath)
		}
	}
	return nil
}

// unquoteGoString decodes a Go source string literal token (double-quoted
// or backtick raw) to its value.
func unquoteGoString(raw string) (string, error) {
	if strings.HasPrefix(raw, "`") {
		return strings.Trim(raw, "`"), nil
	}
	var out strings.Builder
	s := strings.Trim(raw, `"`)
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			i++
			switch s[i] {
			case 'n':
				out.WriteByte('\n')
			case 't':
				out.WriteByte('\t')
			case '"', '\\':
				out.WriteByte(s[i])
			default:
				out.WriteByte(s[i])
			}
			continue
		}
		out.WriteByte(s[i])
	}
	return out.String(), nil
}

func firstToken(s string) string {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

// callTarget resolves an AddCommand argument expression to the funcInfo it
// ultimately calls, following at most one level of local-variable
// indirection within the same function body.
func (a *analyzer) callTarget(fromFile *ast.File, fromPkg *pkgInfo, fd *ast.FuncDecl, expr ast.Expr) *funcInfo {
	switch e := expr.(type) {
	case *ast.CallExpr:
		return a.resolveCall(fromFile, fromPkg, e)
	case *ast.Ident:
		// A local variable: find its assignment from a call expression
		// anywhere earlier in the same function body.
		var target *funcInfo
		ast.Inspect(fd.Body, func(n ast.Node) bool {
			asn, ok := n.(*ast.AssignStmt)
			if !ok {
				return true
			}
			for i, lhs := range asn.Lhs {
				lid, ok := lhs.(*ast.Ident)
				if !ok || lid.Name != e.Name || i >= len(asn.Rhs) {
					continue
				}
				if call, ok := asn.Rhs[i].(*ast.CallExpr); ok {
					if fi := a.resolveCall(fromFile, fromPkg, call); fi != nil {
						target = fi
					}
				}
			}
			return true
		})
		return target
	}
	return nil
}

// resolveCall resolves a call expression's target function, whether
// same-package unqualified (newFooCommand(...)) or cross-package qualified
// (pkgalias.NewCommand(...)). Qualified calls resolve the alias against
// fromFile's OWN imports, never a package-wide map: two files in the same
// package are free to alias different import paths to the same short name.
func (a *analyzer) resolveCall(fromFile *ast.File, fromPkg *pkgInfo, call *ast.CallExpr) *funcInfo {
	switch fun := call.Fun.(type) {
	case *ast.Ident:
		if funcs := a.funcsByPath[fromPkg.importPath]; funcs != nil {
			return funcs[fun.Name]
		}
	case *ast.SelectorExpr:
		ident, ok := fun.X.(*ast.Ident)
		if !ok {
			return nil
		}
		importPath, ok := a.fileImports[fromFile][ident.Name]
		if !ok {
			return nil
		}
		if funcs := a.funcsByPath[importPath]; funcs != nil {
			return funcs[fun.Sel.Name]
		}
	}
	return nil
}

// walk performs the call-graph DFS from the root function, emitting one
// CommandLocation per resolved node.
func (a *analyzer) walk(fd *ast.FuncDecl, parentPath string) {
	// A factory reused in more than one place in the tree is legitimate
	// (cobra allows attaching the same command in two places, and command
	// trees in this codebase do exactly that) -- only re-entering a
	// function that is already on THIS path's active call stack is an
	// actual cycle, which valid command-tree code cannot form. Scoped to
	// the current DFS path (pushed on entry, popped on return), not a
	// global visit count: a global count can't distinguish "this function
	// legitimately appears N times, each independently," which the
	// codebase's own examples show happening well past any small N.
	if a.callStack[fd] {
		return
	}
	a.callStack[fd] = true
	defer delete(a.callStack, fd)

	fi := a.funcInfoOf(fd)
	if fi == nil {
		return
	}
	lit := findOwnCommandLiteral(fd)
	if lit == nil {
		return
	}
	use, _ := stringField(lit, "Use")
	name := firstToken(use)
	if name == "" {
		a.unresolvedUseFields++
		return
	}
	path := name
	if parentPath != "" {
		path = parentPath + " " + name
	}

	loc := a.commandDescriptionLocation(fi, lit)
	flags := a.findFlagLocations(fi, fd, lit)
	a.locations = append(a.locations, CommandLocation{Path: path, Description: loc, Flags: flags})

	pkg := a.pkgs[fi.importPath]
	selfVar := commandVarName(fd, lit)
	if selfVar == "" {
		// The command literal was returned directly with no local variable
		// (e.g. `return &cobra.Command{...}`), so there is no identifier to
		// scope an AddCommand receiver check to. Without one, ANY
		// .AddCommand(...) call anywhere else in this function body -- on
		// a completely unrelated command variable -- would be misattributed
		// as this command's own child. Skip the scan entirely rather than
		// scanning unscoped: a function that returns its command directly
		// has no local variable to attach children to in the first place,
		// so it can have no children of its own to find here.
		return
	}
	a.walkChildren(fi, selfVar, path)

	// A helper that takes the command as a parameter and attaches children
	// to it, such as addPlatformDependentCmds(fs, p, root) in pkg/cli. Its
	// AddCommand calls are on the parameter, so follow the call one level
	// with the parameter name as the receiver.
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		for i, arg := range call.Args {
			id, ok := arg.(*ast.Ident)
			if !ok || id.Name != selfVar {
				continue
			}
			helper := a.resolveCall(fi.file, pkg, call)
			if helper == nil || helper.decl == fd {
				continue
			}
			if param := paramName(helper.decl, i); param != "" {
				a.walkChildren(helper, param, path)
			}
		}
		return true
	})
}

// walkChildren walks every `<recvVar>.AddCommand(...)` argument in fi's
// body as a child of path.
func (a *analyzer) walkChildren(fi *funcInfo, recvVar, path string) {
	pkg := a.pkgs[fi.importPath]
	ast.Inspect(fi.decl.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "AddCommand" {
			return true
		}
		if recv, ok := sel.X.(*ast.Ident); !ok || recv.Name != recvVar {
			return true
		}
		for _, arg := range call.Args {
			target := a.callTarget(fi.file, pkg, fi.decl, arg)
			if target == nil {
				a.unresolvedAddCommandArgs++
				continue
			}
			a.walk(target.decl, path)
		}
		return true
	})
}

// paramName returns the name of fd's i-th parameter, or "" when there is
// none (or it is unnamed or variadic).
func paramName(fd *ast.FuncDecl, i int) string {
	if fd.Type.Params == nil {
		return ""
	}
	idx := 0
	for _, field := range fd.Type.Params.List {
		if _, variadic := field.Type.(*ast.Ellipsis); variadic {
			return ""
		}
		if len(field.Names) == 0 {
			if idx == i {
				return ""
			}
			idx++
			continue
		}
		for _, name := range field.Names {
			if idx == i {
				if name.Name == "_" {
					return ""
				}
				return name.Name
			}
			idx++
		}
	}
	return ""
}

func (a *analyzer) funcInfoOf(fd *ast.FuncDecl) *funcInfo {
	for _, funcs := range a.funcsByPath {
		for _, fi := range funcs {
			if fi.decl == fd {
				return fi
			}
		}
	}
	return nil
}

// commandVarName returns the identifier this function's command literal was
// assigned to, or "" when it's returned directly with no local variable
// (in which case AddCommand, if any, must be called on it before the return
// -- not supported; such functions have no children in practice).
//
// Matches both `cmd := &cobra.Command{...}` / `cmd = &cobra.Command{...}`
// (*ast.AssignStmt) and `var cmd *cobra.Command = &cobra.Command{...}`
// (*ast.GenDecl/*ast.ValueSpec) -- both are real, valid Go for building the
// same command, and only matching the first silently drops every flag
// registered on a command built the second way (findFlagLocations requires
// a non-empty name).
func commandVarName(fd *ast.FuncDecl, lit *ast.CompositeLit) string {
	unwrap := func(rhs ast.Expr) ast.Expr {
		if u, ok := rhs.(*ast.UnaryExpr); ok && u.Op == token.AND {
			return u.X
		}
		return rhs
	}
	var name string
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		switch decl := n.(type) {
		case *ast.AssignStmt:
			if len(decl.Lhs) != 1 || len(decl.Rhs) != 1 {
				return true
			}
			if unwrap(decl.Rhs[0]) == ast.Node(lit) {
				if id, ok := decl.Lhs[0].(*ast.Ident); ok {
					name = id.Name
				}
			}
		case *ast.ValueSpec:
			if len(decl.Names) != 1 || len(decl.Values) != 1 {
				return true
			}
			if unwrap(decl.Values[0]) == ast.Node(lit) {
				name = decl.Names[0].Name
			}
		}
		return true
	})
	return name
}

// commandDescriptionLocation mirrors printtree.go's own priority: Long if
// non-empty, else Short. When Long is set to something whose value is not
// known statically (a variable, a concatenation, fmt.Sprintf(...)),
// --print-tree reports that runtime value, not Short. Return nil in that
// case rather than the Short line: a rewrite there would replace Short with
// long-description text. Short is used only when Long is absent or empty.
func (a *analyzer) commandDescriptionLocation(fi *funcInfo, lit *ast.CompositeLit) *Location {
	if expr := fieldValue(lit, "Long"); expr != nil {
		long := a.resolveString(fi, expr)
		if long == nil {
			return nil
		}
		if long.value != "" {
			return &Location{File: long.repoPath, Line: a.fset.Position(long.lit.Pos()).Line}
		}
	}
	if expr := fieldValue(lit, "Short"); expr != nil {
		if short := a.resolveString(fi, expr); short != nil {
			return &Location{File: short.repoPath, Line: a.fset.Position(short.lit.Pos()).Line}
		}
	}
	return nil
}

// pflagValueTypes are the value types pflag generates registration methods
// for: <T>, <T>P, <T>Var and <T>VarP.
var pflagValueTypes = []string{
	"Bool", "BoolSlice", "BytesBase64", "BytesHex", "Count", "Duration",
	"DurationSlice", "Float32", "Float32Slice", "Float64", "Float64Slice",
	"Int", "Int8", "Int16", "Int32", "Int32Slice", "Int64", "Int64Slice",
	"IntSlice", "IP", "IPMask", "IPNet", "IPSlice", "String", "StringArray",
	"StringSlice", "StringToInt", "StringToInt64", "StringToString", "Uint",
	"Uint8", "Uint16", "Uint32", "Uint64", "UintSlice",
}

// flagRegistrationMethods maps every pflag FlagSet method that registers a
// flag to the index of its name argument. For all of them the usage string
// is the last argument. Anything else called on Flags()/PersistentFlags()
// (MarkHidden, MarkDeprecated, Lookup, SetAnnotation, ...) also takes the
// flag name as a string literal, but is not a registration: matching it
// would point source_line at the wrong statement.
var flagRegistrationMethods = func() map[string]int {
	m := map[string]int{"Var": 1, "VarP": 1, "VarPF": 1}
	for _, t := range pflagValueTypes {
		m[t] = 0
		m[t+"P"] = 0
		m[t+"Var"] = 1
		m[t+"VarP"] = 1
	}
	return m
}()

// findFlagLocations finds every `<selfVar>.Flags().<Method>(...)` /
// `<selfVar>.PersistentFlags().<Method>(...)` call in fd's body and resolves
// each one's flag name and usage-string location, skipping any call whose
// name or usage argument isn't a plain string literal.
func (a *analyzer) findFlagLocations(fi *funcInfo, fd *ast.FuncDecl, lit *ast.CompositeLit) []FlagLocation {
	selfVar := commandVarName(fd, lit)
	if selfVar == "" {
		return nil
	}
	// Local names for this command's flag set: `f := cmd.Flags()`.
	aliases := map[*ast.Object]bool{}
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		asn, ok := n.(*ast.AssignStmt)
		if !ok || asn.Tok != token.DEFINE || len(asn.Lhs) != 1 || len(asn.Rhs) != 1 {
			return true
		}
		if id, ok := asn.Lhs[0].(*ast.Ident); ok && id.Obj != nil && isFlagSetOf(asn.Rhs[0], selfVar) {
			aliases[id.Obj] = true
		}
		return true
	})
	var flags []FlagLocation
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		method, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		if !isFlagSetOf(method.X, selfVar) && !isAlias(method.X, aliases) {
			return true
		}
		nameIdx, isRegistration := flagRegistrationMethods[method.Sel.Name]
		if !isRegistration || nameIdx+1 >= len(call.Args) {
			return true
		}
		flagName := a.resolveString(fi, call.Args[nameIdx])
		if flagName == nil {
			return true // computed flag name; not resolvable
		}
		usage := a.resolveString(fi, call.Args[len(call.Args)-1])
		if usage == nil {
			return true // computed usage string; not resolvable
		}
		pos := a.fset.Position(usage.lit.Pos())
		flags = append(flags, FlagLocation{Flag: flagName.value, Location: Location{File: usage.repoPath, Line: pos.Line}})
		return true
	})
	return dropAmbiguousFlags(flags)
}

// isFlagSetOf reports whether expr is `<cmdVar>.Flags()` or
// `<cmdVar>.PersistentFlags()`.
func isFlagSetOf(expr ast.Expr, cmdVar string) bool {
	call, ok := expr.(*ast.CallExpr)
	if !ok || len(call.Args) != 0 {
		return false
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || (sel.Sel.Name != "Flags" && sel.Sel.Name != "PersistentFlags") {
		return false
	}
	recv, ok := sel.X.(*ast.Ident)
	return ok && recv.Name == cmdVar
}

// isAlias reports whether expr is an identifier bound by `x := cmd.Flags()`
// (one of aliases). Matching by declaration, not by name, keeps a
// same-named variable in another scope out.
func isAlias(expr ast.Expr, aliases map[*ast.Object]bool) bool {
	id, ok := expr.(*ast.Ident)
	return ok && id.Obj != nil && aliases[id.Obj]
}

// dropAmbiguousFlags removes every flag registered on more than one line of
// the same function (for example in two branches of an if): which usage
// string --print-tree reports depends on runtime state, so neither line is
// known to be right.
func dropAmbiguousFlags(flags []FlagLocation) []FlagLocation {
	lines := map[string]map[int]bool{}
	for _, f := range flags {
		if lines[f.Flag] == nil {
			lines[f.Flag] = map[int]bool{}
		}
		lines[f.Flag][f.Line] = true
	}
	var out []FlagLocation
	seen := map[string]bool{}
	for _, f := range flags {
		if len(lines[f.Flag]) > 1 || seen[f.Flag] {
			continue
		}
		seen[f.Flag] = true
		out = append(out, f)
	}
	return out
}
