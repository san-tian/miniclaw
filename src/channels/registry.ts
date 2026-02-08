// Channel Registry: Manages all channels
import type { Channel, Message, ChannelReply } from './types.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('registry')

export class ChannelRegistry {
  private channels: Map<string, Channel> = new Map()
  private messageHandler?: (msg: Message) => void

  register(channel: Channel): void {
    this.channels.set(channel.name, channel)
    channel.onMessage((msg) => {
      log.info(`Message from ${channel.name}:`, msg.text.slice(0, 50))
      this.messageHandler?.(msg)
    })
    log.info(`Registered channel: ${channel.name}`)
  }

  onMessage(handler: (msg: Message) => void): void {
    this.messageHandler = handler
  }

  get(channelName: string): Channel | undefined {
    return this.channels.get(channelName)
  }

  async send(channelName: string, sessionKey: string, reply: ChannelReply): Promise<void> {
    const channel = this.channels.get(channelName)
    if (!channel) {
      log.error(`Channel not found: ${channelName}`)
      return
    }
    await channel.send(sessionKey, reply)
  }

  async broadcast(reply: ChannelReply): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.send('broadcast', reply)
    }
  }

  async startAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.start()
    }
  }

  async stopAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.stop()
    }
  }

  getChannel(name: string): Channel | undefined {
    return this.channels.get(name)
  }
}
