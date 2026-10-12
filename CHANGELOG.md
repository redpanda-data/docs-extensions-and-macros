# Changelog

## [5.54.0](https://github.com/redpanda-data/docs-extensions-and-macros/compare/v5.53.0...v5.54.0) (2026-10-09)


### Features

* **connect-docs:** check the Connect docs build from connect PRs ([#361](https://github.com/redpanda-data/docs-extensions-and-macros/issues/361)) ([8ea62d7](https://github.com/redpanda-data/docs-extensions-and-macros/commit/8ea62d7287c87cd3e3b167cd8ffebd6f6f617f28))
* **rpcn-docs:** download the Connect docs asset with the GitHub token when there is one ([#368](https://github.com/redpanda-data/docs-extensions-and-macros/issues/368)) ([fd0b193](https://github.com/redpanda-data/docs-extensions-and-macros/commit/fd0b19342ae3cc77b4f2d9e08b28a64be5bca616))
* **rpcn-docs:** source connect reference docs from the release asset ([#358](https://github.com/redpanda-data/docs-extensions-and-macros/issues/358)) ([88e21d8](https://github.com/redpanda-data/docs-extensions-and-macros/commit/88e21d819e2b0842b585238e75adee67c9fe3b55))


### Bug fixes

* **connect-docs:** count generated files that replace committed copies as used ([#367](https://github.com/redpanda-data/docs-extensions-and-macros/issues/367)) ([c1d254a](https://github.com/redpanda-data/docs-extensions-and-macros/commit/c1d254a9743200cab95f9d92eb42fa52116f51bb))
* **url-to-xref:** drop the new-window caret from converted link text ([#365](https://github.com/redpanda-data/docs-extensions-and-macros/issues/365)) ([cc5fa01](https://github.com/redpanda-data/docs-extensions-and-macros/commit/cc5fa01ed7b66dce2eec02a90836c21e52c40334))

## [5.53.0](https://github.com/redpanda-data/docs-extensions-and-macros/compare/v5.52.0...v5.53.0) (2026-10-05)


### Features

* **release-notes:** add doc-tools generate redpanda-release-notes command (DOC-2468) ([#337](https://github.com/redpanda-data/docs-extensions-and-macros/issues/337)) ([0a88545](https://github.com/redpanda-data/docs-extensions-and-macros/commit/0a885450afd68e4faf7efab3333ba1892d58f684))

## [5.52.0](https://github.com/redpanda-data/docs-extensions-and-macros/compare/v5.51.2...v5.52.0) (2026-10-05)


### Features

* **lint-strings:** cover connect's published strings end to end ([#353](https://github.com/redpanda-data/docs-extensions-and-macros/issues/353)) ([7d5e61d](https://github.com/redpanda-data/docs-extensions-and-macros/commit/7d5e61d217460c2f6506855462c4905c947e2f6b))
* **rpcn-docs:** source connector reference partials from the connect repo ([#345](https://github.com/redpanda-data/docs-extensions-and-macros/issues/345)) ([ecb1fd6](https://github.com/redpanda-data/docs-extensions-and-macros/commit/ecb1fd6868bf98064f7f88a0a52bce98f0c7433a))


### Bug fixes

* **rpk-docs:** sentence-case section titles ([#352](https://github.com/redpanda-data/docs-extensions-and-macros/issues/352)) ([fb41744](https://github.com/redpanda-data/docs-extensions-and-macros/commit/fb4174472949309d903855d7203a1dcc31c51d9b))


### Reusable workflows and CI

* **doc-strings-review:** send the PR's base and default branch with doc-impact ([#346](https://github.com/redpanda-data/docs-extensions-and-macros/issues/346)) ([31f0fd5](https://github.com/redpanda-data/docs-extensions-and-macros/commit/31f0fd5c0447998d5f8b744aa1d73d05aa12b4a5))

## [5.51.2](https://github.com/redpanda-data/docs-extensions-and-macros/compare/v5.51.1...v5.51.2) (2026-10-05)


### Bug fixes

* **rpk-docs:** keep SSO upper case in section titles ([#351](https://github.com/redpanda-data/docs-extensions-and-macros/issues/351)) ([48f6642](https://github.com/redpanda-data/docs-extensions-and-macros/commit/48f66422d96e5686a69134ce944e6a048555a06a))

## [5.51.1](https://github.com/redpanda-data/docs-extensions-and-macros/compare/v5.51.0...v5.51.1) (2026-10-05)


### Bug fixes

* **rpk-docs:** handle asPartial subtrees in What's new and subcommand tables ([#349](https://github.com/redpanda-data/docs-extensions-and-macros/issues/349)) ([fbd9c62](https://github.com/redpanda-data/docs-extensions-and-macros/commit/fbd9c6221b851025eb35639b85b22b35254eb758))


### Reusable workflows and CI

* release with release-please ([#348](https://github.com/redpanda-data/docs-extensions-and-macros/issues/348)) ([edff958](https://github.com/redpanda-data/docs-extensions-and-macros/commit/edff95877e68bf9fe9e16b808a0af5c225a0a06d))
