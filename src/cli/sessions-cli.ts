// CLI commands for session management
import { getSessionManager } from '../sessions/index.js'
import { getAgentManager } from '../agents/manager.js'

export function sessionList(options: { agentId?: string }): void {
  const sm = getSessionManager()
  const sessions = sm.listSessions(options.agentId)

  console.log('\nSessions:')
  console.log('─'.repeat(70))

  if (sessions.length === 0) {
    console.log('No sessions found.')
    return
  }

  for (const session of sessions) {
    const date = new Date(session.updatedAt).toLocaleString()
    console.log(`  ${session.sessionId.slice(0, 8)}...`)
    console.log(`    Title:    ${session.title || '(untitled)'}`)
    console.log(`    Agent:    ${session.agentId}`)
    console.log(`    Messages: ${session.messageCount}`)
    console.log(`    Updated:  ${date}`)
    console.log('')
  }
}

export function sessionShow(sessionId: string): void {
  const sm = getSessionManager()

  // 支持短 ID
  const sessions = sm.listSessions()
  const session = sessions.find(
    (s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId)
  )

  if (!session) {
    console.error(`\nSession not found: ${sessionId}`)
    process.exit(1)
  }

  const messages = sm.loadTranscript(session.sessionId)

  console.log(`\nSession: ${session.sessionId}`)
  console.log(`Title: ${session.title || '(untitled)'}`)
  console.log(`Agent: ${session.agentId}`)
  console.log('─'.repeat(70))

  for (const msg of messages) {
    if (msg.role === 'system') continue // 跳过系统消息
    if (msg.role === 'tool') continue // 跳过工具结果

    const prefix = msg.role === 'user' ? '👤 User' : '🤖 Assistant'
    const content = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content
    console.log(`\n${prefix}:`)
    console.log(content)
  }
}

export function sessionDelete(sessionId: string): void {
  const sm = getSessionManager()

  // 支持短 ID
  const sessions = sm.listSessions()
  const session = sessions.find(
    (s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId)
  )

  if (!session) {
    console.error(`\nSession not found: ${sessionId}`)
    process.exit(1)
  }

  sm.deleteSession(session.sessionId)
  console.log(`\nDeleted session: ${session.sessionId}`)
}

export function sessionCreate(options: { agentId?: string; title?: string }): void {
  const sm = getSessionManager()
  const am = getAgentManager()

  const agentId = options.agentId || am.getDefaultAgent()?.agentId || 'default'
  const sessionKey = `cli:${Date.now()}`
  const session = sm.createSession(sessionKey, agentId, options.title)

  console.log(`\nCreated session: ${session.sessionId}`)
  console.log(`  Agent: ${session.agentId}`)
  console.log(`  Title: ${session.title}`)
}
