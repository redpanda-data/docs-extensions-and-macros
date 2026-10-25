#!/usr/bin/env node
'use strict'

// The docs language server over stdio. Editors pass --stdio; it is also the
// default, since stdio is the only transport this server supports.
require('../language-server/server').startServer()
