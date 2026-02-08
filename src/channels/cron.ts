// Cron Channel: A silent channel for cron job execution
// Cron jobs run in isolated sessions and don't send replies to any UI.
// Results should be delivered via telegram_send or other tools.

import type { Channel, Message, ChannelReply } from './types.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('cron-channel')

export class CronChannel implements Channel {
  readonly name = 'cron'

  onMessage(_handler: (msg: Message) => void): void {
    // Cron channel doesn't receive external messages
    // Messages are injected directly by CronService
  }

  async send(sessionKey: string, reply: ChannelReply): Promise<void> {
    // Cron channel silently discards replies
    // The agent should use telegram_send or other tools to deliver results
    log.info(`Cron job completed: ${sessionKey}, reply length: ${reply.text?.length || 0}`)
  }

  async start(): Promise<void> {
    log.info('Cron channel started')
  }

  async stop(): Promise<void> {
    log.info('Cron channel stopped')
  }
}
