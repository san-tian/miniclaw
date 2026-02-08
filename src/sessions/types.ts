// Session types for mini-claw

export interface SessionEntry {
  sessionId: string
  sessionKey: string // 用于路由的 key，如 "user:123" 或 "websocket:abc"
  agentId: string // 关联的 agent
  title?: string // 会话标题（可从首条消息生成）
  displayName?: string // 用户手动设置的显示名称（优先级最高）
  subject?: string // 主题（优先级次之）
  createdAt: number
  updatedAt: number
  messageCount: number
  // 可扩展字段
  channel?: string
}

export interface SessionStore {
  sessions: Record<string, SessionEntry>
}

export interface TranscriptMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  timestamp: number
  // tool 相关
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}
