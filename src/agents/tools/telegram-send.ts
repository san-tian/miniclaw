// Telegram Send Tool: allows Agent to send messages to Telegram
import { Bot } from 'grammy'
import type { Tool } from './types.js'
import { createLogger } from '../../infra/logger.js'
import { env } from '../../infra/env.js'
import { getConfigManager } from '../../config/index.js'
import { getSessionManager } from '../../sessions/index.js'

const log = createLogger('tool:telegram_send')

// Lazy-initialized bot instance for sending
let sendBot: Bot | null = null
let cachedConfig: { token?: string; defaultChatId?: string } | null = null

function loadTelegramConfig(): { token?: string; defaultChatId?: string } {
  if (cachedConfig) return cachedConfig

  const configManager = getConfigManager()
  const config = configManager.load()
  const token = config.telegram?.botToken || env.TELEGRAM_BOT_TOKEN
  // Use first allowFrom as default chat_id
  const allowFrom = config.telegram?.allowFrom || env.TELEGRAM_ALLOW_FROM || []
  const defaultChatId = allowFrom[0]

  cachedConfig = { token, defaultChatId }
  return cachedConfig
}

async function getSendBot(): Promise<Bot> {
  if (sendBot) return sendBot

  const { token } = loadTelegramConfig()

  if (!token) {
    throw new Error('Telegram bot token not configured')
  }

  // Check for proxy
  const proxyUrl = process.env.https_proxy || process.env.http_proxy

  if (proxyUrl) {
    const { HttpsProxyAgent } = await import('https-proxy-agent')
    const agent = new HttpsProxyAgent(proxyUrl)

    sendBot = new Bot(token, {
      client: {
        baseFetchConfig: {
          // @ts-ignore - agent type compatibility
          agent,
        },
      },
    })
  } else {
    sendBot = new Bot(token)
  }

  return sendBot
}

export const telegramSendTool: Tool = {
  name: 'telegram_send',
  description: `Send a message to Telegram. If chat_id is not provided, sends to the bot owner (from allowFrom config).

Use this tool to:
- Deliver cron job results to Telegram
- Send notifications to Telegram users
- Test Telegram bot connectivity

PARAMETERS:
- text: The message to send (required)
- chat_id: Telegram chat ID (optional, defaults to bot owner)`,
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Message text to send',
      },
      chat_id: {
        type: 'string',
        description: 'Telegram chat ID (optional, defaults to bot owner)',
      },
    },
    required: ['text'],
  },

  async execute(input: Record<string, unknown>, context?: { agentId?: string }): Promise<string> {
    const text = input.text as string
    let chatId = input.chat_id as string | undefined

    if (!text?.trim()) {
      return JSON.stringify({ success: false, error: 'text is required' })
    }

    // Use default chat_id if not provided
    if (!chatId?.trim()) {
      const { defaultChatId } = loadTelegramConfig()
      chatId = defaultChatId
    }

    if (!chatId?.trim()) {
      return JSON.stringify({
        success: false,
        error: 'chat_id is required (no default configured in allowFrom)',
      })
    }

    try {
      const bot = await getSendBot()

      const result = await bot.api.sendMessage(chatId, text)

      log.info(`Sent message to ${chatId}: ${text.slice(0, 50)}...`)

      // Append the sent message to the Telegram session's transcript
      // so that subsequent conversations have context
      const sessionKey = `telegram:${chatId}`
      const sm = getSessionManager()
      // Use getOrCreate to ensure session exists (handles deleted sessions)
      // Use agentId from context, fallback to 'default'
      const agentId = context?.agentId || 'default'
      const session = sm.getOrCreate(sessionKey, agentId, 'telegram')
      sm.appendMessage(session.sessionId, {
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
      })
      log.info(`Appended message to session ${session.sessionId}`)

      return JSON.stringify({
        success: true,
        message_id: result.message_id,
        chat_id: result.chat.id,
      })
    } catch (error) {
      log.error('Failed to send Telegram message:', error)
      return JSON.stringify({
        success: false,
        error: (error as Error).message,
      })
    }
  },
}
