import { Command } from 'commander'
import { connectCommand } from './commands/connect.js'
import { addressCommand } from './commands/address.js'
import { sessionsCommand } from './commands/sessions.js'
import { disconnectCommand } from './commands/disconnect.js'
import { balancesCommand } from './commands/balances.js'
import { sendNativeCommand } from './commands/send-native.js'
import { sendErc20Command } from './commands/send-erc20.js'
import { sendTokenCommand } from './commands/send-token.js'

const program = new Command()
  .name('polygon-agent')
  .description('Polygon Agent Wallet CLI')
  .version('0.1.0')

program.addCommand(connectCommand)
program.addCommand(addressCommand)
program.addCommand(sessionsCommand)
program.addCommand(disconnectCommand)
program.addCommand(balancesCommand)
program.addCommand(sendNativeCommand)
program.addCommand(sendErc20Command)
program.addCommand(sendTokenCommand)

program.parse()
