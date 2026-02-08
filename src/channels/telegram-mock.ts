// Mock Telegram Channel: Simulates Telegram for demo purposes
import { v4 as uuid } from 'uuid'
import type { Channel, Message, Reply } from './types.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('telegram-mock')

export class TelegramMockChannel implements Channel {
  name = 'telegram'
  private messageHandler?: (msg: Message) => void
  private pendingReplies: Reply[] = []

  onMessage(handler: (msg: Message) => void): void {
    this.messageHandler = handler
  }

  async send(_sessionKey: string, reply: Reply): Promise<void> {
    this.pendingReplies.push(reply)
    log.info(`[Telegram Reply] ${reply.text.slice(0, 100)}...`)
  }

  // Simulate receiving a message from Telegram
  simulateMessage(text: string, from: string = 'telegram-user'): void {
    const msg: Message = {
      id: uuid(),
      channel: 'telegram',
      from,
      text,
      timestamp: Date.now(),
      sessionKey: `telegram:${from}`,
    }
    log.info(`[Telegram Message] from ${from}: ${text}`)
    this.messageHandler?.(msg)
  }

  getPendingReplies(): Reply[] {
    const replies = [...this.pendingReplies]
    this.pendingReplies = []
    return replies
  }

  async start(): Promise<void> {
    log.info('Telegram mock channel started')
  }

  async stop(): Promise<void> {
    log.info('Telegram mock channel stopped')
  }
}

// Singleton for CLI access
let instance: TelegramMockChannel | null = null

export function getTelegramMock(): TelegramMockChannel {
  if (!instance) {
    instance = new TelegramMockChannel()
  }
  return instance
}
