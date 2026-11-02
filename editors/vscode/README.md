# Redpanda Docs for VS Code

A thin client for the docs language server in
`@redpanda-data/docs-extensions-and-macros` (`language-server/`). It adds, in
`.adoc` files of a Redpanda docs repository:

- Completion of property names after `prop:` and `propval:`, of `propval:`
  fields inside the brackets, and of taxonomy labels on `:page-categories:`.
- Hover with a property's description, type, default and limits, the value a
  `propval:` renders, and a category's definition.
- The warnings the build logs for an unknown or unavailable property, a
  `propval:` that renders `<unknown ...>`, and a `:page-categories:` value
  that is unknown or deprecated.
- A quick fix that replaces a deprecated category with its replacement, as
  `doc-tools check-metadata --fix` does.

The server comes from the repository's own `node_modules`, so run `npm install`
first. The editor then uses the same version of the macros as the build.

## Settings

- `redpandaDocs.serverPath`: a different `bin/docs-language-server.js`, such
  as one in a local clone of docs-extensions-and-macros.
- `redpandaDocs.docsPath`: a local checkout of `redpanda-data/docs`. Cloud
  pages need it for property data, and repositories without the taxonomy
  read `taxonomy.yml` from it.
- `redpandaDocs.componentPaths`: local checkouts of other docs components,
  for features that resolve references across components.
- `redpandaDocs.standardsPath`: a local checkout of
  `redpanda-data/docs-team-standards`, for features that read its templates
  or style rules.

Changing a setting restarts the server.

## Override schemas

`docs-data/property-overrides.json` and `docs-data/rpk-overrides.json` are
validated against the schemas in the workspace's installed
`@redpanda-data/docs-extensions-and-macros`, so the editor and the build use
the same version. Without the package installed they are not validated.

## Run it from source

```bash
cd editors/vscode
npm install
code --extensionDevelopmentPath="$PWD" /path/to/docs
```

## Package it

```bash
npx @vscode/vsce package
code --install-extension redpanda-docs-0.1.0.vsix
```
