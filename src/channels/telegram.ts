// Telegram Bot Channel using grammY
import { Bot, Context } from 'grammy'
import type { Channel, Message, ChannelReply } from './types.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('telegram')

export interface TelegramConfig {
  token: string
  allowFrom?: string[]  // 允许的用户 ID 列表，空则允许所有人
  showToolCalls?: boolean  // 是否显示 tool 调用摘要
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram'
  private bot: Bot | null = null
  private config: TelegramConfig
  private messageHandler: ((msg: Message) => void) | null = null
  private isRunning = false
  private typingIntervals = new Map<string, NodeJS.Timeout>()

  constructor(config: TelegramConfig | string) {
    this.config = typeof config === 'string' ? { token: config } : config
  }

  onMessage(handler: (msg: Message) => void): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    if (!this.config.token) {
      log.warn('Telegram bot token not configured, skipping')
      return
    }

    // 检查代理配置
    const proxyUrl = process.env.https_proxy || process.env.http_proxy

    // 创建 Bot，如果有代理则使用代理
    if (proxyUrl) {
      log.info(`Using proxy: ${proxyUrl}`)
      // 动态导入 proxy agent
      const { HttpsProxyAgent } = await import('https-proxy-agent')
      const agent = new HttpsProxyAgent(proxyUrl)

      this.bot = new Bot(this.config.token, {
        client: {
          baseFetchConfig: {
            // @ts-ignore - agent 类型兼容
            agent,
          },
        },
      })
    } else {
      this.bot = new Bot(this.config.token)
    }

    // Handle text messages
    this.bot.on('message:text', async (ctx) => {
      await this.handleMessage(ctx)
    })

    // Handle photos with caption
    this.bot.on('message:photo', async (ctx) => {
      await this.handleMessage(ctx)
    })

    // Handle documents
    this.bot.on('message:document', async (ctx) => {
      await this.handleMessage(ctx)
    })

    // Error handling
    this.bot.catch((err) => {
      log.error('Telegram bot error:', err)
    })

    // Start polling with drop_pending_updates to avoid 409 conflicts
    this.isRunning = true
    this.bot.start({
      drop_pending_updates: true,
      onStart: (botInfo) => {
        log.info(`Telegram bot @${botInfo.username} started`)
      },
    })
  }

  private async handleMessage(ctx: Context): Promise<void> {
    if (!this.messageHandler || !ctx.message) return

    const chatId = ctx.chat?.id.toString() || ''
    const userId = ctx.from?.id.toString() || ''
    const username = ctx.from?.username || ''
    const text = ctx.message.text || ctx.message.caption || ''

    // Skip empty messages
    if (!text.trim()) return

    // 访问控制：检查是否在白名单中
    if (this.config.allowFrom && this.config.allowFrom.length > 0) {
      const allowed = this.config.allowFrom.some(id =>
        id === userId || id === username || id === `@${username}`
      )
      if (!allowed) {
        log.warn(`Blocked message from unauthorized user: ${username || userId}`)
        await ctx.reply('Sorry, you are not authorized to use this bot.')
        return
      }
    }

    // Build session key: telegram:<chatId>
    const sessionKey = `telegram:${chatId}`

    const msg: Message = {
      id: ctx.message.message_id.toString(),
      channel: 'telegram',
      from: userId,
      text,
      timestamp: ctx.message.date * 1000,
      sessionKey,
      metadata: {
        chatId,
        userId,
        username,
        chatType: ctx.chat?.type,
        messageId: ctx.message.message_id,
      },
    }

    log.info(`Message from @${username || userId}: ${text.slice(0, 50)}...`)
    this.messageHandler(msg)
  }

  /** 发送 typing 状态 */
  async sendTyping(sessionKey: string): Promise<void> {
    if (!this.bot) return

    const chatId = sessionKey.replace('telegram:', '')
    if (!chatId) return

    try {
      await this.bot.api.sendChatAction(chatId, 'typing')

      // 设置定时器，每 4 秒发送一次 typing（Telegram typing 状态持续 5 秒）
      this.stopTyping(sessionKey)
      const interval = setInterval(async () => {
        try {
          await this.bot?.api.sendChatAction(chatId, 'typing')
        } catch {
          // ignore
        }
      }, 4000)
      this.typingIntervals.set(sessionKey, interval)
    } catch (err) {
      log.error('Failed to send typing action:', err)
    }
  }

  /** 停止 typing 状态 */
  stopTyping(sessionKey: string): void {
    const interval = this.typingIntervals.get(sessionKey)
    if (interval) {
      clearInterval(interval)
      this.typingIntervals.delete(sessionKey)
    }
  }

  async send(sessionKey: string, reply: ChannelReply): Promise<void> {
    if (!this.bot) return

    // 停止 typing 状态
    this.stopTyping(sessionKey)

    // Extract chatId from sessionKey (telegram:<chatId>)
    const chatId = sessionKey.replace('telegram:', '')
    if (!chatId) {
      log.error('Invalid session key:', sessionKey)
      return
    }

    try {
      // 如果有 tool 调用，先发送摘要
      if (reply.toolCalls && reply.toolCalls.length > 0 && this.config.showToolCalls !== false) {
        const toolSummary = reply.toolCalls.map(tc => `🔧 ${tc.name}`).join('\n')
        if (toolSummary.trim()) {
          await this.bot.api.sendMessage(chatId, toolSummary, {
            parse_mode: 'HTML',
          }).catch(() => {
            // ignore if HTML fails
          })
        }
      }

      // Skip empty messages
      if (!reply.text?.trim()) {
        log.warn('Skipping empty message')
        return
      }

      // Split long messages (Telegram limit is 4096 chars)
      const chunks = this.splitMessage(reply.text, 4000)

      for (const chunk of chunks) {
        await this.bot.api.sendMessage(chatId, chunk, {
          parse_mode: 'HTML',
        }).catch(async () => {
          // Fallback to plain text if HTML fails
          await this.bot!.api.sendMessage(chatId, chunk)
        })
      }
    } catch (err) {
      log.error('Failed to send message:', err)
    }
  }

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text]

    const chunks: string[] = []
    let remaining = text

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining)
        break
      }

      // Find a good split point (newline or space)
      let splitAt = remaining.lastIndexOf('\n', maxLength)
      if (splitAt === -1 || splitAt < maxLength / 2) {
        splitAt = remaining.lastIndexOf(' ', maxLength)
      }
      if (splitAt === -1 || splitAt < maxLength / 2) {
        splitAt = maxLength
      }

      chunks.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt).trimStart()
    }

    return chunks
  }

  async stop(): Promise<void> {
    // 清理所有 typing 定时器
    for (const [sessionKey] of this.typingIntervals) {
      this.stopTyping(sessionKey)
    }

    if (this.bot && this.isRunning) {
      this.isRunning = false
      try {
        // grammY's stop() returns a Promise that resolves when polling stops
        await this.bot.stop()
        log.info('Telegram bot stopped')
      } catch (err) {
        log.error('Error stopping Telegram bot:', err)
      }
      this.bot = null
    }
  }
}

// Singleton instance
let telegramChannel: TelegramChannel | null = null

export function getTelegramChannel(config?: TelegramConfig | string): TelegramChannel {
  if (!telegramChannel && config) {
    telegramChannel = new TelegramChannel(config)
  }
  return telegramChannel!
}

export function createTelegramChannel(config: TelegramConfig | string): TelegramChannel {
  return new TelegramChannel(config)
}
