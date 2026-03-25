import { Command } from 'commander'

const program = new Command()
  .name('polygon-agent')
  .description('Polygon Agent Wallet CLI')
  .version('0.1.0')

// Commands will be registered here in subsequent tasks

program.parse()
