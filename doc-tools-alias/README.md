# doc-tools

Official alias package for the Redpanda `doc-tools` CLI.

The real implementation lives in
[`@redpanda-data/docs-extensions-and-macros`](https://www.npmjs.com/package/@redpanda-data/docs-extensions-and-macros),
which exposes the `doc-tools` and `doc-tools-mcp` bins. This package depends
on it and delegates both bins to it unchanged, so that:

```bash
npx doc-tools setup-mcp
```

works from any machine, whether or not the scoped package is installed
locally.

## Why this package exists

`npx` resolves bare names against the public npm registry. `doc-tools` and
`doc-tools-mcp` are bin names of the scoped package, not packages of their
own, so the unscoped names were claimable by anyone — and `doc-tools-mcp`
was in fact squatted by an unaffiliated account in July 2026, turning a
documented command into a dependency-confusion vector. Publishing this
official passthrough closes that vector for the `doc-tools` name.

If you already depend on `@redpanda-data/docs-extensions-and-macros`, keep
using it directly; you do not need this package.

## Documentation

See the [doc-tools user guide](https://github.com/redpanda-data/docs-extensions-and-macros/blob/main/mcp/USER_GUIDE.adoc).
