const { Command } = require('commander')
const p = new Command()
p.command('x').action(async () => { throw new Error('boom') })
p.parse(['node','t','x'])
