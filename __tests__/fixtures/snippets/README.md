Fixtures for the snippets feature (language-server/features/snippets.js).

`standards/` has the layout of docs-team-standards and `solutions/` the
layout of redpanda-solutions, with short stand-in text: both repositories are
private, so their files are not copied here. The tests check that every
snippet renders exactly the text of these files, and the same tests run
against real checkouts with DOCS_LS_REAL_STANDARDS and DOCS_LS_REAL_SOLUTIONS.
