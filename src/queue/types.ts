// Queue types
export type QueueMode = 'steer' | 'collect'

export interface QueuedMessage {
  id: string
  sessionKey: string
  text: string
  timestamp: number
  channel: string
}
