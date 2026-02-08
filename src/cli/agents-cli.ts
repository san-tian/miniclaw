// CLI commands for agent management
import { getAgentManager } from '../agents/manager.js'

export function agentList(): void {
  const am = getAgentManager()
  const agents = am.listAgents()
  const defaultId = am.getDefaultAgent()?.agentId

  console.log('\nAgents:')
  console.log('─'.repeat(60))

  if (agents.length === 0) {
    console.log('No agents configured.')
    return
  }

  for (const agent of agents) {
    const isDefault = agent.agentId === defaultId ? ' (default)' : ''
    console.log(`  ${agent.agentId}${isDefault}`)
    console.log(`    Name:  ${agent.name}`)
    console.log(`    Model: ${agent.model}`)
    if (agent.description) {
      console.log(`    Desc:  ${agent.description}`)
    }
    console.log('')
  }
}

export function agentCreate(name: string, model: string, options: { description?: string; baseUrl?: string }): void {
  const am = getAgentManager()
  const agent = am.createAgent({
    name,
    model,
    description: options.description,
    baseUrl: options.baseUrl,
  })

  console.log(`\nCreated agent: ${agent.agentId}`)
  console.log(`  Name:  ${agent.name}`)
  console.log(`  Model: ${agent.model}`)
}

export function agentDelete(agentId: string): void {
  const am = getAgentManager()
  const deleted = am.deleteAgent(agentId)

  if (deleted) {
    console.log(`\nDeleted agent: ${agentId}`)
  } else {
    console.error(`\nFailed to delete agent: ${agentId} (not found or is default)`)
    process.exit(1)
  }
}

export function agentSetDefault(agentId: string): void {
  const am = getAgentManager()
  const success = am.setDefaultAgent(agentId)

  if (success) {
    console.log(`\nSet default agent: ${agentId}`)
  } else {
    console.error(`\nAgent not found: ${agentId}`)
    process.exit(1)
  }
}
