# Changelog

## [5.59.2](https://github.com/redpanda-data/docs-extensions-and-macros/compare/v5.59.1...v5.59.2) (2026-10-31)


### Reusable workflows and CI

* **publish-to-npm:** dispatch only after npm serves the version ([#452](https://github.com/redpanda-data/docs-extensions-and-macros/issues/452)) ([6a1f73a](https://github.com/redpanda-data/docs-extensions-and-macros/commit/6a1f73a93419ac93b2e5aa55c05434ca7160d552))

## [5.59.1](https://github.com/redpanda-data/docs-extensions-and-macros/compare/v5.59.0...v5.59.1) (2026-10-30)


### Bug fixes

* **doc-strings-review:** stop telling connect authors to commit regenerated docs ([#467](https://github.com/redpanda-data/docs-extensions-and-macros/issues/467)) ([0f1fb05](https://github.com/redpanda-data/docs-extensions-and-macros/commit/0f1fb050ba21ca7134cdc6596036e26a777c02bb))

## [5.59.0](https://github.com/redpanda-data/docs-extensions-and-macros/compare/v5.58.0...v5.59.0) (2026-10-29)


### Features

* **lint-strings:** route rpk ai to the rpk surface and warn on long sentences ([#461](https://github.com/redpanda-data/docs-extensions-and-macros/issues/461)) ([2583d4c](https://github.com/redpanda-data/docs-extensions-and-macros/commit/2583d4cf69205ea3d0bc8be973772fef7fcfb1d1))

## [5.58.0](https://github.com/redpanda-data/docs-extensions-and-macros/compare/v5.57.0...v5.58.0) (2026-10-28)


### Features

* **doc-strings-review:** let a caller turn committable suggestions off ([#388](https://github.com/redpanda-data/docs-extensions-and-macros/issues/388)) ([23d31bb](https://github.com/redpanda-data/docs-extensions-and-macros/commit/23d31bb782ad7a23fd903e34e78dcfdf242b5e58))
* **prop:** add propval macro and migrate-property-values report ([#434](https://github.com/redpanda-data/docs-extensions-and-macros/issues/434)) ([47cb0c9](https://github.com/redpanda-data/docs-extensions-and-macros/commit/47cb0c97fc05003e2aa1582b26350b2422bf7bf8))


### Bug fixes

* **rpcn-docs:** don't report a newly stated default as a default change ([#395](https://github.com/redpanda-data/docs-extensions-and-macros/issues/395)) ([d344d84](https://github.com/redpanda-data/docs-extensions-and-macros/commit/d344d8424c44722bd44c331da4065fd496dad956))


### Reusable workflows and CI

* **property-corpus-drift:** open a refresh PR instead of filing an issue ([#443](https://github.com/redpanda-data/docs-extensions-and-macros/issues/443)) ([7de15b4](https://github.com/redpanda-data/docs-extensions-and-macros/commit/7de15b4c68888661838e4625e06a0c6bb5176c76))

## [5.57.0](https://github.com/redpanda-data/docs-extensions-and-macros/compare/v5.56.1...v5.57.0) (2026-10-28)


### Features

* **claude-skill:** make pr_number optional for headless callers ([#420](https://github.com/redpanda-data/docs-extensions-and-macros/issues/420)) ([2e090c9](https://github.com/redpanda-data/docs-extensions-and-macros/commit/2e090c94934f1a1d989f058531219c61f065c4b4))
* **release-notes:** link known configuration properties as prop: macros ([#398](https://github.com/redpanda-data/docs-extensions-and-macros/issues/398)) ([9098d84](https://github.com/redpanda-data/docs-extensions-and-macros/commit/9098d84b598dc60b841983e55f6097f77249f091))
* **release-notes:** list each area once per category, with entries as bullets ([#421](https://github.com/redpanda-data/docs-extensions-and-macros/issues/421)) ([2ef7f1f](https://github.com/redpanda-data/docs-extensions-and-macros/commit/2ef7f1ff00b7f6a1ae47d2e86d670a664d4a7c62))


### Bug fixes

* **docs-review:** pin claude-skill to [#303](https://github.com/redpanda-data/docs-extensions-and-macros/issues/303)'s merge SHA and post the status after a failed upsert ([#418](https://github.com/redpanda-data/docs-extensions-and-macros/issues/418)) ([0fac2b8](https://github.com/redpanda-data/docs-extensions-and-macros/commit/0fac2b82207dd97787654a990cd6baf95b2bfcbe))

## [5.56.1](https://github.com/redpanda-data/docs-extensions-and-macros/compare/v5.56.0...v5.56.1) (2026-10-27)


### Bug fixes

* **doc-impact:** dispatch each gating finding once and keep merged tickets honest ([#427](https://github.com/redpanda-data/docs-extensions-and-macros/issues/427)) ([3c3f8e6](https://github.com/redpanda-data/docs-extensions-and-macros/commit/3c3f8e625004e4e30c7072e5c7f3131629e13325))
* **doc-strings-review:** review only the lines a PR changed ([#399](https://github.com/redpanda-data/docs-extensions-and-macros/issues/399)) ([ff12dca](https://github.com/redpanda-data/docs-extensions-and-macros/commit/ff12dca4c8bab0e18562356e55e286e549d44edc))

## [5.56.0](https://github.com/redpanda-data/docs-extensions-and-macros/compare/v5.55.0...v5.56.0) (2026-10-26)


### Features

* add check-dispatch-graph for the repository_dispatch graph ([#409](https://github.com/redpanda-data/docs-extensions-and-macros/issues/409)) ([69ca241](https://github.com/redpanda-data/docs-extensions-and-macros/commit/69ca2410b3d62dfcbc8f2e09de9cf14c7efd1e5a))
* add page-introduced-in to the Markdown front matter ([#394](https://github.com/redpanda-data/docs-extensions-and-macros/issues/394)) ([3aa480a](https://github.com/redpanda-data/docs-extensions-and-macros/commit/3aa480a620f01f04ca2f5d7b8e958c95c127e95f))
* **doc-strings-review:** file doc-impact for enterprise gating changes ([#382](https://github.com/redpanda-data/docs-extensions-and-macros/issues/382)) ([6480a4e](https://github.com/redpanda-data/docs-extensions-and-macros/commit/6480a4e4d350c84d46f6fceb5826139d7ca249c3))
* **docs-pr-review:** report doc-tools check-metadata in the review ([#425](https://github.com/redpanda-data/docs-extensions-and-macros/issues/425)) ([9a0b5d4](https://github.com/redpanda-data/docs-extensions-and-macros/commit/9a0b5d4a3ddfcf32b1a5f8bb9e62caa93f08f433))
* **docs-review:** host the DOC-2496 docs-pr-review pipeline ([#303](https://github.com/redpanda-data/docs-extensions-and-macros/issues/303)) ([681c7a5](https://github.com/redpanda-data/docs-extensions-and-macros/commit/681c7a5774f3dd72733ca1f6f4bbdb8633f548a5))
* **lint-strings:** check env-cloud conditionals in connect spec strings ([#381](https://github.com/redpanda-data/docs-extensions-and-macros/issues/381)) ([c59938b](https://github.com/redpanda-data/docs-extensions-and-macros/commit/c59938bb64cd009c015ae08b19647c38ea963d17))
* record generated-content provenance in the Markdown twins ([#397](https://github.com/redpanda-data/docs-extensions-and-macros/issues/397)) ([55c3e87](https://github.com/redpanda-data/docs-extensions-and-macros/commit/55c3e87aa5dc3edb007ea2e4c393df7d689519d0))
* **sitemap-md:** use page titles and descriptions in Markdown sitemaps ([#403](https://github.com/redpanda-data/docs-extensions-and-macros/issues/403)) ([24c8bfc](https://github.com/redpanda-data/docs-extensions-and-macros/commit/24c8bfcf687ff78d1513fb86e043ebeaf08d4419))
* **taxonomy:** load the docs taxonomy, check page metadata, and emit taxonomy facets ([#423](https://github.com/redpanda-data/docs-extensions-and-macros/issues/423)) ([81ec5e5](https://github.com/redpanda-data/docs-extensions-and-macros/commit/81ec5e5392ffdf27fd1870f99280a08918756340))


### Bug fixes

* convert commented-out Helm value docs to AsciiDoc and keep straight quotes ([#407](https://github.com/redpanda-data/docs-extensions-and-macros/issues/407)) ([2b678fc](https://github.com/redpanda-data/docs-extensions-and-macros/commit/2b678fc862fb81b25bbb478c0a274bba172d60ef))
* **crd-spec:** convert docs URLs to xrefs against the docs checkout ([#414](https://github.com/redpanda-data/docs-extensions-and-macros/issues/414)) ([4457537](https://github.com/redpanda-data/docs-extensions-and-macros/commit/44575375b8d33d1d666cf70f3aafe59e0b0522cd))
* **doc-strings-review:** keep the review's file tools inside the workspace ([#389](https://github.com/redpanda-data/docs-extensions-and-macros/issues/389)) ([0db9792](https://github.com/redpanda-data/docs-extensions-and-macros/commit/0db9792f1f8c0e3746aba45514806a1b1ea3978f))
* **doc-strings-review:** read the staged standards before the first suggestion ([#415](https://github.com/redpanda-data/docs-extensions-and-macros/issues/415)) ([0b67e1f](https://github.com/redpanda-data/docs-extensions-and-macros/commit/0b67e1fd343fed65b8cca13be61042886b50b63a))
* **doc-strings-review:** skip strings a human reviewer wrote ([#396](https://github.com/redpanda-data/docs-extensions-and-macros/issues/396)) ([2e3844f](https://github.com/redpanda-data/docs-extensions-and-macros/commit/2e3844f4e74a929dca893124d150787538917e4c))
* keep every changed default literal and escape pipes in What's new descriptions ([#391](https://github.com/redpanda-data/docs-extensions-and-macros/issues/391)) ([212af80](https://github.com/redpanda-data/docs-extensions-and-macros/commit/212af80d9bf1f4c9c469fcd6ec83da9a96492280))
* **lint-strings:** read docs.Field declarations on the connect surface ([#417](https://github.com/redpanda-data/docs-extensions-and-macros/issues/417)) ([3294fe5](https://github.com/redpanda-data/docs-extensions-and-macros/commit/3294fe582841c5b878b5d93cc47c66f3dc082c2a))
* **lint-strings:** reject whitespace inside a conditional directive's brackets ([#404](https://github.com/redpanda-data/docs-extensions-and-macros/issues/404)) ([be365fa](https://github.com/redpanda-data/docs-extensions-and-macros/commit/be365faaa9d6084166e86f038aa95eee606c59e1))
* **lint-strings:** steer CRD field comments to a verb-led opener ([#405](https://github.com/redpanda-data/docs-extensions-and-macros/issues/405)) ([f3f026a](https://github.com/redpanda-data/docs-extensions-and-macros/commit/f3f026a7f8f0e47d574870b29eab73841ed71a51))
* **llms:** keep &lt;placeholders&gt; in page descriptions ([#402](https://github.com/redpanda-data/docs-extensions-and-macros/issues/402)) ([80198d6](https://github.com/redpanda-data/docs-extensions-and-macros/commit/80198d680c9082ffbd2340fe7f8091f99a2abc73))
* **property-docs:** render each include once when the input was already generated ([#406](https://github.com/redpanda-data/docs-extensions-and-macros/issues/406)) ([97e67b3](https://github.com/redpanda-data/docs-extensions-and-macros/commit/97e67b30dc47c597f3fbc1700734f4625f1015a8))
* **rpcn-docs:** keep sentences with dotted names whole in What's new summaries ([#400](https://github.com/redpanda-data/docs-extensions-and-macros/issues/400)) ([a3a061f](https://github.com/redpanda-data/docs-extensions-and-macros/commit/a3a061f526756a634a1df824ac52e4b2ac887b71))


### Reusable workflows and CI

* **rp-util-schema:** skip patch RCs the docs never read ([#393](https://github.com/redpanda-data/docs-extensions-and-macros/issues/393)) ([ac20687](https://github.com/redpanda-data/docs-extensions-and-macros/commit/ac2068786c163e491937852a1347d453ac258dc2))

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
