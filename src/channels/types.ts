// Channel types: Unified message format
export interface Message {
  id: string
  channel: 'websocket' | 'telegram'
  from: string
  text: string
  timestamp: number
  sessionKey: string
  // 可选：指定会话和 agent
  sessionId?: string
  agentId?: string
  metadata?: Record<string, unknown>
}

export interface ChannelReply {
  text: string
  toolCalls?: ToolCallSummary[]
}

export interface ToolCallSummary {
  name: string
  input?: Record<string, unknown>
}

export interface Channel {
  name: string
  send(sessionKey: string, reply: ChannelReply): Promise<void>
  sendTyping?(sessionKey: string): Promise<void>
  onMessage(handler: (msg: Message) => void): void
  start(): Promise<void>
  stop(): Promise<void>
}
