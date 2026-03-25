import { Command } from 'commander'
import { connectCommand } from './commands/connect.js'

const program = new Command()
  .name('polygon-agent')
  .description('Polygon Agent Wallet CLI')
  .version('0.1.0')

program.addCommand(connectCommand)

program.parse()
