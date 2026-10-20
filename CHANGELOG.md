# Changelog

## [5.55.0](https://github.com/redpanda-data/docs-extensions-and-macros/compare/v5.54.0...v5.55.0) (2026-10-19)


### Features

* **aggregate-terms:** link every component to one site glossary page ([#370](https://github.com/redpanda-data/docs-extensions-and-macros/issues/370)) ([d2911a4](https://github.com/redpanda-data/docs-extensions-and-macros/commit/d2911a43e3a82abb3a798a775d4a881fe0d9c215))
* **doc-strings-review:** save the docs MCP answers each review saw ([#364](https://github.com/redpanda-data/docs-extensions-and-macros/issues/364)) ([f54e74a](https://github.com/redpanda-data/docs-extensions-and-macros/commit/f54e74a719f8060f78dabc30592b55c28c43b139))
* **macros:** add iceberg-explorer block ([#219](https://github.com/redpanda-data/docs-extensions-and-macros/issues/219)) ([2ec0b0a](https://github.com/redpanda-data/docs-extensions-and-macros/commit/2ec0b0ad974a4b8bf7ecfbd8f170d8d170b8a3c2))
* **release-notes:** cluster release-note entries by area ([#359](https://github.com/redpanda-data/docs-extensions-and-macros/issues/359)) ([d0b3f4a](https://github.com/redpanda-data/docs-extensions-and-macros/commit/d0b3f4a423f9f0f49099570fdbaa19329d736896))
* **rpcn-docs:** add the connector data from the Connect docs asset ([#371](https://github.com/redpanda-data/docs-extensions-and-macros/issues/371)) ([b4908ce](https://github.com/redpanda-data/docs-extensions-and-macros/commit/b4908ce6e979d0a16a024ca58dee65220064dd54))
* **rpcn-docs:** date Connect pages by the release that changed their reference ([#375](https://github.com/redpanda-data/docs-extensions-and-macros/issues/375)) ([6698930](https://github.com/redpanda-data/docs-extensions-and-macros/commit/66989303ac3b664a141caf5cdc17b70f4947a034))


### Bug fixes

* attach Helm doc comments to the commented-out key that follows them ([#372](https://github.com/redpanda-data/docs-extensions-and-macros/issues/372)) ([1194b2f](https://github.com/redpanda-data/docs-extensions-and-macros/commit/1194b2fa7ed44f178a5e88c0a9495d8d222d9fbd))
* deploy the docs preview without running a site build ([#383](https://github.com/redpanda-data/docs-extensions-and-macros/issues/383)) ([613628d](https://github.com/redpanda-data/docs-extensions-and-macros/commit/613628d48614c327514252dd47cec88176a6eb03))
* **doc-strings-review:** diff a merge checkout against its first parent ([#360](https://github.com/redpanda-data/docs-extensions-and-macros/issues/360)) ([3e884eb](https://github.com/redpanda-data/docs-extensions-and-macros/commit/3e884eb9b45f0eff59f76b5d56d0f356c1f60085))
* honor descriptionScope cloud in rpk docs ([#374](https://github.com/redpanda-data/docs-extensions-and-macros/issues/374)) ([4312390](https://github.com/redpanda-data/docs-extensions-and-macros/commit/4312390307742bc8793f926f3cb62e5980f070e3))
* map unversioned operator branches to docs main in crd-spec ([#378](https://github.com/redpanda-data/docs-extensions-and-macros/issues/378)) ([2fae67a](https://github.com/redpanda-data/docs-extensions-and-macros/commit/2fae67acf95ffcd958c6aef4e5e7819d89f7982f))
* pin operator and Helm chart versions to each docs version's release line ([#373](https://github.com/redpanda-data/docs-extensions-and-macros/issues/373)) ([227e928](https://github.com/redpanda-data/docs-extensions-and-macros/commit/227e92867048e43cb87accd9a244329244e77f2e))
* render changed defaults in What's new as inline code ([#376](https://github.com/redpanda-data/docs-extensions-and-macros/issues/376)) ([6e379ad](https://github.com/redpanda-data/docs-extensions-and-macros/commit/6e379ad378f61c710f9c29bde8eaf15054f78135))
* **rpcn-docs:** stop defaulting to docs-data/overrides.json ([#380](https://github.com/redpanda-data/docs-extensions-and-macros/issues/380)) ([b0a3f39](https://github.com/redpanda-data/docs-extensions-and-macros/commit/b0a3f39255189b4002a84c92d89f96a2c4d6065c))
* **rpcn-docs:** use field short descriptions in whats-new tables ([#362](https://github.com/redpanda-data/docs-extensions-and-macros/issues/362)) ([b091d28](https://github.com/redpanda-data/docs-extensions-and-macros/commit/b091d286473f53769825a5f94e5083972f384804))

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
