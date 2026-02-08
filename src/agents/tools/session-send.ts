// Session Send Tool: allows Agent to send messages to a specific web session
import type { Tool } from './types.js'
import { createLogger } from '../../infra/logger.js'
import { getGatewayRef } from '../../gateway/gateway-ref.js'
import { getSessionManager } from '../../sessions/index.js'

const log = createLogger('tool:session_send')

export const sessionSendTool: Tool = {
  name: 'session_send',
  description: `Send a message to a Web UI session. The message is persisted to the session transcript and pushed to the connected browser via WebSocket.

Use this tool to:
- Deliver cron job results to a web session
- Send notifications to users on the Web UI
- Push async task results to a specific session

PARAMETERS:
- text: The message to send (required)
- session_id: Target session ID (optional - if not provided, lists available sessions)

To find available sessions, call with only text and no session_id - it will return a list of recent sessions.`,
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Message text to send',
      },
      session_id: {
        type: 'string',
        description: 'Target session ID (optional - omit to list available sessions)',
      },
    },
    required: ['text'],
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const text = input.text as string
    const sessionId = input.session_id as string | undefined

    if (!text?.trim()) {
      return JSON.stringify({ success: false, error: 'text is required' })
    }

    const sm = getSessionManager()

    // If no session_id provided, list available sessions
    if (!sessionId?.trim()) {
      const sessions = sm.listSessions()
        .filter(s => s.channel === 'websocket' || s.channel === 'web')
        .slice(0, 10)
        .map(s => ({
          id: s.sessionId,
          title: s.title,
          channel: s.channel,
          updatedAt: new Date(s.updatedAt).toISOString(),
        }))

      return JSON.stringify({
        success: false,
        error: 'session_id is required. Available web sessions:',
        sessions,
      })
    }

    // Verify session exists
    const session = sm.getSession(sessionId)
    if (!session) {
      return JSON.stringify({
        success: false,
        error: `Session not found: ${sessionId}`,
      })
    }

    try {
      // Persist the message to the session transcript as an assistant message
      // This ensures the message is part of the conversation history
      sm.appendMessage(sessionId, {
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
      })

      // Also try to send via WebSocket if client is connected
      const gatewayRef = getGatewayRef()
      if (gatewayRef) {
        const channel = session.channel || 'websocket'
        await gatewayRef.sendToSession(session.sessionKey, channel, text)
      }

      log.info(`Sent message to session ${sessionId}: ${text.slice(0, 50)}...`)

      return JSON.stringify({
        success: true,
        session_id: sessionId,
        session_title: session.title,
        persisted: true,
      })
    } catch (error) {
      log.error('Failed to send to session:', error)
      return JSON.stringify({
        success: false,
        error: (error as Error).message,
      })
    }
  },
}
