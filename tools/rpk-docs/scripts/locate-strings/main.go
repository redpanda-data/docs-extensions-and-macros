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
// Deliberately conservative: any construct outside these patterns (a
// computed Use/description, an AddCommand argument that isn't a resolvable
// call or literal, a flag whose name or usage argument isn't a plain string
// literal) is left unresolved rather than guessed. Every emitted location is
// either exactly right or absent -- there is no third, approximate case.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
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

// pkgInfo is everything gathered about one Go package directory.
type pkgInfo struct {
	importPath string
	files      []*ast.File
	imports    map[string]string // alias -> import path, per file merged (fine: aliases rarely collide across files in one package)
}

type analyzer struct {
	fset        *token.FileSet
	repoRoot    string
	modulePath  string
	funcsByPath map[string]map[string]*funcInfo // importPath -> funcName -> info
	pkgs        map[string]*pkgInfo             // importPath -> info

	visitedFuncs map[*ast.FuncDecl]bool // global re-entrancy guard against pathological cycles
	results      map[*ast.FuncDecl][]string
	locations    []CommandLocation

	unresolvedAddCommandArgs int
	unresolvedUseFields      int
}

// newAnalyzer builds an empty analyzer ready for analyze().
func newAnalyzer() *analyzer {
	return &analyzer{
		fset:         token.NewFileSet(),
		funcsByPath:  map[string]map[string]*funcInfo{},
		pkgs:         map[string]*pkgInfo{},
		visitedFuncs: map[*ast.FuncDecl]bool{},
		results:      map[*ast.FuncDecl][]string{},
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
	flag.Parse()
	if *repo == "" {
		fmt.Fprintln(os.Stderr, "usage: locate-strings --repo <path to src/go/rpk>")
		os.Exit(2)
	}

	a := newAnalyzer()
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
			pkg = &pkgInfo{importPath: importPath, imports: map[string]string{}}
			a.pkgs[importPath] = pkg
		}
		pkg.files = append(pkg.files, file)
		for _, imp := range file.Imports {
			p := strings.Trim(imp.Path.Value, `"`)
			alias := lastSegment(p)
			if imp.Name != nil {
				alias = imp.Name.Name
			}
			if alias == "_" || alias == "." {
				continue
			}
			pkg.imports[alias] = p
		}

		relPath, err := filepath.Rel(a.repoRoot, path)
		if err != nil {
			return err
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
	// More than one: prefer whichever is part of a `return &cobra.Command{...}`
	// or `return cobra.Command{...}` statement, since that is unambiguous
	// about which literal this function itself hands to its caller.
	for _, lit := range found {
		if isReturnedDirectly(fd, lit) {
			return lit
		}
	}
	// Otherwise ambiguous: don't guess.
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
		return a.resolveCall(fromPkg, e)
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
					if fi := a.resolveCall(fromPkg, call); fi != nil {
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
// (pkgalias.NewCommand(...)).
func (a *analyzer) resolveCall(fromPkg *pkgInfo, call *ast.CallExpr) *funcInfo {
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
		importPath, ok := fromPkg.imports[ident.Name]
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
	if a.visitedFuncs[fd] {
		// A factory reused in more than one place in the tree is legitimate
		// (cobra allows attaching the same command in two places); this
		// guard only stops runaway recursion if the call graph ever formed
		// an actual cycle, which valid command-tree code cannot do.
		if len(a.results[fd]) > 8 {
			return
		}
	}
	a.visitedFuncs[fd] = true

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
	a.results[fd] = append(a.results[fd], path)

	loc := commandDescriptionLocation(a.fset, fi.repoPath, lit)
	flags := a.findFlagLocations(fi, fd, lit)
	a.locations = append(a.locations, CommandLocation{Path: path, Description: loc, Flags: flags})

	pkg := a.pkgs[fi.importPath]
	selfVar := commandVarName(fd, lit)
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "AddCommand" {
			return true
		}
		if selfVar != "" {
			if recv, ok := sel.X.(*ast.Ident); !ok || recv.Name != selfVar {
				return true
			}
		}
		for _, arg := range call.Args {
			target := a.callTarget(fi.file, pkg, fd, arg)
			if target == nil {
				a.unresolvedAddCommandArgs++
				continue
			}
			a.walk(target.decl, path)
		}
		return true
	})
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
func commandVarName(fd *ast.FuncDecl, lit *ast.CompositeLit) string {
	var name string
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		asn, ok := n.(*ast.AssignStmt)
		if !ok || len(asn.Lhs) != 1 || len(asn.Rhs) != 1 {
			return true
		}
		rhs := asn.Rhs[0]
		if u, ok := rhs.(*ast.UnaryExpr); ok && u.Op == token.AND {
			rhs = u.X
		}
		if rhs == ast.Node(lit) {
			if id, ok := asn.Lhs[0].(*ast.Ident); ok {
				name = id.Name
			}
		}
		return true
	})
	return name
}

