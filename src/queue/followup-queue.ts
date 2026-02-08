// Followup Queue: Manages message queue with steer/collect modes
import type { Message } from '../channels/types.js'
import type { QueueMode, QueuedMessage } from './types.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('queue')

export class FollowupQueue {
  private queues: Map<string, QueuedMessage[]> = new Map()
  private mode: QueueMode = 'steer'
  private steerCallback?: (sessionKey: string, msg: QueuedMessage) => void

  setMode(mode: QueueMode): void {
    this.mode = mode
    log.info(`Queue mode set to: ${mode}`)
  }

  getMode(): QueueMode {
    return this.mode
  }

  onSteer(callback: (sessionKey: string, msg: QueuedMessage) => void): void {
    this.steerCallback = callback
  }

  enqueue(msg: Message): void {
    const queued: QueuedMessage = {
      id: msg.id,
      sessionKey: msg.sessionKey,
      text: msg.text,
      timestamp: msg.timestamp,
      channel: msg.channel,
    }

    if (this.mode === 'steer') {
      // In steer mode, immediately notify for injection
      log.info(`Steer mode: injecting message to session ${msg.sessionKey}`)
      this.steerCallback?.(msg.sessionKey, queued)
    } else {
      // In collect mode, queue for later processing
      const queue = this.queues.get(msg.sessionKey) || []
      queue.push(queued)
      this.queues.set(msg.sessionKey, queue)
      log.info(`Collect mode: queued message for session ${msg.sessionKey}`)
    }
  }

  drain(sessionKey: string): QueuedMessage[] {
    const queue = this.queues.get(sessionKey) || []
    this.queues.delete(sessionKey)
    return queue
  }

  peek(sessionKey: string): QueuedMessage[] {
    return this.queues.get(sessionKey) || []
  }

  clear(sessionKey: string): void {
    this.queues.delete(sessionKey)
  }
}
