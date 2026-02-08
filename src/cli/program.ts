// CLI Program: Main CLI entry point
import { Command } from 'commander'
import { runGateway } from './gateway-cli.js'
import { runAgent } from './agent-cli.js'
import { cronAdd, cronRemove, cronList } from './cron-cli.js'
import { sendTelegramMessage } from './telegram-cli.js'
import { agentList, agentCreate, agentDelete, agentSetDefault } from './agents-cli.js'
import { sessionList, sessionShow, sessionDelete, sessionCreate } from './sessions-cli.js'
import { configInit, configShow, configPath, configDir } from './config-cli.js'

export function createProgram(): Command {
  const program = new Command()

  program
    .name('mini-claw')
    .description('Mini-Claw: A minimal demo of OpenClaw architecture')
    .version('0.1.0')

  // ========== Config commands ==========
  const config = program
    .command('config')
    .description('Manage configuration (~/.mini-claw/config.json)')

  config
    .command('init')
    .description('Initialize configuration interactively')
    .action(configInit)

  config
    .command('show')
    .description('Show current configuration')
    .action(configShow)

  config
    .command('path')
    .description('Print config file path')
    .action(configPath)

  config
    .command('dir')
    .description('Print config directory path')
    .action(configDir)

  // Gateway command
  program
    .command('gateway')
    .description('Start the Gateway server')
    .action(runGateway)

  // Agent interactive command
  program
    .command('chat')
    .description('Start interactive CLI agent')
    .action(runAgent)

  // ========== Agents management ==========
  const agents = program
    .command('agents')
    .description('Manage agent configurations')

  agents
    .command('list')
    .description('List all agents')
    .action(agentList)

  agents
    .command('create <name> <model>')
    .description('Create a new agent')
    .option('-d, --description <desc>', 'Agent description')
    .option('-u, --base-url <url>', 'Custom API base URL')
    .action(agentCreate)

  agents
    .command('delete <agentId>')
    .description('Delete an agent')
    .action(agentDelete)

  agents
    .command('default <agentId>')
    .description('Set default agent')
    .action(agentSetDefault)

  // ========== Sessions management ==========
  const sessions = program
    .command('sessions')
    .description('Manage chat sessions')

  sessions
    .command('list')
    .description('List all sessions')
    .option('-a, --agent-id <agentId>', 'Filter by agent ID')
    .action(sessionList)

  sessions
    .command('show <sessionId>')
    .description('Show session messages')
    .action(sessionShow)

  sessions
    .command('create')
    .description('Create a new session')
    .option('-a, --agent-id <agentId>', 'Agent to use')
    .option('-t, --title <title>', 'Session title')
    .action(sessionCreate)

  sessions
    .command('delete <sessionId>')
    .description('Delete a session')
    .action(sessionDelete)

  // ========== Cron commands ==========
  const cron = program
    .command('cron')
    .description('Manage cron jobs')

  cron
    .command('add <schedule> <message>')
    .description('Add a new cron job (e.g., "*/1 * * * *" "Report time")')
    .action(cronAdd)

  cron
    .command('remove <id>')
    .description('Remove a cron job by ID')
    .action(cronRemove)

  cron
    .command('list')
    .description('List all cron jobs')
    .action(cronList)

  // Telegram mock command
  program
    .command('telegram <message>')
    .description('Send a message via mock Telegram channel')
    .action(sendTelegramMessage)

  return program
}