// commandDescriptionLocation mirrors printtree.go's own priority: Long if
// present, else Short.
func commandDescriptionLocation(fset *token.FileSet, repoPath string, lit *ast.CompositeLit) *Location {
	if _, bl := stringField(lit, "Long"); bl != nil {
		pos := fset.Position(bl.Pos())
		return &Location{File: repoPath, Line: pos.Line}
	}
	if _, bl := stringField(lit, "Short"); bl != nil {
		pos := fset.Position(bl.Pos())
		return &Location{File: repoPath, Line: pos.Line}
	}
	return nil
}

// varsFlagMethod names that take a pointer as their first argument
// (StringVar, BoolVarP, ...); every other registration method's flag name
// is its own first argument (String, BoolP, ...). The usage string is
// always the last argument either way -- true for every pflag registration
// method.
func isVarMethod(name string) bool {
	return strings.Contains(name, "Var")
}

// findFlagLocations finds every `<selfVar>.Flags().<Method>(...)` /
// `<selfVar>.PersistentFlags().<Method>(...)` call in fd's body and resolves
// each one's flag name and usage-string location, skipping any call whose
// name or usage argument isn't a plain string literal.
func (a *analyzer) findFlagLocations(fi *funcInfo, fd *ast.FuncDecl, lit *ast.CompositeLit) []FlagLocation {
	selfVar := commandVarName(fd, lit)
	if selfVar == "" {
		return nil
	}
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
		flagSetCall, ok := method.X.(*ast.CallExpr)
		if !ok {
			return true
		}
		flagSetSel, ok := flagSetCall.Fun.(*ast.SelectorExpr)
		if !ok || (flagSetSel.Sel.Name != "Flags" && flagSetSel.Sel.Name != "PersistentFlags") {
			return true
		}
		recv, ok := flagSetSel.X.(*ast.Ident)
		if !ok || recv.Name != selfVar {
			return true
		}
		if len(call.Args) == 0 {
			return true
		}
		nameIdx := 0
		if isVarMethod(method.Sel.Name) {
			nameIdx = 1
		}
		if nameIdx >= len(call.Args) {
			return true
		}
		nameLit, ok := call.Args[nameIdx].(*ast.BasicLit)
		if !ok || nameLit.Kind != token.STRING {
			return true // computed flag name; not resolvable
		}
		flagName, err := unquoteGoString(nameLit.Value)
		if err != nil {
			return true
		}
		usageArg := call.Args[len(call.Args)-1]
		usageLit, ok := usageArg.(*ast.BasicLit)
		if !ok || usageLit.Kind != token.STRING {
			return true // computed usage string; not resolvable
		}
		pos := a.fset.Position(usageLit.Pos())
		flags = append(flags, FlagLocation{Flag: flagName, Location: Location{File: fi.repoPath, Line: pos.Line}})
		return true
	})
	return flags
}
