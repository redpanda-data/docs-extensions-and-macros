'use strict'

// The plugin constants live here, free of the generator's side effects (it
// registers Handlebars helpers on load), so the rpkval: macro can read them
// inside an Antora build. generate-rpk-docs.js re-exports both.

/**
 * Known rpk plugins that are managed separately from rpk core (they have
 * install/uninstall/upgrade shim commands, and their real command tree only
 * appears when the plugin binary is installed in the generation environment).
 * Shared with rpk-docs-handler.js, which iterates this list to install each
 * plugin before running --print-tree.
 */
const KNOWN_PLUGINS = ['ai', 'check', 'connect', 'k8s', 'oxla']

/**
 * Subcommands that rpk core ships as a built-in shim for managed plugins,
 * present even when the plugin binary itself is not installed.
 */
const PLUGIN_SHIM_COMMANDS = new Set(['install', 'uninstall', 'upgrade'])

module.exports = { KNOWN_PLUGINS, PLUGIN_SHIM_COMMANDS }
