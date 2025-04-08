const { Command } = require('commander');
const runExtractor = require('./extract');
const runDocs = require('./generate-docs');
const runClean = require('./clean');

module.exports = function handlePropsCLI(argv) {
  const program = new Command();

  program
    .name('doc-tools props')
    .description('Redpanda Property Generator CLI');

  program
    .command('extract')
    .description('Extract properties from Redpanda source')
    .option('--tag <tag>', 'Git tag or branch of Redpanda to extract from', 'dev')
    .action(runExtractor);

  program
    .command('generate-docs')
    .description('Generate AsciiDoc pages from extracted JSON')
    .action(runDocs);

  program
    .command('clean')
    .description('Clean generated files and environment')
    .action(runClean);

  program.parse(argv, { from: 'user' });
};
